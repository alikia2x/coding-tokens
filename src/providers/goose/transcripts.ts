import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase, tablesIn } from "../../platform/sqlite";
import {
	addItem,
	inferFinalMessages,
	newSession,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import {
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
} from "../../util";
import { getGooseLocations } from "./discovery";

interface GooseDbSessionRow {
	id: string;
	description: string | null;
	working_dir: string | null;
	created_at: number | null;
}

interface GooseDbMessageRow {
	id: number | string;
	session_id: string;
	role: string;
	content: string | null;
	created_at: number | null;
}

function buildGooseDbSession(
	sess: GooseDbSessionRow,
	messages: GooseDbMessageRow[],
): TranscriptSession {
	const session = newSession(
		"goose",
		sess.id,
		normalizedCwd(sess.working_dir),
		timestampMs(sess.created_at),
		sess.description ?? undefined,
	);

	let turnIndex = 0;
	for (const msg of messages) {
		const timestamp = timestampMs(msg.created_at ?? sess.created_at);
		const role = msg.role.toLowerCase();

		if (role === "user") {
			turnIndex++;
			addItem(session, {
				id: `goose-msg-${msg.id}`,
				turnId: `turn-${turnIndex}`,
				role: "user",
				kind: "message",
				phase: "final",
				text: msg.content ?? "",
				timestamp,
			});
		} else if (role === "assistant") {
			addItem(session, {
				id: `goose-msg-${msg.id}`,
				turnId: `turn-${turnIndex}`,
				role: "assistant",
				kind: "message",
				phase: "unknown",
				text: msg.content ?? "",
				timestamp,
			});
		} else if (role === "tool") {
			addItem(session, {
				id: `goose-tool-${msg.id}`,
				turnId: `turn-${turnIndex}`,
				role: "tool",
				kind: "tool_result",
				phase: "intermediate",
				output: msg.content ?? "",
				timestamp,
			});
		}
	}

	inferFinalMessages(session);
	return session;
}

function buildGooseLegacySession(
	jsonlPath: string,
	targetSessionId: string,
): TranscriptSession | null {
	if (!existsSync(jsonlPath)) return null;
	const text = readFileSync(jsonlPath, "utf8");
	const rows = parseJsonl(text);
	const defaultSessionId = path.basename(jsonlPath, ".jsonl");

	const matches = rows.filter((r) => {
		const row = objectOrEmpty(r);
		const id =
			textOrNull(row.sessionId) ?? textOrNull(row.id) ?? defaultSessionId;
		return id === targetSessionId;
	});

	if (matches.length === 0 && defaultSessionId !== targetSessionId) return null;

	const firstRow = matches.length > 0 ? objectOrEmpty(matches[0]) : {};
	const session = newSession(
		"goose",
		targetSessionId,
		normalizedCwd(firstRow.working_dir ?? firstRow.cwd),
		timestampMs(firstRow.created_at ?? firstRow.timestamp),
		`Legacy Goose session ${targetSessionId}`,
	);

	let turnIndex = 0;
	for (let i = 0; i < matches.length; i++) {
		const row = objectOrEmpty(matches[i]);
		const role = textOrNull(row.role) ?? textOrNull(row.type) ?? "assistant";
		const content = textOrNull(row.content) ?? textOrNull(row.text) ?? "";
		const timestamp = timestampMs(row.created_at ?? row.timestamp);

		if (role === "user") {
			turnIndex++;
			addItem(session, {
				id: `legacy-${i}`,
				turnId: `turn-${turnIndex}`,
				role: "user",
				kind: "message",
				phase: "final",
				text: content,
				timestamp,
			});
		} else if (role === "assistant") {
			addItem(session, {
				id: `legacy-${i}`,
				turnId: `turn-${turnIndex}`,
				role: "assistant",
				kind: "message",
				phase: "unknown",
				text: content,
				timestamp,
			});
		}
	}

	inferFinalMessages(session);
	return session;
}

export function readGooseSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const { dbFiles, legacyFiles } = getGooseLocations(paths);

	// 1. Try SQLite databases
	for (const dbPath of dbFiles) {
		try {
			const handle = openSafeReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(handle.db);
				if (!tables.has("sessions") || !tables.has("messages")) continue;

				const sess = handle.db
					.query<GooseDbSessionRow, [string]>(
						"SELECT id, description, working_dir, created_at FROM sessions WHERE id = ?",
					)
					.get(sessionId);

				if (!sess) continue;

				const messages = handle.db
					.query<GooseDbMessageRow, [string]>(
						"SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
					)
					.all(sessionId);

				return buildGooseDbSession(sess, messages);
			} finally {
				handle.close();
			}
		} catch {
			// continue checking remaining DB files
		}
	}

	// 2. Try legacy JSONL files
	for (const jsonlPath of legacyFiles) {
		try {
			const session = buildGooseLegacySession(jsonlPath, sessionId);
			if (session) return session;
		} catch {
			// continue checking remaining legacy files
		}
	}

	return null;
}

export function readGooseTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const { dbFiles, legacyFiles } = getGooseLocations(paths);
	const sessions: TranscriptSession[] = [];
	const warnings: string[] = [];
	const seenSessionIds = new Set<string>();

	// From DBs (single pass per DB)
	for (const dbPath of dbFiles) {
		if (targetFiles && !targetFiles.has(dbPath)) continue;
		try {
			const handle = openSafeReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(handle.db);
				if (!tables.has("sessions") || !tables.has("messages")) continue;

				const dbSessions = handle.db
					.query<GooseDbSessionRow, []>(
						"SELECT id, description, working_dir, created_at FROM sessions",
					)
					.all();
				const allMessages = handle.db
					.query<GooseDbMessageRow, []>(
						"SELECT id, session_id, role, content, created_at FROM messages ORDER BY id ASC",
					)
					.all();
				const messagesBySession = new Map<string, GooseDbMessageRow[]>();
				for (const msg of allMessages) {
					const list = messagesBySession.get(msg.session_id) ?? [];
					list.push(msg);
					messagesBySession.set(msg.session_id, list);
				}

				for (const sess of dbSessions) {
					if (!sess.id || seenSessionIds.has(sess.id)) continue;
					seenSessionIds.add(sess.id);
					sessions.push(
						buildGooseDbSession(sess, messagesBySession.get(sess.id) ?? []),
					);
				}
			} finally {
				handle.close();
			}
		} catch (err) {
			warnings.push(
				`Goose: failed to read transcripts from DB ${dbPath} (${String(err)})`,
			);
		}
	}

	// From Legacy Files
	for (const jsonlPath of legacyFiles) {
		if (targetFiles && !targetFiles.has(jsonlPath)) continue;
		const fileSessionId = path.basename(jsonlPath, ".jsonl");
		if (seenSessionIds.has(fileSessionId)) continue;
		try {
			const sess = buildGooseLegacySession(jsonlPath, fileSessionId);
			if (sess) {
				seenSessionIds.add(fileSessionId);
				sessions.push(sess);
			}
		} catch (err) {
			warnings.push(
				`Goose: failed to read legacy transcript ${jsonlPath} (${String(err)})`,
			);
		}
	}

	return {
		harness: "goose",
		available: dbFiles.length > 0 || legacyFiles.length > 0,
		sessions,
		warnings,
	};
}
