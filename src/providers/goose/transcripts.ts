import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	addItem,
	inferFinalMessages,
	newSession,
	openReadonlyDatabase,
	tablesIn,
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

export function readGooseSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const { dbFiles, legacyFiles } = getGooseLocations(paths);

	// 1. Try SQLite databases
	for (const dbPath of dbFiles) {
		try {
			const db = openReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(db);
				if (!tables.has("sessions") || !tables.has("messages")) continue;

				const sess = db
					.query<
						{
							id: string;
							description: string | null;
							working_dir: string | null;
							created_at: number | null;
						},
						[string]
					>(
						"SELECT id, description, working_dir, created_at FROM sessions WHERE id = ?",
					)
					.get(sessionId);

				if (!sess) continue;

				const messages = db
					.query<
						{
							id: number | string;
							session_id: string;
							role: string;
							content: string | null;
							created_at: number | null;
						},
						[string]
					>(
						"SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
					)
					.all(sessionId);

				const session = newSession(
					"goose",
					sess.id,
					normalizedCwd(sess.working_dir),
					sess.created_at ?? Date.now(),
					sess.description ?? undefined,
				);

				let turnIndex = 0;
				for (const msg of messages) {
					const timestamp = msg.created_at ?? sess.created_at ?? Date.now();
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
			} finally {
				db.close();
			}
		} catch {
			// skip
		}
	}

	// 2. Try legacy JSONL files
	for (const jsonlPath of legacyFiles) {
		if (!existsSync(jsonlPath)) continue;
		try {
			const text = readFileSync(jsonlPath, "utf8");
			const rows = parseJsonl(text);
			const defaultSessionId = path.basename(jsonlPath, ".jsonl");

			const matches = rows.filter((r) => {
				const row = objectOrEmpty(r);
				const id =
					textOrNull(row.sessionId) ?? textOrNull(row.id) ?? defaultSessionId;
				return id === sessionId;
			});

			if (matches.length === 0 && defaultSessionId !== sessionId) continue;

			const session = newSession(
				"goose",
				sessionId,
				null,
				Date.now(),
				`Legacy Goose session ${sessionId}`,
			);

			let turnIndex = 0;
			for (let i = 0; i < matches.length; i++) {
				const row = objectOrEmpty(matches[i]);
				const role =
					textOrNull(row.role) ?? textOrNull(row.type) ?? "assistant";
				const content = textOrNull(row.content) ?? textOrNull(row.text) ?? "";
				const timestamp =
					timestampMs(row.created_at ?? row.timestamp) ?? Date.now();

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
		} catch {
			// skip
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

	// From DBs
	for (const dbPath of dbFiles) {
		if (targetFiles && !targetFiles.has(dbPath)) continue;
		try {
			const db = openReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(db);
				if (tables.has("sessions")) {
					const ids = db
						.query<{ id: string }, []>("SELECT id FROM sessions")
						.all();
					for (const row of ids) {
						if (row.id) {
							const sess = readGooseSingleTranscriptSync(paths, row.id);
							if (sess) sessions.push(sess);
						}
					}
				}
			} finally {
				db.close();
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
		const sess = readGooseSingleTranscriptSync(paths, fileSessionId);
		if (sess) sessions.push(sess);
	}

	return {
		harness: "goose",
		available: dbFiles.length > 0 || legacyFiles.length > 0,
		sessions,
		warnings,
	};
}
