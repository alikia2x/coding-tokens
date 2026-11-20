import { modelProvider } from "@shared/models";
import type {
	BreakdownRow,
	HarnessName,
	HarnessReportPayload,
	HarnessReportRow,
	ModelPricingMeta,
	ModelReportPayload,
	ModelReportRow,
	OverviewPayload,
	ProjectReportPayload,
	ProjectReportRow,
	ProjectSummary,
	SessionSummary,
	SourceResult,
	UsageRecord,
} from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import { store } from "./store";
import {
	type BucketUnit,
	bucketize,
	chooseBucketUnit,
	emptyTotals,
	filterRecords,
	mergeTotals,
	projectName,
	type RecordFilters,
	sparkline,
	summarizeRecords,
	timestampBounds,
	totalTokens,
} from "./totals";

export interface ReportingDataSource {
	getRecords(): readonly UsageRecord[];
	getMessagesFor(records: readonly UsageRecord[]): number;
	getSessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): SessionSummary[];
	getWarnings(): string[];
	getLastIndexedAt(): number | null;
	getHarnessSource?(harness: HarnessName): SourceResult | undefined;
	getModelPricingMeta?(
		model: string,
		records: readonly UsageRecord[],
	): ModelPricingMeta;
}

const defaultReportingSource: ReportingDataSource = {
	getRecords: () => store.allRecords(),
	getMessagesFor: (records) => store.messagesFor(records),
	getSessionSummaries: (range) => store.sessionSummaries(range),
	getWarnings: () => store.warningList(),
	getLastIndexedAt: () => store.lastIndexedAt(),
	getHarnessSource: (harness) => store.source(harness),
	getModelPricingMeta: (model, records) =>
		store.modelPricingMeta(model, records),
};

function warnings(
	source: ReportingDataSource = defaultReportingSource,
): string[] {
	return [...new Set(source.getWarnings())];
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
			return {
				cwd: cwd || null,
				name: projectName(cwd || null),
				totals: summarizeRecords(groupRecords),
				lastActivityAt: timestampBounds(groupRecords)?.max ?? null,
				harnesses: [...new Set(groupRecords.map((record) => record.harness))],
			};
		})
		.sort(
			(left, right) =>
				right.totals.costUsd - left.totals.costUsd ||
				totalTokens(right.totals) - totalTokens(left.totals),
		);
}

function resolveOverviewBucketUnit(
	records: readonly UsageRecord[],
	from: number | null,
	until: number | null,
	requested?: BucketUnit,
): BucketUnit {
	return requested ?? chooseBucketUnit(from, until, records);
}

export function overviewPayload(
	filters: RecordFilters,
	bucketUnit?: BucketUnit,
	source: ReportingDataSource = defaultReportingSource,
): OverviewPayload {
	const allRecords = source.getRecords();
	const records = filterRecords(allRecords, filters);
	const totals = summarizeRecords(records);
	totals.messages = source.getMessagesFor(records);
	const previousWindow = previousRange(
		filters.from ?? null,
		filters.until ?? null,
	);
	const previousRecords = previousWindow
		? filterRecords(allRecords, {
				...filters,
				from: previousWindow.from,
				until: previousWindow.until,
			})
		: null;
	const previousTotals = previousRecords
		? (() => {
				const totals = summarizeRecords(previousRecords);
				totals.messages = source.getMessagesFor(previousRecords);
				return totals;
			})()
		: null;
	const unit = resolveOverviewBucketUnit(
		records,
		filters.from ?? null,
		filters.until ?? null,
		bucketUnit,
	);
	const buckets = bucketize(
		records,
		filters.from ?? null,
		filters.until ?? null,
		unit,
	);
	const projects = projectSummaries(records).slice(0, 6);
	const recentSessions = source
		.getSessionSummaries({
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
		bucketUnit: unit,
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
		warnings: warnings(source),
		indexedAt: source.getLastIndexedAt(),
	};
}

function emptyShare(part: number, whole: number): number {
	return whole > 0 ? part / whole : 0;
}

export function projectReportPayload(
	filters: RecordFilters,
	source: ReportingDataSource = defaultReportingSource,
): ProjectReportPayload {
	const records = filterRecords(source.getRecords(), filters);
	const groups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = record.cwd ?? "";
		const list = groups.get(key) ?? [];
		list.push(record);
		groups.set(key, list);
	}
	const rows: ProjectReportRow[] = [...groups.entries()].map(
		([cwd, groupRecords]) => {
			return {
				cwd: cwd || null,
				name: projectName(cwd || null),
				totals: summarizeRecords(groupRecords),
				lastActivityAt: timestampBounds(groupRecords)?.max ?? null,
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
		warnings: warnings(source),
	};
}

export function modelReportPayload(
	filters: RecordFilters,
	source: ReportingDataSource = defaultReportingSource,
): ModelReportPayload {
	const records = filterRecords(source.getRecords(), filters);
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
			return {
				model,
				provider: modelProvider(model),
				harnesses: [...new Set(groupRecords.map((record) => record.harness))],
				totals,
				lastActivityAt: timestampBounds(groupRecords)?.max ?? null,
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
				pricing: source.getModelPricingMeta
					? source.getModelPricingMeta(model, groupRecords)
					: store.modelPricingMeta(model, groupRecords),
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
		warnings: warnings(source),
	};
}

export function harnessReportPayload(
	filters: RecordFilters,
	paths: Record<string, string[]>,
	source: ReportingDataSource = defaultReportingSource,
): HarnessReportPayload {
	const all = filterRecords(source.getRecords(), filters);
	const totals = summarizeRecords(all);
	const totalTokensAll = totalTokens(totals);
	const byHarness = new Map<HarnessName, UsageRecord[]>();
	for (const record of all) {
		const list = byHarness.get(record.harness) ?? [];
		list.push(record);
		byHarness.set(record.harness, list);
	}
	const providers = defaultHarnessRegistry.getAll();
	const rows: HarnessReportRow[] = providers.map((provider) => {
		const harness = provider.metadata.id;
		const records = byHarness.get(harness) ?? [];
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
		const harnessSource = source.getHarnessSource
			? source.getHarnessSource(harness)
			: store.source(harness);
		return {
			harness,
			label: provider.metadata.displayName,
			color: provider.metadata.color,
			available: harnessSource?.available ?? records.length > 0,
			paths:
				paths[harness] ?? provider.getWatchPaths(defaultPlatformPathService),
			warnings: harnessSource?.warnings ?? [],
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
		warnings: warnings(source),
		indexedAt: source.getLastIndexedAt(),
	};
}

export function overviewSummaryText(
	totals: ReturnType<typeof emptyTotals>,
): string {
	const merged = emptyTotals();
	mergeTotals(merged, totals);
	return `${merged.requests} requests`;
}
