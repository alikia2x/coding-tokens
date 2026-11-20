import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase } from "../../platform/sqlite";
import {
	addItem,
	addToolCall,
	inferFinalMessages,
	newSession,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { objectOrEmpty, textOrNull, timestampMs } from "../../util";
import {
	buildCursorWorkspaceMap,
	discoverCursorSessions,
	getCursorGlobalDbPath,
	getCursorRoots,
	type WorkspaceMapping,
} from "./discovery";
import type { CursorBubble, CursorComposerData } from "./types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildCursorComposerTranscript(
	sessionId: string,
	data: CursorComposerData,
	dbBubbles: CursorBubble[],
	wsInfo: WorkspaceMapping | undefined,
): TranscriptSession {
	const bubbles: CursorBubble[] = [];
	if (data.conversationMap) {
		if (Array.isArray(data.conversationMap)) {
			bubbles.push(...data.conversationMap);
		} else if (typeof data.conversationMap === "object") {
			bubbles.push(...Object.values(data.conversationMap));
		}
	}
	if (Array.isArray(data.bubbles)) {
		bubbles.push(...data.bubbles);
	}
	if (dbBubbles.length > 0) {
		const existingIds = new Set(bubbles.map((b) => b.id).filter(Boolean));
		for (const b of dbBubbles) {
			if (!b.id || !existingIds.has(b.id)) {
				bubbles.push(b);
			}
		}
	}

	const composerCreatedAt = timestampMs(data.createdAt);
	const session = newSession(
		"cursor",
		sessionId,
		wsInfo?.cwd ?? null,
		composerCreatedAt,
		data.text?.slice(0, 100) || "Cursor Composer Session",
	);

	let currentTurnId = `turn-${sessionId}-0`;
	let turnNum = 0;

	for (const [i, bubble] of bubbles.entries()) {
		if (!bubble) continue;
		const isUser =
			bubble.type === "user" ||
			bubble.role === "user" ||
			bubble.type === "human";
		const isAi =
			bubble.type === "ai" ||
			bubble.type === "agent" ||
			bubble.role === "assistant";
		const ts =
			timestampMs(bubble.timestamp) ??
			timestampMs(bubble.createdAt) ??
			composerCreatedAt;

		if (isUser) {
			turnNum++;
			currentTurnId = `turn-${sessionId}-${turnNum}`;
			addItem(session, {
				id: bubble.id ?? `msg-user-${i}`,
				turnId: currentTurnId,
				role: "user",
				kind: "message",
				phase: "final",
				text: bubble.text ?? bubble.rawText ?? "",
				timestamp: ts,
			});
		} else if (isAi) {
			if (Array.isArray(bubble.toolCalls)) {
				for (const [t, tc] of bubble.toolCalls.entries()) {
					if (!tc) continue;
					addToolCall(
						session,
						tc.name ?? "cursor_tool",
						tc.input,
						tc.callId ?? `tool-${i}-${t}`,
						currentTurnId,
						ts,
						tc.status,
					);
				}
			}

			if (bubble.text || bubble.rawText) {
				addItem(session, {
					id: bubble.id ?? `msg-ai-${i}`,
					turnId: currentTurnId,
					role: "assistant",
					kind: "message",
					phase: "final",
					text: bubble.text ?? bubble.rawText ?? "",
					timestamp: ts,
				});
			}
		}
	}

	if (session.items.length === 0 && data.text) {
		addItem(session, {
			id: "msg-user-init",
			turnId: currentTurnId,
			role: "user",
			kind: "message",
			phase: "final",
			text: data.text,
			timestamp: composerCreatedAt,
		});
	}

	inferFinalMessages(session);
	return session;
}

function buildCursorChatJsonTranscript(
	chatFile: string,
	sessionId: string,
	wsInfo: WorkspaceMapping | undefined,
): TranscriptSession | null {
	const parsed: unknown = JSON.parse(readFileSync(chatFile, "utf-8"));
	if (!isPlainRecord(parsed)) return null;
	const content = parsed;
	const session = newSession(
		"cursor",
		sessionId,
		wsInfo?.cwd ?? null,
		timestampMs(content.creationDate),
		textOrNull(content.title) ?? "Cursor Chat Session",
	);

	const requests = Array.isArray(content.requests) ? content.requests : [];
	for (const [i, rawReq] of requests.entries()) {
		const req = objectOrEmpty(rawReq);
		if (Object.keys(req).length === 0) continue;
		const turnId = `turn-${sessionId}-${i + 1}`;
		const ts = timestampMs(req.timestamp);
		const msgObj = objectOrEmpty(req.message);
		const userText =
			typeof req.message === "string"
				? req.message
				: (textOrNull(msgObj.text) ?? "");
		const aiText =
			typeof req.response === "string"
				? req.response
				: Array.isArray(req.response)
					? req.response
							.map((r) => textOrNull(objectOrEmpty(r).value) ?? "")
							.join("\n")
					: (textOrNull(objectOrEmpty(req.response).value) ?? "");

		if (userText) {
			addItem(session, {
				id: `msg-user-${i}`,
				turnId,
				role: "user",
				kind: "message",
				phase: "final",
				text: userText,
				timestamp: ts,
			});
		}

		if (aiText) {
			addItem(session, {
				id: `msg-ai-${i}`,
				turnId,
				role: "assistant",
				kind: "message",
				phase: "final",
				text: aiText,
				timestamp: ts,
			});
		}
	}

	inferFinalMessages(session);
	return session;
}

export async function readCursorTranscript(
	paths: PlatformPathService,
	sessionId: string,
): Promise<TranscriptSession | null> {
	const { workspaceStorage } = getCursorRoots(paths);
	const globalDbPath = getCursorGlobalDbPath(paths);
	const wsMap = buildCursorWorkspaceMap(workspaceStorage);
	const wsInfo = wsMap.get(sessionId);

	if (globalDbPath) {
		try {
			const handle = openSafeReadonlyDatabase(globalDbPath);
			try {
				const row = handle.db
					.query<{ key: string; value: string }, [string]>(
						"SELECT key, value FROM cursorDiskKV WHERE key = ?",
					)
					.get(`composerData:${sessionId}`);

				if (row?.value) {
					const parsed: unknown = JSON.parse(row.value);
					if (isPlainRecord(parsed)) {
						let dbBubbles: CursorBubble[] = [];
						try {
							const bRows = handle.db
								.query<{ key: string; value: string }, [string]>(
									"SELECT key, value FROM cursorDiskKV WHERE key LIKE ?",
								)
								.all(`bubbleId:${sessionId}:%`);
							dbBubbles = bRows
								.map((r) => {
									try {
										const b: unknown = JSON.parse(r.value);
										return isPlainRecord(b) ? (b as CursorBubble) : null;
									} catch {
										return null;
									}
								})
								.filter((b): b is CursorBubble => b !== null);
						} catch {
							// Older Cursor DBs store bubbles inline.
						}

						return buildCursorComposerTranscript(
							sessionId,
							parsed as unknown as CursorComposerData,
							dbBubbles,
							wsInfo,
						);
					}
				}
			} finally {
				handle.close();
			}
		} catch {
			// Fall through to workspace chatSessions if global DB query fails.
		}
	}

	if (existsSync(workspaceStorage)) {
		try {
			for (const entry of readdirSync(workspaceStorage)) {
				const chatFile = path.join(
					workspaceStorage,
					entry,
					"chatSessions",
					`${sessionId}.json`,
				);
				if (existsSync(chatFile)) {
					return buildCursorChatJsonTranscript(chatFile, sessionId, wsInfo);
				}
			}
		} catch {
			// Ignore unreadable workspaceStorage subdirectories.
		}
	}

	return null;
}

export async function readCursorTranscripts(
	paths: PlatformPathService,
	targetFiles?: ReadonlySet<string>,
): Promise<TranscriptReadResult> {
	const result: TranscriptReadResult = {
		harness: "cursor",
		available: false,
		sessions: [],
		warnings: [],
	};

	try {
		const { workspaceStorage } = getCursorRoots(paths);
		const globalDbPath = getCursorGlobalDbPath(paths);
		const discovery = await discoverCursorSessions(paths);
		if (discovery.length > 0) {
			result.available = true;
		}
		if (discovery.length === 0) return result;

		const wsMap = buildCursorWorkspaceMap(workspaceStorage);
		const targetItems = discovery.filter(
			(item) => !targetFiles || targetFiles.has(item.filePath),
		);
		if (targetItems.length === 0) return result;

		const composerMap = new Map<string, CursorComposerData>();
		const bubbleMapByComposer = new Map<string, CursorBubble[]>();

		if (
			globalDbPath &&
			targetItems.some((item) => item.filePath === globalDbPath)
		) {
			try {
				const handle = openSafeReadonlyDatabase(globalDbPath);
				try {
					const composerRows = handle.db
						.query<{ key: string; value: string }, []>(
							"SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
						)
						.all();
					for (const row of composerRows) {
						try {
							const parsed: unknown = JSON.parse(row.value);
							if (!isPlainRecord(parsed)) continue;
							const cId =
								textOrNull(parsed.composerId) ??
								row.key.replace(/^composerData:/, "");
							if (cId) {
								composerMap.set(cId, parsed as unknown as CursorComposerData);
							}
						} catch {
							// Skip malformed composerData entry.
						}
					}

					try {
						const bubbleRows = handle.db
							.query<{ key: string; value: string }, []>(
								"SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'",
							)
							.all();
						for (const bRow of bubbleRows) {
							const cId = bRow.key.split(":")[1];
							if (!cId) continue;
							try {
								const parsed: unknown = JSON.parse(bRow.value);
								if (!isPlainRecord(parsed)) continue;
								const list = bubbleMapByComposer.get(cId) ?? [];
								list.push(parsed as CursorBubble);
								bubbleMapByComposer.set(cId, list);
							} catch {
								// Skip malformed bubble entry.
							}
						}
					} catch {
						// Older Cursor DBs store bubbles inline.
					}
				} finally {
					handle.close();
				}
			} catch (e) {
				result.warnings.push(`Failed to read Cursor global DB: ${e}`);
			}
		}

		for (const item of targetItems) {
			const composerData = composerMap.get(item.sessionId);
			if (composerData) {
				result.sessions.push(
					buildCursorComposerTranscript(
						item.sessionId,
						composerData,
						bubbleMapByComposer.get(item.sessionId) ?? [],
						wsMap.get(item.sessionId),
					),
				);
				continue;
			}

			if (item.filePath.endsWith(".json") && existsSync(item.filePath)) {
				try {
					const session = buildCursorChatJsonTranscript(
						item.filePath,
						item.sessionId,
						wsMap.get(item.sessionId),
					);
					if (session) result.sessions.push(session);
				} catch (e) {
					result.warnings.push(
						`Failed to read Cursor chat file ${item.filePath}: ${e}`,
					);
				}
			}
		}
	} catch (e) {
		result.warnings.push(`Failed to read Cursor transcripts: ${e}`);
	}

	return result;
}
