import { cn } from "cn";
import {
	ArrowRight,
	CalendarDays,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
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
type CalendarView = "days" | "months" | "years";

function addMonths(date: Date, delta: number): Date {
	return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

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
	const { locale, code, weekStartsOn } = useDateLocale();
	const twoMonths = useMediaQuery("(min-width: 780px)");
	const [open, setOpen] = useState(false);
	const [fromDate, setFromDate] = useState<Date | undefined>();
	const [toDate, setToDate] = useState<Date | undefined>();
	const [fromMinutes, setFromMinutes] = useState(0);
	const [toMinutes, setToMinutes] = useState(MINUTES_IN_DAY - 1);
	const [active, setActive] = useState<Endpoint | null>(null);
	const [month, setMonth] = useState(() => startOfMonth(new Date()));
	const [hoverDate, setHoverDate] = useState<Date | null>(null);
	const [calendarView, setCalendarView] = useState<CalendarView>("days");
	const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
	const [yearGridStart, setYearGridStart] = useState(
		() => Math.floor(new Date().getFullYear() / 12) * 12,
	);

	function initializeDraft(): void {
		setCalendarView("days");
		if (range.from === null && range.until === null) {
			const now = new Date();
			setFromDate(undefined);
			setToDate(undefined);
			setFromMinutes(0);
			setToMinutes(MINUTES_IN_DAY - 1);
			setActive(null);
			setHoverDate(null);
			setMonth(startOfMonth(now));
			setViewYear(now.getFullYear());
			setYearGridStart(Math.floor(now.getFullYear() / 12) * 12);
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
		const anchor = start ?? end ?? new Date();
		setFromDate(start ? startOfDay(start) : undefined);
		setToDate(end ? startOfDay(end) : undefined);
		setFromMinutes(start ? minutesSinceMidnight(start) : 0);
		setToMinutes(end ? minutesSinceMidnight(end) : MINUTES_IN_DAY - 1);
		setActive(null);
		setHoverDate(null);
		setMonth(startOfMonth(anchor));
		setViewYear(anchor.getFullYear());
		setYearGridStart(Math.floor(anchor.getFullYear() / 12) * 12);
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
		if (fromValue !== null && toValue !== null && fromValue > toValue)
			return t("time.error.startAfterEnd");
		return null;
	}, [fromValue, toValue, t]);
	const duration = durationLabel(fromValue, toValue, t);
	const rangeSummary = useMemo(() => {
		if (fromValue === null && toValue === null) return t("range.all");
		if (fromValue !== null && toValue === null) {
			return t("range.fromDate", {
				date: formatPickerDate(new Date(fromValue), code),
			});
		}
		if (fromValue === null && toValue !== null) {
			return t("range.untilDate", {
				date: formatPickerDate(new Date(toValue), code),
			});
		}
		return duration;
	}, [fromValue, toValue, duration, code, t]);
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const calendarClassNames = useMemo(
		() => ({
			nav: "hidden",
			month_caption: "hidden",
			months: "relative flex flex-col gap-4 md:flex-row",
			week: "mt-1 flex w-full",
			weekdays: "mt-1 flex",
		}),
		[],
	);
	const calendarLabels = useMemo(
		() => ({
			labelPrevious: () => t("calendar.previousMonth"),
			labelNext: () => t("calendar.nextMonth"),
		}),
		[t],
	);
	const yearFormatter = useMemo(
		() => new Intl.DateTimeFormat(code, { year: "numeric" }),
		[code],
	);
	const monthFormatter = useMemo(
		() => new Intl.DateTimeFormat(code, { month: "short" }),
		[code],
	);
	const yearFirst = useMemo(
		() =>
			code.startsWith("zh") || code.startsWith("ja") || code.startsWith("ko"),
		[code],
	);
	const monthNames = useMemo(
		() =>
			Array.from({ length: 12 }, (_, index) => ({
				index,
				label: monthFormatter.format(new Date(2026, index, 1)),
			})),
		[monthFormatter],
	);
	const visibleMonths = useMemo(
		() => (twoMonths ? [month, addMonths(month, 1)] : [month]),
		[twoMonths, month],
	);

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
				setToDate(undefined);
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
		setFromMinutes(0);
		setToMinutes(MINUTES_IN_DAY - 1);
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
		setCalendarView("days");
		setViewYear(start.getFullYear());
		setYearGridStart(Math.floor(start.getFullYear() / 12) * 12);
	}

	function applyCustom(): void {
		if (validation) return;
		if (fromValue === null && toValue === null) {
			setRange({ key: "all" });
			setOpen(false);
			return;
		}
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
				className="w-auto max-w-[96vw] overflow-hidden p-0"
			>
				<div className="grid md:grid-cols-[148px_auto]">
					<aside className="border-b bg-surface/60 p-2 md:border-b-0 md:border-r">
						<div className="px-2 pb-1.5 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/75">
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
											"flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground",
											isActive && "bg-accent font-medium text-foreground",
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

						<div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
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
									setActive(toDate ? "start" : null);
								}}
								onMinutesChange={setFromMinutes}
							/>
							<ArrowRight className="size-3.5 text-muted-foreground/60" />
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
									setActive(fromDate ? "end" : null);
								}}
								onMinutesChange={setToMinutes}
							/>
						</div>

						{/* biome-ignore lint/a11y/noStaticElementInteractions: clears the hover preview */}
						<div
							className="mt-2"
							onMouseLeave={() => {
								if (hoverDate) setHoverDate(null);
							}}
						>
							{calendarView === "days" ? (
								<div>
									<div className="mb-1 flex h-8 items-center justify-between gap-2">
										<button
											type="button"
											aria-label={t("calendar.previousMonth")}
											onClick={() => setMonth(addMonths(month, -1))}
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										>
											<ChevronLeft className="size-4" />
										</button>
										<div
											className={cn(
												"grid flex-1 items-center gap-4",
												twoMonths ? "grid-cols-2" : "grid-cols-1",
											)}
										>
											{visibleMonths.map((item) => {
												const y = item.getFullYear();
												const m = item.getMonth();
												const yearBtn = (
													<button
														type="button"
														data-calendar-year-trigger={y}
														onClick={() => {
															setViewYear(y);
															setYearGridStart(Math.floor(y / 12) * 12);
															setCalendarView("years");
														}}
														className="rounded px-1 py-0.5 text-[13px] font-medium transition-colors hover:bg-muted"
													>
														{yearFormatter.format(item)}
													</button>
												);
												const monthBtn = (
													<button
														type="button"
														data-calendar-month-trigger={m}
														onClick={() => {
															setViewYear(y);
															setCalendarView("months");
														}}
														className="rounded px-1 py-0.5 text-[13px] font-medium transition-colors hover:bg-muted"
													>
														{monthFormatter.format(item)}
													</button>
												);
												return (
													<div
														key={`${y}-${m}`}
														className="flex items-center justify-center"
													>
														{yearFirst ? (
															<>
																{yearBtn}
																{monthBtn}
															</>
														) : (
															<>
																{monthBtn}
																{yearBtn}
															</>
														)}
													</div>
												);
											})}
										</div>
										<button
											type="button"
											aria-label={t("calendar.nextMonth")}
											onClick={() => setMonth(addMonths(month, 1))}
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										>
											<ChevronRight className="size-4" />
										</button>
									</div>
									<Calendar
										mode="range"
										selected={
											fromDate
												? {
														from: fromDate,
														to:
															active === "end" && hoverDate
																? undefined
																: toDate,
													}
												: toDate
													? { from: toDate, to: toDate }
													: undefined
										}
										onSelect={handleSelect}
										modifiers={modifiers}
										modifiersClassNames={modifiersClassNames}
										onDayMouseEnter={(day) => {
											if (active !== "end" || !fromDate || toDate) return;
											const normalized = startOfDay(day);
											if (
												hoverDate &&
												normalized.getTime() === hoverDate.getTime()
											)
												return;
											setHoverDate(normalized);
										}}
										numberOfMonths={twoMonths ? 2 : 1}
										month={month}
										onMonthChange={setMonth}
										locale={locale}
										weekStartsOn={weekStartsOn}
										showOutsideDays={false}
										classNames={calendarClassNames}
										labels={calendarLabels}
										className="mx-auto p-0 [--cell-size:--spacing(8.5)]"
									/>
								</div>
							) : calendarView === "months" ? (
								<div
									className={cn(
										"mx-auto flex min-h-[248px] flex-col",
										twoMonths ? "w-[492px]" : "w-[238px]",
									)}
								>
									<div className="mb-2 flex h-8 items-center justify-between">
										<button
											type="button"
											aria-label={t("calendar.previousMonth")}
											onClick={() => setViewYear((prev) => prev - 1)}
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										>
											<ChevronLeft className="size-4" />
										</button>
										<button
											type="button"
											data-calendar-year-trigger={viewYear}
											onClick={() => {
												setYearGridStart(Math.floor(viewYear / 12) * 12);
												setCalendarView("years");
											}}
											className="rounded-md px-2 py-0.5 text-[13px] font-medium transition-colors hover:bg-muted"
										>
											{yearFormatter.format(new Date(viewYear, 0, 1))}
										</button>
										<button
											type="button"
											aria-label={t("calendar.nextMonth")}
											onClick={() => setViewYear((prev) => prev + 1)}
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										>
											<ChevronRight className="size-4" />
										</button>
									</div>
									<div
										className={cn(
											"grid flex-1 content-center gap-2",
											twoMonths ? "grid-cols-4" : "grid-cols-3",
										)}
									>
										{monthNames.map((item) => {
											const isCurrent =
												month.getFullYear() === viewYear &&
												month.getMonth() === item.index;
											return (
												<button
													key={item.index}
													type="button"
													data-calendar-month={item.index}
													onClick={() => {
														setMonth(new Date(viewYear, item.index, 1));
														setCalendarView("days");
													}}
													className={cn(
														"h-11 rounded-md text-[13px] font-medium transition-colors",
														isCurrent
															? "bg-primary text-primary-foreground"
															: "text-foreground hover:bg-muted",
													)}
												>
													{item.label}
												</button>
											);
										})}
									</div>
								</div>
							) : (
								<div
									className={cn(
										"mx-auto flex min-h-[248px] flex-col",
										twoMonths ? "w-[492px]" : "w-[238px]",
									)}
								>
									<div className="mb-2 flex h-8 items-center justify-between">
										<button
											type="button"
											aria-label={t("calendar.previousMonth")}
											onClick={() => setYearGridStart((prev) => prev - 12)}
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										>
											<ChevronLeft className="size-4" />
										</button>
										<span className="text-[13px] font-medium tabular">
											{yearGridStart} – {yearGridStart + 11}
										</span>
										<button
											type="button"
											aria-label={t("calendar.nextMonth")}
											onClick={() => setYearGridStart((prev) => prev + 12)}
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										>
											<ChevronRight className="size-4" />
										</button>
									</div>
									<div
										className={cn(
											"grid flex-1 content-center gap-2",
											twoMonths ? "grid-cols-4" : "grid-cols-3",
										)}
									>
										{Array.from({ length: 12 }, (_, idx) => {
											const yearValue = yearGridStart + idx;
											const isCurrent = month.getFullYear() === yearValue;
											return (
												<button
													key={yearValue}
													type="button"
													data-calendar-year={yearValue}
													onClick={() => {
														setViewYear(yearValue);
														setCalendarView("months");
													}}
													className={cn(
														"h-11 rounded-md text-[13px] font-medium tabular transition-colors",
														isCurrent
															? "bg-primary text-primary-foreground"
															: "text-foreground hover:bg-muted",
													)}
												>
													{yearFormatter.format(new Date(yearValue, 0, 1))}
												</button>
											);
										})}
									</div>
								</div>
							)}
						</div>

						<div className="mt-2 flex items-center justify-between gap-3 border-t pt-2">
							<div className="min-w-0 text-[10px] text-muted-foreground">
								{validation ? (
									<p className="text-destructive">{validation}</p>
								) : (
									<p className="flex items-center gap-2 truncate">
										<span>{timeZone}</span>
										{rangeSummary ? <span>{rangeSummary}</span> : null}
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
				"min-w-0 rounded-lg border border-border/80 bg-muted/25 px-2.5 py-2 transition-colors",
				active && "border-foreground/45 bg-card ring-1 ring-foreground/10",
			)}
		>
			<div className="flex items-center justify-between gap-2 text-[10px] leading-none">
				<button
					type="button"
					onClick={onFocus}
					className="font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
				>
					{label}
				</button>
				{date ? (
					<button
						type="button"
						data-clear-endpoint={endpoint}
						aria-label={t("common.clearField", { label })}
						onClick={onClear}
						className="inline-flex items-center gap-0.5 text-muted-foreground/80 transition-colors hover:text-foreground"
					>
						<X className="size-2.5" />
						<span>{t("common.clear")}</span>
					</button>
				) : null}
			</div>
			<div className="mt-1.5 flex min-h-6 items-center justify-between gap-2">
				<button
					type="button"
					data-endpoint={endpoint}
					onClick={onFocus}
					className="min-w-0 flex-1 text-left"
				>
					<span
						className={cn(
							"block truncate text-[12px] font-medium",
							!date && "font-normal text-muted-foreground",
						)}
					>
						{date ? formatPickerDate(date, code) : t("time.selectDate")}
					</span>
				</button>
				{date ? (
					<TimeInput
						minutes={minutes}
						onChange={onMinutesChange}
						label={label}
					/>
				) : null}
			</div>
		</div>
	);
}

function TimeInput({
	minutes,
	onChange,
	label,
	disabled = false,
}: {
	minutes: number;
	onChange: (minutes: number) => void;
	label: string;
	disabled?: boolean;
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
		<div
			className={cn(
				"inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md border border-transparent bg-muted/70 px-1.5 text-[11px] tabular transition-[color,box-shadow,border-color,background-color] hover:bg-muted focus-within:border-ring focus-within:bg-background focus-within:ring-[2px] focus-within:ring-ring/40",
				disabled && "pointer-events-none opacity-40",
			)}
		>
			<input
				value={hourText}
				disabled={disabled}
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
				disabled={disabled}
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
							disabled={disabled}
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
