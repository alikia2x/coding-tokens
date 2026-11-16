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
import {
	buildCursorWorkspaceMap,
	discoverCursorSessions,
	getCursorGlobalDbPath,
	getCursorRoots,
} from "./discovery";
import type { CursorBubble, CursorComposerData } from "./types";

export async function readCursorTranscript(
	paths: PlatformPathService,
	sessionId: string,
): Promise<TranscriptSession | null> {
	const { workspaceStorage } = getCursorRoots(paths);
	const globalDbPath = getCursorGlobalDbPath(paths);
	const wsMap = buildCursorWorkspaceMap(workspaceStorage);
	const wsInfo = wsMap.get(sessionId);

	// 1. Try reading from globalStorage state.vscdb
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
					const data = JSON.parse(row.value) as CursorComposerData;

					// Also get separate bubbles if any
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
									return JSON.parse(r.value) as CursorBubble;
								} catch {
									return null;
								}
							})
							.filter((b): b is CursorBubble => b !== null);
					} catch {}

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
						const existingIds = new Set(
							bubbles.map((b) => b.id).filter(Boolean),
						);
						for (const b of dbBubbles) {
							if (!b.id || !existingIds.has(b.id)) {
								bubbles.push(b);
							}
						}
					}

					const session = newSession(
						"cursor",
						sessionId,
						wsInfo?.cwd ?? null,
						data.createdAt ?? Date.now(),
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
							bubble.timestamp ?? bubble.createdAt ?? data.createdAt ?? null;

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

					// Fallback if no bubbles were stored but initial prompt exists
					if (session.items.length === 0 && data.text) {
						addItem(session, {
							id: `msg-user-init`,
							turnId: currentTurnId,
							role: "user",
							kind: "message",
							phase: "final",
							text: data.text,
							timestamp: data.createdAt ?? null,
						});
					}

					inferFinalMessages(session);
					return session;
				}
			} finally {
				handle.close();
			}
		} catch {}
	}

	// 2. Check workspace chatSessions/*.json
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
					const content = JSON.parse(readFileSync(chatFile, "utf-8"));
					const session = newSession(
						"cursor",
						sessionId,
						wsInfo?.cwd ?? null,
						content.creationDate ?? Date.now(),
						content.title ?? "Cursor Chat Session",
					);

					const requests = Array.isArray(content.requests)
						? content.requests
						: [];
					for (const [i, req] of requests.entries()) {
						if (!req) continue;
						const turnId = `turn-${sessionId}-${i + 1}`;
						const userText =
							typeof req.message === "string"
								? req.message
								: (req.message?.text ?? "");
						const aiText =
							typeof req.response === "string"
								? req.response
								: Array.isArray(req.response)
									? req.response
											.map(
												(r: { value?: string } | undefined) => r?.value ?? "",
											)
											.join("\n")
									: (req.response?.value ?? "");

						if (userText) {
							addItem(session, {
								id: `msg-user-${i}`,
								turnId,
								role: "user",
								kind: "message",
								phase: "final",
								text: userText,
								timestamp: req.timestamp ?? null,
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
								timestamp: req.timestamp ?? null,
							});
						}
					}

					inferFinalMessages(session);
					return session;
				}
			}
		} catch {}
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
		const discovery = await discoverCursorSessions(paths);
		if (discovery.length > 0) {
			result.available = true;
		}

		for (const item of discovery) {
			if (targetFiles && !targetFiles.has(item.filePath)) continue;
			const session = await readCursorTranscript(paths, item.sessionId);
			if (session) {
				result.sessions.push(session);
			}
		}
	} catch (e) {
		result.warnings.push(`Failed to read Cursor transcripts: ${e}`);
	}

	return result;
}
