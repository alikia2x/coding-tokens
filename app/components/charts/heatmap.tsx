import type { HeatmapDay } from "@shared/types";
import { Fragment, useMemo, useState } from "react";
import {
	formatDateFor,
	formatMonthShortFor,
	formatWeekdayShortFor,
	useDateLocale,
} from "~/lib/date-locale";
import { formatCost, formatNumber, formatTokens } from "~/lib/format";
import { useT } from "~/lib/i18n";

const weekdayIds = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function quantile(values: number[], ratio: number): number {
	if (!values.length) return 0;
	const index = Math.min(values.length - 1, Math.floor(values.length * ratio));
	return values[index] ?? 0;
}

function monthLabel(day: HeatmapDay, code: "en" | "zh-CN"): string {
	return formatMonthShortFor(day.start, code);
}

export function ContributionHeatmap({
	days,
	maxTokens,
	totals,
}: {
	days: HeatmapDay[];
	maxTokens: number;
	totals: {
		tokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
	};
}) {
	const t = useT();
	const { code } = useDateLocale();
	const [hovered, setHovered] = useState<HeatmapDay | null>(null);
	const weeks = useMemo(() => {
		const chunks: HeatmapDay[][] = [];
		for (let index = 0; index < days.length; index += 7)
			chunks.push(days.slice(index, index + 7));
		return chunks;
	}, [days]);
	const levels = useMemo(() => {
		const positive = days
			.map((day) => day.tokens)
			.filter((value) => value > 0)
			.sort((left, right) => left - right);
		return {
			p25: quantile(positive, 0.25),
			p50: quantile(positive, 0.5),
			p75: quantile(positive, 0.75),
			p90: quantile(positive, 0.9),
		};
	}, [days]);
	const labels = useMemo(() => {
		const result: Array<{ index: number; label: string }> = [];
		let previous = "";
		for (const [index, week] of weeks.entries()) {
			const first = week[0];
			if (!first) continue;
			const label = monthLabel(first, code);
			if (label !== previous && (index === 0 || index >= 2)) {
				result.push({ index, label });
				previous = label;
			}
		}
		return result;
	}, [weeks, code]);
	const weekdayLabels = useMemo(() => {
		const firstWeek = weeks[0] ?? [];
		return Array.from({ length: 7 }, (_, index) => ({
			index,
			label:
				index % 2 === 1
					? formatWeekdayShortFor(firstWeek[index]?.start ?? Date.now(), code)
					: "",
		}));
	}, [weeks, code]);
	const labelByIndex = new Map(
		labels.map((label) => [label.index, label.label]),
	);

	function color(day: HeatmapDay): string {
		if (day.tokens === 0) return "var(--heat-0)";
		const level =
			day.tokens <= levels.p25
				? 1
				: day.tokens <= levels.p50
					? 2
					: day.tokens <= levels.p75
						? 3
						: 4;
		return `var(--heat-${level})`;
	}

	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<div className="flex items-baseline gap-2">
					<h2 className="text-[13px] font-semibold">{t("heatmap.title")}</h2>
					<span className="text-[11px] text-muted-foreground">
						{t("heatmap.period")}
					</span>
				</div>
				<div className="flex items-baseline gap-3 text-[11px] text-muted-foreground tabular">
					{hovered ? (
						<>
							<span className="text-foreground">
								{formatDateFor(hovered.start, code)}
							</span>
							<span>
								{formatTokens(hovered.tokens)} {t("metric.tokensLower")}
							</span>
							<span>
								{formatNumber(hovered.requests)} {t("metric.requestsLower")}
							</span>
							<span>{formatCost(hovered.costUsd)}</span>
						</>
					) : (
						<>
							<span>
								{formatTokens(totals.tokens)} {t("metric.tokensLower")}
							</span>
							<span>
								{formatNumber(totals.requests)} {t("metric.requestsLower")}
							</span>
							<span>{formatCost(totals.costUsd, true)}</span>
							<span>
								{t("metric.peak")} {formatNumber(maxTokens)}
							</span>
						</>
					)}
				</div>
			</div>
			<div
				className="mt-3 grid gap-[3px]"
				style={{
					gridTemplateColumns: `24px repeat(${weeks.length}, minmax(0, 1fr))`,
				}}
			>
				<span />
				{weeks.map((week, index) => (
					<div
						key={`month-${week[0]?.date ?? index}`}
						className="relative h-[14px]"
					>
						{labelByIndex.get(index) ? (
							<span className="absolute left-0 top-0 whitespace-nowrap text-[9px] text-muted-foreground">
								{labelByIndex.get(index)}
							</span>
						) : null}
					</div>
				))}
				{weekdayIds.map((weekday, row) => (
					<Fragment key={weekday}>
						<span className="flex items-center justify-end pr-0.5 text-[9px] text-muted-foreground">
							{weekdayLabels[row]?.label}
						</span>
						{weeks.map((week) => {
							const day = week[row];
							if (!day)
								return (
									<span
										key={`empty-${weekday}-${week.at(-1)?.date ?? "none"}`}
									/>
								);
							return (
								<div
									key={day.date}
									className="aspect-square w-full rounded-[2px] outline-0 outline-offset-1 transition-[outline,transform] duration-100 hover:z-10 hover:scale-110 hover:outline hover:outline-1 hover:outline-foreground"
									style={{ background: color(day) }}
									onMouseEnter={() => setHovered(day)}
									onMouseLeave={() => setHovered(null)}
									role="img"
									aria-label={`${formatDateFor(day.start, code)}: ${formatNumber(day.tokens)} ${t("metric.tokensLower")}`}
								/>
							);
						})}
					</Fragment>
				))}
			</div>
			<div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
				<span>{t("common.less")}</span>
				{[0, 1, 2, 3, 4].map((level) => (
					<span
						key={level}
						className="size-[11px] rounded-[2px]"
						style={{ background: `var(--heat-${level})` }}
					/>
				))}
				<span>{t("common.more")}</span>
			</div>
		</div>
	);
}
