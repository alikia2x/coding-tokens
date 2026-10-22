import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { SourceResult, UsageRecord } from "../types";
import {
	blankSourceResult,
	contentText,
	expandHome,
	homeDir,
	modelName,
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	uniqueBy,
	usageRecord,
	walkFiles,
} from "../util";

interface SessionLog {
	filePath: string;
	generation: number;
}

function generationOf(name: string): number {
	const match = name.match(/^session\.v(\d+)\.jsonl(?:\.zstd)?$/u);
	return match ? Number(match[1]) : 0;
}

function extractUsage(data: Record<string, unknown>): Record<string, unknown> {
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

function hasUsage(usage: Record<string, unknown>): boolean {
	return Object.values(usage).some(
		(value) => typeof value === "number" && Number.isFinite(value) && value > 0,
	);
}

function routeModel(event: Record<string, unknown>): string | null {
	const data = objectOrEmpty(event.data);
	const header = objectOrEmpty(data.header);
	const config = objectOrEmpty(header.config);
	const route = objectOrEmpty(data.route);
	const configuredModel = modelName(config.model, "");
	if (configuredModel) return configuredModel;
	return modelName(route, "") || textOrNull(route.model);
}

function collectLogs(root: string): SessionLog[] {
	const candidates = walkFiles(
		path.join(root, "sessions"),
		(_filePath, name) =>
			name.startsWith("session") &&
			(name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd")),
	);
	const bySessionDirectory = new Map<string, SessionLog>();
	for (const filePath of candidates) {
		const candidate = {
			filePath,
			generation: generationOf(path.basename(filePath)),
		};
		const key = path.dirname(filePath);
		const current = bySessionDirectory.get(key);
		if (!current || candidate.generation > current.generation) {
			bySessionDirectory.set(key, candidate);
		}
	}
	return [...bySessionDirectory.values()];
}

function readLog(filePath: string): unknown[] {
	const bytes = readFileSync(filePath);
	const text = filePath.endsWith(".zstd")
		? zstdDecompressSync(bytes).toString("utf8")
		: bytes.toString("utf8");
	return parseJsonl(text);
}

export function readDsh(): SourceResult {
	const roots = process.env.DSH_HOME
		? [path.resolve(expandHome(process.env.DSH_HOME))]
		: [
				path.join(homeDir, ".dsh"),
				path.join(homeDir, "Library/Application Support/dsh-desktop/harness"),
			];
	const existingRoots = roots.filter((root) =>
		existsSync(path.join(root, "sessions")),
	);
	const result = blankSourceResult("dsh", existingRoots.length > 0);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	const seenEvents = new Set<string>();
	for (const root of existingRoots) {
		for (const log of collectLogs(root)) {
			try {
				const events = readLog(log.filePath).map(objectOrEmpty);
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
						if (text && !text.startsWith("Current runtime context."))
							messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
					}
					if (
						eventType === "request/header" ||
						eventType === "request/context"
					) {
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
								output: usage.outputTokens,
								cacheRead: usage.cacheReadTokens,
								cacheWrite: usage.cacheWriteTokens,
								reasoning: usage.reasoningTokens,
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
	}
	result.records = uniqueBy(
		records,
		(record) => `${record.sessionId}:${record.messageId}`,
	);
	result.messages = messages;
	return result;
}
