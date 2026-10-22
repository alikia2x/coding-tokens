import path from "node:path";
import type { HarnessName, UsageRecord, UsageTotals } from "@shared/types";

export interface RecordFilters {
	from?: number | null;
	until?: number | null;
	harnesses?: ReadonlySet<HarnessName> | null;
	projects?: ReadonlySet<string> | null;
	models?: ReadonlySet<string> | null;
}

export function emptyTotals(): UsageTotals {
	return {
		sessions: 0,
		messages: 0,
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: 0,
		estimatedRequests: 0,
		unpricedRequests: 0,
	};
}

export function addRecord(totals: UsageTotals, record: UsageRecord): void {
	totals.requests += 1;
	totals.inputTokens += record.inputTokens;
	totals.outputTokens += record.outputTokens;
	totals.cacheReadTokens += record.cacheReadTokens;
	totals.cacheWriteTokens += record.cacheWriteTokens;
	totals.reasoningTokens += record.reasoningTokens;
	if (record.costUsd === null) {
		totals.unpricedRequests += 1;
	} else {
		totals.costUsd += record.costUsd;
		if (record.costEstimated) totals.estimatedRequests += 1;
	}
}

export function mergeTotals(target: UsageTotals, source: UsageTotals): void {
	target.sessions += source.sessions;
	target.messages += source.messages;
	target.requests += source.requests;
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.costUsd += source.costUsd;
	target.estimatedRequests += source.estimatedRequests;
	target.unpricedRequests += source.unpricedRequests;
}

export function roundTotals(totals: UsageTotals): UsageTotals {
	return { ...totals, costUsd: Number(totals.costUsd.toFixed(8)) };
}

export function totalTokens(totals: UsageTotals): number {
	return (
		totals.inputTokens +
		totals.outputTokens +
		totals.cacheReadTokens +
		totals.cacheWriteTokens
	);
}

export function sessionKey(
	record: Pick<UsageRecord, "harness" | "sessionId">,
): string {
	return `${record.harness}:${record.sessionId}`;
}

export function isCumulative(record: UsageRecord): boolean {
	return record.messageId.endsWith(":cumulative-total");
}

export function summarizeSessionRecords(records: UsageRecord[]): UsageTotals {
	const totals = emptyTotals();
	if (!records.length) return totals;
	const cumulative = records.filter(isCumulative);
	const basis = cumulative.length
		? [cumulative.at(-1) as UsageRecord]
		: records;
	for (const record of basis) addRecord(totals, record);
	if (cumulative.length) {
		totals.requests = records.filter((record) => !isCumulative(record)).length;
	}
	totals.sessions = 1;
	totals.costUsd = Number(totals.costUsd.toFixed(8));
	return totals;
}

export function summarizeRecords(records: UsageRecord[]): UsageTotals {
	const bySession = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = sessionKey(record);
		const list = bySession.get(key) ?? [];
		list.push(record);
		bySession.set(key, list);
	}
	const totals = emptyTotals();
	for (const sessionRecords of bySession.values()) {
		mergeTotals(totals, summarizeSessionRecords(sessionRecords));
	}
	return { ...totals, costUsd: Number(totals.costUsd.toFixed(8)) };
}

export function recordMatches(
	record: UsageRecord,
	filters: RecordFilters,
): boolean {
	if (filters.harnesses && !filters.harnesses.has(record.harness)) return false;
	if (filters.projects) {
		const cwd = record.cwd ? path.normalize(record.cwd) : null;
		if (!cwd || !filters.projects.has(cwd)) return false;
	}
	if (filters.models && !filters.models.has(record.model)) return false;
	if (filters.from === undefined || filters.from === null) {
		if (filters.until === undefined || filters.until === null) return true;
	}
	if (record.timestamp === null || !Number.isFinite(record.timestamp))
		return false;
	if (
		filters.from !== undefined &&
		filters.from !== null &&
		record.timestamp < filters.from
	)
		return false;
	if (
		filters.until !== undefined &&
		filters.until !== null &&
		record.timestamp >= filters.until
	)
		return false;
	return true;
}

export function filterRecords(
	records: readonly UsageRecord[],
	filters: RecordFilters,
): UsageRecord[] {
	return records.filter((record) => recordMatches(record, filters));
}

export function projectName(cwd: string | null): string {
	if (!cwd) return "Unknown project";
	const normalized = path.normalize(cwd).replace(/\/+$/u, "");
	const name = path.basename(normalized);
	return name || normalized;
}

export type BucketUnit = "hour" | "day" | "week" | "month";

export interface Bucket {
	key: string;
	label: string;
	start: number;
	end: number;
	totals: UsageTotals;
}

function startOfHour(date: Date): Date {
	const value = new Date(date);
	value.setMinutes(0, 0, 0);
	return value;
}

function startOfDay(date: Date): Date {
	const value = new Date(date);
	value.setHours(0, 0, 0, 0);
	return value;
}

function startOfMonth(date: Date): Date {
	const value = new Date(date);
	value.setDate(1);
	value.setHours(0, 0, 0, 0);
	return value;
}

function startOfWeek(date: Date): Date {
	const value = startOfDay(date);
	const day = value.getDay();
	const delta = day === 0 ? -6 : 1 - day;
	value.setDate(value.getDate() + delta);
	return value;
}

function dateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function hourKey(date: Date): string {
	return `${dateKey(date)}T${String(date.getHours()).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function nextBucket(date: Date, unit: BucketUnit): Date {
	const value = new Date(date);
	if (unit === "hour") value.setHours(value.getHours() + 1);
	else if (unit === "day") value.setDate(value.getDate() + 1);
	else if (unit === "week") value.setDate(value.getDate() + 7);
	else value.setMonth(value.getMonth() + 1);
	return value;
}

export function chooseBucketUnit(
	from: number | null,
	until: number | null,
): BucketUnit {
	if (from === null || until === null) return "day";
	const span = until - from;
	if (span <= 48 * 60 * 60 * 1000) return "hour";
	if (span <= 180 * 24 * 60 * 60 * 1000) return "day";
	return "week";
}

export function bucketize(
	records: readonly UsageRecord[],
	from: number | null,
	until: number | null,
	unit: BucketUnit,
): Bucket[] {
	const timestamps = records
		.map((record) => record.timestamp)
		.filter(
			(value): value is number => value !== null && Number.isFinite(value),
		);
	if (!records.length && (from === null || until === null)) return [];
	const startMs =
		from ?? (timestamps.length ? Math.min(...timestamps) : Date.now());
	let endMs =
		until ?? (timestamps.length ? Math.max(...timestamps) + 1 : Date.now());
	if (endMs <= startMs) endMs = startMs + 1;
	const startDate =
		unit === "hour"
			? startOfHour(new Date(startMs))
			: unit === "day"
				? startOfDay(new Date(startMs))
				: unit === "week"
					? startOfWeek(new Date(startMs))
					: startOfMonth(new Date(startMs));
	const endDate = new Date(endMs);
	const buckets: Bucket[] = [];
	const byKey = new Map<string, Bucket>();
	let cursor = startDate;
	let guard = 0;
	while (cursor < endDate && guard < 2000) {
		const next = nextBucket(cursor, unit);
		const key =
			unit === "hour"
				? hourKey(cursor)
				: unit === "month"
					? monthKey(cursor)
					: dateKey(cursor);
		const label =
			unit === "hour"
				? `${String(cursor.getHours()).padStart(2, "0")}:00`
				: unit === "month"
					? cursor.toLocaleDateString(undefined, {
							month: "short",
							year: "numeric",
						})
					: cursor.toLocaleDateString(undefined, {
							month: "short",
							day: "numeric",
						});
		const bucket: Bucket = {
			key,
			label,
			start: cursor.getTime(),
			end: next.getTime(),
			totals: emptyTotals(),
		};
		buckets.push(bucket);
		byKey.set(key, bucket);
		cursor = next;
		guard += 1;
	}
	const sessionSets = new Map<string, Set<string>>();
	for (const record of records) {
		if (record.timestamp === null || !Number.isFinite(record.timestamp))
			continue;
		const date = new Date(record.timestamp);
		const key =
			unit === "hour"
				? hourKey(date)
				: unit === "month"
					? monthKey(date)
					: dateKey(date);
		const bucket = byKey.get(key);
		if (!bucket) continue;
		addRecord(bucket.totals, record);
		const set = sessionSets.get(key) ?? new Set<string>();
		set.add(sessionKey(record));
		sessionSets.set(key, set);
	}
	for (const bucket of buckets) {
		bucket.totals.sessions = sessionSets.get(bucket.key)?.size ?? 0;
		bucket.totals.costUsd = Number(bucket.totals.costUsd.toFixed(8));
	}
	return buckets;
}

export function sparkline(
	records: readonly UsageRecord[],
	from: number | null,
	until: number | null,
	points = 14,
): number[] {
	if (!records.length) return [];
	const timestamps = records
		.map((record) => record.timestamp)
		.filter(
			(value): value is number => value !== null && Number.isFinite(value),
		);
	const first =
		from ?? (timestamps.length ? Math.min(...timestamps) : Date.now());
	const last =
		until ?? (timestamps.length ? Math.max(...timestamps) + 1 : Date.now());
	const span = Math.max(1, last - first);
	const values = new Array<number>(points).fill(0);
	for (const record of records) {
		if (record.timestamp === null || record.costUsd === null) continue;
		const ratio = (record.timestamp - first) / span;
		const index = Math.min(points - 1, Math.max(0, Math.floor(ratio * points)));
		values[index] = (values[index] ?? 0) + record.costUsd;
	}
	return values.map((value) => Number(value.toFixed(6)));
}

export function sessionSortValue(totals: UsageTotals): number {
	return totals.inputTokens + totals.outputTokens;
}
