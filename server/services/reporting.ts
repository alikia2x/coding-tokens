import type {
	ExploreOptions,
	ExplorePayload,
	HarnessReportPayload,
	HeatmapPayload,
	ModelReportPayload,
	OverviewPayload,
	ProjectReportPayload,
	RecordFilters,
	SessionSummary,
	UsageRecord,
	UsageTotals,
} from "../../src/types";
import { explorePayload } from "../data/explore";
import { heatmapPayload } from "../data/heatmap";
import {
	harnessReportPayload,
	modelReportPayload,
	overviewPayload,
	projectReportPayload,
} from "../data/reports";
import { store } from "../data/store";
import { summarizeRecords } from "../data/totals";

export interface ReportingDataProvider {
	getRecords(): readonly UsageRecord[];
	getMessagesFor(records: readonly UsageRecord[]): number;
	getSessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): SessionSummary[];
	getWarnings(): string[];
	getLastIndexedAt(): number | null;
	getSourcePaths(): Record<string, string[]>;
}

export class StoreReportingDataProvider implements ReportingDataProvider {
	getRecords(): readonly UsageRecord[] {
		return store.allRecords();
	}

	getMessagesFor(records: readonly UsageRecord[]): number {
		return store.messagesFor(records);
	}

	getSessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): SessionSummary[] {
		return store.sessionSummaries(range);
	}

	getWarnings(): string[] {
		return [...new Set(store.warningList())];
	}

	getLastIndexedAt(): number | null {
		return store.status().indexedAt;
	}

	getSourcePaths(): Record<string, string[]> {
		return store.sourcePaths();
	}
}

export interface ReportingService {
	getOverview(filters: RecordFilters): OverviewPayload;
	getProjectReport(filters: RecordFilters): ProjectReportPayload;
	getModelReport(filters: RecordFilters): ModelReportPayload;
	getHarnessReport(
		filters: RecordFilters,
		paths?: Record<string, string[]>,
	): HarnessReportPayload;
	getExploreReport(options: ExploreOptions): ExplorePayload;
	getHeatmapReport(weeks?: number): HeatmapPayload;
	calculateTotals(records: readonly UsageRecord[]): UsageTotals;
}

export class DefaultReportingService implements ReportingService {
	constructor(
		private readonly dataProvider: ReportingDataProvider = new StoreReportingDataProvider(),
	) {}

	getOverview(filters: RecordFilters): OverviewPayload {
		return overviewPayload(filters);
	}

	getProjectReport(filters: RecordFilters): ProjectReportPayload {
		return projectReportPayload(filters);
	}

	getModelReport(filters: RecordFilters): ModelReportPayload {
		return modelReportPayload(filters);
	}

	getHarnessReport(
		filters: RecordFilters,
		paths?: Record<string, string[]>,
	): HarnessReportPayload {
		const resolvedPaths = paths ?? this.dataProvider.getSourcePaths();
		return harnessReportPayload(filters, resolvedPaths);
	}

	getExploreReport(options: ExploreOptions): ExplorePayload {
		return explorePayload(options);
	}

	getHeatmapReport(weeks = 53): HeatmapPayload {
		return heatmapPayload(weeks);
	}

	calculateTotals(records: readonly UsageRecord[]): UsageTotals {
		return summarizeRecords(records as UsageRecord[]);
	}
}

export function createReportingService(
	dataProvider?: ReportingDataProvider,
): ReportingService {
	return new DefaultReportingService(dataProvider);
}

export const defaultReportingService = new DefaultReportingService();
