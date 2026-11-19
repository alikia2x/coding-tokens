import { modelProvider } from "@shared/models";
import type {
	BreakdownRow,
	HarnessName,
	HarnessReportPayload,
	HarnessReportRow,
	ModelReportPayload,
	ModelReportRow,
	OverviewPayload,
	ProjectReportPayload,
	ProjectReportRow,
	ProjectSummary,
	UsageRecord,
} from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import { store } from "./store";
import {
	bucketize,
	chooseBucketUnit,
	emptyTotals,
	filterRecords,
	mergeTotals,
	projectName,
	type RecordFilters,
	sparkline,
	summarizeRecords,
	totalTokens,
} from "./totals";

function warnings(): string[] {
	return [...new Set(store.warningList())];
}

function sortByCost(rows: BreakdownRow[]): BreakdownRow[] {
	return rows.sort(
		(left, right) =>
			right.totals.costUsd - left.totals.costUsd ||
			totalTokens(right.totals) - totalTokens(left.totals),
	);
}

function breakdownBy(
	records: readonly UsageRecord[],
	keyOf: (record: UsageRecord) => string,
	labelOf: (key: string, record: UsageRecord) => string,
): BreakdownRow[] {
	const groups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = keyOf(record);
		const list = groups.get(key) ?? [];
		list.push(record);
		groups.set(key, list);
	}
	return sortByCost(
		[...groups.entries()].map(([key, groupRecords]) => ({
			key,
			label: labelOf(key, groupRecords[0] as UsageRecord),
			harness: groupRecords[0]?.harness,
			totals: summarizeRecords(groupRecords),
		})),
	);
}

function previousRange(
	from: number | null,
	until: number | null,
): { from: number; until: number } | null {
	if (from === null || until === null) return null;
	const span = until - from;
	if (span <= 0) return null;
	return { from: from - span, until: from };
}

function projectSummaries(records: readonly UsageRecord[]): ProjectSummary[] {
	const groups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = record.cwd ?? "";
		const list = groups.get(key) ?? [];
		list.push(record);
		groups.set(key, list);
	}
	return [...groups.entries()]
		.map(([cwd, groupRecords]) => {
			const timestamps = groupRecords
				.map((record) => record.timestamp)
				.filter((value): value is number => value !== null);
			return {
				cwd: cwd || null,
				name: projectName(cwd || null),
				totals: summarizeRecords(groupRecords),
				lastActivityAt: timestamps.length ? Math.max(...timestamps) : null,
				harnesses: [...new Set(groupRecords.map((record) => record.harness))],
			};
		})
		.sort(
			(left, right) =>
				right.totals.costUsd - left.totals.costUsd ||
				totalTokens(right.totals) - totalTokens(left.totals),
		);
}

export function overviewPayload(filters: RecordFilters): OverviewPayload {
	const records = filterRecords(store.allRecords(), filters);
	const totals = summarizeRecords(records);
	totals.messages = store.messagesFor(records);
	const previousWindow = previousRange(
		filters.from ?? null,
		filters.until ?? null,
	);
	const previousRecords = previousWindow
		? filterRecords(store.allRecords(), {
				...filters,
				from: previousWindow.from,
				until: previousWindow.until,
			})
		: null;
	const previousTotals = previousRecords
		? (() => {
				const totals = summarizeRecords(previousRecords);
				totals.messages = store.messagesFor(previousRecords);
				return totals;
			})()
		: null;
	const unit = chooseBucketUnit(filters.from ?? null, filters.until ?? null);
	const buckets = bucketize(
		records,
		filters.from ?? null,
		filters.until ?? null,
		unit,
	);
	const projects = projectSummaries(records).slice(0, 6);
	const recentSessions = store
		.sessionSummaries({
			from: filters.from ?? null,
			until: filters.until ?? null,
		})
		.filter((session) => !session.isSubagent && !session.isReview)
		.filter((session) => {
			if (filters.harnesses && !filters.harnesses.has(session.harness))
				return false;
			if (filters.projects) {
				if (!session.cwd || !filters.projects.has(session.cwd)) return false;
			}
			if (filters.models) {
				if (!session.models.some((model) => filters.models?.has(model)))
					return false;
			}
			return true;
		})
		.slice(0, 7);
	return {
		range: { from: filters.from ?? null, until: filters.until ?? null },
		totals,
		previous: previousTotals,
		bucketUnit: unit === "month" ? "day" : unit,
		buckets,
		harnesses: breakdownBy(
			records,
			(record) => record.harness,
			(key) => HARNESS_LABELS[key as HarnessName] ?? key,
		),
		models: breakdownBy(
			records,
			(record) => record.model,
			(key) => key,
		).slice(0, 7),
		projects,
		recentSessions,
		warnings: warnings(),
		indexedAt: store.lastIndexedAt(),
	};
}

function emptyShare(part: number, whole: number): number {
	return whole > 0 ? part / whole : 0;
}

export function projectReportPayload(
	filters: RecordFilters,
): ProjectReportPayload {
	const records = filterRecords(store.allRecords(), filters);
	const groups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = record.cwd ?? "";
		const list = groups.get(key) ?? [];
		list.push(record);
		groups.set(key, list);
	}
	const rows: ProjectReportRow[] = [...groups.entries()].map(
		([cwd, groupRecords]) => {
			const timestamps = groupRecords
				.map((record) => record.timestamp)
				.filter((value): value is number => value !== null);
			return {
				cwd: cwd || null,
				name: projectName(cwd || null),
				totals: summarizeRecords(groupRecords),
				lastActivityAt: timestamps.length ? Math.max(...timestamps) : null,
				harnesses: [...new Set(groupRecords.map((record) => record.harness))],
				models: [...new Set(groupRecords.map((record) => record.model))],
				sparkline: sparkline(
					groupRecords,
					filters.from ?? null,
					filters.until ?? null,
				),
			};
		},
	);
	rows.sort(
		(left, right) =>
			right.totals.costUsd - left.totals.costUsd ||
			totalTokens(right.totals) - totalTokens(left.totals),
	);
	return {
		rows,
		totals: summarizeRecords(records),
		warnings: warnings(),
	};
}

export function modelReportPayload(filters: RecordFilters): ModelReportPayload {
	const records = filterRecords(store.allRecords(), filters);
	const groups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const list = groups.get(record.model) ?? [];
		list.push(record);
		groups.set(record.model, list);
	}
	const rows: ModelReportRow[] = [...groups.entries()].map(
		([model, groupRecords]) => {
			const totals = summarizeRecords(groupRecords);
			const tokens = totalTokens(totals);
			const timestamps = groupRecords
				.map((record) => record.timestamp)
				.filter((value): value is number => value !== null);
			return {
				model,
				provider: modelProvider(model),
				harnesses: [...new Set(groupRecords.map((record) => record.harness))],
				totals,
				lastActivityAt: timestamps.length ? Math.max(...timestamps) : null,
				costPerMillionTokens:
					tokens > 0 && totals.unpricedRequests < totals.requests
						? (totals.costUsd / tokens) * 1_000_000
						: null,
				cacheReadShare:
					totals.inputTokens +
						totals.cacheReadTokens +
						totals.cacheWriteTokens >
					0
						? emptyShare(
								totals.cacheReadTokens,
								totals.inputTokens +
									totals.cacheReadTokens +
									totals.cacheWriteTokens,
							)
						: null,
				sparkline: sparkline(
					groupRecords,
					filters.from ?? null,
					filters.until ?? null,
				),
				pricing: store.modelPricingMeta(model, groupRecords),
			};
		},
	);
	rows.sort(
		(left, right) =>
			right.totals.costUsd - left.totals.costUsd ||
			totalTokens(right.totals) - totalTokens(left.totals),
	);
	return {
		rows,
		totals: summarizeRecords(records),
		warnings: warnings(),
	};
}

export function harnessReportPayload(
	filters: RecordFilters,
	paths: Record<string, string[]>,
): HarnessReportPayload {
	const all = filterRecords(store.allRecords(), filters);
	const totals = summarizeRecords(all);
	const totalTokensAll = totalTokens(totals);
	const providers = defaultHarnessRegistry.getAll();
	const rows: HarnessReportRow[] = providers.map((provider) => {
		const harness = provider.metadata.id;
		const records = all.filter((record) => record.harness === harness);
		const harnessTotals = summarizeRecords(records);
		const byModel = new Map<string, { costUsd: number; tokens: number }>();
		for (const record of records) {
			const current = byModel.get(record.model) ?? { costUsd: 0, tokens: 0 };
			current.costUsd += record.costUsd ?? 0;
			current.tokens +=
				record.inputTokens +
				record.outputTokens +
				record.cacheReadTokens +
				record.cacheWriteTokens;
			byModel.set(record.model, current);
		}
		const source = store.source(harness);
		return {
			harness,
			label: provider.metadata.displayName,
			color: provider.metadata.color,
			available: source?.available ?? false,
			paths:
				paths[harness] ?? provider.getWatchPaths(defaultPlatformPathService),
			warnings: source?.warnings ?? [],
			totals: harnessTotals,
			costShare: emptyShare(harnessTotals.costUsd, totals.costUsd),
			tokenShare: emptyShare(totalTokens(harnessTotals), totalTokensAll),
			topModels: [...byModel.entries()]
				.map(([model, value]) => ({ model, ...value }))
				.sort((left, right) => right.costUsd - left.costUsd)
				.slice(0, 4),
			sparkline: sparkline(
				records,
				filters.from ?? null,
				filters.until ?? null,
			),
		};
	});
	return {
		rows,
		totals,
		warnings: warnings(),
		indexedAt: store.lastIndexedAt(),
	};
}

export function overviewSummaryText(
	totals: ReturnType<typeof emptyTotals>,
): string {
	const merged = emptyTotals();
	mergeTotals(merged, totals);
	return `${merged.requests} requests`;
}
