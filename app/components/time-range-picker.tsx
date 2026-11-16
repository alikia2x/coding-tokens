import { cn } from "cn";
import {
	ArrowRight,
	CalendarDays,
	Check,
	ChevronDown,
	RotateCcw,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "~/components/ui/button";
import { Calendar } from "~/components/ui/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import {
	formatPickerDate,
	useDateLocale,
	uses12HourClock,
} from "~/lib/date-locale";
import { formatDateTime } from "~/lib/format";
import { useMediaQuery } from "~/lib/hooks";
import { type TranslationKey, useT } from "~/lib/i18n";
import { useRange, useRangeLabel } from "~/lib/range";
import { useSettings } from "~/lib/settings";
import {
	RANGE_PRESETS,
	type RangeKey,
	type ResolvedRange,
	resolveRange,
} from "~/lib/time-range";

const MINUTE_MS = 60_000;
const MINUTES_IN_DAY = 24 * 60;

type Endpoint = "start" | "end";

function startOfDay(date: Date): Date {
	const next = new Date(date);
	next.setHours(0, 0, 0, 0);
	return next;
}

function startOfMonth(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

function minutesSinceMidnight(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}

function atMinutes(date: Date, minutes: number): Date {
	const next = new Date(date);
	next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
	return next;
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function durationLabel(
	from: number | null,
	to: number | null,
	t: (key: TranslationKey, options?: Record<string, unknown>) => string,
): string | null {
	if (from === null || to === null || to < from) return null;
	const totalMinutes = Math.floor((to + MINUTE_MS - from) / MINUTE_MS);
	if (totalMinutes < 1) return t("time.lessThanMinute");
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(t("units.days", { value: days }));
	if (hours > 0) parts.push(t("units.hours", { value: hours }));
	if (days === 0 && minutes > 0)
		parts.push(t("units.minutes", { value: minutes }));
	return parts.join(" ");
}

export function TimeRangePicker() {
	const { range, setRange } = useRange();
	const rangeLabel = useRangeLabel();
	const { settings } = useSettings();
	const t = useT();
	const { locale, weekStartsOn } = useDateLocale();
	const twoMonths = useMediaQuery("(min-width: 780px)");
	const [open, setOpen] = useState(false);
	const [fromDate, setFromDate] = useState<Date | undefined>();
	const [toDate, setToDate] = useState<Date | undefined>();
	const [fromMinutes, setFromMinutes] = useState(0);
	const [toMinutes, setToMinutes] = useState(MINUTES_IN_DAY - 1);
	const [active, setActive] = useState<Endpoint | null>(null);
	const [month, setMonth] = useState(() => startOfMonth(new Date()));
	const [hoverDate, setHoverDate] = useState<Date | null>(null);

	function initializeDraft(): void {
		if (range.from === null && range.until === null) {
			setFromDate(undefined);
			setToDate(undefined);
			setFromMinutes(0);
			setToMinutes(MINUTES_IN_DAY - 1);
			setActive(null);
			setHoverDate(null);
			setMonth(startOfMonth(new Date()));
			return;
		}
		const start = range.from !== null ? new Date(range.from) : null;
		const end =
			range.until !== null
				? new Date(
						range.from !== null
							? Math.max(range.from, range.until - MINUTE_MS)
							: range.until - MINUTE_MS,
					)
				: null;
		setFromDate(start ? startOfDay(start) : undefined);
		setToDate(end ? startOfDay(end) : undefined);
		setFromMinutes(start ? minutesSinceMidnight(start) : 0);
		setToMinutes(end ? minutesSinceMidnight(end) : MINUTES_IN_DAY - 1);
		setActive(null);
		setHoverDate(null);
		setMonth(startOfMonth(start ?? end ?? new Date()));
	}

	function handleOpenChange(next: boolean): void {
		if (next) initializeDraft();
		setOpen(next);
	}

	const fromValue = useMemo(
		() => (fromDate ? atMinutes(fromDate, fromMinutes).getTime() : null),
		[fromDate, fromMinutes],
	);
	const toValue = useMemo(
		() => (toDate ? atMinutes(toDate, toMinutes).getTime() : null),
		[toDate, toMinutes],
	);
	const validation = useMemo(() => {
		if (fromValue === null && toValue === null)
			return t("time.error.chooseDates");
		if (fromValue !== null && toValue !== null && fromValue > toValue)
			return t("time.error.startAfterEnd");
		return null;
	}, [fromValue, toValue, t]);
	const duration = durationLabel(fromValue, toValue, t);
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	// The preview band connects the already-selected start day to the day the
	// pointer is over, without restyling the selected start day itself.
	const previewBand = useMemo(() => {
		if (!fromDate || active !== "end" || !hoverDate) return null;
		const anchor = startOfDay(fromDate);
		const hover = startOfDay(hoverDate);
		if (hover.getTime() === anchor.getTime()) return null;
		if (hover > anchor) return { start: addDays(anchor, 1), end: hover };
		return { start: hover, end: addDays(anchor, -1) };
	}, [fromDate, active, hoverDate]);

	const modifiers = useMemo(() => {
		if (!previewBand) return undefined;
		return {
			preview_start: previewBand.start,
			preview_end: previewBand.end,
			preview_middle: {
				after: previewBand.start,
				before: previewBand.end,
			},
		};
	}, [previewBand]);

	const modifiersClassNames = useMemo(
		() => ({
			preview_start:
				"[&>button]:rounded-l-md [&>button]:bg-accent [&>button]:text-accent-foreground",
			preview_middle:
				"[&>button]:rounded-none [&>button]:bg-accent [&>button]:text-accent-foreground",
			preview_end:
				"[&>button]:rounded-r-md [&>button]:bg-accent [&>button]:text-accent-foreground",
		}),
		[],
	);

	function focusEndpoint(endpoint: Endpoint): void {
		setActive(endpoint);
		setHoverDate(null);
		const date = endpoint === "start" ? fromDate : toDate;
		if (!date) return;
		const visibleMonths = twoMonths ? 2 : 1;
		const offset =
			(date.getFullYear() - month.getFullYear()) * 12 +
			(date.getMonth() - month.getMonth());
		if (offset < 0 || offset >= visibleMonths) setMonth(startOfMonth(date));
	}

	function handleSelect(
		_selected: DateRange | undefined,
		triggerDate: Date,
	): void {
		const clicked = startOfDay(triggerDate);
		setHoverDate(null);

		if (active === "start") {
			setFromDate(clicked);
			if (toDate && clicked > toDate) {
				setToDate(clicked);
				setToMinutes(MINUTES_IN_DAY - 1);
			}
			setActive("end");
			return;
		}

		if (active === "end") {
			if (!fromDate) {
				setToDate(clicked);
				if (clicked.getTime() !== startOfDay(new Date()).getTime()) {
					setToMinutes(MINUTES_IN_DAY - 1);
				}
				setActive(null);
				return;
			}
			if (clicked < fromDate) {
				setFromDate(clicked);
				setToDate(fromDate);
				setToMinutes(MINUTES_IN_DAY - 1);
				setActive(null);
				return;
			}
			setToDate(clicked);
			const today = startOfDay(new Date()).getTime();
			if (clicked.getTime() !== today) {
				setToMinutes(MINUTES_IN_DAY - 1);
			} else if (
				clicked.getTime() === fromDate.getTime() &&
				toMinutes < fromMinutes
			) {
				setToMinutes(MINUTES_IN_DAY - 1);
			}
			setActive(null);
			return;
		}

		// A click with no endpoint selected always starts a fresh range. Waiting
		// for the next click to finish it is more predictable than inheriting the
		// previous range's end (which also skipped the end-of-day adjustment).
		setFromDate(clicked);
		setToDate(undefined);
		setActive("end");
	}

	function resetDraft(): void {
		const fallback =
			settings.defaultRange === "all" || settings.defaultRange === "custom"
				? "30d"
				: settings.defaultRange;
		const resolved = resolveRange(
			new URLSearchParams({ range: fallback }),
			Date.now(),
		);
		if (resolved.from === null || resolved.until === null) return;
		const start = new Date(resolved.from);
		const end = new Date(Math.max(resolved.from, resolved.until - MINUTE_MS));
		setFromDate(startOfDay(start));
		setToDate(startOfDay(end));
		setFromMinutes(minutesSinceMidnight(start));
		setToMinutes(minutesSinceMidnight(end));
		setActive(null);
		setHoverDate(null);
		setMonth(startOfMonth(start));
	}

	function applyCustom(): void {
		if (validation || (fromValue === null && toValue === null)) return;
		setRange({
			key: "custom",
			from: fromValue,
			until: toValue !== null ? toValue + MINUTE_MS : null,
		});
		setOpen(false);
	}

	function selectPreset(key: Exclude<RangeKey, "custom">): void {
		setRange({ key });
		setOpen(false);
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="gap-2 font-normal"
					title={rangeTitle(range, t)}
					data-range-picker
				>
					<CalendarDays className="text-muted-foreground" />
					<span className="max-w-56 truncate">{rangeLabel}</span>
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={8}
				collisionPadding={12}
				className="w-[min(96vw,820px)] overflow-hidden p-0"
			>
				<div className="grid md:grid-cols-[176px_minmax(0,1fr)]">
					<aside className="border-b bg-surface p-2 md:border-b-0 md:border-r">
						<div className="px-2 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
							{t("range.title")}
						</div>
						<div className="grid grid-cols-2 gap-0.5 md:grid-cols-1">
							{RANGE_PRESETS.map((preset) => {
								const isActive = range.key === preset.key;
								return (
									<button
										key={preset.key}
										type="button"
										onClick={() => selectPreset(preset.key)}
										className={cn(
											"flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
											isActive && "bg-muted text-foreground",
										)}
									>
										<span>{t(preset.label)}</span>
										{isActive ? <Check className="size-3.5" /> : null}
									</button>
								);
							})}
						</div>
					</aside>

					<section className="min-w-0 p-3">
						<div className="flex items-center justify-between">
							<div className="text-[12px] font-medium">{t("range.custom")}</div>
							<button
								type="button"
								onClick={resetDraft}
								className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
							>
								<RotateCcw className="size-3" />
								{t("common.reset")}
							</button>
						</div>

						<div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
							<EndpointField
								endpoint="start"
								label={t("time.start")}
								date={fromDate}
								minutes={fromMinutes}
								active={active === "start"}
								onFocus={() => focusEndpoint("start")}
								onClear={() => {
									setFromDate(undefined);
									setFromMinutes(0);
									setHoverDate(null);
								}}
								onMinutesChange={setFromMinutes}
							/>
							<ArrowRight className="size-4 text-muted-foreground" />
							<EndpointField
								endpoint="end"
								label={t("time.end")}
								date={toDate}
								minutes={toMinutes}
								active={active === "end"}
								onFocus={() => focusEndpoint("end")}
								onClear={() => {
									setToDate(undefined);
									setToMinutes(MINUTES_IN_DAY - 1);
									setHoverDate(null);
								}}
								onMinutesChange={setToMinutes}
							/>
						</div>

						{/* biome-ignore lint/a11y/noStaticElementInteractions: clears the hover preview */}
						<div className="mt-1" onMouseLeave={() => setHoverDate(null)}>
							<Calendar
								mode="range"
								selected={
									fromDate
										? {
												from: fromDate,
												to: active === "end" && hoverDate ? undefined : toDate,
											}
										: toDate
											? { from: toDate, to: toDate }
											: undefined
								}
								onSelect={handleSelect}
								modifiers={modifiers}
								modifiersClassNames={modifiersClassNames}
								onDayMouseEnter={(day) => {
									if (active === "end" && fromDate && !toDate)
										setHoverDate(day);
								}}
								numberOfMonths={twoMonths ? 2 : 1}
								month={month}
								onMonthChange={setMonth}
								locale={locale}
								weekStartsOn={weekStartsOn}
								showOutsideDays={false}
								classNames={{ week: "flex w-full" }}
								labels={{
									labelPrevious: () => t("calendar.previousMonth"),
									labelNext: () => t("calendar.nextMonth"),
								}}
								className="mx-auto mt-1 p-0 [--cell-size:--spacing(9)]"
							/>
						</div>

						<div className="mt-2 flex items-center justify-between gap-3 border-t pt-2">
							<div className="min-w-0 text-[10px] text-muted-foreground">
								{validation ? (
									<p className="text-destructive">{validation}</p>
								) : (
									<p className="truncate">
										{timeZone}
										{duration ? ` · ${duration}` : ""}
									</p>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-1.5">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setOpen(false)}
								>
									{t("common.cancel")}
								</Button>
								<Button
									size="sm"
									disabled={Boolean(validation)}
									onClick={applyCustom}
								>
									{t("common.apply")}
								</Button>
							</div>
						</div>
					</section>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function EndpointField({
	endpoint,
	label,
	date,
	minutes,
	active,
	onFocus,
	onClear,
	onMinutesChange,
}: {
	endpoint: Endpoint;
	label: string;
	date: Date | undefined;
	minutes: number;
	active: boolean;
	onFocus: () => void;
	onClear: () => void;
	onMinutesChange: (minutes: number) => void;
}) {
	const t = useT();
	const { code } = useDateLocale();
	return (
		<div
			className={cn(
				"flex min-w-0 items-center justify-between gap-1.5 rounded-lg border bg-card px-2.5 py-2 transition-colors",
				active && "border-foreground/35 ring-1 ring-foreground/10",
			)}
		>
			<button
				type="button"
				data-endpoint={endpoint}
				onClick={onFocus}
				className="min-w-0 flex-1 text-left"
			>
				<span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					{label}
				</span>
				<span className="mt-0.5 block truncate text-[12px] font-medium">
					{date ? formatPickerDate(date, code) : t("time.selectDate")}
				</span>
			</button>
			{date && (
				<button
					type="button"
					data-clear-endpoint={endpoint}
					aria-label={`Clear ${label}`}
					onClick={onClear}
					className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<X className="size-3" />
				</button>
			)}
			<TimeInput minutes={minutes} onChange={onMinutesChange} label={label} />
		</div>
	);
}

function TimeInput({
	minutes,
	onChange,
	label,
}: {
	minutes: number;
	onChange: (minutes: number) => void;
	label: string;
}) {
	const t = useT();
	const { code } = useDateLocale();
	const hour24 = Math.floor(minutes / 60);
	const minute = minutes % 60;
	const is12Hour = uses12HourClock(code);
	const hour12 = hour24 % 12 || 12;
	const displayHour = is12Hour ? hour12 : hour24;
	const period: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
	const [hourText, setHourText] = useState(() => pad(displayHour));
	const [minuteText, setMinuteText] = useState(() => pad(minute));
	const minuteRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setHourText(pad(displayHour));
	}, [displayHour]);
	useEffect(() => {
		setMinuteText(pad(minute));
	}, [minute]);

	function commitHour(raw: string): void {
		const parsed = Number(raw);
		if (raw.trim() === "" || !Number.isFinite(parsed)) {
			setHourText(pad(displayHour));
			return;
		}
		// Accept 0-23 even in 12-hour locales: typing 18 means 6 PM, not an
		// invalid "18" that silently snaps to noon.
		const value = Math.min(23, Math.max(0, parsed));
		const nextHour24 = is12Hour
			? value > 12
				? value
				: (value % 12) + (period === "PM" ? 12 : 0)
			: value;
		onChange(nextHour24 * 60 + minute);
		setHourText(pad(is12Hour ? nextHour24 % 12 || 12 : nextHour24));
	}

	function commitMinute(raw: string): void {
		const parsed = Number(raw);
		if (raw.trim() === "" || !Number.isFinite(parsed)) {
			setMinuteText(pad(minute));
			return;
		}
		const clamped = Math.min(59, Math.max(0, parsed));
		onChange(hour24 * 60 + clamped);
		setMinuteText(pad(clamped));
	}

	function shiftHour(delta: number): void {
		if (is12Hour) {
			const next = ((((hour12 - 1 + delta) % 12) + 12) % 12) + 1;
			const nextHour24 = (next % 12) + (period === "PM" ? 12 : 0);
			onChange(nextHour24 * 60 + minute);
			setHourText(pad(next));
			return;
		}
		const next = (hour24 + delta + 24) % 24;
		onChange(next * 60 + minute);
		setHourText(pad(next));
	}

	function shiftMinute(delta: number): void {
		const next = (minute + delta + 60) % 60;
		onChange(hour24 * 60 + next);
		setMinuteText(pad(next));
	}

	function setPeriod(next: "AM" | "PM"): void {
		const parsedHour = Number(hourText);
		const parsedMinute = Number(minuteText);
		const baseHour =
			hourText.trim() !== "" && Number.isFinite(parsedHour)
				? Math.min(12, Math.max(1, parsedHour)) % 12
				: hour24 % 12;
		const effectiveMinute =
			minuteText.trim() !== "" && Number.isFinite(parsedMinute)
				? Math.min(59, Math.max(0, parsedMinute))
				: minute;
		onChange((baseHour + (next === "PM" ? 12 : 0)) * 60 + effectiveMinute);
	}

	return (
		<div className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-input bg-background px-1 text-[11px] tabular transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
			<input
				value={hourText}
				inputMode="numeric"
				maxLength={2}
				aria-label={`${label} ${t("time.hourPart")}`}
				onFocus={(event) => event.currentTarget.select()}
				onChange={(event) => {
					const digits = event.target.value.replace(/\D/gu, "").slice(0, 2);
					setHourText(digits);
					if (
						(digits.length === 2 && Number(digits) <= 23) ||
						(digits.length === 1 && Number(digits) > (is12Hour ? 1 : 2))
					) {
						commitHour(digits);
						minuteRef.current?.focus();
					}
				}}
				onBlur={(event) => commitHour(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "ArrowUp") {
						event.preventDefault();
						shiftHour(1);
					} else if (event.key === "ArrowDown") {
						event.preventDefault();
						shiftHour(-1);
					} else if (event.key === "Enter") {
						event.currentTarget.blur();
					}
				}}
				className="w-5 rounded bg-transparent text-center outline-none"
			/>
			<span className="text-muted-foreground">:</span>
			<input
				ref={minuteRef}
				value={minuteText}
				inputMode="numeric"
				maxLength={2}
				aria-label={`${label} ${t("time.minutePart")}`}
				onFocus={(event) => event.currentTarget.select()}
				onChange={(event) => {
					const digits = event.target.value.replace(/\D/gu, "").slice(0, 2);
					setMinuteText(digits);
					if (digits.length === 2) commitMinute(digits);
				}}
				onBlur={(event) => commitMinute(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "ArrowUp") {
						event.preventDefault();
						shiftMinute(1);
					} else if (event.key === "ArrowDown") {
						event.preventDefault();
						shiftMinute(-1);
					} else if (event.key === "Enter") {
						event.currentTarget.blur();
					}
				}}
				className="w-5 rounded bg-transparent text-center outline-none"
			/>
			{is12Hour ? (
				<div className="ml-0.5 flex items-center rounded border border-input/60 p-px">
					{(["AM", "PM"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setPeriod(value)}
							aria-pressed={period === value}
							className={cn(
								"rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors",
								period === value
									? "bg-foreground text-background"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{value === "AM" ? t("time.am") : t("time.pm")}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

function rangeTitle(
	range: ResolvedRange,
	t: (key: TranslationKey) => string,
): string {
	if (range.from === null || range.until === null)
		return t(range.label as TranslationKey);
	return `${formatDateTime(range.from)} – ${formatDateTime(range.until - 1)}`;
}
