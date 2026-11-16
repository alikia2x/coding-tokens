import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	addItem,
	addToolCall,
	cleanUserMessage,
	contentBlocks,
	inferFinalMessages,
	isReasoningType,
	newSession,
	textFromContent,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import {
	normalizedCwd,
	objectOrEmpty,
	textOrNull,
	timestampMs,
} from "../../util";
import {
	findClineTaskHistoryFiles,
	findClineTasksDirs,
	getClineRoots,
} from "./discovery";

function parseToolText(text: unknown): {
	toolName: string;
	payload: unknown;
	content?: unknown;
} {
	if (typeof text === "string") {
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			const toolName =
				textOrNull(parsed.tool) ?? textOrNull(parsed.name) ?? "tool";
			return { toolName, payload: parsed, content: parsed.content };
		} catch {
			return { toolName: "command", payload: text };
		}
	}
	if (typeof text === "object" && text !== null) {
		const obj = text as Record<string, unknown>;
		const toolName = textOrNull(obj.tool) ?? textOrNull(obj.name) ?? "tool";
		return { toolName, payload: obj, content: obj.content };
	}
	return { toolName: "tool", payload: text };
}

export function buildClineSessionTranscript(
	taskId: string,
	taskFolder?: string,
	summaryData?: {
		cwd?: string | null;
		startedAt?: number | null;
		title?: string;
	},
): TranscriptSession | null {
	let cwd = summaryData?.cwd ?? null;
	let startedAt = summaryData?.startedAt ?? null;
	let title = summaryData?.title;

	let uiMessagesPath: string | undefined;
	let apiHistoryPath: string | undefined;

	if (taskFolder && existsSync(taskFolder)) {
		const metaPath = path.join(taskFolder, "task_metadata.json");
		if (existsSync(metaPath)) {
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf8"));
				cwd = cwd ?? normalizedCwd(meta.cwd);
				startedAt = startedAt ?? timestampMs(meta.createdAt);
				title = title ?? textOrNull(meta.task) ?? undefined;
			} catch {
				// ignore
			}
		}

		const uiP = path.join(taskFolder, "ui_messages.json");
		if (existsSync(uiP)) uiMessagesPath = uiP;

		const apiP = path.join(taskFolder, "api_conversation_history.json");
		if (existsSync(apiP)) apiHistoryPath = apiP;
	}

	const session = newSession("cline", taskId, cwd, startedAt, title);

	let currentTurn = 0;
	let parsedFromUi = false;

	if (uiMessagesPath) {
		try {
			const uiMsgs = JSON.parse(readFileSync(uiMessagesPath, "utf8"));
			if (Array.isArray(uiMsgs) && uiMsgs.length > 0) {
				let isFirstText = true;

				for (let i = 0; i < uiMsgs.length; i++) {
					const m = objectOrEmpty(uiMsgs[i]);
					const ts = timestampMs(m.ts);
					if (startedAt === null && ts !== null) {
						session.startedAt = ts;
						startedAt = ts;
					}

					// Detect user message
					const isUserMsg =
						m.say === "user_feedback" ||
						m.say === "user_feedback_diff" ||
						m.conversationHistoryIndex === -1 ||
						(isFirstText && m.say === "text");

					if (isUserMsg) {
						currentTurn += 1;
						isFirstText = false;
						const rawText =
							typeof m.text === "string" ? m.text : JSON.stringify(m.text);
						const userText = cleanUserMessage("cline", rawText);
						if (userText) {
							if (!session.title) {
								session.title = userText.slice(0, 100);
							}
							addItem(session, {
								id: `${taskId}:ui-msg-${i}`,
								turnId: String(currentTurn),
								role: "user",
								kind: "message",
								phase: "unknown",
								text: userText,
								timestamp: ts,
							});
						}
						continue;
					}

					if (m.say === "api_req_started") {
						isFirstText = false;
					}

					const turnId = String(Math.max(1, currentTurn));

					// Detect assistant reasoning
					if (m.say === "reasoning") {
						const reasoningText =
							typeof m.text === "string" ? m.text : JSON.stringify(m.text);
						if (reasoningText) {
							addItem(session, {
								id: `${taskId}:ui-reasoning-${i}`,
								turnId,
								role: "assistant",
								kind: "message",
								phase: "intermediate",
								text: reasoningText,
								status: "reasoning",
								timestamp: ts,
							});
						}
						continue;
					}

					// Detect assistant text
					if (m.say === "text") {
						const assistantText =
							typeof m.text === "string" ? m.text : JSON.stringify(m.text);
						if (assistantText) {
							addItem(session, {
								id: `${taskId}:ui-text-${i}`,
								turnId,
								role: "assistant",
								kind: "message",
								phase: "unknown",
								text: assistantText,
								timestamp: ts,
							});
						}
						continue;
					}

					// Detect tool invocation
					if (m.say === "tool" || m.ask === "tool") {
						const { toolName, payload, content } = parseToolText(m.text);
						addToolCall(
							session,
							toolName,
							payload,
							`${taskId}:ui-tool-${i}`,
							turnId,
							ts,
						);
						if (content !== undefined) {
							addItem(session, {
								id: `${taskId}:ui-tool-res-${i}`,
								turnId,
								role: "tool",
								kind: "tool_result",
								phase: "intermediate",
								name: toolName,
								output: content,
								toolCallId: `${taskId}:ui-tool-${i}`,
								timestamp: ts,
							});
						}
						continue;
					}

					if (m.say === "command" || m.ask === "command") {
						addToolCall(
							session,
							"execute_command",
							m.text,
							`${taskId}:ui-cmd-${i}`,
							turnId,
							ts,
						);
					}
				}
				parsedFromUi = session.items.length > 0;
			}
		} catch {
			// fallback to api conversation history
		}
	}

	// Fallback to api_conversation_history.json if ui_messages was absent or empty
	if (!parsedFromUi && apiHistoryPath) {
		try {
			const history = JSON.parse(readFileSync(apiHistoryPath, "utf8"));
			if (Array.isArray(history)) {
				let turn = 0;
				for (let i = 0; i < history.length; i++) {
					const entry = objectOrEmpty(history[i]);
					const role = textOrNull(entry.role);

					if (role === "user") {
						turn += 1;
						const rawText =
							typeof entry.content === "string"
								? entry.content
								: textFromContent(entry.content);
						const userText = cleanUserMessage("cline", rawText);
						if (userText) {
							if (!session.title) {
								session.title = userText.slice(0, 100);
							}
							addItem(session, {
								id: `${taskId}:api-usr-${i}`,
								turnId: String(turn),
								role: "user",
								kind: "message",
								phase: "unknown",
								text: userText,
								timestamp: startedAt,
							});
						}
					} else if (role === "assistant") {
						const turnId = String(Math.max(1, turn));
						if (typeof entry.content === "string") {
							addItem(session, {
								id: `${taskId}:api-asst-${i}`,
								turnId,
								role: "assistant",
								kind: "message",
								phase: "unknown",
								text: entry.content,
								timestamp: startedAt,
							});
						} else if (Array.isArray(entry.content)) {
							const blocks = contentBlocks(entry.content);
							for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
								const block = blocks[bIdx];
								if (!block) continue;
								const bType = textOrNull(block.type) ?? "";
								if (isReasoningType(bType)) {
									const text =
										textOrNull(block.thinking) ?? textFromContent(block);
									if (text) {
										addItem(session, {
											id: `${taskId}:api-asst-${i}-${bIdx}`,
											turnId,
											role: "assistant",
											kind: "message",
											phase: "intermediate",
											text,
											status: "reasoning",
											timestamp: startedAt,
										});
									}
								} else if (bType === "text") {
									const text = textOrNull(block.text);
									if (text) {
										addItem(session, {
											id: `${taskId}:api-asst-${i}-${bIdx}`,
											turnId,
											role: "assistant",
											kind: "message",
											phase: "unknown",
											text,
											timestamp: startedAt,
										});
									}
								} else if (bType === "tool_use") {
									const toolName = textOrNull(block.name) ?? "tool";
									const toolCallId = textOrNull(block.id);
									addToolCall(
										session,
										toolName,
										block.input,
										toolCallId ?? `${taskId}:api-tool-${i}-${bIdx}`,
										turnId,
										startedAt,
									);
								} else if (bType === "tool_result") {
									const toolCallId = textOrNull(block.tool_use_id);
									addItem(session, {
										id: `${taskId}:api-res-${i}-${bIdx}`,
										turnId,
										role: "tool",
										kind: "tool_result",
										phase: "intermediate",
										output: block.content,
										toolCallId: toolCallId ?? undefined,
										timestamp: startedAt,
									});
								}
							}
						}
					}
				}
			}
		} catch {
			// ignore
		}
	}

	inferFinalMessages(session);
	return session;
}

export function readClineSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const roots = getClineRoots(paths);
	const tasksDirs = findClineTasksDirs(roots);

	// First find task directory
	let targetFolder: string | undefined;
	for (const td of tasksDirs) {
		const candidate = path.join(td, sessionId);
		if (existsSync(candidate)) {
			targetFolder = candidate;
			break;
		}
	}

	// Also find summary from taskHistory.json if available
	let summaryData:
		| { cwd?: string | null; startedAt?: number | null; title?: string }
		| undefined;
	for (const historyFile of findClineTaskHistoryFiles(roots)) {
		try {
			const list = JSON.parse(readFileSync(historyFile, "utf8"));
			if (Array.isArray(list)) {
				const item = list.find((e) => e && e.id === sessionId);
				if (item) {
					summaryData = {
						cwd: normalizedCwd(item.cwdOnTaskInitialization),
						startedAt: timestampMs(item.ts),
						title: textOrNull(item.task) ?? undefined,
					};
					break;
				}
			}
		} catch {
			// ignore
		}
	}

	if (!targetFolder && !summaryData) {
		return null;
	}

	return buildClineSessionTranscript(sessionId, targetFolder, summaryData);
}

export function readClineTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const roots = getClineRoots(paths);
	const historyFiles = findClineTaskHistoryFiles(roots);
	const tasksDirs = findClineTasksDirs(roots);

	const available = historyFiles.length > 0 || tasksDirs.length > 0;
	const result: TranscriptReadResult = {
		harness: "cline",
		available,
		sessions: [],
		warnings: [],
	};

	if (!available) return result;

	const discoveredTaskIds = new Set<string>();

	for (const td of tasksDirs) {
		try {
			const entries = readdirSync(td, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const taskId = entry.name;
				const taskFolder = path.join(td, taskId);
				const uiPath = path.join(taskFolder, "ui_messages.json");
				if (
					targetFiles &&
					!targetFiles.has(taskFolder) &&
					!targetFiles.has(uiPath)
				) {
					continue;
				}
				discoveredTaskIds.add(taskId);
				const s = buildClineSessionTranscript(taskId, taskFolder);
				if (s) result.sessions.push(s);
			}
		} catch (error) {
			result.warnings.push(`Cline: failed to scan ${td} (${String(error)})`);
		}
	}

	// Check any in historyFiles that weren't discovered in tasksDirs
	for (const historyFile of historyFiles) {
		try {
			const list = JSON.parse(readFileSync(historyFile, "utf8"));
			if (Array.isArray(list)) {
				for (const item of list) {
					const id = textOrNull(item?.id);
					if (id && !discoveredTaskIds.has(id)) {
						if (targetFiles && !targetFiles.has(historyFile)) continue;
						discoveredTaskIds.add(id);
						const s = buildClineSessionTranscript(id, undefined, {
							cwd: normalizedCwd(item.cwdOnTaskInitialization),
							startedAt: timestampMs(item.ts),
							title: textOrNull(item.task) ?? undefined,
						});
						if (s) result.sessions.push(s);
					}
				}
			}
		} catch {
			// ignore
		}
	}

	return result;
}
