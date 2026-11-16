import { formatRangeLabel } from "./format";
import type { TranslationKey } from "./i18n";

export const RANGE_KEYS = [
	"today",
	"yesterday",
	"7d",
	"30d",
	"90d",
	"month",
	"last-month",
	"year",
	"all",
	"custom",
] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

export interface ResolvedRange {
	key: RangeKey;
	from: number | null;
	until: number | null;
	label: string;
	fromInput: string;
	toInput: string;
}

export interface RangeSelection {
	key: RangeKey;
	from?: number | null;
	until?: number | null;
}

export interface PersistedRange {
	key: RangeKey;
	from: number | null;
	until: number | null;
}

export const RANGE_PRESETS: Array<{
	key: Exclude<RangeKey, "custom">;
	label: TranslationKey;
}> = [
	{ key: "today", label: "range.today" },
	{ key: "yesterday", label: "range.yesterday" },
	{ key: "7d", label: "range.last7Days" },
	{ key: "30d", label: "range.last30Days" },
	{ key: "90d", label: "range.last90Days" },
	{ key: "month", label: "range.thisMonth" },
	{ key: "last-month", label: "range.lastMonth" },
	{ key: "year", label: "range.thisYear" },
	{ key: "all", label: "range.all" },
];

const RANGE_STORAGE_KEY = "coding-tokens-range";
const MINUTE_MS = 60_000;

export function isRangeKey(
	value: string | null | undefined,
): value is RangeKey {
	return value !== null && value !== undefined
		? (RANGE_KEYS as readonly string[]).includes(value)
		: false;
}

function startOfDay(value: number): number {
	const date = new Date(value);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function startOfMonth(value: number): number {
	const date = new Date(value);
	date.setDate(1);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function startOfYear(value: number): number {
	const date = new Date(value);
	date.setMonth(0, 1);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function toLocalInput(value: number): string {
	const date = new Date(value);
	const pad = (part: number) => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate(),
	)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseLocalInput(value: string | null): number | null {
	if (!value) return null;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value) ??
		/^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = match[4] === undefined ? 0 : Number(match[4]);
	const minute = match[5] === undefined ? 0 : Number(match[5]);
	const date = new Date(year, month - 1, day, hour, minute, 0, 0);
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day ||
		date.getHours() !== hour ||
		date.getMinutes() !== minute
	)
		return null;
	return date.getTime();
}

function presetRange(
	key: Exclude<RangeKey, "custom" | "all">,
	now: number,
): { from: number; until: number } {
	const today = startOfDay(now);
	switch (key) {
		case "today":
			return { from: today, until: now };
		case "yesterday":
			return { from: today - 86_400_000, until: today };
		case "7d":
			return { from: today - 6 * 86_400_000, until: now };
		case "30d":
			return { from: today - 29 * 86_400_000, until: now };
		case "90d":
			return { from: today - 89 * 86_400_000, until: now };
		case "month":
			return { from: startOfMonth(now), until: now };
		case "last-month": {
			const thisMonth = startOfMonth(now);
			const previousMonth = new Date(thisMonth);
			previousMonth.setMonth(previousMonth.getMonth() - 1);
			return { from: previousMonth.getTime(), until: thisMonth };
		}
		case "year":
			return { from: startOfYear(now), until: now };
	}
}

function presetLabel(key: RangeKey): string {
	return (
		RANGE_PRESETS.find((preset) => preset.key === key)?.label ??
		"range.last30Days"
	);
}

function allTimeRange(now: number): ResolvedRange {
	return {
		key: "all",
		from: null,
		until: null,
		label: "range.all",
		fromInput: toLocalInput(now - 7 * 86_400_000),
		toInput: toLocalInput(now),
	};
}

function customRange(
	from: number | null,
	until: number | null,
): ResolvedRange | null {
	if (from === null && until === null) return null;
	if (from !== null && until !== null) {
		const toInput = toLocalInput(until - MINUTE_MS);
		const untilStart = parseLocalInput(toInput);
		if (untilStart === null || untilStart <= from) return null;
		return {
			key: "custom",
			from,
			until: untilStart + MINUTE_MS,
			label: formatRangeLabel(from, untilStart + MINUTE_MS),
			fromInput: toLocalInput(from),
			toInput,
		};
	}
	if (from !== null) {
		return {
			key: "custom",
			from,
			until: null,
			label: formatRangeLabel(from, null),
			fromInput: toLocalInput(from),
			toInput: "",
		};
	}
	const toInput = toLocalInput((until as number) - MINUTE_MS);
	const untilStart = parseLocalInput(toInput);
	if (untilStart === null) return null;
	return {
		key: "custom",
		from: null,
		until: untilStart + MINUTE_MS,
		label: formatRangeLabel(null, untilStart + MINUTE_MS),
		fromInput: "",
		toInput,
	};
}

function presetResolvedRange(
	key: Exclude<RangeKey, "custom" | "all">,
	now: number,
): ResolvedRange {
	const { from, until } = presetRange(key, now);
	return {
		key,
		from,
		until,
		label: presetLabel(key),
		fromInput: toLocalInput(from),
		toInput: toLocalInput(until),
	};
}

/**
 * Resolve a range key and its (optional) raw `from`/`to` query values.
 * Returns `null` when the values are missing, unknown, or do not describe a
 * valid range, so callers can fall back to persisted or default state.
 */
export function parseRangeValues(
	keyValue: string | null | undefined,
	fromValue: string | null | undefined,
	toValue: string | null | undefined,
	now = Date.now(),
): ResolvedRange | null {
	if (!isRangeKey(keyValue)) return null;
	if (keyValue === "all") return allTimeRange(now);
	if (keyValue === "custom") {
		const from = parseLocalInput(fromValue ?? null);
		const untilStart = parseLocalInput(toValue ?? null);
		if (from === null && untilStart === null) return null;
		if (from !== null && untilStart !== null && untilStart <= from) return null;
		return customRange(
			from,
			untilStart !== null ? untilStart + MINUTE_MS : null,
		);
	}
	return presetResolvedRange(keyValue, now);
}

export function parseRangeParams(
	search: URLSearchParams,
	now = Date.now(),
): ResolvedRange | null {
	return parseRangeValues(
		search.get("range"),
		search.get("from"),
		search.get("to"),
		now,
	);
}

export function resolveRange(
	search: URLSearchParams,
	now = Date.now(),
	fallback = "30d",
): ResolvedRange {
	const parsed = parseRangeParams(search, now);
	if (parsed) return parsed;
	const fallbackKey = isRangeKey(fallback) ? fallback : "30d";
	if (fallbackKey === "all") return allTimeRange(now);
	if (fallbackKey === "custom") return presetResolvedRange("30d", now);
	return presetResolvedRange(fallbackKey, now);
}

/** Build the query string (without a leading `?`) for a resolved range. */
export function rangeQueryString(range: ResolvedRange): string {
	const params = new URLSearchParams();
	params.set("range", range.key);
	if (range.key === "custom" && (range.from !== null || range.until !== null)) {
		if (range.from !== null) params.set("from", range.fromInput);
		if (range.until !== null) params.set("to", range.toInput);
	}
	return params.toString();
}

/** Build query parameters for a range selection (`until` is exclusive). */
export function rangeParamsFor(
	selection: RangeSelection,
): Record<string, string> {
	if (selection.key !== "custom") return { range: selection.key };
	const from = selection.from ?? null;
	const until = selection.until ?? null;
	if (from === null && until === null) return { range: "custom" };
	if (from !== null && until !== null && until <= from)
		return { range: "custom" };
	const params: Record<string, string> = { range: "custom" };
	if (from !== null) params.from = toLocalInput(from);
	if (until !== null) params.to = toLocalInput(until - MINUTE_MS);
	return params;
}

export function persistedFromResolved(range: ResolvedRange): PersistedRange {
	if (range.key !== "custom") {
		return { key: range.key, from: null, until: null };
	}
	return { key: range.key, from: range.from, until: range.until };
}

export function resolvePersistedRange(
	persisted: PersistedRange | null,
	now = Date.now(),
): ResolvedRange | null {
	if (!persisted) return null;
	if (persisted.key === "all") return allTimeRange(now);
	if (persisted.key === "custom") {
		if (persisted.from === null && persisted.until === null) return null;
		if (
			persisted.from !== null &&
			persisted.until !== null &&
			persisted.until <= persisted.from
		)
			return null;
		return customRange(persisted.from, persisted.until);
	}
	if (!isRangeKey(persisted.key)) return null;
	return presetResolvedRange(persisted.key, now);
}

export function samePersistedRange(
	left: PersistedRange | null,
	right: PersistedRange | null,
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return (
		left.key === right.key &&
		left.from === right.from &&
		left.until === right.until
	);
}

export function readStoredRange(): PersistedRange | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(RANGE_STORAGE_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const candidate = parsed as Partial<PersistedRange>;
		if (!isRangeKey(candidate.key)) return null;
		if (candidate.key !== "custom")
			return { key: candidate.key, from: null, until: null };
		const from =
			candidate.from === null || candidate.from === undefined
				? null
				: typeof candidate.from === "number" && Number.isFinite(candidate.from)
					? candidate.from
					: undefined;
		const until =
			candidate.until === null || candidate.until === undefined
				? null
				: typeof candidate.until === "number" &&
						Number.isFinite(candidate.until)
					? candidate.until
					: undefined;
		if (from === undefined || until === undefined) return null;
		if (from === null && until === null) return null;
		if (from !== null && until !== null && until <= from) return null;
		return { key: "custom", from, until };
	} catch {
		return null;
	}
}

export function writeStoredRange(range: PersistedRange | null): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (!range) localStorage.removeItem(RANGE_STORAGE_KEY);
		else localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(range));
	} catch {}
}
