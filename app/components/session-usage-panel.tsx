import type { SessionStats, SessionSummary, TurnSummary } from "@shared/types";
import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CopyButton } from "~/components/copy-button";
import { tokenColors } from "~/lib/chart-colors";
import {
	formatCost,
	formatDateTime,
	formatDuration,
	formatLatency,
	formatNumber,
	formatPercent,
	formatThroughput,
	formatTokens,
	totalTokens,
} from "~/lib/format";
import { useT } from "~/lib/i18n";

const TURN_CHART_MARGIN = { top: 4, right: 4, left: 0, bottom: 0 };
const TURN_TOOLTIP_CURSOR = { fill: "var(--hover)", fillOpacity: 0.7 };

const tokenParts = [
	{ key: "inputTokens", label: "metric.input", color: tokenColors.input },
	{ key: "outputTokens", label: "metric.output", color: tokenColors.output },
	{
		key: "cacheReadTokens",
		label: "metric.cacheRead",
		color: tokenColors.cacheRead,
	},
	{
		key: "cacheWriteTokens",
		label: "metric.cacheWrite",
		color: tokenColors.cacheWrite,
	},
] as const;

export function SessionUsagePanel({
	summary,
	stats,
	turns,
}: {
	summary: SessionSummary;
	stats: SessionStats;
	turns: TurnSummary[];
}) {
	const t = useT();
	const [open, setOpen] = useState(true);
	const totals = summary.totals;
	const tokens = totalTokens(totals);
	const cacheDenominator =
		totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
	const cacheHit =
		cacheDenominator > 0 ? totals.cacheReadTokens / cacheDenominator : null;
	const modelMax = useMemo(
		() =>
			Math.max(1, ...stats.models.map((model) => totalTokens(model.totals))),
		[stats.models],
	);
	const turnData = useMemo(
		() =>
			turns
				.filter((turn) => turn.index >= 0)
				.map((turn) => ({
					label: `T${turn.index + 1}`,
					tokens: totalTokens(turn.totals),
					cost: turn.totals.costUsd,
					durationMs: turn.durationMs ?? null,
					ttftMs: turn.ttftMs ?? null,
					tokensPerSecond: turn.tokensPerSecond ?? null,
				})),
		[turns],
	);
	const metrics = stats.metrics;
	const hasGenerationMetrics = Boolean(
		metrics &&
			(metrics.avgTtftMs !== null ||
				metrics.tokensPerSecond !== null ||
				metrics.modelDurationMs !== null ||
				metrics.toolDurationMs !== null),
	);
	const splitTotalMs =
		(metrics?.modelDurationMs ?? 0) + (metrics?.toolDurationMs ?? 0);
	const showTimeSplit =
		Boolean(metrics?.modelDurationMs && metrics.modelDurationMs > 0) &&
		Boolean(metrics?.toolDurationMs && metrics.toolDurationMs > 0) &&
		splitTotalMs > 0;

	return (
		<section className="pb-3">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex w-full items-center justify-between py-3 text-left"
			>
				<span className="text-[12px] font-medium">{t("session.usage")}</span>
				<span className="flex items-center gap-2 text-[11px] text-muted-foreground tabular">
					{formatCost(totals.costUsd)}
					<ChevronDown
						className={cn(
							"size-3.5 transition-transform duration-150",
							open && "rotate-180",
						)}
					/>
				</span>
			</button>
			<div className="collapse-grid" data-open={open}>
				<div>
					<div className="pb-4">
						<div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
							<Stat
								label={t("metric.cost")}
								value={formatCost(totals.costUsd)}
							/>
							<Stat label={t("metric.tokens")} value={formatTokens(tokens)} />
							<Stat
								label={t("metric.requests")}
								value={formatNumber(totals.requests)}
							/>
							<Stat
								label={t("metric.messages")}
								value={formatNumber(totals.messages)}
							/>
							<Stat
								label={t("metric.duration")}
								value={formatDuration(summary.durationMs)}
							/>
						</div>

						{hasGenerationMetrics && metrics ? (
							<div className="mt-5 border-t pt-4">
								<div className="text-[11px] text-muted-foreground">
									{t("metric.generationPerformance")}
								</div>
								<div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
									<Stat
										label={t("metric.ttft")}
										value={formatLatency(metrics.avgTtftMs)}
										detail={
											metrics.p50TtftMs !== null &&
											metrics.p50TtftMs !== metrics.avgTtftMs
												? t("metric.p50", {
														value: formatLatency(metrics.p50TtftMs),
													})
												: undefined
										}
									/>
									<Stat
										label={t("metric.throughput")}
										value={formatThroughput(metrics.tokensPerSecond)}
									/>
									<Stat
										label={t("metric.modelTime")}
										value={formatLatency(metrics.modelDurationMs)}
									/>
									<Stat
										label={t("metric.toolTime")}
										value={formatLatency(metrics.toolDurationMs)}
										detail={
											metrics.avgToolDurationMs !== null
												? t("metric.avgToolDuration", {
														value: formatLatency(metrics.avgToolDurationMs),
													})
												: undefined
										}
									/>
								</div>
								{showTimeSplit ? (
									<div className="mt-3">
										<div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
											<span>{t("metric.timeSplit")}</span>
											<span className="flex items-center gap-2 tabular">
												<span>
													{t("metric.modelTime")}{" "}
													{formatPercent(
														(metrics.modelDurationMs ?? 0) / splitTotalMs,
													)}
												</span>
												<span>
													{t("metric.toolTime")}{" "}
													{formatPercent(
														(metrics.toolDurationMs ?? 0) / splitTotalMs,
													)}
												</span>
											</span>
										</div>
										<div className="mt-1.5 flex h-2 overflow-hidden rounded-[2px] bg-muted">
											<div
												style={{
													width: `${((metrics.modelDurationMs ?? 0) / splitTotalMs) * 100}%`,
													background: "var(--chart-1)",
												}}
											/>
											<div
												style={{
													width: `${((metrics.toolDurationMs ?? 0) / splitTotalMs) * 100}%`,
													background: "var(--chart-2)",
												}}
											/>
										</div>
									</div>
								) : null}
							</div>
						) : null}

						<div className="mt-5 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
							<div>
								<div className="flex items-baseline justify-between">
									<span className="text-[11px] text-muted-foreground">
										{t("metric.tokenMix")}
									</span>
									<span className="text-[10px] text-muted-foreground tabular">
										{formatTokens(tokens)}
									</span>
								</div>
								<div className="mt-2 flex h-2.5 overflow-hidden rounded-[2px] bg-muted">
									{tokenParts.map((part) => (
										<div
											key={part.key}
											style={{
												width: `${tokens > 0 ? (totals[part.key] / tokens) * 100 : 0}%`,
												background: part.color,
											}}
										/>
									))}
								</div>
								<div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
									{tokenParts.map((part) => (
										<div key={part.key}>
											<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
												<span
													className="size-1.5 rounded-[1px]"
													style={{ background: part.color }}
												/>
												{t(part.label)}
											</div>
											<div className="mt-0.5 flex items-baseline gap-1.5">
												<span className="text-[12px] tabular">
													{formatTokens(totals[part.key])}
												</span>
												<span className="text-[10px] text-muted-foreground tabular">
													{formatPercent(
														tokens ? totals[part.key] / tokens : 0,
													)}
												</span>
											</div>
										</div>
									))}
								</div>
								<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
									<span>
										{t("metric.cacheHit")}{" "}
										<span className="text-foreground tabular">
											{formatPercent(cacheHit)}
										</span>
									</span>
									{totals.costUsd > 0 ? (
										<span>
											{t("metric.costPerRequest")}{" "}
											<span className="text-foreground tabular">
												{formatCost(
													totals.requests
														? totals.costUsd / totals.requests
														: 0,
												)}
											</span>
										</span>
									) : null}
									<span>
										{t("metric.tokensPerRequest")}{" "}
										<span className="text-foreground tabular">
											{formatTokens(
												totals.requests ? tokens / totals.requests : 0,
											)}
										</span>
									</span>
									<span>
										{t("metric.toolCalls")}{" "}
										<span className="text-foreground tabular">
											{formatNumber(stats.toolCalls)}
										</span>
									</span>
								</div>
							</div>

							<div>
								<div className="text-[11px] text-muted-foreground">
									{t("common.models")}
								</div>
								<div className="mt-1.5 space-y-2">
									{stats.models.map((model) => {
										const modelTokens = totalTokens(model.totals);
										return (
											<div key={model.model}>
												<div className="flex items-baseline justify-between gap-3 text-[11px]">
													<span className="truncate">{model.model}</span>
													<span className="shrink-0 tabular">
														{formatTokens(modelTokens)}
													</span>
												</div>
												<div className="mt-1 h-1 overflow-hidden rounded-[1px] bg-muted">
													<div
														className="h-full bg-chart-1"
														style={{
															width:
																modelTokens > 0
																	? `${Math.max(1, (modelTokens / modelMax) * 100)}%`
																	: "0%",
														}}
													/>
												</div>
												<div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground tabular">
													<span>
														{t("count.requests", {
															count: model.totals.requests,
															formatted: formatNumber(model.totals.requests),
														})}
													</span>
													{model.totals.costUsd > 0 ? (
														<span>{formatCost(model.totals.costUsd)}</span>
													) : null}
												</div>
											</div>
										);
									})}
								</div>
							</div>
						</div>

						{turnData.length ? (
							<div className="mt-5">
								<div className="flex items-baseline justify-between">
									<span className="text-[11px] text-muted-foreground">
										{t("metric.tokensByTurn")}
									</span>
									<span className="text-[10px] text-muted-foreground tabular">
										{t("count.turns", {
											count: stats.turns,
											formatted: formatNumber(stats.turns),
										})}
									</span>
								</div>
								<div className="mt-1 h-[112px]">
									<ResponsiveContainer width="100%" height="100%">
										<BarChart data={turnData} margin={TURN_CHART_MARGIN}>
											<CartesianGrid
												vertical={false}
												stroke="var(--chart-grid)"
											/>
											<XAxis
												dataKey="label"
												axisLine={false}
												tickLine={false}
												minTickGap={24}
												tickMargin={4}
											/>
											<YAxis
												axisLine={false}
												tickLine={false}
												width={56}
												tickMargin={6}
												tickFormatter={formatTokens}
											/>
											<Tooltip
												content={<TurnTooltip />}
												cursor={TURN_TOOLTIP_CURSOR}
												isAnimationActive={false}
											/>
											<Bar
												dataKey="tokens"
												fill="var(--chart-1)"
												radius={0}
												maxBarSize={22}
												isAnimationActive={false}
											/>
										</BarChart>
									</ResponsiveContainer>
								</div>
							</div>
						) : null}

						<div className="mt-5 grid gap-x-6 gap-y-2 text-[11px] sm:grid-cols-3">
							<Meta
								label={t("session.started")}
								value={formatDateTime(summary.startedAt)}
							/>
							<Meta
								label={t("session.lastActivity")}
								value={formatDateTime(summary.lastActivityAt)}
							/>
							<Meta label={t("common.project")} value={summary.projectName} />
							<div>
								<div className="text-[10px] text-muted-foreground">
									{t("session.id")}
								</div>
								<div className="mt-0.5 flex items-center gap-1">
									<span className="truncate font-mono text-[10px]">
										{summary.sessionId}
									</span>
									<CopyButton
										value={summary.sessionId}
										label={t("session.copyId")}
									/>
								</div>
							</div>
							{summary.cwd ? (
								<div className="sm:col-span-2">
									<div className="text-[10px] text-muted-foreground">
										{t("session.path")}
									</div>
									<div className="mt-0.5 truncate font-mono text-[10px]">
										{summary.cwd}
									</div>
								</div>
							) : null}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function TurnTooltip({
	active,
	payload,
	label,
}: {
	active?: boolean;
	payload?: Array<{
		payload?: {
			tokens: number;
			cost: number;
			durationMs?: number | null;
			ttftMs?: number | null;
			tokensPerSecond?: number | null;
		};
	}>;
	label?: string;
}) {
	const t = useT();
	const point = payload?.[0]?.payload;
	if (!active || !point) return null;
	return (
		<div className="min-w-40 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md">
			<div className="text-[11px] font-medium">{label}</div>
			<div className="mt-1 flex items-center justify-between gap-4 text-[11px]">
				<span className="text-muted-foreground">{t("metric.tokens")}</span>
				<span className="tabular">{formatTokens(point.tokens)}</span>
			</div>
			<div className="flex items-center justify-between gap-4 text-[11px]">
				<span className="text-muted-foreground">{t("metric.cost")}</span>
				<span className="tabular">{formatCost(point.cost)}</span>
			</div>
			{point.ttftMs !== null && point.ttftMs !== undefined ? (
				<div className="flex items-center justify-between gap-4 text-[11px]">
					<span className="text-muted-foreground">{t("metric.ttft")}</span>
					<span className="tabular">{formatLatency(point.ttftMs)}</span>
				</div>
			) : null}
			{point.tokensPerSecond !== null && point.tokensPerSecond !== undefined ? (
				<div className="flex items-center justify-between gap-4 text-[11px]">
					<span className="text-muted-foreground">
						{t("metric.throughput")}
					</span>
					<span className="tabular">
						{formatThroughput(point.tokensPerSecond)}
					</span>
				</div>
			) : null}
			{point.durationMs !== null && point.durationMs !== undefined ? (
				<div className="flex items-center justify-between gap-4 text-[11px]">
					<span className="text-muted-foreground">{t("metric.duration")}</span>
					<span className="tabular">{formatLatency(point.durationMs)}</span>
				</div>
			) : null}
		</div>
	);
}

function Stat({
	label,
	value,
	detail,
}: {
	label: string;
	value: string;
	detail?: string;
}) {
	return (
		<div className="min-w-0">
			<div className="text-[10px] text-muted-foreground">{label}</div>
			<div className="mt-0.5 text-[15px] font-medium leading-5 tabular">
				{value}
			</div>
			{detail ? (
				<div className="mt-0.5 text-[10px] text-muted-foreground tabular">
					{detail}
				</div>
			) : null}
		</div>
	);
}

function Meta({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<div className="text-[10px] text-muted-foreground">{label}</div>
			<div className="mt-0.5 truncate tabular">{value}</div>
		</div>
	);
}
