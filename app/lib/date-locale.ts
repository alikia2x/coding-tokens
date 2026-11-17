import type { AppLocale } from "@shared/types";
import { useMemo } from "react";
import type { DayPickerLocale } from "react-day-picker";
import { de, enUS, es, fr, ja, ko, zhCN, zhTW } from "react-day-picker/locale";
import { useTranslation } from "react-i18next";

export type DateLocaleCode = AppLocale;

export interface DateLocale {
	code: DateLocaleCode;
	locale: DayPickerLocale;
	weekStartsOn: 0 | 1;
}

const LOCALE_CONFIG: Record<DateLocaleCode, DateLocale> = {
	en: { code: "en", locale: enUS, weekStartsOn: 0 },
	"zh-CN": { code: "zh-CN", locale: zhCN, weekStartsOn: 1 },
	"zh-TW": { code: "zh-TW", locale: zhTW, weekStartsOn: 1 },
	ja: { code: "ja", locale: ja, weekStartsOn: 0 },
	ko: { code: "ko", locale: ko, weekStartsOn: 0 },
	es: { code: "es", locale: es, weekStartsOn: 1 },
	fr: { code: "fr", locale: fr, weekStartsOn: 1 },
	de: { code: "de", locale: de, weekStartsOn: 1 },
};

export function dateLocaleFor(language: string): DateLocale {
	const lower = language.toLowerCase();
	if (
		lower.startsWith("zh-tw") ||
		lower.startsWith("zh-hk") ||
		lower.startsWith("zh-mo") ||
		lower.includes("hant")
	) {
		return LOCALE_CONFIG["zh-TW"];
	}
	if (lower.startsWith("zh")) return LOCALE_CONFIG["zh-CN"];
	if (lower.startsWith("ja")) return LOCALE_CONFIG.ja;
	if (lower.startsWith("ko")) return LOCALE_CONFIG.ko;
	if (lower.startsWith("es")) return LOCALE_CONFIG.es;
	if (lower.startsWith("fr")) return LOCALE_CONFIG.fr;
	if (lower.startsWith("de")) return LOCALE_CONFIG.de;
	return LOCALE_CONFIG.en;
}

export function useDateLocale(): DateLocale {
	const { i18n } = useTranslation();
	return useMemo(() => dateLocaleFor(i18n.language), [i18n.language]);
}

const hourCycleFormats = new Map<string, boolean>();

/** Whether a locale reads clocks as 12-hour (AM/PM) rather than 24-hour. */
export function uses12HourClock(code: DateLocaleCode): boolean {
	let value = hourCycleFormats.get(code);
	if (value === undefined) {
		value =
			new Intl.DateTimeFormat(code, { hour: "numeric" }).resolvedOptions()
				.hour12 ?? false;
		hourCycleFormats.set(code, value);
	}
	return value;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

export function formatPickerDate(
	date: Date,
	code: DateLocaleCode,
	now = new Date(),
): string {
	const withYear = date.getFullYear() !== now.getFullYear();
	const key = `${code}:${withYear ? "year" : "plain"}`;
	let format = dayFormats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(code, {
			weekday: "short",
			month: "short",
			day: "numeric",
			...(withYear ? { year: "numeric" as const } : {}),
		});
		dayFormats.set(key, format);
	}
	return format.format(date);
}

const rangeFormats = new Map<string, Intl.DateTimeFormat>();

function rangeFormat(
	code: DateLocaleCode,
	withYear: boolean,
): Intl.DateTimeFormat {
	const key = `${code}:${withYear ? "year" : "plain"}`;
	let format = rangeFormats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(code, {
			month: "short",
			day: "numeric",
			...(withYear ? { year: "numeric" as const } : {}),
		});
		rangeFormats.set(key, format);
	}
	return format;
}

/** A compact locale-aware label for an inclusive custom range. */
export function formatRangeDates(
	from: number,
	until: number,
	code: DateLocaleCode,
	now = new Date(),
): string {
	const start = new Date(from);
	const end = new Date(Math.max(from, until - 1));
	const currentYear = now.getFullYear();
	const startYear = start.getFullYear();
	const endYear = end.getFullYear();
	const sameDay =
		startYear === endYear &&
		start.getMonth() === end.getMonth() &&
		start.getDate() === end.getDate();

	if (sameDay) {
		return rangeFormat(code, startYear !== currentYear).format(start);
	}

	if (startYear === endYear) {
		const showYear = startYear !== currentYear;
		if (code === "zh-CN" || code === "zh-TW") {
			return `${rangeFormat(code, showYear).format(start)} – ${rangeFormat(
				code,
				false,
			).format(end)}`;
		}
		return rangeFormat(code, showYear).formatRange(start, end);
	}

	if (code === "zh-CN" || code === "zh-TW") {
		return `${rangeFormat(code, true).format(start)} – ${rangeFormat(
			code,
			true,
		).format(end)}`;
	}
	return rangeFormat(code, true).formatRange(start, end);
}

const monthFormats = new Map<DateLocaleCode, Intl.DateTimeFormat>();

/** Short month name that follows the active language immediately. */
export function formatMonthShortFor(
	value: number,
	code: DateLocaleCode,
): string {
	let format = monthFormats.get(code);
	if (!format) {
		format = new Intl.DateTimeFormat(code, { month: "short" });
		monthFormats.set(code, format);
	}
	return format.format(new Date(value));
}

const weekdayFormats = new Map<DateLocaleCode, Intl.DateTimeFormat>();

/** Short weekday name that follows the active language immediately. */
export function formatWeekdayShortFor(
	value: number,
	code: DateLocaleCode,
): string {
	let format = weekdayFormats.get(code);
	if (!format) {
		format = new Intl.DateTimeFormat(code, { weekday: "short" });
		weekdayFormats.set(code, format);
	}
	return format.format(new Date(value));
}

/** Localized calendar date (month, day, year). */
export function formatDateFor(value: number, code: DateLocaleCode): string {
	return rangeFormat(code, true).format(new Date(value));
}

const timeFormats = new Map<DateLocaleCode, Intl.DateTimeFormat>();

/** Localized time-of-day used by chart axes. */
export function formatTimeFor(value: number, code: DateLocaleCode): string {
	let format = timeFormats.get(code);
	if (!format) {
		format = new Intl.DateTimeFormat(code, {
			hour: "numeric",
			minute: "2-digit",
		});
		timeFormats.set(code, format);
	}
	return format.format(new Date(value));
}

/** Localized bucket label for hour/day/week/month chart axes. */
export function formatBucketLabelFor(
	value: number,
	unit: "hour" | "day" | "week" | "month",
	code: DateLocaleCode,
): string {
	if (!Number.isFinite(value)) return "";
	if (unit === "hour") return formatTimeFor(value, code);
	if (unit === "month") return rangeFormat(code, true).format(new Date(value));
	return rangeFormat(code, false).format(new Date(value));
}

const tooltipTimeFormats = new Map<DateLocaleCode, Intl.DateTimeFormat>();

/** Localized bucket label for chart tooltips (includes date for hourly buckets). */
export function formatBucketTooltipLabelFor(
	value: number,
	unit: "hour" | "day" | "week" | "month",
	code: DateLocaleCode,
): string {
	if (!Number.isFinite(value)) return "";
	if (unit === "hour") {
		let format = tooltipTimeFormats.get(code);
		if (!format) {
			format = new Intl.DateTimeFormat(code, {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
			tooltipTimeFormats.set(code, format);
		}
		return format.format(new Date(value));
	}
	return formatBucketLabelFor(value, unit, code);
}
