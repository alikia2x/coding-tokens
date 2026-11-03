import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
	decodeProto,
	loadSummaries,
	openSafeReadonlyDatabase,
	parseWorkspaceUri,
	protoSub,
	protoText,
} from "./sources/antigravity";
import type { HarnessName, UsageRecord } from "./types";
import {
	expandHome,
	homeDir,
	localDate,
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	walkFiles,
} from "./util";

export type ExportDetail =
	| "user_only"
	| "chat_compact"
	| "chat"
	| "chat_tools"
	| "agent"
	| "agent_full";

export type TranscriptRole =
	| "user"
	| "assistant"
	| "tool"
	| "system"
	| "developer"
	| "other";

export type TranscriptKind = "message" | "tool_call" | "tool_result" | "other";

export type ToolCategory = "command" | "read" | "write" | "other";

export interface TranscriptItem {
	id: string;
	order: number;
	turnId: string;
	role: TranscriptRole;
	kind: TranscriptKind;
	phase: "final" | "intermediate" | "unknown";
	text?: string;
	name?: string;
	input?: unknown;
	output?: unknown;
	toolCallId?: string;
	usageId?: string;
	category?: ToolCategory;
	status?: string;
	timestamp: number | null;
}

export interface TranscriptSession {
	harness: HarnessName;
	sessionId: string;
	cwd: string | null;
	startedAt: number | null;
	title?: string;
	usageRecords?: UsageRecord[];
	items: TranscriptItem[];
}

export interface TranscriptReadResult {
	harness: HarnessName;
	available: boolean;
	sessions: TranscriptSession[];
	warnings: string[];
}

export interface TranscriptFilters {
	harnesses: Set<HarnessName>;
	projects?: Set<string>;
	date?: string;
	/** Inclusive lower bound in epoch milliseconds. */
	since?: number;
	/** Exclusive upper bound in epoch milliseconds. */
	until?: number;
}

const newSession = (
	harness: HarnessName,
	sessionId: string,
	cwd: string | null,
	startedAt: number | null,
	title?: string,
): TranscriptSession => ({
	harness,
	sessionId,
	cwd,
	startedAt,
	title,
	items: [],
});

function addItem(
	session: TranscriptSession,
	item: Omit<TranscriptItem, "order">,
): TranscriptItem {
	const complete = { ...item, order: session.items.length };
	session.items.push(complete);
	return complete;
}

function typeOf(value: unknown): string {
	return textOrNull(objectOrEmpty(value).type) ?? "";
}

function idString(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function dshEventId(
	event: Record<string, unknown>,
	data: Record<string, unknown>,
	type: string,
): string {
	return (
		textOrNull(event.id) ??
		`${String(data.turn ?? "?")}:${String(data.step ?? "?")}:${type}:${String(event.seq ?? "?")}`
	);
}

function isReasoningType(type: string): boolean {
	const normalized = type.toLowerCase();
	return (
		normalized.includes("reasoning") ||
		normalized.includes("thinking") ||
		normalized === "analysis" ||
		normalized === "encrypted_content"
	);
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const lines: string[] = [];
	for (const blockValue of value) {
		const block = objectOrEmpty(blockValue);
		const type = typeOf(block);
		if (isReasoningType(type)) continue;
		if (
			type === "text" ||
			type === "input_text" ||
			type === "output_text" ||
			type === "markdown"
		) {
			if (typeof block.text === "string") lines.push(block.text);
			continue;
		}
		if (type.includes("image")) {
			const name =
				textOrNull(block.filename) ??
				textOrNull(objectOrEmpty(block.source).filename);
			lines.push(name ? `[Image: ${name}]` : "[Image attached]");
			continue;
		}
		if (type === "file" || type.includes("input_file")) {
			const name =
				textOrNull(block.filename) ??
				textOrNull(block.name) ??
				textOrNull(block.path);
			lines.push(name ? `[File: ${name}]` : "[File attached]");
		}
	}
	return lines.join("\n");
}

function removeTaggedBlocks(value: string, tags: string[]): string {
	let text = value;
	for (const tag of tags) {
		const escaped = tag.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		text = text
			.replace(
				new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}\\s*>`, "giu"),
				"",
			)
			.replace(new RegExp(`<${escaped}\\b[^>]*/\\s*>`, "giu"), "");
	}
	return text
		.replaceAll(/[ \t]+\n/gu, "\n")
		.replaceAll(/\n{3,}/gu, "\n\n")
		.trim();
}

export function isInjectedUserMessage(
	harness: HarnessName,
	value: string,
): boolean {
	return (
		(harness === "codex" &&
			/^\s*(?:#\s*AGENTS\.md instructions\b|The following is the Codex agent history|<codex_internal_context|<turn_aborted|<subagent_notification|<codex_delegation)\b/iu.test(
				value,
			)) ||
		(harness === "dsh" &&
			/^\s*Current runtime context\. This snapshot supersedes earlier runtime-context snapshots\./iu.test(
				value,
			))
	);
}

function codexMyRequest(value: string): string | null {
	const marker = /(?:^|\n)#{0,6}\s*My request(?: for Codex)?\s*:\s*/iu.exec(
		value,
	);
	if (!marker) return null;
	return value.slice(marker.index + marker[0].length).trim();
}

function codexAnnotationText(value: string): string | null {
	const block =
		/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/iu.exec(
			value,
		);
	if (!block?.[1]) return null;
	try {
		const parsed: unknown = JSON.parse(block[1]);
		if (!Array.isArray(parsed)) return null;
		const lines = parsed
			.map((entry) => {
				const record = objectOrEmpty(entry);
				const selected = textOrNull(record.text)?.trim() ?? "";
				const comment = textOrNull(record.annotation)?.trim() ?? "";
				if (selected && comment) return `> ${selected}\n\n${comment}`;
				if (comment) return comment;
				if (selected) return `> ${selected}`;
				return "";
			})
			.filter(Boolean);
		return lines.length ? lines.join("\n\n") : null;
	} catch {
		return null;
	}
}

export function cleanUserMessage(harness: HarnessName, value: string): string {
	if (isInjectedUserMessage(harness, value)) return "";
	if (harness === "codex") {
		const questionReply = value.match(
			/<send_user_message_question_reply\b[^>]*>([\s\S]*?)<\/send_user_message_question_reply\s*>/iu,
		)?.[1];
		if (questionReply !== undefined) {
			try {
				const parsed: unknown = JSON.parse(questionReply);
				if (Array.isArray(parsed)) {
					const answers = parsed
						.map((entry) => textOrNull(objectOrEmpty(entry).answer))
						.filter((answer): answer is string => answer !== null);
					if (answers.length) return answers.join("\n");
				}
			} catch {
				// Keep the remaining message when the UI wrapper is malformed.
			}
		}

		const annotations = codexAnnotationText(value);
		const request = codexMyRequest(value);
		if (annotations !== null || request !== null) {
			const body = [annotations, request].filter(Boolean).join("\n\n");
			return body
				? removeTaggedBlocks(body, [
						"system-reminder",
						"environment_context",
						"external_codex_apps_open_page",
						"codex_internal_context",
						"guardian_tool_descriptions",
						"subagents",
						"image",
					])
				: "";
		}

		if (
			/^\s*#{0,6}\s*(?:Files mentioned by the user|Referenced chats with Codex|Response annotations)\b/iu.test(
				value,
			)
		)
			return "";
	}

	if (harness === "opencode") {
		const requests = [
			...value.matchAll(/<user-request\b[^>]*>([\s\S]*?)<\/user-request>/giu),
		]
			.map((match) => match[1]?.trim() ?? "")
			.filter(Boolean);
		if (value.includes("<auto-slash-command") || requests.length > 0) {
			if (requests.length)
				return removeTaggedBlocks(requests.at(-1) ?? "", ["session-context"]);
			const fallback = value.match(
				/(?:^|\n)---\s*\n## User Request\s*\n([\s\S]*?)(?:\n---|$)/iu,
			)?.[1];
			return fallback ? removeTaggedBlocks(fallback, ["session-context"]) : "";
		}
	}

	const tags = [
		"system-reminder",
		"environment_context",
		"external_codex_apps_open_page",
		"recommended_plugins",
		"skills_instructions",
		"app-context",
		"Work_Context",
		"session-context",
		"auto-slash-command",
		"command-instruction",
		"user-request",
	];
	if (harness === "codex") {
		tags.push(
			"codex_internal_context",
			"guardian_tool_descriptions",
			"subagents",
			"turn_aborted",
			"subagent_notification",
			"codex_delegation",
			"image",
		);
	}
	const cleaned = removeTaggedBlocks(value, tags);
	if (isInjectedUserMessage(harness, cleaned)) return "";
	if (
		harness === "codex" &&
		/^\s*#{0,6}\s*(?:Files mentioned by the user|Referenced chats with Codex|Response annotations)\b/iu.test(
			cleaned,
		)
	)
		return "";
	return cleaned;
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.map(objectOrEmpty);
}

function categoryForTool(name: string): ToolCategory {
	const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_");
	if (
		/(^|_)(bash|shell|command|exec|exec_command|shell_command|run_command)(_|$)/u.test(
			normalized,
		)
	) {
		return "command";
	}
	if (
		/(^|_)(read|grep|glob|search|list_directory|find_file|cat)(_|$)/u.test(
			normalized,
		)
	) {
		return "read";
	}
	if (
		/(^|_)(write|edit|patch|apply_patch|save|delete|move|rename)(_|$)/u.test(
			normalized,
		)
	) {
		return "write";
	}
	return "other";
}

function readJsonlFile(filePath: string): unknown[] {
	const bytes = readFileSync(filePath);
	const text = /\.zstd?$/u.test(filePath)
		? zstdDecompressSync(bytes).toString("utf8")
		: bytes.toString("utf8");
	return parseJsonl(text);
}

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

function codexToolName(payload: Record<string, unknown>): string {
	return textOrNull(payload.name) ?? textOrNull(payload.namespace) ?? "tool";
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
	const phase =
		payload.phase === "final_answer"
			? "final"
			: payload.phase === "commentary"
				? "intermediate"
				: "unknown";
	return addItem(session, {
		id:
			textOrNull(payload.id) ??
			`${fileIdPrefix}:message-${session.items.length}`,
		turnId,
		role,
		kind: "message",
		phase,
		text,
		timestamp,
	});
}

function readCodexTranscripts(
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
					// Subagent rollouts replay the parent's session_meta after their
					// own. The first one owns the file; later replays must not move
					// the items into the parent conversation.
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
						if (text)
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
						if (text)
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
					continue;
				}
				if (itemType === "agent_message" || itemType === "compaction") {
					const text = textFromContent(item.content ?? item.text);
					if (text)
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
					continue;
				}

				if (
					itemType === "function_call" ||
					itemType === "custom_tool_call" ||
					(itemType.endsWith("_call") && !isReasoningType(itemType))
				) {
					const name = codexToolName(item);
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
						input: item.arguments ?? item.input,
						toolCallId:
							textOrNull(item.call_id) ?? textOrNull(item.id) ?? undefined,
						category: categoryForTool(name),
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
						timestamp,
					});
				}
			}
			const existing = sessionsById.get(session.sessionId);
			if (!existing) {
				sessionsById.set(session.sessionId, session);
				continue;
			}
			existing.startedAt =
				existing.startedAt === null
					? session.startedAt
					: session.startedAt === null
						? existing.startedAt
						: Math.min(existing.startedAt, session.startedAt);
			existing.cwd ??= session.cwd;
			existing.title ??= session.title;
			const itemIndexes = new Map(
				existing.items.map((item, index) => [
					`${item.role}:${item.kind}:${item.id}`,
					index,
				]),
			);
			for (const { order: _order, ...item } of session.items) {
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

interface DshSessionLog {
	filePath: string;
	generation: number;
}

function dshGeneration(name: string): number {
	const match = name.match(/^session\.v(\d+)\.jsonl\.zstd$/u);
	return match ? Number(match[1]) : 0;
}

function dshLogs(root: string): DshSessionLog[] {
	const candidates = walkFiles(
		path.join(root, "sessions"),
		(_filePath, name) =>
			name.startsWith("session") && name.endsWith(".jsonl.zstd"),
	);
	const byDirectory = new Map<string, DshSessionLog>();
	for (const filePath of candidates) {
		const candidate = {
			filePath,
			generation: dshGeneration(path.basename(filePath)),
		};
		const directory = path.dirname(filePath);
		const current = byDirectory.get(directory);
		if (!current || candidate.generation > current.generation)
			byDirectory.set(directory, candidate);
	}
	return [...byDirectory.values()];
}

function addToolCall(
	session: TranscriptSession,
	name: string,
	input: unknown,
	callId: string | null,
	turnId: string,
	timestamp: number | null,
	status?: string,
): TranscriptItem {
	return addItem(session, {
		id: callId ?? `tool-${session.items.length}`,
		turnId,
		role: "tool",
		kind: "tool_call",
		phase: "intermediate",
		name,
		input,
		toolCallId: callId ?? undefined,
		category: categoryForTool(name),
		status,
		timestamp,
	});
}

function markCompletedTurnFinal(
	session: TranscriptSession,
	turnId: string,
): void {
	let lastToolOrder = -1;
	for (const item of session.items) {
		if (item.turnId === turnId && item.kind === "tool_call")
			lastToolOrder = Math.max(lastToolOrder, item.order);
	}
	let final: TranscriptItem | undefined;
	for (const item of session.items) {
		if (
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message" &&
			item.order > lastToolOrder
		) {
			final = item;
		}
	}
	if (final) {
		for (const item of session.items) {
			if (
				item.turnId === turnId &&
				item.role === "assistant" &&
				item.kind === "message"
			) {
				item.phase = item === final ? "final" : "intermediate";
			}
		}
	}
}

function readDshTranscripts(
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const roots = process.env.DSH_HOME
		? [path.resolve(expandHome(process.env.DSH_HOME))]
		: [
				path.join(homeDir, ".dsh"),
				path.join(homeDir, "Library/Application Support/dsh-desktop/harness"),
			];
	const existing = roots.filter((root) =>
		existsSync(path.join(root, "sessions")),
	);
	const result: TranscriptReadResult = {
		harness: "dsh",
		available: existing.length > 0,
		sessions: [],
		warnings: [],
	};
	const seen = new Set<string>();
	for (const root of existing) {
		for (const { filePath } of dshLogs(root).filter(
			(log) => !targetFiles || targetFiles.has(log.filePath),
		)) {
			try {
				const events = readJsonlFile(filePath).map(objectOrEmpty);
				const header = events.find((event) => event.type === "session") ?? {};
				const sessionId =
					textOrNull(header.id) ?? path.basename(path.dirname(filePath));
				const origin = (textOrNull(header.origin) ?? "").toLowerCase();
				const isSubagent =
					origin === "subagent" ||
					textOrNull(header.parentSession) !== null ||
					(Number(header.delegationDepth) || 0) > 0;
				if (isSubagent && !targetFiles) continue;
				if (seen.has(sessionId)) continue;
				seen.add(sessionId);
				const session = newSession(
					"dsh",
					sessionId,
					normalizedCwd(header.cwd),
					timestampMs(header.createdAt),
					textOrNull(header.title) ?? undefined,
				);
				let fallbackTurn = 0;
				for (const event of events) {
					const type = textOrNull(event.type) ?? "";
					const data = objectOrEmpty(event.data);
					const time = timestampMs(event.time);
					if (type === "session/title") {
						session.title = textOrNull(data.title) ?? session.title;
						continue;
					}
					if (type === "user/message") {
						fallbackTurn += 1;
						const text = cleanUserMessage("dsh", textFromContent(data.content));
						if (text)
							addItem(session, {
								id: textOrNull(data.id) ?? `user-${session.items.length}`,
								turnId: idString(data.turn) ?? String(fallbackTurn),
								role: "user",
								kind: "message",
								phase: "unknown",
								text,
								timestamp: time,
							});
						continue;
					}
					if (type === "assistant/message") {
						const message = objectOrEmpty(data.message);
						const turnId = idString(data.turn) ?? String(fallbackTurn);
						const blocks = contentBlocks(message.content);
						const hasToolCall = blocks.some(
							(block) => typeOf(block) === "tool-call",
						);
						const text = textFromContent(message.content);
						if (text)
							addItem(session, {
								id:
									textOrNull(message.id) ?? `assistant-${session.items.length}`,
								usageId: dshEventId(event, data, type),
								turnId,
								role: "assistant",
								kind: "message",
								phase: hasToolCall ? "intermediate" : "unknown",
								text,
								timestamp: time,
							});
						continue;
					}
					if (type === "system/message" || type === "developer/message") {
						const role = type.startsWith("developer") ? "developer" : "system";
						const message = objectOrEmpty(data.message);
						const text = textFromContent(
							data.content ?? message.content ?? data.message,
						);
						if (text)
							addItem(session, {
								id: textOrNull(data.id) ?? `${role}-${session.items.length}`,
								turnId: idString(data.turn) ?? String(fallbackTurn),
								role,
								kind: "other",
								phase: "unknown",
								text,
								timestamp: time,
							});
						continue;
					}
					if (type === "tool/call") {
						const name = textOrNull(data.name) ?? "tool";
						addToolCall(
							session,
							name,
							data.arguments,
							idString(data.callId),
							idString(data.turn) ?? String(fallbackTurn),
							time,
						);
						continue;
					}
					if (type === "tool/result") {
						const message = objectOrEmpty(data.message);
						const output = message.content ?? message;
						addItem(session, {
							id: `tool-result-${session.items.length}`,
							turnId: idString(data.turn) ?? String(fallbackTurn),
							role: "tool",
							kind: "tool_result",
							phase: "intermediate",
							text: textFromContent(output),
							output,
							toolCallId: idString(data.callId) ?? undefined,
							timestamp: time,
						});
						continue;
					}
					if (type === "turn/end") {
						const reason = objectOrEmpty(data.reason);
						if (reason.kind === "completed")
							markCompletedTurnFinal(
								session,
								idString(data.turn) ?? String(fallbackTurn),
							);
						continue;
					}
					if (
						type === "todo/write" ||
						type === "workspace/changes" ||
						type === "deliverables/presented"
					) {
						addItem(session, {
							id: `${type}-${session.items.length}`,
							turnId: idString(data.turn) ?? String(fallbackTurn),
							role: "other",
							kind: "other",
							phase: "unknown",
							text: JSON.stringify(data, null, 2),
							timestamp: time,
						});
					}
				}
				result.sessions.push(session);
			} catch (error) {
				result.warnings.push(
					`DSH: failed to read ${filePath} (${String(error)})`,
				);
			}
		}
	}
	return result;
}

function readCommandCodeTranscripts(
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const root = process.env.COMMANDCODE_HOME
		? path.resolve(expandHome(process.env.COMMANDCODE_HOME))
		: path.join(homeDir, ".commandcode");
	const projectsRoot = path.join(root, "projects");
	const result: TranscriptReadResult = {
		harness: "commandcode",
		available: existsSync(projectsRoot),
		sessions: [],
		warnings: [],
	};
	let projectDirs: string[] = [];
	try {
		projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(projectsRoot, entry.name));
	} catch (error) {
		if (existsSync(projectsRoot))
			result.warnings.push(
				`Command Code: failed to list projects (${String(error)})`,
			);
	}
	const files = projectDirs
		.flatMap((directory) =>
			walkFiles(
				directory,
				(_filePath, name) =>
					name.endsWith(".jsonl") &&
					!name.endsWith(".checkpoints.jsonl") &&
					!name.endsWith(".prompts.jsonl"),
			),
		)
		.filter((filePath) => !targetFiles || targetFiles.has(filePath));
	for (const filePath of files) {
		try {
			const rows = readJsonlFile(filePath).map(objectOrEmpty);
			const header = rows.find((row) => row.type === "session");
			if (!header) continue;
			const sessionId =
				textOrNull(header.id) ?? path.basename(filePath, ".jsonl");
			let metadata: Record<string, unknown> = {};
			try {
				metadata = objectOrEmpty(
					JSON.parse(
						readFileSync(filePath.replace(/\.jsonl$/u, ".meta.json"), "utf8"),
					),
				);
			} catch {
				// Older Command Code sessions may not have a metadata sidecar.
			}
			const sessionInfo = rows.find((row) => row.type === "session_info");
			const session = newSession(
				"commandcode",
				sessionId,
				normalizedCwd(header.cwd) ??
					`Unknown directory (${path.basename(path.dirname(filePath))})`,
				timestampMs(header.timestamp),
				textOrNull(metadata.title) ??
					textOrNull(objectOrEmpty(sessionInfo).name) ??
					textOrNull(header.title) ??
					undefined,
			);
			let turn = 0;
			for (const [index, row] of rows.entries()) {
				if (row.type !== "message") continue;
				const message = objectOrEmpty(row.message);
				const role = textOrNull(message.role);
				const blocks = contentBlocks(message.content);
				const hasToolResult = blocks.some(
					(block) => typeOf(block) === "tool_result",
				);
				const text = textFromContent(message.content);
				if (role === "user" && text && !hasToolResult) turn += 1;
				const turnId = String(turn);
				const timestamp = timestampMs(row.timestamp);
				if (role === "user") {
					for (const block of blocks) {
						if (typeOf(block) !== "tool_result") continue;
						const output = block.content ?? block;
						addItem(session, {
							id: `tool-result-${textOrNull(block.tool_use_id) ?? index}`,
							turnId,
							role: "tool",
							kind: "tool_result",
							phase: "intermediate",
							text: textFromContent(output),
							output,
							toolCallId: textOrNull(block.tool_use_id) ?? undefined,
							status: block.is_error === true ? "error" : "completed",
							timestamp,
						});
					}
					const userText = cleanUserMessage("commandcode", text);
					if (userText && !hasToolResult)
						addItem(session, {
							id: textOrNull(row.id) ?? `user-${index}`,
							turnId,
							role: "user",
							kind: "message",
							phase: "unknown",
							text: userText,
							timestamp,
						});
					continue;
				}
				if (role === "assistant") {
					const toolBlocks = blocks.filter(
						(block) => typeOf(block) === "tool_use",
					);
					const assistantText = textFromContent(blocks);
					if (assistantText)
						addItem(session, {
							id: textOrNull(row.id) ?? `assistant-${index}`,
							usageId: textOrNull(row.id) ?? undefined,
							turnId,
							role: "assistant",
							kind: "message",
							phase: toolBlocks.length > 0 ? "intermediate" : "unknown",
							text: assistantText,
							timestamp,
						});
					for (const block of toolBlocks) {
						const name = textOrNull(block.name) ?? "tool";
						addToolCall(
							session,
							name,
							block.input,
							textOrNull(block.id),
							turnId,
							timestamp,
						);
					}
				}
			}
			inferFinalMessages(session);
			result.sessions.push(session);
		} catch (error) {
			result.warnings.push(
				`Command Code: failed to read ${filePath} (${String(error)})`,
			);
		}
	}
	return result;
}

function inferFinalMessages(session: TranscriptSession): void {
	const turns = new Set(session.items.map((item) => item.turnId));
	for (const turnId of turns) {
		inferUnknownFinalMessage(session, turnId);
	}
}

function inferUnknownFinalMessage(
	session: TranscriptSession,
	turnId: string,
): void {
	if (
		session.items.some(
			(item) =>
				item.turnId === turnId &&
				item.role === "assistant" &&
				item.kind === "message" &&
				item.phase === "final",
		)
	)
		return;
	let lastToolOrder = -1;
	for (const item of session.items) {
		if (item.turnId === turnId && item.kind === "tool_call")
			lastToolOrder = Math.max(lastToolOrder, item.order);
	}
	let final: TranscriptItem | undefined;
	for (const item of session.items) {
		if (
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message" &&
			item.phase === "unknown" &&
			item.order > lastToolOrder
		)
			final = item;
	}
	if (!final) return;
	for (const item of session.items) {
		if (
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message" &&
			item.phase === "unknown"
		)
			item.phase = item === final ? "final" : "intermediate";
	}
}

function inferUnknownFinalMessages(sessions: TranscriptSession[]): void {
	for (const session of sessions) inferFinalMessages(session);
}

function hasNonEmptySidecar(filePath: string): boolean {
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

function openReadonlyDatabase(dbPath: string): Database {
	const hasPendingSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);
	if (hasPendingSidecar)
		return new Database(dbPath, { readonly: true, create: false });
	return new Database(`${pathToFileURL(dbPath).href}?immutable=1`, {
		readonly: true,
		create: false,
	});
}

function tablesIn(db: Database): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((row) => row.name),
	);
}

function openCodeToolPart(
	session: TranscriptSession,
	part: Record<string, unknown>,
	turnId: string,
	timestamp: number | null,
): void {
	const state = objectOrEmpty(part.state);
	const name = textOrNull(part.tool) ?? "tool";
	const callId = textOrNull(part.callID) ?? textOrNull(part.id);
	addToolCall(
		session,
		name,
		state.input,
		callId,
		turnId,
		timestamp,
		textOrNull(state.status) ?? undefined,
	);
	if (state.output !== undefined || state.error !== undefined) {
		const output = state.output ?? state.error;
		addItem(session, {
			id: `tool-result-${callId ?? session.items.length}`,
			turnId,
			role: "tool",
			kind: "tool_result",
			phase: "intermediate",
			name,
			text: typeof output === "string" ? output : textFromContent(output),
			output,
			toolCallId: callId ?? undefined,
			status: textOrNull(state.status) ?? undefined,
			timestamp,
		});
	}
}

function addOpenCodeContent(
	session: TranscriptSession,
	id: string,
	content: unknown,
	role: TranscriptRole,
	turnId: string,
	timestamp: number | null,
	phase: TranscriptItem["phase"],
): void {
	const blocks = contentBlocks(content);
	const text = textFromContent(content);
	if (text)
		addItem(session, {
			id,
			usageId: role === "assistant" ? id : undefined,
			turnId,
			role,
			kind: role === "system" || role === "developer" ? "other" : "message",
			phase,
			text,
			timestamp,
		});
	for (const block of blocks) {
		if (typeOf(block) === "tool")
			openCodeToolPart(session, block, turnId, timestamp);
	}
}

function readOpenCodeV2(
	db: Database,
	sessions: TranscriptSession[],
	hasPartTable: boolean,
): Set<string> {
	const map = new Map(sessions.map((session) => [session.sessionId, session]));
	const currentTurnBySession = new Map<string, number>();
	const extraPartsByMessage = new Map<
		string,
		{ data: string; time_created: number }[]
	>();
	const partRows = hasPartTable
		? db
				.query<{ message_id: string; data: string; time_created: number }, []>(
					"SELECT message_id, data, time_created FROM part ORDER BY time_created, id",
				)
				.all()
		: [];
	for (const part of partRows) {
		const parts = extraPartsByMessage.get(part.message_id) ?? [];
		parts.push(part);
		extraPartsByMessage.set(part.message_id, parts);
	}
	const rows = db
		.query<
			{
				id: string;
				type: string;
				data: string;
				session_id: string;
				time_created: number;
				directory: string | null;
				title: string | null;
				started_at: number | null;
			},
			[]
		>(
			"SELECT sm.id, sm.type, sm.data, sm.session_id, sm.time_created, " +
				"s.directory, s.title, s.time_created AS started_at " +
				"FROM session_message AS sm JOIN session_v2 AS s ON s.id = sm.session_id " +
				"ORDER BY sm.session_id, sm.seq",
		)
		.all();
	for (const row of rows) {
		let session = map.get(row.session_id);
		if (!session) {
			session = newSession(
				"opencode",
				row.session_id,
				normalizedCwd(row.directory),
				timestampMs(row.started_at),
				textOrNull(row.title) ?? undefined,
			);
			map.set(row.session_id, session);
			sessions.push(session);
		}
		let data: Record<string, unknown>;
		try {
			data = objectOrEmpty(JSON.parse(row.data));
		} catch {
			continue;
		}
		const timestamp =
			timestampMs(objectOrEmpty(data.time).created) ?? row.time_created;
		let turn = currentTurnBySession.get(row.session_id) ?? 0;
		if (row.type === "user" && (textOrNull(data.text) || data.content)) {
			turn += 1;
			currentTurnBySession.set(row.session_id, turn);
		}
		const turnId = String(turn);
		if (row.type === "user") {
			const attachments = (extraPartsByMessage.get(row.id) ?? [])
				.map((part) => {
					try {
						return objectOrEmpty(JSON.parse(part.data));
					} catch {
						return {};
					}
				})
				.filter((part) => typeOf(part) === "file")
				.map((part) => {
					const name = textOrNull(part.filename) ?? textOrNull(part.name);
					return name ? `[File: ${name}]` : "[File attached]";
				});
			const text = cleanUserMessage(
				"opencode",
				[textOrNull(data.text) ?? textFromContent(data.content), ...attachments]
					.filter(Boolean)
					.join("\n"),
			);
			if (text)
				addItem(session, {
					id: row.id,
					turnId,
					role: "user",
					kind: "message",
					phase: "unknown",
					text,
					timestamp,
				});
			continue;
		}
		if (row.type === "assistant") {
			const finish = textOrNull(data.finish);
			addOpenCodeContent(
				session,
				row.id,
				data.content,
				"assistant",
				turnId,
				timestamp,
				finish === "stop"
					? "final"
					: finish === "tool-calls"
						? "intermediate"
						: "unknown",
			);
			continue;
		}
		if (row.type === "system" || row.type === "synthetic") {
			const text = textOrNull(data.text);
			if (text)
				addItem(session, {
					id: row.id,
					turnId,
					role: row.type === "system" ? "system" : "other",
					kind: "other",
					phase: "unknown",
					text,
					timestamp,
				});
		}
		for (const extra of extraPartsByMessage.get(row.id) ?? []) {
			let part: Record<string, unknown>;
			try {
				part = objectOrEmpty(JSON.parse(extra.data));
			} catch {
				continue;
			}
			const partType = typeOf(part);
			if (partType !== "patch" && partType !== "file" && partType !== "agent")
				continue;
			addItem(session, {
				id: `${row.id}-${partType}-${session.items.length}`,
				turnId,
				role: "other",
				kind: "other",
				phase: "unknown",
				text: `${partType}\n${JSON.stringify(part, null, 2)}`,
				timestamp: extra.time_created,
			});
		}
	}
	inferUnknownFinalMessages(sessions);
	return new Set(map.keys());
}

function readOpenCodeLegacy(
	db: Database,
	sessions: TranscriptSession[],
	knownSessions: Set<string>,
	hasPartTable: boolean,
): void {
	const rows = db
		.query<
			{
				id: string;
				data: string;
				session_id: string;
				time_created: number;
				directory: string | null;
				title: string | null;
				started_at: number | null;
			},
			[]
		>(
			"SELECT m.id, m.data, m.session_id, m.time_created, s.directory, s.title, " +
				"s.time_created AS started_at FROM message AS m " +
				"JOIN session AS s ON s.id = m.session_id ORDER BY m.session_id, m.time_created",
		)
		.all();
	const grouped = new Map<string, typeof rows>();
	for (const row of rows) {
		if (knownSessions.has(row.session_id)) continue;
		const list = grouped.get(row.session_id) ?? [];
		list.push(row);
		grouped.set(row.session_id, list);
	}
	for (const [sessionId, messages] of grouped) {
		const first = messages[0];
		if (!first) continue;
		const session = newSession(
			"opencode",
			sessionId,
			normalizedCwd(first.directory),
			timestampMs(first.started_at),
			textOrNull(first.title) ?? undefined,
		);
		let turn = 0;
		for (const message of messages) {
			let data: Record<string, unknown>;
			try {
				data = objectOrEmpty(JSON.parse(message.data));
			} catch {
				continue;
			}
			const role = textOrNull(data.role);
			const parts = (
				hasPartTable
					? db
							.query<{ data: string }, [string]>(
								"SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id",
							)
							.all(message.id)
					: []
			).map((part) => {
				try {
					return objectOrEmpty(JSON.parse(part.data));
				} catch {
					return {};
				}
			});
			const text = parts
				.filter((part) => !isReasoningType(typeOf(part)))
				.map((part) => {
					if (typeOf(part) === "file") {
						const name = textOrNull(part.filename) ?? textOrNull(part.name);
						return name ? `[File: ${name}]` : "[File attached]";
					}
					return textOrNull(part.text) ?? "";
				})
				.filter(Boolean)
				.join("\n");
			const timestamp =
				timestampMs(objectOrEmpty(data.time).created) ?? message.time_created;
			const userText =
				role === "user" ? cleanUserMessage("opencode", text) : text;
			if (role === "user" && userText) turn += 1;
			const turnId = String(turn);
			if (role === "user" && userText) {
				addItem(session, {
					id: message.id,
					turnId,
					role: "user",
					kind: "message",
					phase: "unknown",
					text: userText,
					timestamp,
				});
			} else if (role === "assistant") {
				const finish = textOrNull(data.finish);
				if (text)
					addItem(session, {
						id: message.id,
						usageId: message.id,
						turnId,
						role: "assistant",
						kind: "message",
						phase: finish === "stop" ? "final" : "unknown",
						text,
						timestamp,
					});
				for (const part of parts) {
					if (typeOf(part) === "tool")
						openCodeToolPart(session, part, turnId, timestamp);
				}
			} else if (role === "system" && text) {
				addItem(session, {
					id: message.id,
					turnId,
					role: "system",
					kind: "other",
					phase: "unknown",
					text,
					timestamp,
				});
			}
			for (const part of parts) {
				const partType = typeOf(part);
				if (partType !== "patch" && partType !== "file" && partType !== "agent")
					continue;
				addItem(session, {
					id: `${message.id}-${partType}-${session.items.length}`,
					turnId,
					role: "other",
					kind: "other",
					phase: "unknown",
					text: `${partType}\n${JSON.stringify(part, null, 2)}`,
					timestamp,
				});
			}
		}
		inferFinalMessages(session);
		sessions.push(session);
	}
}

function readOpenCodeTranscripts(
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const explicitDb = process.env.OPENCODE_DB
		? path.resolve(expandHome(process.env.OPENCODE_DB))
		: null;
	const dataDir = process.env.OPENCODE_DATA_DIR
		? path.resolve(expandHome(process.env.OPENCODE_DATA_DIR))
		: path.join(homeDir, ".local/share/opencode");
	let dbPaths = explicitDb ? [explicitDb] : [];
	if (!explicitDb) {
		try {
			dbPaths = readdirSync(dataDir)
				.filter((name) => /^opencode(?:-[^/]*)?\.db$/u.test(name))
				.map((name) => path.join(dataDir, name));
		} catch {
			// OpenCode may not be installed.
		}
	}
	dbPaths = dbPaths
		.filter(existsSync)
		.filter((dbPath) => !targetFiles || targetFiles.has(dbPath));
	const result: TranscriptReadResult = {
		harness: "opencode",
		available: dbPaths.length > 0,
		sessions: [],
		warnings: [],
	};
	const seen = new Set<string>();
	for (const dbPath of dbPaths) {
		try {
			const db = openReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(db);
				let known = new Set<string>();
				if (tables.has("session_v2") && tables.has("session_message"))
					known = readOpenCodeV2(db, result.sessions, tables.has("part"));
				if (tables.has("session") && tables.has("message"))
					readOpenCodeLegacy(db, result.sessions, known, tables.has("part"));
			} finally {
				db.close();
			}
		} catch (error) {
			result.warnings.push(
				`OpenCode: failed to read ${dbPath} (${String(error)})`,
			);
		}
	}
	result.sessions = result.sessions.filter((session) => {
		const key = `${session.sessionId}:${session.harness}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return result;
}

function readAntigravityTranscripts(
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const roots = process.env.ANTIGRAVITY_HOME
		? [path.resolve(expandHome(process.env.ANTIGRAVITY_HOME))]
		: [
				path.join(homeDir, ".gemini/antigravity"),
				path.join(homeDir, ".antigravity"),
			];
	const existingRoots = roots.filter((root) =>
		existsSync(path.join(root, "conversations")),
	);
	const result: TranscriptReadResult = {
		harness: "antigravity",
		available: existingRoots.length > 0,
		sessions: [],
		warnings: [],
	};
	if (!result.available) return result;

	const seen = new Set<string>();
	for (const root of existingRoots) {
		const summaries = loadSummaries(root);
		const convFiles = walkFiles(
			path.join(root, "conversations"),
			(_filePath, name) => name.endsWith(".db"),
		).filter((filePath) => !targetFiles || targetFiles.has(filePath));

		for (const filePath of convFiles) {
			const sessionId = path.basename(filePath, ".db");
			if (seen.has(sessionId)) continue;
			seen.add(sessionId);

			try {
				const { db, cleanup } = openSafeReadonlyDatabase(filePath);
				try {
					let cwd: string | null = summaries.get(sessionId)?.cwd ?? null;
					let startedAt: number | null = null;
					const title = summaries.get(sessionId)?.title ?? undefined;

					try {
						const metaBlobRow = db
							.query<{ data: Uint8Array }, []>(
								"SELECT data FROM trajectory_metadata_blob LIMIT 1",
							)
							.get();
						if (metaBlobRow?.data) {
							const trajFields = decodeProto(metaBlobRow.data);
							if (!cwd) {
								const rawUri =
									protoText(trajFields.find((f) => f.field === 7)) ??
									protoText(
										protoSub(trajFields.find((f) => f.field === 1)).find(
											(f) => f.field === 1,
										),
									);
								cwd = parseWorkspaceUri(rawUri) ?? cwd;
							}
							const tsFields = protoSub(trajFields.find((f) => f.field === 2));
							const sec = tsFields.find(
								(f) => f.field === 1 && f.wire === 0,
							)?.val;
							const nano =
								tsFields.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
							if (sec) startedAt = sec * 1000 + Math.floor(nano / 1e6);
						}
					} catch {}

					const session = newSession(
						"antigravity",
						sessionId,
						cwd,
						startedAt,
						title,
					);

					const steps = db
						.query<
							{
								idx: number;
								step_type: number;
								status: number;
								metadata: Uint8Array | null;
								step_payload: Uint8Array | null;
							},
							[]
						>(
							"SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx",
						)
						.all();

					let currentTurn = 0;
					for (let i = 0; i < steps.length; i++) {
						const step = steps[i];
						if (!step?.step_payload) continue;
						const stepMeta = step.metadata ? decodeProto(step.metadata) : [];
						const tsFields = protoSub(stepMeta.find((f) => f.field === 1));
						const sec = tsFields.find(
							(f) => f.field === 1 && f.wire === 0,
						)?.val;
						const nano =
							tsFields.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
						const timestamp = sec
							? sec * 1000 + Math.floor(nano / 1e6)
							: startedAt;

						if (step.step_type === 14) {
							currentTurn += 1;
							const turnId = String(currentTurn);
							const payload = decodeProto(step.step_payload);
							const f19 = protoSub(payload.find((f) => f.field === 19));
							const text = cleanUserMessage(
								"antigravity",
								protoText(f19.find((f) => f.field === 2)) ?? "",
							);
							if (text) {
								addItem(session, {
									id: `${sessionId}:user-${step.idx}`,
									turnId,
									role: "user",
									kind: "message",
									phase: "unknown",
									text,
									timestamp,
								});
							}
							continue;
						}

						if (step.step_type === 15) {
							const turnId = String(currentTurn);
							const payload = decodeProto(step.step_payload);
							const f20 = protoSub(payload.find((f) => f.field === 20));
							const text = protoText(f20.find((f) => f.field === 1));
							const thinking = protoText(f20.find((f) => f.field === 3));
							const hasToolCalls =
								f20.some((f) => f.field === 7) ||
								steps[i + 1]?.step_type === 132;

							const f5 = protoSub(payload.find((f) => f.field === 5));
							const f9 = protoSub(f5.find((f) => f.field === 9));
							const requestId = protoText(f9.find((f) => f.field === 11));

							if (thinking) {
								addItem(session, {
									id: `${sessionId}:assistant-${step.idx}-thinking`,
									turnId,
									role: "other",
									kind: "other",
									phase: "intermediate",
									text: `Thinking:\n${thinking}`,
									timestamp,
								});
							}

							if (text) {
								addItem(session, {
									id: `${sessionId}:assistant-${step.idx}`,
									usageId: requestId ?? undefined,
									turnId,
									role: "assistant",
									kind: "message",
									phase: hasToolCalls ? "intermediate" : "unknown",
									text,
									timestamp,
								});
							}
							continue;
						}

						if (step.step_type === 132) {
							const turnId = String(currentTurn);
							const payload = decodeProto(step.step_payload);
							const f5 = protoSub(payload.find((f) => f.field === 5));
							const f4 = protoSub(f5.find((f) => f.field === 4));
							const toolName =
								protoText(f4.find((f) => f.field === 2)) ?? "tool";
							const callId = protoText(f4.find((f) => f.field === 1));
							const rawInput = protoText(f4.find((f) => f.field === 3));
							let input: unknown = rawInput;
							if (rawInput) {
								try {
									input = JSON.parse(rawInput);
								} catch {}
							}

							const f156 = protoSub(payload.find((f) => f.field === 156));
							const f2 = protoSub(f156.find((f) => f.field === 2));
							const output = protoText(f2.find((f) => f.field === 1));

							addItem(session, {
								id: callId ?? `${sessionId}:tool-${step.idx}`,
								turnId,
								role: "tool",
								kind: "tool_call",
								phase: "intermediate",
								name: toolName,
								input,
								toolCallId: callId ?? undefined,
								category: categoryForTool(toolName),
								timestamp,
							});

							if (output !== null && output !== undefined) {
								addItem(session, {
									id: `${callId ?? `${sessionId}:tool-${step.idx}`}-result`,
									turnId,
									role: "tool",
									kind: "tool_result",
									phase: "intermediate",
									name: toolName,
									output,
									text: output,
									toolCallId: callId ?? undefined,
									timestamp,
								});
							}
						}
					}

					inferFinalMessages(session);
					result.sessions.push(session);
				} finally {
					cleanup();
				}
			} catch (error) {
				result.warnings.push(
					`Antigravity: failed to read ${filePath} (${String(error)})`,
				);
			}
		}
	}
	return result;
}

export function readTranscriptSources(
	harnesses: readonly HarnessName[],
	targets?: Partial<Record<HarnessName, ReadonlySet<string>>>,
): TranscriptReadResult[] {
	const readers: Record<
		HarnessName,
		(files?: ReadonlySet<string>) => TranscriptReadResult
	> = {
		codex: readCodexTranscripts,
		dsh: readDshTranscripts,
		opencode: readOpenCodeTranscripts,
		commandcode: readCommandCodeTranscripts,
		antigravity: readAntigravityTranscripts,
	};
	return harnesses.map((harness) => readers[harness](targets?.[harness]));
}

export function filterTranscriptSessions(
	sessions: TranscriptSession[],
	filters: TranscriptFilters,
): TranscriptSession[] {
	return sessions.filter((session) => {
		if (!filters.harnesses.has(session.harness)) return false;
		if (filters.projects) {
			const cwd = normalizedCwd(session.cwd);
			if (!cwd || !filters.projects.has(cwd)) return false;
		}
		if (filters.date !== undefined) {
			return localDate(session.startedAt) === filters.date;
		}
		if (filters.since === undefined && filters.until === undefined) return true;
		const startedAt = session.startedAt;
		if (startedAt === null || !Number.isFinite(startedAt)) return false;
		if (filters.since !== undefined && startedAt < filters.since) return false;
		if (filters.until !== undefined && startedAt >= filters.until) return false;
		return true;
	});
}

export function shaSegment(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
