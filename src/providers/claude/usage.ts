import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	finiteCostOrNull,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	numberOrZero,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import {
	decodeClaudeProjectPath,
	getClaudeRoots,
	getClaudeSessionFiles,
} from "./discovery";

function estimateThinkingTokens(thinking: string): number {
	if (!thinking) return 0;
	// Standard heuristic: ~3.5 chars per token for English/code text
	return Math.max(1, Math.round(thinking.length / 3.5));
}

export function readClaudeUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const { root, projectsRoot, statsCachePath } = getClaudeRoots(paths);
	const available =
		existsSync(root) &&
		(existsSync(projectsRoot) || existsSync(statsCachePath));
	const result = blankSourceResult("claude", available);
	if (!result.available) return result;

	const { allFiles } = getClaudeSessionFiles(paths);
	const filesToRead = item ? [item.filePath] : allFiles;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	for (const filePath of filesToRead) {
		try {
			const content = readFileSync(filePath, "utf8");
			const rows = parseJsonl(content);
			const defaultSessionId = path.basename(filePath, ".jsonl");
			const projectDirName = path.basename(path.dirname(filePath));
			let sessionCwd: string | null = decodeClaudeProjectPath(projectDirName);
			const isSubagent =
				filePath.includes("/subagents/") || filePath.includes("\\subagents\\");

			// Track seen message IDs and update in place so the final complete chunk wins
			const seenMessages = new Map<
				string,
				{
					index: number;
					estimatedThinking: number;
					costUsd: number | null;
				}
			>();

			for (let i = 0; i < rows.length; i++) {
				const row = objectOrEmpty(rows[i]);
				const rowType = textOrNull(row.type) ?? "";
				const sessionId = textOrNull(row.sessionId) ?? defaultSessionId;

				if (row.cwd) {
					sessionCwd = normalizedCwd(row.cwd) ?? sessionCwd;
				}

				if (rowType === "user") {
					messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
					continue;
				}

				if (rowType === "assistant") {
					const message = objectOrEmpty(row.message);
					const usage = objectOrEmpty(message.usage ?? row.usage);
					if (Object.keys(usage).length === 0) continue;

					const messageId =
						textOrNull(message.id) ??
						textOrNull(row.requestId) ??
						textOrNull(row.uuid) ??
						`${sessionId}:${i}`;

					const prev = seenMessages.get(messageId);
					const model = modelName(
						message.model ?? row.model,
						"claude-3-7-sonnet",
					);
					const timestamp = timestampMs(row.timestamp);

					// Anthropic Usage Accounting:
					// input_tokens is already uncached tokens; output_tokens includes thinking tokens
					const inputTokens = numberOrZero(
						usage.input_tokens ?? usage.inputTokens,
					);
					const outputTokens = numberOrZero(
						usage.output_tokens ?? usage.outputTokens,
					);
					const cacheReadTokens = numberOrZero(
						usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
					);
					const cacheWriteTokens = numberOrZero(
						usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
					);

					const explicitReasoningRaw =
						usage.thinking_tokens ??
						usage.reasoning_tokens ??
						usage.reasoningTokens;
					const hasExplicitReasoning =
						explicitReasoningRaw !== undefined && explicitReasoningRaw !== null;

					let estimatedThinking = 0;
					let reasoningTokens = 0;
					if (hasExplicitReasoning) {
						reasoningTokens = numberOrZero(explicitReasoningRaw);
					} else {
						if (Array.isArray(message.content)) {
							for (const block of message.content) {
								const b = objectOrEmpty(block);
								if (b.type === "thinking" && typeof b.thinking === "string") {
									estimatedThinking += estimateThinkingTokens(b.thinking);
								}
							}
						}
						if (estimatedThinking === 0 && prev) {
							estimatedThinking = prev.estimatedThinking;
						}
						reasoningTokens =
							outputTokens > 0 ? Math.min(estimatedThinking, outputTokens) : 0;
					}

					const rowCostUsd =
						finiteCostOrNull(row.costUSD) ?? finiteCostOrNull(usage.costUSD);
					const costUsd = rowCostUsd ?? prev?.costUsd ?? null;

					const record = usageRecord(
						{
							harness: "claude",
							sessionId,
							messageId,
							turnId: textOrNull(row.uuid) ?? undefined,
							isSubagent: isSubagent || row.isSidechain === true,
							cwd: sessionCwd,
							model,
							timestamp,
						},
						{
							input: inputTokens,
							output: outputTokens,
							cacheRead: cacheReadTokens,
							cacheWrite: cacheWriteTokens,
							reasoning: reasoningTokens,
							cost: costUsd,
						},
					);

					if (prev) {
						records[prev.index] = record;
						prev.estimatedThinking = estimatedThinking;
						prev.costUsd = costUsd;
					} else {
						seenMessages.set(messageId, {
							index: records.length,
							estimatedThinking,
							costUsd,
						});
						records.push(record);
					}
				}
			}
		} catch (error) {
			result.warnings.push(
				`Claude: failed to read ${filePath} (${String(error)})`,
			);
		}
	}

	// Fallback to stats-cache.json if no project session records were found
	if (records.length === 0 && existsSync(statsCachePath) && !item) {
		try {
			const cacheText = readFileSync(statsCachePath, "utf8");
			const stats = objectOrEmpty(JSON.parse(cacheText));
			const modelUsage = objectOrEmpty(stats.modelUsage);

			for (const [modelKey, usageObj] of Object.entries(modelUsage)) {
				const u = objectOrEmpty(usageObj);
				records.push(
					usageRecord(
						{
							harness: "claude",
							sessionId: "claude-stats-cache",
							messageId: `stats-cache:${modelKey}`,
							cwd: null,
							model: modelKey,
							timestamp: null,
						},
						{
							input: u.inputTokens,
							output: u.outputTokens,
							cacheRead: u.cacheReadInputTokens,
							cacheWrite: u.cacheCreationInputTokens,
							cost: finiteCostOrNull(u.costUSD),
						},
					),
				);
			}
		} catch (error) {
			result.warnings.push(
				`Claude: failed to read stats-cache.json (${String(error)})`,
			);
		}
	}

	result.records = records.filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
