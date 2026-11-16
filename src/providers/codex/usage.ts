import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { PlatformPathService } from "../../platform/paths";
import { cleanUserMessage } from "../../transcripts";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	contentText,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	uniqueBy,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import {
	codexSessionFiles,
	getCodexRolloutFiles,
	getCodexRoots,
} from "./discovery";

export function tokenCount(
	value: unknown,
): Omit<
	UsageRecord,
	| "harness"
	| "sessionId"
	| "messageId"
	| "cwd"
	| "model"
	| "timestamp"
	| "costUsd"
	| "costEstimated"
> {
	const usage = objectOrEmpty(value);
	const inputDetails = objectOrEmpty(usage.input_tokens_details);
	const outputDetails = objectOrEmpty(usage.output_tokens_details);
	const cacheReadTokens =
		Number(
			usage.cached_input_tokens ??
				usage.cache_read_input_tokens ??
				inputDetails.cached_tokens ??
				usage.cached_tokens ??
				0,
		) || 0;
	const cacheWriteTokens =
		Number(usage.cache_write_input_tokens ?? usage.cache_write_tokens ?? 0) ||
		0;
	return {
		inputTokens: Math.max(
			0,
			(Number(usage.input_tokens ?? usage.input ?? 0) || 0) -
				cacheReadTokens -
				cacheWriteTokens,
		),
		outputTokens: Number(usage.output_tokens ?? usage.output ?? 0) || 0,
		cacheReadTokens,
		cacheWriteTokens,
		reasoningTokens:
			Number(
				usage.reasoning_output_tokens ??
					outputDetails.reasoning_tokens ??
					usage.reasoning_tokens ??
					0,
			) || 0,
	};
}

export function sourceUsage(usage: ReturnType<typeof tokenCount>) {
	return {
		input: usage.inputTokens,
		output: usage.outputTokens,
		cacheRead: usage.cacheReadTokens,
		cacheWrite: usage.cacheWriteTokens,
		reasoning: usage.reasoningTokens,
	};
}

export function eventType(event: Record<string, unknown>): unknown {
	return event.type === "event_msg"
		? objectOrEmpty(event.payload).type
		: event.type;
}

export function firstTurnModel(events: unknown[]): string | null {
	for (const value of events) {
		const event = objectOrEmpty(value);
		if (event.type !== "turn_context") continue;
		const model = textOrNull(objectOrEmpty(event.payload).model);
		if (model) return model;
	}
	return null;
}

export function readRolloutSync(filePath: string): unknown[] {
	const bytes = readFileSync(filePath);
	const text = filePath.endsWith(".zst")
		? zstdDecompressSync(bytes).toString("utf8")
		: bytes.toString("utf8");
	return parseJsonl(text);
}

export function readCodexUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const { sessionsRoot, archivedRoot } = getCodexRoots(paths);
	const available = existsSync(sessionsRoot) || existsSync(archivedRoot);
	const result = blankSourceResult("codex", available);
	if (!result.available) return result;

	const rolloutFiles = item
		? codexSessionFiles(item.sessionId, paths)
		: getCodexRolloutFiles(paths);

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	for (const filePath of rolloutFiles) {
		try {
			const events = readRolloutSync(filePath);
			const metadata = events
				.map(objectOrEmpty)
				.find((event) => event.type === "session_meta");
			const metadataPayload = objectOrEmpty(metadata?.payload);
			const declaredSessionId =
				textOrNull(metadataPayload.id) ??
				textOrNull(metadataPayload.session_id);
			const source = objectOrEmpty(metadataPayload.source);
			const subagent = objectOrEmpty(source.subagent);
			const isSubagent = Object.keys(subagent).length > 0;
			const isReview =
				subagent.other === "guardian" || subagent.other === "guardian_review";
			const hasUsageRecords = events.some(
				(value) => eventType(objectOrEmpty(value)) === "token_usage_record",
			);
			const sessionId =
				declaredSessionId ??
				path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/u, "");
			let cwd: string | null = null;
			let model = firstTurnModel(events) ?? "Unknown model";
			let sessionTimestamp: number | null = null;
			let prevTotalKey: string | null = null;
			let prevLastKey: string | null = null;
			let emittedLastCount = 0;
			let fallbackTotal: ReturnType<typeof tokenCount> | null = null;
			let fallbackModel = model;
			let fallbackCwd: string | null = cwd;
			let fallbackTime: number | null = null;

			const usageKey = (u: ReturnType<typeof tokenCount>) =>
				`${u.inputTokens},${u.outputTokens},${u.cacheReadTokens},${u.cacheWriteTokens},${u.reasoningTokens}`;

			for (let index = 0; index < events.length; index += 1) {
				const event = objectOrEmpty(events[index]);
				const payload = objectOrEmpty(event.payload);
				const type = eventType(event);
				if (event.type === "session_meta") {
					const metaId =
						textOrNull(payload.id) ?? textOrNull(payload.session_id);
					if (metaId !== null && metaId !== sessionId) continue;
					cwd = normalizedCwd(payload.cwd) ?? cwd;
					sessionTimestamp = timestampMs(payload.timestamp) ?? sessionTimestamp;
				}
				if (
					!isSubagent &&
					!isReview &&
					event.type === "response_item" &&
					textOrNull(payload.type) === "message" &&
					textOrNull(payload.role) === "user"
				) {
					const text = cleanUserMessage("codex", contentText(payload.content));
					if (text) messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
				}
				if (event.type === "turn_context") {
					cwd = normalizedCwd(payload.cwd) ?? cwd;
					model = modelName(payload.model, model);
				}
				if (type === "token_usage_record" && hasUsageRecords) {
					const usage = tokenCount(payload.usage);
					if (!hasTokenUsage(usage)) continue;
					records.push(
						usageRecord(
							{
								harness: "codex",
								sessionId,
								messageId:
									textOrNull(payload.response_id) ??
									`${path.basename(filePath)}:${index}`,
								turnId:
									textOrNull(payload.turn_id) ??
									textOrNull(payload.root_turn_id) ??
									undefined,
								cwd,
								model,
								timestamp: timestampMs(event.timestamp) ?? sessionTimestamp,
								...(isSubagent ? { isSubagent: true } : {}),
								...(isReview ? { isReview: true } : {}),
							},
							sourceUsage(usage),
						),
					);
					continue;
				}
				if (type !== "token_count" || hasUsageRecords) continue;

				const info = objectOrEmpty(payload.info);
				const eventTime = timestampMs(event.timestamp) ?? sessionTimestamp;
				const lastUsage = tokenCount(info.last_token_usage);
				const totalUsage = tokenCount(info.total_token_usage);
				const totalKey = usageKey(totalUsage);
				const lastKey = usageKey(lastUsage);
				if (
					prevTotalKey !== null &&
					totalKey === prevTotalKey &&
					lastKey === prevLastKey
				) {
					continue;
				}
				prevTotalKey = totalKey;
				prevLastKey = lastKey;

				if (hasTokenUsage(lastUsage)) {
					emittedLastCount += 1;
					records.push(
						usageRecord(
							{
								harness: "codex",
								sessionId,
								messageId: `${path.basename(filePath)}:${index}`,
								cwd,
								model,
								timestamp: eventTime,
								...(isSubagent ? { isSubagent: true } : {}),
								...(isReview ? { isReview: true } : {}),
							},
							sourceUsage(lastUsage),
						),
					);
				} else if (hasTokenUsage(totalUsage)) {
					fallbackTotal = totalUsage;
					fallbackModel = model;
					fallbackCwd = cwd;
					fallbackTime = eventTime;
				}
			}

			if (emittedLastCount === 0 && fallbackTotal !== null) {
				records.push(
					usageRecord(
						{
							harness: "codex",
							sessionId,
							messageId: `${path.basename(filePath)}:cumulative-total`,
							cwd: fallbackCwd,
							model: fallbackModel,
							timestamp: fallbackTime,
							...(isSubagent ? { isSubagent: true } : {}),
							...(isReview ? { isReview: true } : {}),
						},
						sourceUsage(fallbackTotal),
					),
				);
			}
		} catch (error) {
			result.warnings.push(
				`Codex: failed to read ${filePath} (${String(error)})`,
			);
		}
	}

	result.records = uniqueBy(
		records,
		(record) => `${record.sessionId}:${record.messageId}`,
	).filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
