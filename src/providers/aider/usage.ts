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
import { getAiderLocations, parseAiderSessionStarts } from "./discovery";

export function readAiderUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const locations = getAiderLocations(paths);
	const available = locations.length > 0;
	const result = blankSourceResult("aider", available);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	for (const loc of locations) {
		const targetDir = loc.directory;
		const cwd = normalizedCwd(targetDir);

		// If a specific session item is requested, check if it matches this location
		if (
			item &&
			item.filePath !== loc.historyFile &&
			item.filePath !== loc.analyticsFile
		) {
			continue;
		}

		// 1. Parse history file for session messages and transcript statistics
		const sessionUserCounts = new Map<string, number>();
		const sessionCharCounts = new Map<
			string,
			{ inChars: number; outChars: number; timestamp: number | null }
		>();

		if (existsSync(loc.historyFile)) {
			try {
				const historyContent = readFileSync(loc.historyFile, "utf8");
				const sessionStarts = parseAiderSessionStarts(historyContent);
				const defaultSessId =
					sessionStarts[0]?.sessionId ?? `aider-${path.basename(targetDir)}`;

				const lines = historyContent.split(/\r?\n/u);
				let currentSessionId = defaultSessId;
				let currentTimestamp: number | null =
					sessionStarts[0]?.timestampMs ?? null;

				for (const line of lines) {
					if (
						/#\s+aider\s+chat\s+started\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/iu.test(
							line,
						)
					) {
						const match =
							/([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/iu.exec(
								line,
							);
						if (match?.[1]) {
							currentSessionId = `aider-${match[1].replace(/[\s:]/gu, "-")}`;
							const parsed = Date.parse(match[1].replace(" ", "T"));
							currentTimestamp = Number.isNaN(parsed) ? null : parsed;
						}
						continue;
					}

					if (line.startsWith("#### ")) {
						sessionUserCounts.set(
							currentSessionId,
							(sessionUserCounts.get(currentSessionId) ?? 0) + 1,
						);
						const curr = sessionCharCounts.get(currentSessionId) ?? {
							inChars: 0,
							outChars: 0,
							timestamp: currentTimestamp,
						};
						curr.inChars += line.length;
						sessionCharCounts.set(currentSessionId, curr);
					} else if (!line.startsWith("> ") && line.trim().length > 0) {
						const curr = sessionCharCounts.get(currentSessionId) ?? {
							inChars: 0,
							outChars: 0,
							timestamp: currentTimestamp,
						};
						curr.outChars += line.length;
						sessionCharCounts.set(currentSessionId, curr);
					}
				}

				for (const [sessId, count] of sessionUserCounts.entries()) {
					messages.set(sessId, (messages.get(sessId) ?? 0) + count);
				}
			} catch (err) {
				result.warnings.push(
					`Aider: failed to read history ${loc.historyFile} (${String(err)})`,
				);
			}
		}

		// 2. Parse analytics log if present
		let hasAnalyticsRecords = false;
		if (loc.analyticsFile && existsSync(loc.analyticsFile)) {
			try {
				const analyticsText = readFileSync(loc.analyticsFile, "utf8");
				const rows = parseJsonl(analyticsText);

				for (let i = 0; i < rows.length; i++) {
					const row = objectOrEmpty(rows[i]);
					const rawSessId = textOrNull(row.session_id);
					const sessionId = rawSessId
						? rawSessId.startsWith("aider-")
							? rawSessId
							: `aider-${rawSessId}`
						: `aider-${path.basename(targetDir)}`;

					if (item && item.sessionId !== sessionId) {
						continue;
					}

					const model = modelName(row.main_model ?? row.model, "gpt-4o");
					const timestamp = timestampMs(row.timestamp);
					const inputTokens = numberOrZero(
						row.tokens_in ?? row.input_tokens ?? row.tokensIn,
					);
					const outputTokens = numberOrZero(
						row.tokens_out ?? row.output_tokens ?? row.tokensOut,
					);
					const cacheRead = numberOrZero(
						row.tokens_cached ?? row.cache_read ?? row.cacheRead,
					);
					const cost = finiteCostOrNull(
						row.cost !== undefined ? row.cost : row.total_cost,
					);

					records.push(
						usageRecord(
							{
								harness: "aider",
								sessionId,
								messageId: `aider-analytics-${i}`,
								turnId: `turn-${i}`,
								cwd,
								model,
								timestamp,
							},
							{
								input: inputTokens,
								output: outputTokens,
								cacheRead,
								cost,
							},
						),
					);
					hasAnalyticsRecords = true;
				}
			} catch (err) {
				result.warnings.push(
					`Aider: failed to read analytics log ${loc.analyticsFile} (${String(err)})`,
				);
			}
		}

		// 3. Fallback to estimated token usage from markdown if no analytics file exists
		if (!hasAnalyticsRecords && sessionCharCounts.size > 0) {
			for (const [sessId, stats] of sessionCharCounts.entries()) {
				if (item && item.sessionId !== sessId) continue;
				const inputEst = Math.max(1, Math.round(stats.inChars / 3.8));
				const outputEst = Math.max(1, Math.round(stats.outChars / 3.8));

				const rec = usageRecord(
					{
						harness: "aider",
						sessionId: sessId,
						messageId: `${sessId}:estimated`,
						cwd,
						model: "gpt-4o",
						timestamp: stats.timestamp,
					},
					{
						input: inputEst,
						output: outputEst,
						cost: null,
					},
				);
				records.push(rec);
			}
		}
	}

	result.records = records.filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
