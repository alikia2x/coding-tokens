import { readFileSync } from "node:fs";
import type { PlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase } from "../../platform/sqlite";
import type { SourceResult } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	numberOrZero,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import {
	buildCursorWorkspaceMap,
	discoverCursorSessions,
	getCursorGlobalDbPath,
	getCursorRoots,
} from "./discovery";
import type { CursorBubble, CursorComposerData } from "./types";

function extractBubbles(
	data: CursorComposerData,
	dbBubbles: CursorBubble[] = [],
): CursorBubble[] {
	const bubbles: CursorBubble[] = [];

	if (data.conversationMap) {
		if (Array.isArray(data.conversationMap)) {
			bubbles.push(
				...data.conversationMap.filter((b): b is CursorBubble => Boolean(b)),
			);
		} else if (typeof data.conversationMap === "object") {
			bubbles.push(
				...Object.values(data.conversationMap).filter((b): b is CursorBubble =>
					Boolean(b),
				),
			);
		}
	}

	if (Array.isArray(data.bubbles)) {
		bubbles.push(...data.bubbles.filter((b): b is CursorBubble => Boolean(b)));
	}

	if (dbBubbles.length > 0) {
		const existingIds = new Set(bubbles.map((b) => b.id).filter(Boolean));
		for (const b of dbBubbles) {
			if (!b.id || !existingIds.has(b.id)) {
				bubbles.push(b);
			}
		}
	}

	return bubbles;
}

export async function readCursorUsage(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): Promise<SourceResult> {
	const { workspaceStorage } = getCursorRoots(paths);
	const globalDbPath = getCursorGlobalDbPath(paths);
	const result = blankSourceResult("cursor", false);

	const wsMap = buildCursorWorkspaceMap(workspaceStorage);

	// If a specific non-db chat session file was targeted
	if (item?.filePath.endsWith(".json")) {
		try {
			const content = JSON.parse(readFileSync(item.filePath, "utf-8"));
			result.available = true;
			const requests = Array.isArray(content.requests) ? content.requests : [];
			let msgCount = 0;

			for (const [i, req] of requests.entries()) {
				if (!req) continue;
				const userText =
					typeof req.message === "string"
						? req.message
						: (req.message?.text ?? "");
				const aiText =
					typeof req.response === "string"
						? req.response
						: Array.isArray(req.response)
							? req.response
									.map((r: { value?: string } | undefined) => r?.value ?? "")
									.join("\n")
							: (req.response?.value ?? "");

				if (userText) msgCount++;

				const inTokens = Math.max(1, Math.ceil((userText.length || 10) / 4));
				const outTokens = Math.max(1, Math.ceil((aiText.length || 10) / 4));

				const rec = usageRecord(
					{
						harness: "cursor",
						sessionId: item.sessionId,
						messageId: `cursor-chat-${item.sessionId}-${i}`,
						cwd: item.cwd ?? null,
						model: modelName(req.modelId ?? content.model ?? "cursor-chat"),
						timestamp: req.timestamp ?? item.mtimeMs,
					},
					{
						input: inTokens,
						output: outTokens,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
					},
				);
				rec.costEstimated = true;
				result.records.push(rec);
			}
			result.messages.set(item.sessionId, msgCount);
			return result;
		} catch (e) {
			result.warnings.push(
				`Failed to read Cursor chat file ${item.filePath}: ${e}`,
			);
			return result;
		}
	}

	if (!globalDbPath) {
		// No global DB available, check if we discovered any workspace chat files
		const sessions = await discoverCursorSessions(paths);
		if (sessions.length > 0 && !item) {
			result.available = true;
			for (const sess of sessions) {
				if (sess.filePath.endsWith(".json")) {
					const subResult = await readCursorUsage(paths, sess);
					result.records.push(...subResult.records);
					for (const [sId, count] of subResult.messages.entries()) {
						result.messages.set(sId, count);
					}
				}
			}
		}
		return result;
	}

	result.available = true;

	try {
		const handle = openSafeReadonlyDatabase(globalDbPath);
		try {
			const targetComposerId = item?.sessionId;

			// Fetch composers
			const query = targetComposerId
				? handle.db
						.query<{ key: string; value: string }, [string]>(
							"SELECT key, value FROM cursorDiskKV WHERE key = ?",
						)
						.all(`composerData:${targetComposerId}`)
				: handle.db
						.query<{ key: string; value: string }, []>(
							"SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
						)
						.all();

			// Also fetch separate bubble rows if any
			let allBubbleRows: Array<{ key: string; value: string }> = [];
			try {
				allBubbleRows = handle.db
					.query<{ key: string; value: string }, []>(
						"SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'",
					)
					.all();
			} catch {}

			const bubbleMapByComposer = new Map<string, CursorBubble[]>();
			for (const bRow of allBubbleRows) {
				// key format: bubbleId:<composerId>:<bubbleId>
				const parts = bRow.key.split(":");
				const cId = parts[1];
				if (cId) {
					try {
						const bData = JSON.parse(bRow.value) as CursorBubble;
						const list = bubbleMapByComposer.get(cId) ?? [];
						list.push(bData);
						bubbleMapByComposer.set(cId, list);
					} catch {}
				}
			}

			for (const row of query) {
				let composerData: CursorComposerData;
				try {
					composerData = JSON.parse(row.value) as CursorComposerData;
				} catch {
					continue;
				}

				const composerId = composerData.composerId;
				const cwd = wsMap.get(composerId)?.cwd ?? null;
				const unifiedMode = composerData.unifiedMode ?? "agent";
				const rawModel =
					composerData.modelConfig?.modelName ??
					composerData.model ??
					"claude-3-5-sonnet";
				const resolvedModel = modelName(rawModel);

				const extraBubbles = bubbleMapByComposer.get(composerId) ?? [];
				const bubbles = extractBubbles(composerData, extraBubbles);

				let userMessagesCount = 0;
				let lastUserText = composerData.text ?? "";
				let turnIndex = 0;

				for (const bubble of bubbles) {
					const isUser =
						bubble.type === "user" ||
						bubble.role === "user" ||
						bubble.type === "human";
					const isAi =
						bubble.type === "ai" ||
						bubble.type === "agent" ||
						bubble.role === "assistant";

					if (isUser) {
						userMessagesCount++;
						if (bubble.text) lastUserText = bubble.text;
						continue;
					}

					if (isAi) {
						turnIndex++;
						const bubbleUsage = bubble.tokenUsage ?? bubble.usage;
						let inTokens = numberOrZero(
							bubbleUsage?.inputTokens ?? bubbleUsage?.input,
						);
						let outTokens = numberOrZero(
							bubbleUsage?.outputTokens ?? bubbleUsage?.output,
						);
						const cacheRead = numberOrZero(
							bubbleUsage?.cacheReadTokens ?? bubbleUsage?.cacheRead,
						);
						const cacheWrite = numberOrZero(
							bubbleUsage?.cacheWriteTokens ?? bubbleUsage?.cacheWrite,
						);
						const reasoning = numberOrZero(bubbleUsage?.reasoningTokens);

						let isEstimated = false;

						// If no explicit tokens were recorded, estimate from content
						if (inTokens === 0 && outTokens === 0) {
							const promptLen = lastUserText.length || 40;
							const replyLen = bubble.text?.length || 40;
							inTokens = Math.max(1, Math.ceil(promptLen / 4));
							outTokens = Math.max(1, Math.ceil(replyLen / 4));
							isEstimated = true;
						}

						const usageFields = {
							inputTokens: inTokens,
							outputTokens: outTokens,
							cacheReadTokens: cacheRead,
							cacheWriteTokens: cacheWrite,
							reasoningTokens: reasoning,
						};

						if (hasTokenUsage(usageFields)) {
							const rec = usageRecord(
								{
									harness: "cursor",
									sessionId: composerId,
									messageId:
										bubble.id ?? `cursor-${composerId}-bubble-${turnIndex}`,
									cwd,
									model: modelName(
										bubble.modelName ?? bubble.model ?? resolvedModel,
									),
									timestamp:
										bubble.timestamp ??
										bubble.createdAt ??
										composerData.createdAt ??
										Date.now(),
									isSubagent: bubble.isSubagent ?? false,
								},
								{
									input: inTokens,
									output: outTokens,
									cacheRead,
									cacheWrite,
									reasoning,
								},
							);
							rec.costEstimated = isEstimated;
							result.records.push(rec);
						}
					}
				}

				// If no AI bubbles had usage, but composer has text or usageData
				if (turnIndex === 0 && (composerData.text || composerData.usageData)) {
					const compUsage = composerData.usageData;
					let inTokens = numberOrZero(compUsage?.inputTokens);
					let outTokens = numberOrZero(compUsage?.outputTokens);
					let isEstimated = false;

					if (inTokens === 0 && outTokens === 0 && composerData.text) {
						inTokens = Math.max(1, Math.ceil(composerData.text.length / 4));
						outTokens = Math.max(1, Math.ceil(40 / 4));
						isEstimated = true;
					}

					const usageFields = {
						inputTokens: inTokens,
						outputTokens: outTokens,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
					};

					if (hasTokenUsage(usageFields)) {
						const rec = usageRecord(
							{
								harness: "cursor",
								sessionId: composerId,
								messageId: `cursor-${composerId}-turn-1`,
								cwd,
								model: resolvedModel,
								timestamp: composerData.createdAt ?? Date.now(),
								isSubagent: unifiedMode === "agent",
							},
							{
								input: inTokens,
								output: outTokens,
								cacheRead: 0,
								cacheWrite: 0,
								reasoning: 0,
							},
						);
						rec.costEstimated = isEstimated;
						result.records.push(rec);
					}
					if (composerData.text)
						userMessagesCount = Math.max(1, userMessagesCount);
				}

				result.messages.set(composerId, userMessagesCount);
			}
		} finally {
			handle.close();
		}
	} catch (e) {
		result.warnings.push(`Failed to read Cursor database: ${e}`);
	}

	return result;
}
