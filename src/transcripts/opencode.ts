import type { Database } from "bun:sqlite";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../platform/paths";
import { openSafeReadonlyDatabase, tablesIn } from "../platform/sqlite";
import { getOpenCodeDbPaths } from "../providers/opencode/discovery";
import { normalizedCwd, objectOrEmpty, textOrNull, timestampMs } from "../util";
import {
	addItem,
	addToolCall,
	cleanUserMessage,
	contentBlocks,
	inferFinalMessages,
	inferUnknownFinalMessages,
	isReasoningType,
	newSession,
	type TranscriptItem,
	type TranscriptReadResult,
	type TranscriptRole,
	type TranscriptSession,
	textFromContent,
	typeOf,
} from "./shared";

function finishPhase(finish: string | null): TranscriptItem["phase"] {
	if (finish === "stop") return "final";
	if (finish === "tool-calls") return "intermediate";
	return "unknown";
}

function openCodeErrorText(error: unknown): string {
	if (typeof error === "string") return error;
	const obj = objectOrEmpty(error);
	return textOrNull(obj.message) ?? textFromContent(error);
}

function openCodeToolPart(
	session: TranscriptSession,
	part: Record<string, unknown>,
	turnId: string,
	timestamp: number | null,
): void {
	const state = objectOrEmpty(part.state);
	const name = textOrNull(part.tool) ?? textOrNull(part.name) ?? "tool";
	const callId = textOrNull(part.callID) ?? textOrNull(part.id);
	const stateMeta = objectOrEmpty(state.metadata);
	const exitCode =
		typeof stateMeta.exit === "number" && Number.isFinite(stateMeta.exit)
			? stateMeta.exit
			: undefined;
	const timedOut = stateMeta.timeout === true || stateMeta.status === "timeout";
	const interrupted =
		stateMeta.interrupted === true || stateMeta.status === "killed";
	const rawStatus = textOrNull(state.status) ?? undefined;
	let status = rawStatus;
	if (rawStatus === "completed" && exitCode !== undefined && exitCode !== 0) {
		status = "error";
	} else if (rawStatus === "completed" && timedOut) {
		status = "error";
	} else if (rawStatus === "completed" && interrupted) {
		status = "cancelled";
	}

	const stateTime = objectOrEmpty(state.time);
	const startTs = timestampMs(stateTime.start) ?? timestamp;
	const endTs = timestampMs(stateTime.end) ?? startTs;

	addToolCall(session, name, state.input, callId, turnId, startTs, status);

	const rawContent = state.output ?? state.content;
	if (rawContent !== undefined || state.error !== undefined) {
		const rawOutput = rawContent ?? state.error;
		const text =
			state.error !== undefined && rawContent === undefined
				? openCodeErrorText(state.error)
				: typeof rawOutput === "string"
					? rawOutput
					: textFromContent(rawOutput);
		const needsMetadata =
			(exitCode !== undefined && exitCode !== 0) || timedOut || interrupted;
		const output = needsMetadata
			? { output: text || rawOutput, metadata: stateMeta }
			: rawOutput;
		addItem(session, {
			id: `tool-result-${callId ?? session.items.length}`,
			turnId,
			role: "tool",
			kind: "tool_result",
			phase: "intermediate",
			name,
			text,
			output,
			toolCallId: callId ?? undefined,
			status,
			timestamp: endTs,
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
	extraParts: Record<string, unknown>[] = [],
): void {
	const blocks = contentBlocks(content);
	const inlineText = textFromContent(content);
	const extraText = extraParts
		.filter((part) => typeOf(part) === "text")
		.map((part) => textOrNull(part.text) ?? "")
		.filter(Boolean)
		.join("\n");
	const text = [inlineText, extraText].filter(Boolean).join("\n");
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
	for (const block of [...blocks, ...extraParts]) {
		if (typeOf(block) === "tool")
			openCodeToolPart(session, block, turnId, timestamp);
	}
}

function readOpenCodeV2(
	db: Database,
	sessions: TranscriptSession[],
	hasPartTable: boolean,
	hasSessionPartTable: boolean,
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
	const sessionPartsByMessage = new Map<string, Record<string, unknown>[]>();
	if (hasSessionPartTable) {
		for (const row of db
			.query<{ message_id: string; data: string }, []>(
				"SELECT message_id, data FROM session_part ORDER BY ordinal, time_created",
			)
			.all()) {
			try {
				const parsed = objectOrEmpty(JSON.parse(row.data));
				const list = sessionPartsByMessage.get(row.message_id) ?? [];
				list.push(parsed);
				sessionPartsByMessage.set(row.message_id, list);
			} catch {
				// Ignore malformed part row.
			}
		}
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
			const inlineBlocks = contentBlocks(data.content);
			const sessionParts = sessionPartsByMessage.get(row.id) ?? [];
			const extraParts = inlineBlocks.length === 0 ? sessionParts : [];
			addOpenCodeContent(
				session,
				row.id,
				data.content,
				"assistant",
				turnId,
				timestamp,
				finishPhase(finish),
				extraParts,
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

export function readOpenCodeTranscripts(
	targetFiles?: ReadonlySet<string>,
	paths: PlatformPathService = defaultPlatformPathService,
): TranscriptReadResult {
	const dbPaths = getOpenCodeDbPaths(paths).filter(
		(dbPath) => !targetFiles || targetFiles.has(dbPath),
	);
	const result: TranscriptReadResult = {
		harness: "opencode",
		available: dbPaths.length > 0,
		sessions: [],
		warnings: [],
	};
	const seen = new Set<string>();
	for (const dbPath of dbPaths) {
		try {
			const handle = openSafeReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(handle.db);
				let known = new Set<string>();
				if (tables.has("session_v2") && tables.has("session_message"))
					known = readOpenCodeV2(
						handle.db,
						result.sessions,
						tables.has("part"),
						tables.has("session_part"),
					);
				if (tables.has("session") && tables.has("message"))
					readOpenCodeLegacy(
						handle.db,
						result.sessions,
						known,
						tables.has("part"),
					);
			} finally {
				handle.close();
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
