import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
	expandHome,
	homeDir,
	normalizedCwd,
	objectOrEmpty,
	textOrNull,
	timestampMs,
	walkFiles,
} from "../util";
import {
	addItem,
	categoryForTool,
	cleanUserMessage,
	isInjectedUserMessage,
	isReasoningType,
	newSession,
	openReadonlyDatabase,
	readJsonlFile,
	shaSegment,
	type TranscriptItem,
	type TranscriptReadResult,
	type TranscriptRole,
	type TranscriptSession,
	tablesIn,
	textFromContent,
} from "./shared";

function codexHomePath(): string {
	return process.env.CODEX_HOME
		? path.resolve(expandHome(process.env.CODEX_HOME))
		: path.join(homeDir, ".codex");
}

function codexRolloutFiles(codexHome: string): string[] {
	const isRollout = (_filePath: string, name: string) =>
		name.startsWith("rollout-") && /\.jsonl(?:\.zst)?$/u.test(name);
	return [
		...walkFiles(path.join(codexHome, "sessions"), isRollout),
		...walkFiles(path.join(codexHome, "archived_sessions"), isRollout),
	].sort(
		(left, right) =>
			path.basename(left).localeCompare(path.basename(right)) ||
			left.localeCompare(right),
	);
}

/**
 * Codex splits a single conversation across several rollout files when it is
 * resumed or compacted: the first file is `rollout-<time>-<thread>.jsonl` and
 * every continuation appends `_<rollout>` to the same thread id. A thread's
 * `rollout_path` in Codex's database only points at the most recent segment, so
 * callers that need the whole conversation must read every matching file.
 */
export function codexSessionFiles(sessionId: string): string[] {
	const needle = sessionId.toLowerCase();
	return codexRolloutFiles(codexHomePath()).filter((filePath) =>
		path.basename(filePath).toLowerCase().includes(needle),
	);
}

function isCodexSubagentRollout(events: Record<string, unknown>[]): boolean {
	const metadata = events.find((event) => event.type === "session_meta");
	const source = objectOrEmpty(objectOrEmpty(metadata?.payload).source);
	return source.subagent !== undefined && source.subagent !== null;
}

function codexThreadTitles(codexHome: string): Map<string, string> {
	const titles = new Map<string, string>();
	let stateDatabases: string[] = [];
	try {
		stateDatabases = readdirSync(codexHome).filter((entry) =>
			/^state_.*\.sqlite$/u.test(entry),
		);
	} catch {
		// Codex may not have a local state database yet.
	}
	for (const name of stateDatabases) {
		try {
			const db = openReadonlyDatabase(path.join(codexHome, name));
			try {
				if (!tablesIn(db).has("threads")) continue;
				for (const row of db
					.query<{ id: string; title: string | null }, []>(
						"SELECT id, title FROM threads WHERE title IS NOT NULL",
					)
					.all()) {
					if (row.title?.trim()) titles.set(row.id, row.title);
				}
			} finally {
				db.close();
			}
		} catch {
			// One unavailable state database should not hide titles in the others.
		}
	}

	const databasePath = path.join(codexHome, "sqlite/codex-dev.db");
	if (!existsSync(databasePath)) return titles;
	try {
		const db = openReadonlyDatabase(databasePath);
		try {
			if (!tablesIn(db).has("local_thread_catalog")) return titles;
			for (const row of db
				.query<{ thread_id: string; display_title: string | null }, []>(
					"SELECT thread_id, display_title FROM local_thread_catalog " +
						"WHERE display_title IS NOT NULL",
				)
				.all()) {
				if (row.display_title?.trim())
					titles.set(row.thread_id, row.display_title);
			}
			return titles;
		} finally {
			db.close();
		}
	} catch {
		return titles;
	}
}

function codexToolName(
	payload: Record<string, unknown>,
	itemType: string,
): string {
	if (itemType === "web_search_call") return "web_search_call";
	if (itemType === "local_shell_call") return "local_shell_call";
	if (itemType === "mcp_call") {
		const server = textOrNull(payload.server_label);
		const name = textOrNull(payload.name);
		if (server && name) return `mcp__${server}__${name}`;
	}
	return (
		textOrNull(payload.name) ??
		textOrNull(payload.namespace) ??
		(itemType !== "function_call" && itemType !== "custom_tool_call"
			? itemType
			: null) ??
		"tool"
	);
}

function codexToolInput(
	payload: Record<string, unknown>,
	itemType: string,
): unknown {
	if (itemType === "web_search_call") {
		return payload.action !== undefined
			? { action: payload.action }
			: undefined;
	}
	if (itemType === "local_shell_call") {
		return payload.action ?? payload.input ?? payload.arguments;
	}
	return payload.arguments ?? payload.input ?? payload.action;
}

function codexMessagePhase(phaseValue: unknown): TranscriptItem["phase"] {
	if (phaseValue === "final_answer") return "final";
	if (phaseValue === "commentary") return "intermediate";
	return "unknown";
}

function addCodexMessage(
	session: TranscriptSession,
	role: TranscriptRole,
	payload: Record<string, unknown>,
	timestamp: number | null,
	turnId: string,
	fileIdPrefix: string,
): TranscriptItem | null {
	const text = textFromContent(payload.content);
	if (!text) return null;
	return addItem(session, {
		id:
			textOrNull(payload.id) ??
			`${fileIdPrefix}:message-${session.items.length}`,
		turnId,
		role,
		kind: "message",
		phase: codexMessagePhase(payload.phase),
		text,
		timestamp,
	});
}

function mergeStartedAt(
	left: number | null,
	right: number | null,
): number | null {
	if (left === null) return right;
	if (right === null) return left;
	return Math.min(left, right);
}

function mergeCodexSession(
	existing: TranscriptSession,
	incoming: TranscriptSession,
): void {
	existing.startedAt = mergeStartedAt(existing.startedAt, incoming.startedAt);
	existing.cwd ??= incoming.cwd;
	existing.title ??= incoming.title;
	const itemIndexes = new Map(
		existing.items.map((item, index) => [
			`${item.role}:${item.kind}:${item.id}`,
			index,
		]),
	);
	for (const { order: _order, ...item } of incoming.items) {
		const key = `${item.role}:${item.kind}:${item.id}`;
		const existingIndex = itemIndexes.get(key);
		if (existingIndex !== undefined) {
			const duplicate = existing.items[existingIndex];
			if (duplicate && item.phase === "final") duplicate.phase = "final";
			continue;
		}
		const added = addItem(existing, item);
		itemIndexes.set(key, existing.items.length - 1);
		added.order = existing.items.length - 1;
	}
}

export function readCodexTranscripts(
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const codexHome = codexHomePath();
	const files = codexRolloutFiles(codexHome).filter(
		(filePath) => !targetFiles || targetFiles.has(filePath),
	);
	const titles = codexThreadTitles(codexHome);
	const result: TranscriptReadResult = {
		harness: "codex",
		available:
			existsSync(path.join(codexHome, "sessions")) ||
			existsSync(path.join(codexHome, "archived_sessions")),
		sessions: [],
		warnings: [],
	};
	const sessionsById = new Map<string, TranscriptSession>();

	for (const filePath of files) {
		try {
			const events = readJsonlFile(filePath).map(objectOrEmpty);
			if (targetFiles === undefined && isCodexSubagentRollout(events)) continue;
			let sessionId = path
				.basename(filePath)
				.replace(/\.jsonl(?:\.zst)?$/u, "");
			const fileIdPrefix = shaSegment(path.basename(filePath));
			let currentTurn = `${fileIdPrefix}:turn-0`;
			let turnCounter = 0;
			let sessionMetaSeen = false;
			const session = newSession("codex", sessionId, null, null);

			for (const event of events) {
				const payload = objectOrEmpty(event.payload);
				const type =
					event.type === "event_msg" ? textOrNull(payload.type) : event.type;
				const timestamp = timestampMs(event.timestamp);

				if (event.type === "session_meta") {
					const metaId =
						textOrNull(payload.id) ?? textOrNull(payload.session_id);
					// Subagent rollouts replay the parent's session_meta after their own.
					if (sessionMetaSeen && metaId !== null && metaId !== sessionId)
						continue;
					sessionMetaSeen = true;
					sessionId = metaId ?? sessionId;
					session.sessionId = sessionId;
					session.cwd = normalizedCwd(payload.cwd) ?? session.cwd;
					session.startedAt =
						timestampMs(payload.timestamp) ?? session.startedAt;
					session.title =
						textOrNull(payload.title) ??
						textOrNull(payload.display_title) ??
						session.title;
				}

				if (type === "task_started") {
					turnCounter += 1;
					currentTurn =
						textOrNull(payload.turn_id) ??
						textOrNull(payload.root_turn_id) ??
						`${fileIdPrefix}:turn-${turnCounter}`;
				}

				if (event.type !== "response_item") {
					if (type === "task_complete") {
						for (let index = session.items.length - 1; index >= 0; index -= 1) {
							const candidate = session.items[index];
							if (candidate?.turnId !== currentTurn) continue;
							if (
								candidate.kind === "message" &&
								candidate.role === "assistant" &&
								candidate.phase === "unknown"
							) {
								candidate.phase = "final";
								break;
							}
						}
					}
					continue;
				}

				const item = objectOrEmpty(event.payload);
				const itemType = textOrNull(item.type) ?? "";
				const role = textOrNull(item.role);
				const turnId =
					textOrNull(objectOrEmpty(event.metadata).turn_id) ?? currentTurn;

				if (itemType === "message") {
					if (role === "user") {
						const text = cleanUserMessage(
							"codex",
							textFromContent(item.content),
						);
						if (text) {
							addItem(session, {
								id:
									textOrNull(item.id) ??
									`${fileIdPrefix}:user-${session.items.length}`,
								turnId,
								role: "user",
								kind: "message",
								phase: "unknown",
								text,
								timestamp,
							});
						}
					} else if (role === "assistant") {
						addCodexMessage(
							session,
							"assistant",
							item,
							timestamp,
							turnId,
							fileIdPrefix,
						);
					} else if (role === "developer" || role === "system") {
						const text = textFromContent(item.content);
						if (text) {
							addItem(session, {
								id:
									textOrNull(item.id) ??
									`${fileIdPrefix}:${role}-${session.items.length}`,
								turnId,
								role,
								kind: "other",
								phase: "unknown",
								text,
								timestamp,
							});
						}
					}
					continue;
				}

				if (itemType === "agent_message" || itemType === "compaction") {
					const text = textFromContent(item.content ?? item.text);
					if (text) {
						addItem(session, {
							id:
								textOrNull(item.id) ??
								`${fileIdPrefix}:${itemType}-${session.items.length}`,
							turnId,
							role: "other",
							kind: "other",
							phase: "unknown",
							text,
							timestamp,
						});
					}
					continue;
				}

				if (
					itemType === "function_call" ||
					itemType === "custom_tool_call" ||
					(itemType.endsWith("_call") && !isReasoningType(itemType))
				) {
					const name = codexToolName(item, itemType);
					addItem(session, {
						id:
							textOrNull(item.call_id) ??
							textOrNull(item.id) ??
							`${fileIdPrefix}:tool-${session.items.length}`,
						turnId,
						role: "tool",
						kind: "tool_call",
						phase: "intermediate",
						name,
						input: codexToolInput(item, itemType),
						toolCallId:
							textOrNull(item.call_id) ?? textOrNull(item.id) ?? undefined,
						category: categoryForTool(name),
						status: textOrNull(item.status) ?? undefined,
						timestamp,
					});
					continue;
				}

				if (
					itemType === "function_call_output" ||
					itemType === "custom_tool_call_output" ||
					itemType.endsWith("_call_output")
				) {
					const output = item.output ?? item.content ?? item.result;
					addItem(session, {
						id:
							textOrNull(item.call_id) ??
							textOrNull(item.id) ??
							`${fileIdPrefix}:tool-result-${session.items.length}`,
						turnId,
						role: "tool",
						kind: "tool_result",
						phase: "intermediate",
						name: textOrNull(item.name) ?? "tool",
						output,
						text: typeof output === "string" ? output : textFromContent(output),
						toolCallId:
							textOrNull(item.call_id) ?? textOrNull(item.id) ?? undefined,
						status: textOrNull(item.status) ?? undefined,
						timestamp,
					});
				}
			}

			const existing = sessionsById.get(session.sessionId);
			if (!existing) {
				sessionsById.set(session.sessionId, session);
			} else {
				mergeCodexSession(existing, session);
			}
		} catch (error) {
			result.warnings.push(
				`Codex: failed to read ${filePath} (${String(error)})`,
			);
		}
	}

	result.sessions = [...sessionsById.values()];
	for (const session of result.sessions) {
		const firstUser = session.items.find(
			(item) =>
				item.role === "user" && item.kind === "message" && Boolean(item.text),
		);
		const raw =
			titles.get(session.sessionId) ?? session.title ?? firstUser?.text ?? null;
		const cleaned = raw ? cleanUserMessage("codex", raw) : "";
		const title =
			cleaned ||
			firstUser?.text ||
			(raw && !isInjectedUserMessage("codex", raw) ? raw : undefined);
		if (title) {
			const compact = title.replaceAll(/\s+/gu, " ").trim();
			const characters = Array.from(compact);
			session.title =
				characters.length > 160
					? `${characters.slice(0, 159).join("").trimEnd()}…`
					: compact;
		} else {
			session.title = undefined;
		}
	}
	return result;
}
