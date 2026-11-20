import { dateLocaleFor, formatRangeDates } from "./date-locale";

export interface RangeTextFormatter {
	all: string;
	fromDate: (date: string) => string;
	untilDate: (date: string) => string;
}

let activeLocale: string | undefined;
let activeRangeFormatter: RangeTextFormatter = {
	all: "All time",
	fromDate: (date) => `From ${date}`,
	untilDate: (date) => `Until ${date}`,
};

export function setFormatLocale(
	locale: string,
	rangeFormatter?: RangeTextFormatter,
): void {
	activeLocale = locale;
	if (rangeFormatter) activeRangeFormatter = rangeFormatter;
}

export function totalTokens(totals: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}): number {
	return (
		totals.inputTokens +
		totals.outputTokens +
		totals.cacheReadTokens +
		totals.cacheWriteTokens
	);
}

function numberFormat(): Intl.NumberFormat {
	return new Intl.NumberFormat(activeLocale);
}

function currencyFormat(): Intl.NumberFormat {
	return new Intl.NumberFormat(activeLocale, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function preciseCurrencyFormat(): Intl.NumberFormat {
	return new Intl.NumberFormat(activeLocale, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
	});
}

function dateFormat(): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(activeLocale, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function dateTimeFormat(): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(activeLocale, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function formatNumber(value: number): string {
	return numberFormat().format(value);
}

export function formatCompact(value: number): string {
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000_000)
		return `${trimFixed(value / 1_000_000_000, 2)}B`;
	if (absolute >= 1_000_000) return `${trimFixed(value / 1_000_000, 2)}M`;
	if (absolute >= 1_000) return `${trimFixed(value / 1_000, 1)}k`;
	return numberFormat().format(value);
}

function trimFixed(value: number, digits: number): string {
	const fixed = value.toFixed(digits);
	return fixed.replace(/\.0+$/u, "").replace(/(\.\d*[1-9])0+$/u, "$1");
}

export function formatTokens(value: number): string {
	return formatCompact(value);
}

export function formatCost(value: number): string {
	return Math.abs(value) > 0 && Math.abs(value) < 0.01
		? preciseCurrencyFormat().format(value)
		: currencyFormat().format(value);
}

export function formatCostAxis(value: number): string {
	if (!Number.isFinite(value)) return "";
	if (Math.abs(value) >= 1) return `$${trimFixed(value, 0)}`;
	return `$${trimFixed(value, 2)}`;
}

export function formatCostExact(value: number): string {
	return preciseCurrencyFormat().format(value);
}

export function formatPercent(value: number | null, digits = 1): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${(value * 100).toFixed(digits)}%`;
}

export function formatIntegerPercent(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${Math.round(value * 100)}%`;
}

export function formatDuration(value: number | null): string {
	if (value === null || !Number.isFinite(value) || value < 0) return "—";
	const seconds = Math.floor(value / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

export function formatLatency(value: number | null | undefined): string {
	if (
		value === null ||
		value === undefined ||
		!Number.isFinite(value) ||
		value < 0
	)
		return "—";
	if (value < 1000) return `${Math.round(value)}ms`;
	if (value < 60_000) {
		const seconds = value / 1000;
		return seconds < 10
			? `${trimFixed(seconds, 2)}s`
			: `${trimFixed(seconds, 1)}s`;
	}
	return formatDuration(value);
}

export function formatThroughput(value: number | null | undefined): string {
	if (
		value === null ||
		value === undefined ||
		!Number.isFinite(value) ||
		value <= 0
	)
		return "—";
	return `${trimFixed(value, 1)} tok/s`;
}

export function formatDate(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return dateFormat().format(new Date(value));
}

export function formatDateTime(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return dateTimeFormat().format(new Date(value));
}

export function formatRelativeTime(
	value: number | null,
	now = Date.now(),
): string {
	if (value === null || !Number.isFinite(value)) return "—";
	const delta = now - value;
	const relative = new Intl.RelativeTimeFormat(activeLocale, {
		numeric: "auto",
	});
	if (delta < 60_000) return relative.format(0, "second");
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return relative.format(-minutes, "minute");
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return relative.format(-hours, "hour");
	const days = Math.floor(hours / 24);
	if (days < 30) return relative.format(-days, "day");
	const months = Math.floor(days / 30);
	if (months < 12) return relative.format(-months, "month");
	return relative.format(-Math.floor(months / 12), "year");
}

export function formatRangeLabel(
	from: number | null,
	until: number | null,
): string {
	if (from === null && until === null) return activeRangeFormatter.all;
	const locale = dateLocaleFor(
		activeLocale ??
			(typeof navigator !== "undefined" ? navigator.language : "en"),
	).code;
	if (from === null) {
		const end = Math.max(0, (until as number) - 1);
		return activeRangeFormatter.untilDate(
			formatRangeDates(end, end + 1, locale),
		);
	}
	if (until === null) {
		return activeRangeFormatter.fromDate(
			formatRangeDates(from, from + 1, locale),
		);
	}
	return formatRangeDates(from, until, locale);
}

export function formatDayLabel(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return new Intl.DateTimeFormat(activeLocale, {
		weekday: "short",
		month: "short",
		day: "numeric",
	}).format(new Date(value));
}

export function formatDelta(
	current: number,
	previous: number | null,
): { label: string; direction: "up" | "down" | "flat" } | null {
	if (previous === null || !Number.isFinite(previous) || previous === 0)
		return null;
	const delta = (current - previous) / previous;
	if (Math.abs(delta) < 0.0005) return { label: "0%", direction: "flat" };
	return {
		label: `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`,
		direction: delta > 0 ? "up" : "down",
	};
}

export function modelLabel(model: string): string {
	return model === "Unknown model" ? "Unknown model" : model;
}

export function truncate(value: string, length: number): string {
	const characters = Array.from(value);
	if (characters.length <= length) return value;
	return `${characters
		.slice(0, length - 1)
		.join("")
		.trimEnd()}…`;
}
