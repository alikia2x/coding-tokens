import type {
	ExploreBucket,
	ExploreDimension,
	ExploreMetric,
	ExploreMode,
	ExplorePayload,
	ExploreRow,
	ExploreSeries,
	UsageRecord,
	UsageTotals,
} from "@shared/types";
import { HARNESS_LABELS, type HarnessName } from "@shared/types";
import { store } from "./store";
import {
	bucketize,
	emptyTotals,
	filterRecords,
	projectName,
	type RecordFilters,
	summarizeRecords,
	totalTokens,
} from "./totals";

export interface ExploreOptions {
	filters: RecordFilters;
	mode: ExploreMode;
	metric: ExploreMetric;
	dimension: ExploreDimension;
	bucket: ExploreBucket;
	breakdown: ExploreDimension | "none";
	limit?: number;
}

function metricValue(totals: UsageTotals, metric: ExploreMetric): number {
	switch (metric) {
		case "tokens":
			return totalTokens(totals);
		case "cost":
			return totals.costUsd;
		case "requests":
			return totals.requests;
		case "sessions":
			return totals.sessions;
	}
}

function groupKey(record: UsageRecord, dimension: ExploreDimension): string {
	if (dimension === "harness") return record.harness;
	if (dimension === "project") return record.cwd ?? "";
	return record.model;
}

function groupLabel(key: string, dimension: ExploreDimension): string {
	if (dimension === "harness") return HARNESS_LABELS[key as HarnessName] ?? key;
	if (dimension === "project") return projectName(key || null);
	return key || "Unrecorded model";
}

function sortByMetric<T extends { totals: UsageTotals }>(
	rows: T[],
	metric: ExploreMetric,
): T[] {
	return [...rows].sort(
		(left, right) =>
			metricValue(right.totals, metric) - metricValue(left.totals, metric),
	);
}

function seriesFor(
	groups: Array<{ key: string; label: string; records: UsageRecord[] }>,
	buckets: ReturnType<typeof bucketize>,
	metric: ExploreMetric,
	unit: ExploreBucket,
): ExploreSeries[] {
	return groups.map((group) => {
		const groupBuckets = bucketize(
			group.records,
			buckets[0]?.start ?? null,
			buckets.at(-1)?.end ?? null,
			unit,
		);
		const byKey = new Map(groupBuckets.map((bucket) => [bucket.key, bucket]));
		return {
			key: group.key,
			label: group.label,
			totals: summarizeRecords(group.records),
			points: buckets.map((bucket) => ({
				label: bucket.label,
				value: metricValue(
					byKey.get(bucket.key)?.totals ?? emptyTotals(),
					metric,
				),
			})),
		};
	});
}

export function explorePayload(options: ExploreOptions): ExplorePayload {
	const filtered = filterRecords(store.allRecords(), options.filters);
	const payload = build(options, filtered);
	payload.totals.messages = store.messagesFor(filtered);
	return payload;
}

function build(
	options: ExploreOptions,
	records: UsageRecord[],
): ExplorePayload {
	const breakdown = options.breakdown;
	const totals = summarizeRecords(records);
	if (options.mode === "dimension") {
		const groups = new Map<string, UsageRecord[]>();
		for (const record of records) {
			const key = groupKey(record, options.dimension);
			const list = groups.get(key) ?? [];
			list.push(record);
			groups.set(key, list);
		}
		const rows: ExploreRow[] = sortByMetric(
			[...groups.entries()].map(([key, groupRecords]) => ({
				key,
				label: groupLabel(key, options.dimension),
				totals: summarizeRecords(groupRecords),
			})),
			options.metric,
		).slice(0, options.limit ?? 30);
		return {
			from: options.filters.from ?? null,
			until: options.filters.until ?? null,
			mode: options.mode,
			metric: options.metric,
			dimension: options.dimension,
			bucket: options.bucket,
			breakdown: breakdown,
			series: [],
			rows,
			totals,
			xLabels: rows.map((row) => row.label),
			starts: [],
		};
	}

	const buckets = bucketize(
		records,
		options.filters.from ?? null,
		options.filters.until ?? null,
		options.bucket,
	);
	const groupMap = new Map<string, UsageRecord[]>();
	if (breakdown === "none") {
		groupMap.set("all", records);
	} else {
		for (const record of records) {
			const key = groupKey(record, breakdown);
			const list = groupMap.get(key) ?? [];
			list.push(record);
			groupMap.set(key, list);
		}
	}
	let groups = sortByMetric(
		[...groupMap.entries()].map(([key, groupRecords]) => ({
			key,
			label: breakdown === "none" ? "All" : groupLabel(key, breakdown),
			records: groupRecords,
			totals: summarizeRecords(groupRecords),
		})),
		options.metric,
	);
	const limit = options.limit ?? 8;
	if (groups.length > limit) {
		const head = groups.slice(0, limit - 1);
		const rest = groups.slice(limit - 1);
		groups = [
			...head,
			{
				key: "__other",
				label: "Other",
				records: rest.flatMap((group) => group.records),
				totals: summarizeRecords(rest.flatMap((group) => group.records)),
			},
		];
	}
	const series = seriesFor(groups, buckets, options.metric, options.bucket);
	return {
		from: options.filters.from ?? null,
		until: options.filters.until ?? null,
		mode: options.mode,
		metric: options.metric,
		dimension: options.dimension,
		bucket: options.bucket,
		breakdown: breakdown,
		series,
		rows: series.map((item) => ({
			key: item.key,
			label: item.label,
			totals: item.totals,
		})),
		totals,
		xLabels: buckets.map((bucket) => bucket.label),
		starts: buckets.map((bucket) => bucket.start),
	};
}
