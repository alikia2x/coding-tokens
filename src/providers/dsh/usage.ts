import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	contentText,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	numberOrZero,
	objectOrEmpty,
	readJsonlFileSync,
	textOrNull,
	timestampMs,
	uniqueBy,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { collectDshLogs, getDshRoots } from "./discovery";

export function extractUsage(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const direct = objectOrEmpty(data.usage);
	if (Object.keys(direct).length > 0) return direct;

	const stream = Array.isArray(data.stream) ? data.stream : [];
	let lastUsage: Record<string, unknown> = {};
	for (const chunkValue of stream) {
		const chunk = objectOrEmpty(chunkValue);
		const inner = objectOrEmpty(chunk.chunk);
		if (chunk.type !== "usage" && inner.type !== "usage") continue;
		const usage = objectOrEmpty(
			chunk.usage ?? chunk.data ?? inner.usage ?? inner.data,
		);
		if (Object.keys(usage).length > 0) lastUsage = usage;
	}
	return lastUsage;
}

export function hasUsage(usage: Record<string, unknown>): boolean {
	return Object.values(usage).some(
		(value) => typeof value === "number" && Number.isFinite(value) && value > 0,
	);
}

export function routeModel(event: Record<string, unknown>): string | null {
	const data = objectOrEmpty(event.data);
	const header = objectOrEmpty(data.header);
	const config = objectOrEmpty(header.config);
	const route = objectOrEmpty(data.route);
	const configuredModel = modelName(config.model, "");
	if (configuredModel) return configuredModel;
	return modelName(route, "") || textOrNull(route.model);
}

export function readLogSync(filePath: string): unknown[] {
	return readJsonlFileSync(filePath);
}

export function readDshUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const existingRoots = getDshRoots(paths);
	const available = existingRoots.length > 0;
	const result = blankSourceResult("dsh", available);
	if (!result.available) return result;

	const logs = item
		? [{ filePath: item.filePath, generation: 0 }]
		: collectDshLogs(paths);

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	const seenEvents = new Set<string>();

	for (const log of logs) {
		try {
			const events = readLogSync(log.filePath).map(objectOrEmpty);
			const header = events.find((event) => event.type === "session") ?? {};
			const sessionId =
				textOrNull(header.id) ?? path.basename(path.dirname(log.filePath));
			const cwd = normalizedCwd(header.cwd);
			const createdAt = timestampMs(header.createdAt);
			const origin = (textOrNull(header.origin) ?? "").toLowerCase();
			const isSubagent =
				origin === "subagent" ||
				textOrNull(header.parentSession) !== null ||
				(Number(header.delegationDepth) || 0) > 0;
			const isReview = origin === "review";
			let currentModel: string | null = null;

			for (const event of events) {
				const eventType = textOrNull(event.type) ?? "";
				if (!isSubagent && !isReview && eventType === "user/message") {
					const text = contentText(objectOrEmpty(event.data).content);
					if (text && !text.startsWith("Current runtime context.")) {
						messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
					}
				}
				if (eventType === "request/header" || eventType === "request/context") {
					currentModel = routeModel(event) ?? currentModel;
				}
				if (
					eventType !== "assistant/message" &&
					eventType !== "assistant/attempt"
				) {
					continue;
				}
				const data = objectOrEmpty(event.data);
				const usage = extractUsage(data);
				if (!hasUsage(usage)) continue;

				const message = objectOrEmpty(data.message);
				const source = objectOrEmpty(message.source);
				const model =
					textOrNull(source.model) ?? currentModel ?? "Unknown model";
				const provider = textOrNull(source.provider);
				const resolvedModel = provider ? `${provider}/${model}` : model;
				const eventId =
					textOrNull(event.id) ??
					`${String(data.turn ?? "?")}:${String(data.step ?? "?")}:${eventType}:${String(event.seq ?? "?")}`;
				const dedupKey = `${sessionId}:${eventId}`;
				if (seenEvents.has(dedupKey)) continue;
				seenEvents.add(dedupKey);

				const rawOutput = numberOrZero(usage.outputTokens);
				const reasoning = numberOrZero(usage.reasoningTokens);
				const outputTokens =
					rawOutput < reasoning ? rawOutput + reasoning : rawOutput;

				records.push(
					usageRecord(
						{
							harness: "dsh",
							sessionId,
							messageId: eventId,
							turnId: data.turn === undefined ? undefined : String(data.turn),
							cwd,
							model: modelName(resolvedModel),
							pricingModel: resolvedModel,
							timestamp: timestampMs(event.time) ?? createdAt,
							isSubagent,
							isReview,
						},
						{
							input: usage.inputTokens,
							output: outputTokens,
							cacheRead: usage.cacheReadTokens,
							cacheWrite: usage.cacheWriteTokens,
							reasoning,
						},
					),
				);
			}
		} catch (error) {
			result.warnings.push(
				`DSH: failed to read ${log.filePath} (${String(error)})`,
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
