import type { ModelPricingMeta, SourceResult } from "@shared/types";
import type {
	ExploreOptions,
	ExplorePayload,
	HarnessName,
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
	type ReportingDataSource,
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
	getHarnessSource?(harness: HarnessName): SourceResult | undefined;
	getModelPricingMeta?(
		model: string,
		records: readonly UsageRecord[],
	): ModelPricingMeta;
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
	private readonly source: ReportingDataSource;

	constructor(
		private readonly dataProvider: ReportingDataProvider = new StoreReportingDataProvider(),
	) {
		this.source = {
			getRecords: () => this.dataProvider.getRecords(),
			getMessagesFor: (records) => this.dataProvider.getMessagesFor(records),
			getSessionSummaries: (range) =>
				this.dataProvider.getSessionSummaries(range),
			getWarnings: () => this.dataProvider.getWarnings(),
			getLastIndexedAt: () => this.dataProvider.getLastIndexedAt(),
			getHarnessSource: (harness) =>
				this.dataProvider.getHarnessSource?.(harness) ?? store.source(harness),
			getModelPricingMeta: (model, records) =>
				this.dataProvider.getModelPricingMeta?.(model, records) ??
				store.modelPricingMeta(model, records),
		};
	}

	getOverview(filters: RecordFilters): OverviewPayload {
		return overviewPayload(filters, undefined, this.source);
	}

	getProjectReport(filters: RecordFilters): ProjectReportPayload {
		return projectReportPayload(filters, this.source);
	}

	getModelReport(filters: RecordFilters): ModelReportPayload {
		return modelReportPayload(filters, this.source);
	}

	getHarnessReport(
		filters: RecordFilters,
		paths?: Record<string, string[]>,
	): HarnessReportPayload {
		const resolvedPaths = paths ?? this.dataProvider.getSourcePaths();
		return harnessReportPayload(filters, resolvedPaths, this.source);
	}

	getExploreReport(options: ExploreOptions): ExplorePayload {
		return explorePayload(options, this.source);
	}

	getHeatmapReport(weeks = 53): HeatmapPayload {
		return heatmapPayload(weeks, this.source);
	}

	calculateTotals(records: readonly UsageRecord[]): UsageTotals {
		return summarizeRecords(records);
	}
}

export function createReportingService(
	dataProvider?: ReportingDataProvider,
): ReportingService {
	return new DefaultReportingService(dataProvider);
}

export const defaultReportingService = new DefaultReportingService();
