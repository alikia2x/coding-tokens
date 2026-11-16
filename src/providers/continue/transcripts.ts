import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	addItem,
	addToolCall,
	cleanUserMessage,
	inferFinalMessages,
	newSession,
	textFromContent,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import {
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
} from "../../util";
import {
	decodeWorkspaceUri,
	findContinueDevDataFiles,
	findContinueSessionsFiles,
	getContinueRoots,
} from "./discovery";

export function buildContinueSessionTranscript(
	sessionId: string,
	sessionJsonPath?: string,
	summaryData?: {
		cwd?: string | null;
		startedAt?: number | null;
		title?: string;
	},
	chatInteractions?: Array<{
		timestamp: number | null;
		prompt?: string;
		completion?: string;
		tools?: string[];
	}>,
): TranscriptSession | null {
	let cwd = summaryData?.cwd ?? null;
	let startedAt = summaryData?.startedAt ?? null;
	let title = summaryData?.title;

	let history: unknown[] = [];

	if (sessionJsonPath && existsSync(sessionJsonPath)) {
		try {
			const parsed = JSON.parse(readFileSync(sessionJsonPath, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				cwd =
					cwd ??
					normalizedCwd(
						decodeWorkspaceUri(textOrNull(parsed.workspaceDirectory)),
					);
				startedAt = startedAt ?? timestampMs(parsed.dateCreated);
				title = title ?? textOrNull(parsed.title) ?? undefined;
				if (Array.isArray(parsed.history)) {
					history = parsed.history;
				}
			}
		} catch {
			// ignore
		}
	}

	const session = newSession("continue", sessionId, cwd, startedAt, title);
	let turn = 0;

	// 1. Parse history array from session json if present
	if (history.length > 0) {
		for (let i = 0; i < history.length; i++) {
			const h = objectOrEmpty(history[i]);
			const msg = objectOrEmpty(h.message);
			const role = textOrNull(msg.role);
			const content = msg.content;

			if (role === "user") {
				turn += 1;
				const raw = textFromContent(content);
				const userText = cleanUserMessage("continue", raw);
				if (userText) {
					if (!session.title) {
						session.title = userText.slice(0, 100);
					}
					addItem(session, {
						id: `${sessionId}:hist-${i}`,
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
				const asstText = textFromContent(content);
				if (asstText) {
					addItem(session, {
						id: `${sessionId}:hist-${i}`,
						turnId,
						role: "assistant",
						kind: "message",
						phase: "unknown",
						text: asstText,
						timestamp: startedAt,
					});
				}
			} else if (role === "thinking") {
				const turnId = String(Math.max(1, turn));
				const reasoningText = textFromContent(content);
				if (reasoningText) {
					addItem(session, {
						id: `${sessionId}:hist-thinking-${i}`,
						turnId,
						role: "assistant",
						kind: "message",
						phase: "intermediate",
						status: "reasoning",
						text: reasoningText,
						timestamp: startedAt,
					});
				}
			}
		}
	}

	// 2. Add tools & fallback turns from chatInteractions if present
	if (chatInteractions && chatInteractions.length > 0) {
		for (let ciIdx = 0; ciIdx < chatInteractions.length; ciIdx++) {
			const ci = chatInteractions[ciIdx];
			if (!ci) continue;
			const ts = ci.timestamp ?? startedAt;

			// If history was empty, reconstruct turn from prompt and completion
			if (history.length === 0) {
				turn += 1;
				if (ci.prompt) {
					const userText = cleanUserMessage("continue", ci.prompt);
					if (userText) {
						if (!session.title) session.title = userText.slice(0, 100);
						addItem(session, {
							id: `${sessionId}:ci-usr-${ciIdx}`,
							turnId: String(turn),
							role: "user",
							kind: "message",
							phase: "unknown",
							text: userText,
							timestamp: ts,
						});
					}
				}
				if (ci.completion) {
					addItem(session, {
						id: `${sessionId}:ci-asst-${ciIdx}`,
						turnId: String(turn),
						role: "assistant",
						kind: "message",
						phase: "unknown",
						text: ci.completion,
						timestamp: ts,
					});
				}
			}

			// Add tool calls
			if (Array.isArray(ci.tools)) {
				const turnId = String(Math.max(1, turn));
				for (let tIdx = 0; tIdx < ci.tools.length; tIdx++) {
					const toolName = ci.tools[tIdx];
					if (typeof toolName === "string" && toolName.length > 0) {
						addToolCall(
							session,
							toolName,
							null,
							`${sessionId}:tool-${ciIdx}-${tIdx}`,
							turnId,
							ts,
						);
					}
				}
			}
		}
	}

	if (session.items.length === 0 && !sessionJsonPath && !summaryData) {
		return null;
	}

	inferFinalMessages(session);
	return session;
}

export function readContinueSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const roots = getContinueRoots(paths);
	const sessionsFiles = findContinueSessionsFiles(roots);
	const devDataFiles = findContinueDevDataFiles(roots);

	let targetFile: string | undefined;
	for (const sf of sessionsFiles.sessionFiles) {
		if (path.basename(sf, ".json") === sessionId) {
			targetFile = sf;
			break;
		}
	}

	let summaryData:
		| { cwd?: string | null; startedAt?: number | null; title?: string }
		| undefined;

	for (const catPath of sessionsFiles.catalogs) {
		try {
			const list = JSON.parse(readFileSync(catPath, "utf8"));
			if (Array.isArray(list)) {
				const item = list.find((e) => e && e.sessionId === sessionId);
				if (item) {
					summaryData = {
						cwd: normalizedCwd(
							decodeWorkspaceUri(textOrNull(item.workspaceDirectory)),
						),
						startedAt: timestampMs(item.dateCreated),
						title: textOrNull(item.title) ?? undefined,
					};
					break;
				}
			}
		} catch {
			// ignore
		}
	}

	const matchingChatInteractions: Array<{
		timestamp: number | null;
		prompt?: string;
		completion?: string;
		tools?: string[];
	}> = [];

	for (const chatPath of devDataFiles.chatJsonl) {
		try {
			const rows = parseJsonl(readFileSync(chatPath, "utf8"));
			for (const r of rows) {
				const obj = objectOrEmpty(r);
				if (obj.sessionId === sessionId) {
					matchingChatInteractions.push({
						timestamp: timestampMs(obj.timestamp),
						prompt: textOrNull(obj.prompt) ?? undefined,
						completion: textOrNull(obj.completion) ?? undefined,
						tools: Array.isArray(obj.tools)
							? (obj.tools.filter((t) => typeof t === "string") as string[])
							: undefined,
					});
				}
			}
		} catch {
			// ignore
		}
	}

	if (!targetFile && !summaryData && matchingChatInteractions.length === 0) {
		return null;
	}

	return buildContinueSessionTranscript(
		sessionId,
		targetFile,
		summaryData,
		matchingChatInteractions,
	);
}

export function readContinueTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const roots = getContinueRoots(paths);
	const sessionsFiles = findContinueSessionsFiles(roots);
	const devDataFiles = findContinueDevDataFiles(roots);

	const available =
		sessionsFiles.catalogs.length > 0 ||
		sessionsFiles.sessionFiles.length > 0 ||
		devDataFiles.chatJsonl.length > 0;

	const result: TranscriptReadResult = {
		harness: "continue",
		available,
		sessions: [],
		warnings: [],
	};

	if (!available) return result;

	const chatBySession = new Map<
		string,
		Array<{
			timestamp: number | null;
			prompt?: string;
			completion?: string;
			tools?: string[];
		}>
	>();

	for (const chatPath of devDataFiles.chatJsonl) {
		try {
			const rows = parseJsonl(readFileSync(chatPath, "utf8"));
			for (const r of rows) {
				const obj = objectOrEmpty(r);
				const sId = textOrNull(obj.sessionId);
				if (!sId) continue;
				const list = chatBySession.get(sId) ?? [];
				list.push({
					timestamp: timestampMs(obj.timestamp),
					prompt: textOrNull(obj.prompt) ?? undefined,
					completion: textOrNull(obj.completion) ?? undefined,
					tools: Array.isArray(obj.tools)
						? (obj.tools.filter((t) => typeof t === "string") as string[])
						: undefined,
				});
				chatBySession.set(sId, list);
			}
		} catch (error) {
			result.warnings.push(
				`Continue: failed to read ${chatPath} (${String(error)})`,
			);
		}
	}

	const processedIds = new Set<string>();

	for (const sf of sessionsFiles.sessionFiles) {
		if (targetFiles && !targetFiles.has(sf)) continue;
		const sId = path.basename(sf, ".json");
		processedIds.add(sId);
		const s = buildContinueSessionTranscript(
			sId,
			sf,
			undefined,
			chatBySession.get(sId),
		);
		if (s) result.sessions.push(s);
	}

	for (const catPath of sessionsFiles.catalogs) {
		try {
			const list = JSON.parse(readFileSync(catPath, "utf8"));
			if (Array.isArray(list)) {
				for (const item of list) {
					const sId = textOrNull(item?.sessionId);
					if (sId && !processedIds.has(sId)) {
						if (targetFiles && !targetFiles.has(catPath)) continue;
						processedIds.add(sId);
						const s = buildContinueSessionTranscript(
							sId,
							undefined,
							{
								cwd: normalizedCwd(
									decodeWorkspaceUri(textOrNull(item.workspaceDirectory)),
								),
								startedAt: timestampMs(item.dateCreated),
								title: textOrNull(item.title) ?? undefined,
							},
							chatBySession.get(sId),
						);
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
