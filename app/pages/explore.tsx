import { getHarnessLabel, HARNESS_NAMES } from "@shared/types";
import {
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import { Link, useNavigationType, useSearchParams } from "react-router";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { EmptyState } from "~/components/empty-state";
import { FacetFilter, type FacetOption } from "~/components/facet-filter";
import { PageContainer } from "~/components/page-container";
import { SectionHeading } from "~/components/section-heading";
import { SummaryStrip } from "~/components/summary-strip";
import { TokenTotal } from "~/components/token-total";
import { Button } from "~/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import { categoricalColors, colorForSeries } from "~/lib/chart-colors";
import {
	formatBucketLabelFor,
	formatBucketTooltipLabelFor,
	useDateLocale,
} from "~/lib/date-locale";
import {
	formatCost,
	formatCostAxis,
	formatNumber,
	formatPercent,
	formatTokens,
	totalTokens,
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { type TranslationKey, useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useExplore, useModels, useProjects, useStatus } from "~/lib/queries";
import { useRangeLabel } from "~/lib/range";
import { useSettings } from "~/lib/settings";
import { type ExploreSlice, useAppStore } from "~/lib/store";
import { sessionsPath, UNKNOWN_PROJECT_KEY } from "~/lib/time-range";

type Metric = "tokens" | "cost" | "requests" | "sessions";
type Dimension = "harness" | "project" | "model";
type Mode = "time" | "dimension";
type Bucket = "hour" | "day" | "week" | "month";
type Chart = "bar" | "line" | "area";

const EXPLORE_URL_KEYS = [
	"mode",
	"metric",
	"dimension",
	"bucket",
	"breakdown",
	"chart",
	"harness",
	"project",
	"model",
] as const;

function hasUrlExploreParams(params: URLSearchParams): boolean {
	return EXPLORE_URL_KEYS.some((key) => params.has(key));
}

function metricValue(
	totals: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
	},
	metric: Metric,
): number {
	if (metric === "tokens") return totalTokens(totals);
	if (metric === "cost") return totals.costUsd;
	if (metric === "requests") return totals.requests;
	return totals.sessions;
}

function formatMetric(value: number, metric: Metric): string {
	if (metric === "cost") return formatCost(value);
	if (metric === "tokens") return formatTokens(value);
	return formatNumber(value);
}

export function ExplorePage() {
	const range = useResolvedRange();
	const [searchParams, setSearchParams] = useSearchParams();
	const navigationType = useNavigationType();
	const status = useStatus();
	const projects = useProjects(range);
	const models = useModels(range);
	const { settings, update: updateSettings } = useSettings();
	const t = useT();
	const { code } = useDateLocale();
	const rangeLabel = useRangeLabel();

	const storeExplore = useAppStore((state) => state.explore);
	const setExploreField = useAppStore((state) => state.setExploreField);
	const applyExploreUrlState = useAppStore(
		(state) => state.applyExploreUrlState,
	);
	const resetExploreState = useAppStore((state) => state.resetExploreState);
	const ownSyncRef = useRef<string | null>(null);
	const mountedRef = useRef(false);

	const buildExploreParams = useCallback(
		(base: URLSearchParams, slice: ExploreSlice): URLSearchParams => {
			const next = new URLSearchParams();
			for (const key of ["range", "from", "to"]) {
				const value = base.get(key);
				if (value) next.set(key, value);
			}
			if (slice.mode) next.set("mode", slice.mode);
			if (slice.metric) next.set("metric", slice.metric);
			if (slice.dimension) next.set("dimension", slice.dimension);
			if (slice.bucket) next.set("bucket", slice.bucket);
			if (slice.breakdown) next.set("breakdown", slice.breakdown);
			if (slice.chart) next.set("chart", slice.chart);
			for (const item of slice.harnesses) next.append("harness", item);
			for (const item of slice.projects) next.append("project", item);
			for (const item of slice.models) next.append("model", item);
			return next;
		},
		[],
	);

	useLayoutEffect(() => {
		const rawSearch = searchParams.toString();
		if (ownSyncRef.current === rawSearch) {
			ownSyncRef.current = null;
			mountedRef.current = true;
			return;
		}
		if (
			hasUrlExploreParams(searchParams) &&
			(!mountedRef.current || navigationType !== "POP")
		) {
			mountedRef.current = true;
			applyExploreUrlState({
				mode: (searchParams.get("mode") as Mode | null) ?? null,
				metric: (searchParams.get("metric") as Metric | null) ?? null,
				dimension: (searchParams.get("dimension") as Dimension | null) ?? null,
				bucket: (searchParams.get("bucket") as Bucket | null) ?? null,
				breakdown:
					(searchParams.get("breakdown") as (Dimension | "none") | null) ??
					null,
				chart: (searchParams.get("chart") as Chart | null) ?? null,
				harnesses: searchParams.getAll("harness"),
				projects: searchParams.getAll("project"),
				models: searchParams.getAll("model"),
			});
			return;
		}
		mountedRef.current = true;
		const current = useAppStore.getState().explore;
		const mirrored = buildExploreParams(searchParams, current);
		const mirroredStr = mirrored.toString();
		if (mirroredStr !== rawSearch) {
			ownSyncRef.current = mirroredStr;
			setSearchParams(mirrored, { replace: true });
		}
	}, [
		searchParams,
		navigationType,
		applyExploreUrlState,
		buildExploreParams,
		setSearchParams,
	]);

	const mode = (storeExplore.mode ?? settings.exploreMode) as Mode;
	const metric = (storeExplore.metric ?? settings.exploreMetric) as Metric;
	const dimension = (storeExplore.dimension ??
		settings.exploreDimension) as Dimension;
	const bucket = (storeExplore.bucket ?? settings.exploreBucket) as Bucket;
	const breakdown = (storeExplore.breakdown ?? settings.exploreBreakdown) as
		| Dimension
		| "none";
	const chart = (storeExplore.chart ??
		(mode === "dimension" ? "bar" : settings.exploreChart)) as Chart;
	const harnesses = storeExplore.harnesses;
	const projectValues = storeExplore.projects;
	const modelValues = storeExplore.models;
	const activeMetric = metric;

	const explore = useExplore({
		from: range.from,
		until: range.until,
		mode,
		metric: activeMetric,
		dimension,
		bucket,
		breakdown,
		harnesses,
		projects: projectValues,
		models: modelValues,
	});

	const harnessOptions = useMemo<FacetOption[]>(() => {
		if (status.data?.harnesses?.length) {
			return status.data.harnesses
				.filter(
					(item) =>
						item.sessions > 0 ||
						item.records > 0 ||
						harnesses.includes(item.harness),
				)
				.map((item) => ({
					value: item.harness,
					label: getHarnessLabel(item.harness),
					count: item.sessions,
				}));
		}
		return harnesses
			.filter((value): value is (typeof HARNESS_NAMES)[number] =>
				HARNESS_NAMES.includes(value as (typeof HARNESS_NAMES)[number]),
			)
			.map((harness) => ({
				value: harness,
				label: getHarnessLabel(harness),
				count: 0,
			}));
	}, [status.data, harnesses]);
	const projectOptions = useMemo<FacetOption[]>(() => {
		const map = new Map<string, FacetOption>();
		for (const row of projects.data?.rows ?? []) {
			if (!row.cwd) continue;
			map.set(row.cwd, {
				value: row.cwd,
				label: localizeLabel(t, row.name),
				count: row.totals.sessions,
			});
		}
		for (const selectedCwd of projectValues) {
			if (!map.has(selectedCwd)) {
				map.set(selectedCwd, {
					value: selectedCwd,
					label: selectedCwd.split("/").at(-1) || selectedCwd,
					count: 0,
				});
			}
		}
		return [...map.values()];
	}, [projects.data, projectValues, t]);
	const modelOptions = useMemo<FacetOption[]>(() => {
		const map = new Map<string, FacetOption>();
		for (const row of models.data?.rows ?? []) {
			map.set(row.model, {
				value: row.model,
				label: localizeLabel(t, row.model),
				count: row.totals.requests,
			});
		}
		for (const selectedModel of modelValues) {
			if (!map.has(selectedModel)) {
				map.set(selectedModel, {
					value: selectedModel,
					label: localizeLabel(t, selectedModel),
					count: 0,
				});
			}
		}
		return [...map.values()];
	}, [models.data, modelValues, t]);

	function setValue(
		key: "mode" | "metric" | "dimension" | "bucket" | "breakdown" | "chart",
		value: string,
	): void {
		setExploreField(key, value as ExploreSlice[typeof key]);
		const next = new URLSearchParams(searchParams);
		next.set(key, value);
		ownSyncRef.current = next.toString();
		setSearchParams(next, { replace: true });
		const settingsKey = {
			mode: "exploreMode",
			metric: "exploreMetric",
			dimension: "exploreDimension",
			bucket: "exploreBucket",
			breakdown: "exploreBreakdown",
			chart: "exploreChart",
		}[key] as
			| "exploreMode"
			| "exploreMetric"
			| "exploreDimension"
			| "exploreBucket"
			| "exploreBreakdown"
			| "exploreChart"
			| undefined;
		if (settingsKey) updateSettings({ [settingsKey]: value });
	}

	function setList(
		key: "harness" | "project" | "model",
		values: string[],
	): void {
		const sliceKey =
			key === "harness"
				? "harnesses"
				: key === "project"
					? "projects"
					: "models";
		setExploreField(sliceKey, values);
		const next = new URLSearchParams(searchParams);
		next.delete(key);
		for (const value of values) next.append(key, value);
		ownSyncRef.current = next.toString();
		setSearchParams(next, { replace: true });
	}

	function reset(): void {
		resetExploreState();
		const next = new URLSearchParams();
		for (const key of ["range", "from", "to"]) {
			const value = searchParams.get(key);
			if (value) next.set(key, value);
		}
		ownSyncRef.current = next.toString();
		setSearchParams(next, { replace: true });
	}

	const data = useMemo(() => {
		if (!explore.data) return [];
		if (mode === "dimension")
			return explore.data.rows.map((row, index) => {
				const localized = localizeLabel(t, row.label);
				return {
					key: `${row.key}::${index}`,
					label: localized,
					tooltipLabel: localized,
					value: metricValue(row.totals, activeMetric),
				};
			});
		return explore.data.xLabels.map((label, index) => {
			const start = explore.data?.starts[index];
			const hasStart = typeof start === "number" && Number.isFinite(start);
			const axisLabel = hasStart
				? formatBucketLabelFor(start, bucket, code)
				: label;
			const row: Record<string, string | number> = {
				key: hasStart ? String(start) : `${label}::${index}`,
				label: axisLabel,
				tooltipLabel: hasStart
					? formatBucketTooltipLabelFor(start, bucket, code)
					: label,
			};
			for (const series of explore.data?.series ?? [])
				row[series.key] = series.points[index]?.value ?? 0;
			return row;
		});
	}, [explore.data, mode, activeMetric, bucket, code, t]);

	const labelByKey = useMemo(
		() =>
			new Map(data.map((point) => [String(point.key), String(point.label)])),
		[data],
	);

	const series =
		mode === "dimension"
			? [
					{
						key: "value",
						label: t(metricLabel(activeMetric)),
						color: categoricalColors[0],
					},
				]
			: (explore.data?.series ?? []).map((item, index) => ({
					key: item.key,
					label: localizeLabel(t, item.label),
					color: colorForSeries(
						item.key,
						index,
						breakdown === "none" ? null : breakdown,
					),
				}));

	const areaOverlay = useMemo(() => {
		if (chart !== "area" || series.length === 0 || !data.length) {
			return {
				chartData: data,
				strokeLines: [] as Array<{ dataKey: string; color: string }>,
			};
		}
		const strokeLines: Array<{ dataKey: string; color: string }> = [];
		const chartData: Array<Record<string, string | number | null>> = data.map(
			(row) => ({ ...row }),
		);
		const cumulativeByIndex = chartData.map(() => 0);

		for (let sIdx = 0; sIdx < series.length; sIdx += 1) {
			const item = series[sIdx];
			if (!item) continue;
			const color = item.color ?? categoricalColors[0] ?? "var(--chart-1)";
			const values = chartData.map((row) => Number(row[item.key] ?? 0));
			for (let i = 0; i < chartData.length; i += 1) {
				cumulativeByIndex[i] = (cumulativeByIndex[i] ?? 0) + (values[i] ?? 0);
			}

			let i = 0;
			let island = 0;
			while (i < values.length) {
				if ((values[i] ?? 0) <= 0) {
					i += 1;
					continue;
				}
				const start = Math.max(0, i - 1);
				let end = i;
				while (end + 1 < values.length && (values[end + 1] ?? 0) > 0) {
					end += 1;
				}
				const paddedEnd = Math.min(values.length - 1, end + 1);
				const dataKey = `__area_stroke_${sIdx}_${island}`;
				strokeLines.push({ dataKey, color });
				for (let p = start; p <= paddedEnd; p += 1) {
					const target = chartData[p];
					if (target) target[dataKey] = cumulativeByIndex[p] ?? 0;
				}
				island += 1;
				i = end + 1;
			}
		}

		return { chartData, strokeLines };
	}, [chart, data, series]);

	const tableRows =
		mode === "dimension"
			? (explore.data?.rows ?? []).map((row, index) => ({
					key: row.key,
					label: localizeLabel(t, row.label),
					totals: row.totals,
					color:
						dimension === "harness"
							? colorForSeries(row.key, index, "harness")
							: undefined,
				}))
			: (explore.data?.series ?? []).map((item, index) => ({
					key: item.key,
					label: localizeLabel(t, item.label),
					totals: item.totals,
					color: colorForSeries(
						item.key,
						index,
						breakdown === "none" ? null : breakdown,
					),
				}));
	const totalMetric = explore.data
		? metricValue(explore.data.totals, activeMetric)
		: 0;

	return (
		<PageContainer>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-[24px] font-semibold tracking-[-0.03em]">
						{t("nav.explore")}
					</h1>
					<p className="mt-0.5 text-[12px] text-muted-foreground">
						{t("explore.description")}
					</p>
				</div>
			</div>

			<div className="mt-4 rounded-lg border bg-card">
				<div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
					<span className="mr-1 text-[11px] text-muted-foreground">
						{t("common.filters")}
					</span>
					<FacetFilter
						label={t("common.harness")}
						options={harnessOptions}
						values={harnesses}
						onChange={(values) => setList("harness", values)}
					/>
					<FacetFilter
						label={t("common.project")}
						options={projectOptions}
						values={projectValues}
						onChange={(values) => setList("project", values)}
					/>
					<FacetFilter
						label={t("common.model")}
						options={modelOptions}
						values={modelValues}
						onChange={(values) => setList("model", values)}
					/>
					<Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
						{t("common.reset")}
					</Button>
				</div>

				<div className="grid grid-cols-2 gap-3 px-3 py-3 md:grid-cols-3 xl:grid-cols-5">
					<Field label={t("explore.mode")}>
						<Select
							value={mode}
							onValueChange={(value) => setValue("mode", value)}
						>
							<SelectTrigger size="sm" className="w-full text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="time">{t("explore.overTime")}</SelectItem>
								<SelectItem value="dimension">
									{t("explore.byDimension")}
								</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					<Field label={t("explore.metric")}>
						<Select
							value={activeMetric}
							onValueChange={(value) => setValue("metric", value)}
						>
							<SelectTrigger size="sm" className="w-full text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="cost">{t("metric.cost")}</SelectItem>
								<SelectItem value="tokens">{t("metric.tokens")}</SelectItem>
								<SelectItem value="requests">{t("metric.requests")}</SelectItem>
								<SelectItem value="sessions">{t("common.sessions")}</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					{mode === "time" ? (
						<>
							<Field label={t("explore.breakdown")}>
								<Select
									value={breakdown}
									onValueChange={(value) => setValue("breakdown", value)}
								>
									<SelectTrigger size="sm" className="w-full text-[12px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent align="end">
										<SelectItem value="none">{t("common.none")}</SelectItem>
										<SelectItem value="harness">
											{t("common.harness")}
										</SelectItem>
										<SelectItem value="project">
											{t("common.project")}
										</SelectItem>
										<SelectItem value="model">{t("common.model")}</SelectItem>
									</SelectContent>
								</Select>
							</Field>
							<Field label={t("explore.interval")}>
								<Select
									value={bucket}
									onValueChange={(value) => setValue("bucket", value)}
								>
									<SelectTrigger size="sm" className="w-full text-[12px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent align="end">
										<SelectItem value="hour">{t("interval.hour")}</SelectItem>
										<SelectItem value="day">{t("interval.day")}</SelectItem>
										<SelectItem value="week">{t("interval.week")}</SelectItem>
										<SelectItem value="month">{t("interval.month")}</SelectItem>
									</SelectContent>
								</Select>
							</Field>
						</>
					) : (
						<Field label={t("explore.dimension")}>
							<Select
								value={dimension}
								onValueChange={(value) => setValue("dimension", value)}
							>
								<SelectTrigger size="sm" className="w-full text-[12px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									<SelectItem value="harness">{t("common.harness")}</SelectItem>
									<SelectItem value="project">{t("common.project")}</SelectItem>
									<SelectItem value="model">{t("common.model")}</SelectItem>
								</SelectContent>
							</Select>
						</Field>
					)}
					<Field label={t("explore.chart")}>
						<Select
							value={chart}
							onValueChange={(value) => setValue("chart", value)}
						>
							<SelectTrigger size="sm" className="w-full text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="bar">{t("chart.bar")}</SelectItem>
								<SelectItem value="line">{t("chart.line")}</SelectItem>
								<SelectItem value="area">{t("chart.area")}</SelectItem>
							</SelectContent>
						</Select>
					</Field>
				</div>
			</div>

			<SummaryStrip
				columns={5}
				items={[
					{
						label: t("metric.cost"),
						value: formatCost(explore.data?.totals.costUsd ?? 0),
					},
					{
						label: t("metric.tokens"),
						value: explore.data ? (
							<TokenTotal totals={explore.data.totals} />
						) : (
							formatTokens(0)
						),
					},
					{
						label: t("metric.requests"),
						value: formatNumber(explore.data?.totals.requests ?? 0),
					},
					{
						label: t("common.sessions"),
						value: formatNumber(explore.data?.totals.sessions ?? 0),
					},
					{
						label: t("metric.messages"),
						value: formatNumber(explore.data?.totals.messages ?? 0),
					},
				]}
			/>

			<div className="mt-3 rounded-lg border bg-card p-4">
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<SectionHeading
						title={t(metricLabel(activeMetric))}
						description={`${rangeLabel}, ${mode === "time" ? t(`chart.by.${bucket}`) : t(`chart.by.${dimension}`)}`}
					/>
					<span className="text-[11px] text-muted-foreground tabular">
						{t("common.totalValue", {
							value: formatMetric(totalMetric, activeMetric),
						})}
					</span>
				</div>
				{explore.isLoading && !explore.data ? (
					<Skeleton className="mt-4 h-[320px] rounded-md" />
				) : explore.isError ? (
					<div className="mt-4 rounded-lg border border-destructive/30 bg-destructive-surface p-4 text-sm text-destructive">
						{t("error.usageLoad")} {explore.error.message}
					</div>
				) : data.length === 0 ? (
					<EmptyState
						className="mt-4 border-0"
						title={t("empty.filters")}
						description={t("empty.widenFilter")}
					/>
				) : (
					<div className="mt-3 h-[340px]">
						<ResponsiveContainer width="100%" height="100%">
							{chart === "line" ? (
								<LineChart
									data={data}
									margin={{ top: 8, right: 24, left: 0, bottom: 0 }}
								>
									<CartesianGrid vertical={false} stroke="var(--chart-grid)" />
									<XAxis
										dataKey="key"
										tickFormatter={(key: string) => labelByKey.get(key) ?? key}
										axisLine={false}
										tickLine={false}
										minTickGap={32}
									/>
									<YAxis
										axisLine={false}
										tickLine={false}
										width={54}
										tickFormatter={(value: number) =>
											activeMetric === "cost"
												? formatCostAxis(value)
												: formatMetric(value, activeMetric)
										}
									/>
									<Tooltip
										content={<ExploreTooltip metric={activeMetric} />}
										isAnimationActive={false}
										cursor={{
											stroke: "var(--muted-foreground)",
											strokeOpacity: 0.35,
											strokeDasharray: "3 3",
										}}
									/>
									{series.map((item) => (
										<Line
											key={item.key}
											type="linear"
											dataKey={item.key}
											name={item.label}
											stroke={item.color ?? categoricalColors[0]}
											strokeWidth={1.6}
											dot={false}
											activeDot={{ r: 3 }}
											isAnimationActive={false}
										/>
									))}
								</LineChart>
							) : chart === "area" ? (
								<AreaChart
									data={areaOverlay.chartData}
									margin={{ top: 8, right: 24, left: 0, bottom: 0 }}
								>
									<defs>
										{series.map((item, index) => {
											const color =
												item.color ?? categoricalColors[0] ?? "var(--chart-1)";
											const stacked = series.length > 1;
											return (
												<linearGradient
													key={item.key}
													id={`explore-area-${index}`}
													x1="0"
													y1="0"
													x2="0"
													y2="1"
												>
													<stop
														offset="0%"
														stopColor={color}
														stopOpacity={stacked ? 0.8 : 0.48}
													/>
													<stop
														offset="100%"
														stopColor={color}
														stopOpacity={stacked ? 0.52 : 0.08}
													/>
												</linearGradient>
											);
										})}
									</defs>
									<CartesianGrid vertical={false} stroke="var(--chart-grid)" />
									<XAxis
										dataKey="key"
										tickFormatter={(key: string) => labelByKey.get(key) ?? key}
										axisLine={false}
										tickLine={false}
										minTickGap={32}
									/>
									<YAxis
										axisLine={false}
										tickLine={false}
										width={54}
										tickFormatter={(value: number) =>
											activeMetric === "cost"
												? formatCostAxis(value)
												: formatMetric(value, activeMetric)
										}
									/>
									<Tooltip
										content={<ExploreTooltip metric={activeMetric} />}
										isAnimationActive={false}
										cursor={{
											stroke: "var(--muted-foreground)",
											strokeOpacity: 0.35,
											strokeDasharray: "3 3",
										}}
									/>
									{series.map((item, index) => (
										<Area
											key={item.key}
											type="linear"
											stackId="explore"
											dataKey={item.key}
											name={item.label}
											stroke="none"
											fill={`url(#explore-area-${index})`}
											fillOpacity={1}
											strokeWidth={0}
											dot={false}
											activeDot={{ r: 3 }}
											isAnimationActive={false}
										/>
									))}
									{areaOverlay.strokeLines.map((line) => (
										<Line
											key={line.dataKey}
											type="linear"
											dataKey={line.dataKey}
											stroke={line.color}
											strokeWidth={1.5}
											dot={false}
											activeDot={false}
											legendType="none"
											tooltipType="none"
											connectNulls={false}
											isAnimationActive={false}
										/>
									))}
								</AreaChart>
							) : mode === "dimension" ? (
								<BarChart
									layout="vertical"
									data={data}
									margin={{ top: 8, right: 24, left: 8, bottom: 0 }}
								>
									<CartesianGrid
										horizontal={false}
										stroke="var(--chart-grid)"
									/>
									<XAxis
										type="number"
										axisLine={false}
										tickLine={false}
										tickFormatter={(value: number) =>
											activeMetric === "cost"
												? formatCostAxis(value)
												: formatMetric(value, activeMetric)
										}
									/>
									<YAxis
										type="category"
										dataKey="key"
										axisLine={false}
										tickLine={false}
										width={172}
										tickFormatter={(key: string) => {
											const value = labelByKey.get(key) ?? key;
											return value.length > 26
												? `${value.slice(0, 25)}…`
												: value;
										}}
									/>
									<Tooltip
										content={<ExploreTooltip metric={activeMetric} />}
										isAnimationActive={false}
										cursor={{ fill: "var(--hover)", fillOpacity: 0.7 }}
									/>
									<Bar
										dataKey="value"
										name={t(metricLabel(activeMetric))}
										fill={categoricalColors[0]}
										radius={[0, 2, 2, 0]}
										maxBarSize={18}
										isAnimationActive={false}
									/>
								</BarChart>
							) : (
								<BarChart
									data={data}
									margin={{ top: 8, right: 24, left: 0, bottom: 0 }}
								>
									<CartesianGrid vertical={false} stroke="var(--chart-grid)" />
									<XAxis
										dataKey="key"
										tickFormatter={(key: string) => labelByKey.get(key) ?? key}
										axisLine={false}
										tickLine={false}
										minTickGap={32}
									/>
									<YAxis
										axisLine={false}
										tickLine={false}
										width={54}
										tickFormatter={(value: number) =>
											activeMetric === "cost"
												? formatCostAxis(value)
												: formatMetric(value, activeMetric)
										}
									/>
									<Tooltip
										content={<ExploreTooltip metric={activeMetric} />}
										isAnimationActive={false}
										cursor={{ fill: "var(--hover)", fillOpacity: 0.7 }}
									/>
									{series.map((item) => (
										<Bar
											key={item.key}
											stackId="series"
											dataKey={item.key}
											name={item.label}
											fill={item.color ?? categoricalColors[0]}
											radius={0}
											maxBarSize={34}
											isAnimationActive={false}
										/>
									))}
								</BarChart>
							)}
						</ResponsiveContainer>
					</div>
				)}
				<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
					{series.map((item) => (
						<span
							key={item.key}
							className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
						>
							<span
								className="size-2 rounded-[2px]"
								style={{ background: item.color ?? categoricalColors[0] }}
							/>
							{item.label}
						</span>
					))}
				</div>
			</div>

			<div className="mt-3 rounded-lg border bg-card px-2 py-1">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							<TableHead className="h-9 px-0 text-[11px]">
								{mode === "time"
									? t("explore.series")
									: t(dimensionLabel(dimension))}
							</TableHead>
							<TableHead className="h-9 text-right text-[11px]">
								{t(metricLabel(activeMetric))}
							</TableHead>
							<TableHead className="h-9 text-right text-[11px]">
								{t("metric.share")}
							</TableHead>
							{activeMetric !== "requests" ? (
								<TableHead className="h-9 text-right text-[11px]">
									{t("metric.requests")}
								</TableHead>
							) : null}
							{activeMetric !== "tokens" ? (
								<TableHead className="h-9 text-right text-[11px]">
									{t("metric.tokens")}
								</TableHead>
							) : null}
							{activeMetric !== "cost" ? (
								<TableHead className="h-9 pr-2 text-right text-[11px]">
									{t("metric.cost")}
								</TableHead>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{tableRows.map((row) => {
							const value = metricValue(row.totals, activeMetric);
							return (
								<TableRow key={row.key} className="text-[12px]">
									<TableCell className="px-2 py-2">
										<Link
											to={rowLink(
												row.key,
												mode,
												breakdown,
												dimension,
												searchParams,
											)}
											className="inline-flex max-w-80 items-center gap-2 truncate font-medium hover:underline"
										>
											{row.color ? (
												<span
													className="size-2 shrink-0 rounded-[2px]"
													style={{ background: row.color }}
												/>
											) : null}
											<span className="truncate">{row.label}</span>
										</Link>
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{activeMetric === "tokens" ? (
											<TokenTotal totals={row.totals} />
										) : (
											formatMetric(value, activeMetric)
										)}
									</TableCell>
									<TableCell className="py-2 text-right text-muted-foreground tabular">
										{formatPercent(totalMetric > 0 ? value / totalMetric : 0)}
									</TableCell>
									{activeMetric !== "requests" ? (
										<TableCell className="py-2 text-right tabular">
											{formatNumber(row.totals.requests)}
										</TableCell>
									) : null}
									{activeMetric !== "tokens" ? (
										<TableCell className="py-2 text-right tabular">
											{formatTokens(totalTokens(row.totals))}
										</TableCell>
									) : null}
									{activeMetric !== "cost" ? (
										<TableCell className="py-2 pr-2 text-right tabular">
											{formatCost(row.totals.costUsd)}
										</TableCell>
									) : null}
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
		</PageContainer>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid gap-1">
			<span className="text-[10px] font-medium text-muted-foreground">
				{label}
			</span>
			{children}
		</div>
	);
}

function metricLabel(metric: Metric): TranslationKey {
	if (metric === "tokens") return "metric.tokens";
	if (metric === "cost") return "metric.cost";
	if (metric === "requests") return "metric.requests";
	return "common.sessions";
}

function dimensionLabel(dimension: Dimension): TranslationKey {
	if (dimension === "harness") return "common.harness";
	if (dimension === "project") return "common.project";
	return "common.model";
}

function ExploreTooltip({
	active,
	payload,
	label,
	metric,
}: {
	active?: boolean;
	payload?: Array<{
		dataKey?: string | number;
		name?: string;
		value?: number;
		color?: string;
		payload?: { tooltipLabel?: string };
	}>;
	label?: string;
	metric: Metric;
}) {
	if (!active || !payload?.length) return null;
	const visiblePayload = payload.filter(
		(item) => !String(item.dataKey ?? item.name ?? "").startsWith("__"),
	);
	if (!visiblePayload.length) return null;
	const heading = visiblePayload[0]?.payload?.tooltipLabel ?? label;
	return (
		<div className="min-w-40 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md">
			<div className="text-[11px] font-medium">{heading}</div>
			<div className="mt-1.5 space-y-1">
				{visiblePayload.map((item) => (
					<div
						key={String(item.dataKey ?? item.name)}
						className="flex items-center justify-between gap-4 text-[11px]"
					>
						<span className="flex items-center gap-1.5 text-muted-foreground">
							<span
								className="size-1.5 rounded-[1px]"
								style={{ background: item.color }}
							/>
							{item.name}
						</span>
						<span className="tabular">
							{formatMetric(item.value ?? 0, metric)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function rowLink(
	key: string,
	mode: Mode,
	breakdown: Dimension | "none",
	dimension: Dimension,
	searchParams: URLSearchParams,
): string {
	const dimensionKey = mode === "time" ? breakdown : dimension;
	if (key === "__other" || key === "all") return sessionsPath(searchParams);
	if (dimensionKey === "harness")
		return sessionsPath(searchParams, { harness: key });
	if (dimensionKey === "project")
		return sessionsPath(searchParams, { project: key || UNKNOWN_PROJECT_KEY });
	if (dimensionKey === "model")
		return sessionsPath(searchParams, { model: key });
	return sessionsPath(searchParams);
}
