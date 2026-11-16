import { existsSync, readFileSync, statSync } from "node:fs";
import type { PlatformPathService } from "../../platform/paths";
import type { SourceResult } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	numberOrZero,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { discoverCopilotSessions } from "./discovery";
import type { CopilotChatSessionData } from "./types";

export function parseCopilotChatJson(
	filePath: string,
): CopilotChatSessionData | null {
	if (!existsSync(filePath)) return null;
	try {
		const stat = statSync(filePath);
		if (stat.size === 0) return null;
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content) as CopilotChatSessionData;
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
			if (!chatData) continue;

			const sessionId =
				chatData.sessionId ?? chatData.id ?? discovery.sessionId;
			const requests = Array.isArray(chatData.requests)
				? chatData.requests
				: [];
			let userMsgCount = 0;

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

				if (userText) userMsgCount++;

				const explicitUsage =
					req.tokenUsage ?? req.result?.metadata?.tokenUsage;

				let inTokens = numberOrZero(explicitUsage?.inputTokens);
				let outTokens = numberOrZero(explicitUsage?.outputTokens);
				const cacheRead = numberOrZero(explicitUsage?.cacheReadTokens);
				const cacheWrite = numberOrZero(explicitUsage?.cacheWriteTokens);
				const reasoning = numberOrZero(explicitUsage?.reasoningTokens);

				let isEstimated = false;

				if (inTokens === 0 && outTokens === 0) {
					inTokens = Math.max(1, Math.ceil((userText.length || 20) / 4));
					outTokens = Math.max(1, Math.ceil((aiText.length || 20) / 4));
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
							harness: "copilot",
							sessionId,
							messageId: `copilot-${sessionId}-turn-${i + 1}`,
							cwd: discovery.cwd ?? null,
							model: modelName(req.modelId ?? "copilot/gpt-4o"),
							timestamp:
								req.timestamp ?? chatData.creationDate ?? discovery.mtimeMs,
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
							timestamp: discovery.mtimeMs,
						},
						{
							input: completedCount * 250,
							output: completedCount * 150,
							cacheRead: 0,
							cacheWrite: 0,
							reasoning: 0,
						},
					);
					rec.costEstimated = true;
					result.records.push(rec);
					result.messages.set(discovery.sessionId, completedCount);
				}
			} catch {}
		}
	}

	return result;
}
