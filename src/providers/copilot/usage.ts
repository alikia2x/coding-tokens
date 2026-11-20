import { existsSync, readFileSync, statSync } from "node:fs";
import type { PlatformPathService } from "../../platform/paths";
import type { SourceResult } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	numberOrZero,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { discoverCopilotSessions } from "./discovery";
import type { CopilotChatSessionData, CopilotRequest } from "./types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCopilotChatJson(
	filePath: string,
): CopilotChatSessionData | null {
	if (!existsSync(filePath)) return null;
	try {
		const stat = statSync(filePath);
		if (stat.size === 0) return null;
		const content = readFileSync(filePath, "utf-8");

		if (filePath.endsWith(".jsonl")) {
			const rows = parseJsonl(content);
			if (rows.length === 0) return null;

			const merged: CopilotChatSessionData = { requests: [] };
			for (const rawRow of rows) {
				if (!isPlainRecord(rawRow)) continue;

				// Incremental VS Code Copilot patch format: { kind: 0|1|2, k?, v }
				if (typeof rawRow.kind === "number" && "v" in rawRow) {
					const keyPath = Array.isArray(rawRow.k) ? rawRow.k : [];
					if (rawRow.kind === 0 && isPlainRecord(rawRow.v)) {
						const v = rawRow.v as unknown as CopilotChatSessionData;
						merged.sessionId ??= textOrNull(v.sessionId) ?? undefined;
						merged.id ??= textOrNull(v.id) ?? undefined;
						merged.creationDate ??= timestampMs(v.creationDate) ?? undefined;
						merged.lastMessageDate =
							timestampMs(v.lastMessageDate) ?? merged.lastMessageDate;
						merged.title ??= textOrNull(v.title) ?? undefined;
						if (Array.isArray(v.requests)) {
							merged.requests?.push(...v.requests);
						}
					} else if (
						rawRow.kind === 2 &&
						keyPath[0] === "requests" &&
						Array.isArray(rawRow.v)
					) {
						merged.requests?.push(...(rawRow.v as CopilotRequest[]));
					} else if (rawRow.kind === 1 && keyPath[0] === "lastMessageDate") {
						const ts = timestampMs(rawRow.v);
						if (ts !== null) merged.lastMessageDate = ts;
					}
					continue;
				}

				const session = rawRow as unknown as CopilotChatSessionData;
				merged.sessionId ??= textOrNull(session.sessionId) ?? undefined;
				merged.id ??= textOrNull(session.id) ?? undefined;
				merged.creationDate ??= timestampMs(session.creationDate) ?? undefined;
				merged.lastMessageDate =
					timestampMs(session.lastMessageDate) ?? merged.lastMessageDate;
				merged.title ??= textOrNull(session.title) ?? undefined;

				if (Array.isArray(session.requests)) {
					merged.requests?.push(...session.requests);
				} else if ("message" in rawRow || "response" in rawRow) {
					merged.requests?.push(rawRow as unknown as CopilotRequest);
				}
			}
			return merged;
		}

		const parsed: unknown = JSON.parse(content);
		return isPlainRecord(parsed)
			? (parsed as unknown as CopilotChatSessionData)
			: null;
	} catch {
		return null;
	}
}

export async function readCopilotUsage(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): Promise<SourceResult> {
	const result = blankSourceResult("copilot", false);

	const itemsToRead = item ? [item] : await discoverCopilotSessions(paths);

	if (itemsToRead.length > 0) {
		result.available = true;
	}

	for (const discovery of itemsToRead) {
		// A. Workspace chat session (.json or .jsonl)
		if (
			discovery.filePath.endsWith(".json") ||
			discovery.filePath.endsWith(".jsonl")
		) {
			const chatData = parseCopilotChatJson(discovery.filePath);
			if (!chatData) {
				if (existsSync(discovery.filePath)) {
					try {
						if (statSync(discovery.filePath).size > 0) {
							result.warnings.push(
								`Copilot: failed to parse ${discovery.filePath}`,
							);
						}
					} catch {
						// File disappeared mid-scan.
					}
				}
				continue;
			}

			const sessionId =
				chatData.sessionId ?? chatData.id ?? discovery.sessionId;
			const requests = Array.isArray(chatData.requests)
				? chatData.requests
				: [];
			let userMsgCount = 0;
			const fallbackCreationTs =
				timestampMs(chatData.creationDate) ?? timestampMs(discovery.mtimeMs);

			for (const [i, rawReq] of requests.entries()) {
				const req = objectOrEmpty(rawReq);
				if (Object.keys(req).length === 0) continue;
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

				if (userText) userMsgCount++;

				const explicitUsage =
					(req.tokenUsage as Record<string, unknown> | undefined) ??
					(objectOrEmpty(objectOrEmpty(req.result).metadata).tokenUsage as
						| Record<string, unknown>
						| undefined);

				let inTokens = numberOrZero(explicitUsage?.inputTokens);
				let outTokens = numberOrZero(explicitUsage?.outputTokens);
				const cacheRead = numberOrZero(explicitUsage?.cacheReadTokens);
				const cacheWrite = numberOrZero(explicitUsage?.cacheWriteTokens);
				const reasoning = numberOrZero(explicitUsage?.reasoningTokens);

				if (
					inTokens === 0 &&
					outTokens === 0 &&
					cacheRead === 0 &&
					cacheWrite === 0 &&
					reasoning === 0
				) {
					inTokens = Math.max(1, Math.ceil((userText.length || 20) / 4));
					outTokens = Math.max(1, Math.ceil((aiText.length || 20) / 4));
				} else if (outTokens < reasoning) {
					outTokens += reasoning;
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
							harness: "copilot",
							sessionId,
							messageId: `copilot-${sessionId}-turn-${i + 1}`,
							cwd: discovery.cwd ?? null,
							model: modelName(req.modelId ?? "copilot/gpt-4o"),
							timestamp: timestampMs(req.timestamp) ?? fallbackCreationTs,
						},
						{
							input: inTokens,
							output: outTokens,
							cacheRead,
							cacheWrite,
							reasoning,
						},
					);
					result.records.push(rec);
				}
			}

			result.messages.set(sessionId, userMsgCount);
		}

		// B. Copilot CLI process logs
		if (discovery.filePath.endsWith(".log")) {
			try {
				const text = readFileSync(discovery.filePath, "utf-8");
				const lines = text.split(/\r?\n/);
				let completedCount = 0;
				for (const line of lines) {
					if (
						line.includes("Request completed") ||
						line.includes("copilot-agent")
					) {
						completedCount++;
					}
				}

				if (completedCount > 0) {
					const rec = usageRecord(
						{
							harness: "copilot",
							sessionId: discovery.sessionId,
							messageId: `copilot-cli-${discovery.sessionId}`,
							cwd: null,
							model: "copilot/gpt-4o",
							timestamp: timestampMs(discovery.mtimeMs),
						},
						{
							input: completedCount * 250,
							output: completedCount * 150,
							cacheRead: 0,
							cacheWrite: 0,
							reasoning: 0,
						},
					);
					result.records.push(rec);
					result.messages.set(discovery.sessionId, completedCount);
				}
			} catch (err) {
				result.warnings.push(
					`Copilot: failed to read log ${discovery.filePath} (${String(err)})`,
				);
			}
		}
	}

	return result;
}
