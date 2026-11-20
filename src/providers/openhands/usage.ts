import { existsSync, readdirSync, readFileSync } from "node:fs";
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
	textOrNull,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { findOpenHandsConversations } from "./discovery";

export function readOpenHandsUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const conversations = findOpenHandsConversations(paths);
	const available = conversations.length > 0;
	const result = blankSourceResult("openhands", available);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	for (const conv of conversations) {
		if (
			item &&
			item.filePath !== conv.baseStatePath &&
			item.sessionId !== conv.conversationId
		) {
			continue;
		}

		try {
			const baseStateRaw = readFileSync(conv.baseStatePath, "utf8");
			const baseState = objectOrEmpty(JSON.parse(baseStateRaw));
			const sessionId =
				textOrNull(baseState.conversation_id) ?? conv.conversationId;
			const cwd = normalizedCwd(baseState.workspace_path ?? conv.cwd);
			const defaultModel = modelName(
				baseState.model_name ?? "claude-3-5-sonnet-20241022",
			);
			const sessionTime = timestampMs(baseState.created_at) ?? conv.mtimeMs;

			let hasGranularEvents = false;

			// Check events directory for fine-grained per-action metrics
			if (conv.eventsDir && existsSync(conv.eventsDir)) {
				try {
					const eventFiles = readdirSync(conv.eventsDir)
						.filter((name) => name.endsWith(".json"))
						.sort((a, b) => {
							const numA = Number.parseInt(
								a.replace(/[^0-9]/gu, "") || "0",
								10,
							);
							const numB = Number.parseInt(
								b.replace(/[^0-9]/gu, "") || "0",
								10,
							);
							return numA - numB;
						});

					for (const eventFileName of eventFiles) {
						const eventFilePath = path.join(conv.eventsDir, eventFileName);
						const eventRaw = readFileSync(eventFilePath, "utf8");
						const event = objectOrEmpty(JSON.parse(eventRaw));
						const source = textOrNull(event.source) ?? "";

						if (source === "user") {
							messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
							continue;
						}

						const eventMetrics = objectOrEmpty(event.metrics);
						if (Object.keys(eventMetrics).length > 0) {
							const inTokens = numberOrZero(
								eventMetrics.prompt_tokens ?? eventMetrics.tokens_in,
							);
							const outTokens = numberOrZero(
								eventMetrics.completion_tokens ?? eventMetrics.tokens_out,
							);
							const cost = finiteCostOrNull(eventMetrics.cost);

							if (inTokens > 0 || outTokens > 0) {
								const eventTime = timestampMs(event.timestamp) ?? sessionTime;
								records.push(
									usageRecord(
										{
											harness: "openhands",
											sessionId,
											messageId: `openhands-${sessionId}-${event.id ?? eventFileName}`,
											turnId: `turn-${event.id ?? eventFileName}`,
											cwd,
											model: defaultModel,
											timestamp: eventTime,
										},
										{
											input: inTokens,
											output: outTokens,
											cost,
										},
									),
								);
								hasGranularEvents = true;
							}
						}
					}
				} catch (err) {
					result.warnings.push(
						`OpenHands: failed reading events from ${conv.eventsDir} (${String(err)})`,
					);
				}
			}

			// If no granular events produced records, use base_state.metrics
			if (!hasGranularEvents) {
				const baseMetrics = objectOrEmpty(baseState.metrics);
				const inTokens = numberOrZero(baseMetrics.prompt_tokens);
				const outTokens = numberOrZero(baseMetrics.completion_tokens);
				const cost = finiteCostOrNull(baseMetrics.accumulated_cost);

				if (inTokens > 0 || outTokens > 0) {
					records.push(
						usageRecord(
							{
								harness: "openhands",
								sessionId,
								messageId: `openhands-base-${sessionId}`,
								cwd,
								model: defaultModel,
								timestamp: sessionTime,
							},
							{
								input: inTokens,
								output: outTokens,
								cost,
							},
						),
					);
				}
			}
		} catch (err) {
			result.warnings.push(
				`OpenHands: failed to read base_state ${conv.baseStatePath} (${String(err)})`,
			);
		}
	}

	result.records = records.filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
