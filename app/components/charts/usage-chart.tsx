import type { UsageBucket } from "@shared/types";
import { useMemo } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import {
	formatBucketLabelFor,
	formatBucketTooltipLabelFor,
	useDateLocale,
} from "~/lib/date-locale";
import { formatCompact, formatCost, formatNumber } from "~/lib/format";
import { useT } from "~/lib/i18n";

export type UsageMetric = "tokens" | "cost";

const tokenSeries = [
	{ key: "inputTokens", label: "metric.input", color: "var(--chart-1)" },
	{ key: "outputTokens", label: "metric.output", color: "var(--chart-2)" },
	{
		key: "cacheReadTokens",
		label: "metric.cacheRead",
		color: "var(--chart-7)",
	},
	{
		key: "cacheWriteTokens",
		label: "metric.cacheWrite",
		color: "var(--chart-4)",
	},
] as const;

interface Point {
	key: string;
	label: string;
	tooltipLabel: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
	requests: number;
}

function pointOf(
	bucket: UsageBucket,
	unit: "hour" | "day" | "week" | "month",
	code: "en" | "zh-CN",
): Point {
	return {
		key: bucket.key,
		label: formatBucketLabelFor(bucket.start, unit, code),
		tooltipLabel: formatBucketTooltipLabelFor(bucket.start, unit, code),
		inputTokens: bucket.totals.inputTokens,
		outputTokens: bucket.totals.outputTokens,
		cacheReadTokens: bucket.totals.cacheReadTokens,
		cacheWriteTokens: bucket.totals.cacheWriteTokens,
		reasoningTokens: bucket.totals.reasoningTokens,
		costUsd: bucket.totals.costUsd,
		requests: bucket.totals.requests,
	};
}

function TokenTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: Array<{ payload?: Point }>;
}) {
	const t = useT();
	const data = payload?.[0]?.payload;
	if (!active || !data) return null;
	const total =
		data.inputTokens +
		data.outputTokens +
		data.cacheReadTokens +
		data.cacheWriteTokens;
	return (
		<div className="min-w-48 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md">
			<div className="flex items-baseline justify-between gap-6">
				<span className="text-[11px] font-medium">{data.tooltipLabel}</span>
				<span className="tabular">{formatNumber(total)}</span>
			</div>
			<div className="mt-1.5 space-y-1">
				{tokenSeries.map((series) => (
					<div
						key={series.key}
						className="flex items-center justify-between gap-4 text-[11px]"
					>
						<span className="flex items-center gap-1.5 text-muted-foreground">
							<span
								className="size-2 rounded-[1px]"
								style={{ background: series.color }}
							/>
							{t(series.label)}
						</span>
						<span className="tabular">{formatNumber(data[series.key])}</span>
					</div>
				))}
				<div className="flex items-center justify-between gap-4 border-t pt-1 text-[11px]">
					<span className="text-muted-foreground">{t("metric.requests")}</span>
					<span className="tabular">{formatNumber(data.requests)}</span>
				</div>
			</div>
		</div>
	);
}

function CostTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: Array<{ payload?: Point }>;
}) {
	const t = useT();
	const data = payload?.[0]?.payload;
	if (!active || !data) return null;
	return (
		<div className="min-w-40 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md">
			<div className="flex items-baseline justify-between gap-6">
				<span className="text-[11px] font-medium">{data.tooltipLabel}</span>
				<span className="tabular">{formatCost(data.costUsd)}</span>
			</div>
			<div className="mt-1 flex items-center justify-between gap-4 text-[11px]">
				<span className="text-muted-foreground">{t("metric.requests")}</span>
				<span className="tabular">{formatNumber(data.requests)}</span>
			</div>
		</div>
	);
}

export function UsageChart({
	buckets,
	metric,
	onMetricChange,
	unit,
}: {
	buckets: UsageBucket[];
	metric: UsageMetric;
	onMetricChange: (metric: UsageMetric) => void;
	unit: "hour" | "day" | "week" | "month";
}) {
	const t = useT();
	const { code } = useDateLocale();
	const data = useMemo(
		() => buckets.map((bucket) => pointOf(bucket, unit, code)),
		[buckets, unit, code],
	);
	const labelByKey = useMemo(
		() => new Map(data.map((point) => [point.key, point.label])),
		[data],
	);
	const empty = data.every(
		(point) =>
			point.inputTokens === 0 &&
			point.outputTokens === 0 &&
			point.cacheReadTokens === 0 &&
			point.costUsd === 0,
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h2 className="text-[13px] font-semibold">
						{t("overview.usageOverTime")}
					</h2>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						{t(metric === "tokens" ? "metric.tokens" : "metric.cost")}{" "}
						{t(`chart.by.${unit}`)}
					</p>
				</div>
				<ToggleGroup
					type="single"
					value={metric}
					onValueChange={(value) => {
						if (value === "tokens" || value === "cost") onMetricChange(value);
					}}
					variant="outline"
					size="sm"
					className="h-7"
					aria-label={t("chart.metric")}
				>
					<ToggleGroupItem
						value="tokens"
						className="px-2.5 text-[11px] data-[state=on]:bg-foreground data-[state=on]:text-background"
					>
						{t("metric.tokens")}
					</ToggleGroupItem>
					<ToggleGroupItem
						value="cost"
						className="px-2.5 text-[11px] data-[state=on]:bg-foreground data-[state=on]:text-background"
					>
						{t("metric.cost")}
					</ToggleGroupItem>
				</ToggleGroup>
			</div>

			{empty ? (
				<div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
					{t("empty.usage")}
				</div>
			) : (
				<div className="mt-3 min-h-[270px] flex-1">
					<ResponsiveContainer width="100%" height="100%">
						<BarChart
							data={data}
							margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
						>
							<CartesianGrid vertical={false} stroke="var(--chart-grid)" />
							<XAxis
								dataKey="key"
								tickFormatter={(key: string) => labelByKey.get(key) ?? key}
								axisLine={false}
								tickLine={false}
								minTickGap={40}
								interval="preserveStartEnd"
								tickMargin={8}
							/>
							<YAxis
								axisLine={false}
								tickLine={false}
								width={metric === "cost" ? 54 : 46}
								tickFormatter={(value: number) =>
									metric === "cost"
										? `$${formatCompact(value)}`
										: formatCompact(value)
								}
							/>
							<Tooltip
								cursor={{ fill: "var(--hover)", fillOpacity: 0.7 }}
								content={
									metric === "tokens" ? <TokenTooltip /> : <CostTooltip />
								}
								isAnimationActive={false}
							/>
							{metric === "tokens" ? (
								tokenSeries.map((series, index) => (
									<Bar
										key={series.key}
										dataKey={series.key}
										stackId="tokens"
										fill={series.color}
										radius={index === tokenSeries.length - 1 ? [2, 2, 0, 0] : 0}
										isAnimationActive={false}
										maxBarSize={28}
									/>
								))
							) : (
								<Bar
									dataKey="costUsd"
									fill="var(--chart-1)"
									radius={[2, 2, 0, 0]}
									isAnimationActive={false}
									maxBarSize={28}
								/>
							)}
						</BarChart>
					</ResponsiveContainer>
				</div>
			)}

			{metric === "tokens" ? (
				<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
					{tokenSeries.map((series) => (
						<span
							key={series.key}
							className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
						>
							<span
								className="size-2 rounded-[1px]"
								style={{ background: series.color }}
							/>
							{t(series.label)}
						</span>
					))}
				</div>
			) : null}
		</div>
	);
}
