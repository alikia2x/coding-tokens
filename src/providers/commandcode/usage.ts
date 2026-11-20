import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
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
	getCommandCodeProjectsRoot,
	getCommandCodeSessionFiles,
} from "./discovery";

export function readCommandCodeUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const projectsRoot = getCommandCodeProjectsRoot(paths);
	const available = existsSync(projectsRoot);
	const result = blankSourceResult("commandcode", available);
	if (!result.available) return result;

	const files = item ? [item.filePath] : getCommandCodeSessionFiles(paths);

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	for (const filePath of files) {
		try {
			const rows = parseJsonl(readFileSync(filePath, "utf8"));
			const header = rows
				.map(objectOrEmpty)
				.find((row) => row.type === "session");
			if (!header) continue;
			const sessionId =
				textOrNull(header.id) ?? path.basename(filePath, ".jsonl");
			const cwd =
				normalizedCwd(header.cwd) ??
				`Unknown directory (${path.basename(path.dirname(filePath))})`;
			const sessionTime = timestampMs(header.timestamp);

			for (let index = 0; index < rows.length; index += 1) {
				const row = objectOrEmpty(rows[index]);
				if (row.type !== "message") continue;
				const message = objectOrEmpty(row.message);
				if (message.role === "user") {
					messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
				}
				const usage = objectOrEmpty(row.usage);
				if (Object.keys(usage).length === 0) continue;
				if (message.role && message.role !== "assistant") continue;

				const rawOutput = numberOrZero(usage.outputTokens);
				const reasoning = numberOrZero(
					usage.reasoningTokens ?? usage.reasoning,
				);
				const outputTokens =
					rawOutput < reasoning ? rawOutput + reasoning : rawOutput;

				records.push(
					usageRecord(
						{
							harness: "commandcode",
							sessionId,
							messageId:
								textOrNull(row.id) ?? `${path.basename(filePath)}:${index}`,
							cwd,
							model: modelName(row.model),
							timestamp: timestampMs(row.timestamp) ?? sessionTime,
						},
						{
							input: usage.inputTokens,
							output: outputTokens,
							cacheRead: usage.cacheReadTokens,
							cacheWrite: usage.cacheWriteTokens,
							reasoning,
							cost: usage.costUsd,
						},
					),
				);
			}
		} catch (error) {
			result.warnings.push(
				`Command Code: failed to read ${filePath} (${String(error)})`,
			);
		}
	}

	result.records = records.filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
