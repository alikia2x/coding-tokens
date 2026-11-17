import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { HarnessShare } from "~/components/charts/harness-share";
import { ContributionHeatmap } from "~/components/charts/heatmap";
import { TopModels } from "~/components/charts/top-models";
import { UsageChart, type UsageMetric } from "~/components/charts/usage-chart";
import { HarnessDot } from "~/components/harness-badge";
import { KpiCard } from "~/components/kpi-card";
import { PageContainer } from "~/components/page-container";
import { SectionHeading } from "~/components/section-heading";
import { TokenTotal } from "~/components/token-total";
import { Skeleton } from "~/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import {
	formatCost,
	formatNumber,
	formatPercent,
	formatRelativeTime,
	formatTokens,
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useHeatmap, useOverview } from "~/lib/queries";
import { useRangeLabel } from "~/lib/range";
import { rangeQueryString } from "~/lib/time-range";

function totalTokens(totals: {
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

export function OverviewPage() {
	const range = useResolvedRange();
	const overview = useOverview(range);
	const heatmap = useHeatmap();
	const [searchParams, setSearchParams] = useSearchParams();
	const [metric, setMetric] = useState<UsageMetric>(
		searchParams.get("metric") === "tokens" ? "tokens" : "cost",
	);
	const t = useT();
	const rangeLabel = useRangeLabel();
	const rangeQuery = rangeQueryString(range);

	if (overview.isLoading && !overview.data) return <OverviewSkeleton />;
	if (overview.isError) {
		return (
			<PageContainer>
				<div className="rounded-lg border border-destructive/30 bg-destructive-surface p-4 text-sm text-destructive">
					{t("error.usageLoad")} {overview.error.message}
				</div>
			</PageContainer>
		);
	}
	const data = overview.data;
	if (!data) return null;
	const tokens = totalTokens(data.totals);
	const estimated = data.totals.estimatedRequests > 0;
	const cacheShare = tokens > 0 ? data.totals.cacheReadTokens / tokens : 0;
	const previousRequests = data.previous?.requests ?? 0;
	const activeHarnessCount = data.harnesses.filter(
		(row) => row.totals.requests > 0,
	).length;
	const requestsPerSession = data.totals.sessions
		? Math.round(data.totals.requests / data.totals.sessions)
		: 0;
	const messagesPerSession = data.totals.sessions
		? Math.round(data.totals.messages / data.totals.sessions)
		: 0;

	return (
		<PageContainer>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-[24px] font-semibold tracking-[-0.03em]">
						{t("nav.overview")}
					</h1>
					<p className="mt-0.5 text-[12px] text-muted-foreground">
						{rangeLabel} ·{" "}
						{t("count.requests", {
							count: data.totals.requests,
							formatted: formatNumber(data.totals.requests),
						})}{" "}
						·{" "}
						{t("count.sessions", {
							count: data.totals.sessions,
							formatted: formatNumber(data.totals.sessions),
						})}
					</p>
				</div>
				<span className="text-[11px] text-muted-foreground tabular">
					{t("common.updated")} {formatRelativeTime(data.indexedAt)}
				</span>
			</div>

			<div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-5">
				<KpiCard
					className="rounded-none border-0 bg-card"
					label={t("metric.cost")}
					value={formatCost(data.totals.costUsd, estimated)}
					detail={t("count.harnesses", {
						count: activeHarnessCount,
						formatted: formatNumber(activeHarnessCount),
					})}
					previous={
						previousRequests
							? {
									current: data.totals.costUsd,
									previous: data.previous?.costUsd ?? null,
								}
							: undefined
					}
				/>
				<KpiCard
					className="rounded-none border-0 bg-card"
					label={t("metric.tokens")}
					value={<TokenTotal totals={data.totals} />}
					detail={t("metric.cacheReadShare", {
						value: formatPercent(cacheShare),
					})}
					previous={
						previousRequests
							? {
									current: tokens,
									previous: data.previous ? totalTokens(data.previous) : null,
								}
							: undefined
					}
				/>
				<KpiCard
					className="rounded-none border-0 bg-card"
					label={t("metric.requests")}
					value={formatNumber(data.totals.requests)}
					detail={t("metric.costPerRequestValue", {
						value: formatCost(
							data.totals.requests
								? data.totals.costUsd / data.totals.requests
								: 0,
							estimated,
						),
					})}
					previous={
						previousRequests
							? {
									current: data.totals.requests,
									previous: data.previous?.requests ?? null,
								}
							: undefined
					}
				/>
				<KpiCard
					className="rounded-none border-0 bg-card"
					label={t("common.sessions")}
					value={formatNumber(data.totals.sessions)}
					detail={t("count.requestsPerSession", {
						count: requestsPerSession,
						formatted: formatNumber(requestsPerSession),
					})}
					previous={
						previousRequests
							? {
									current: data.totals.sessions,
									previous: data.previous?.sessions ?? null,
								}
							: undefined
					}
				/>
				<KpiCard
					className="rounded-none border-0 bg-card"
					label={t("metric.messages")}
					value={formatNumber(data.totals.messages)}
					detail={t("count.messagesPerSession", {
						count: messagesPerSession,
						formatted: formatNumber(messagesPerSession),
					})}
					previous={
						previousRequests
							? {
									current: data.totals.messages,
									previous: data.previous?.messages ?? null,
								}
							: undefined
					}
				/>
			</div>

			<div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)]">
				<div className="flex flex-col rounded-lg border bg-card p-4">
					<UsageChart
						buckets={data.buckets}
						metric={metric}
						onMetricChange={(next) => {
							setMetric(next);
							const params = new URLSearchParams(searchParams);
							params.set("metric", next);
							setSearchParams(params, { replace: true });
						}}
						unit={data.bucketUnit}
					/>
				</div>
				<div className="divide-y rounded-lg border bg-card">
					<div className="p-4">
						<HarnessShare rows={data.harnesses} />
					</div>
					<div className="p-4">
						<TopModels rows={data.models.slice(0, 5)} />
					</div>
				</div>
			</div>

			<div className="mt-3">
				{heatmap.data ? (
					<ContributionHeatmap
						days={heatmap.data.days}
						maxTokens={heatmap.data.maxTokens}
						totals={heatmap.data.totals}
					/>
				) : (
					<Skeleton className="h-[170px] rounded-lg" />
				)}
			</div>

			<div className="mt-3 grid rounded-lg border bg-card lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:divide-x">
				<div className="p-4">
					<SectionHeading
						title={t("overview.topProjects")}
						actions={
							<Link
								to={`/projects?${rangeQuery}`}
								className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
							>
								{t("common.allProjects")}
								<ArrowUpRight className="size-3" />
							</Link>
						}
					/>
					<Table className="mt-2 text-[12px]">
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="h-8 px-0 text-[11px]">
									{t("common.project")}
								</TableHead>
								<TableHead className="h-8 text-right text-[11px]">
									{t("common.sessions")}
								</TableHead>
								<TableHead className="h-8 text-right text-[11px]">
									{t("metric.tokens")}
								</TableHead>
								<TableHead className="h-8 text-right text-[11px]">
									{t("metric.cost")}
								</TableHead>
								<TableHead className="h-8 pr-2 text-right text-[11px]">
									{t("common.last")}
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.projects.map((project) => (
								<TableRow key={project.cwd ?? project.name}>
									<TableCell className="px-2 py-2">
										<Link
											to={`/sessions?${rangeQuery}${project.cwd ? `&project=${encodeURIComponent(project.cwd)}` : ""}`}
											className="block max-w-64 truncate font-medium hover:underline"
										>
											{localizeLabel(t, project.name)}
										</Link>
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatNumber(project.totals.sessions)}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatTokens(totalTokens(project.totals))}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatCost(
											project.totals.costUsd,
											project.totals.estimatedRequests > 0,
										)}
									</TableCell>
									<TableCell className="py-2 pr-2 text-right text-[11px] text-muted-foreground">
										{formatRelativeTime(project.lastActivityAt)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					{!data.projects.length ? (
						<p className="py-8 text-center text-[12px] text-muted-foreground">
							{t("empty.projectActivity")}
						</p>
					) : null}
				</div>

				<div className="border-t p-4 lg:border-t-0">
					<SectionHeading
						title={t("overview.recentSessions")}
						actions={
							<Link
								to={`/sessions?${rangeQuery}`}
								className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
							>
								{t("common.allSessions")}
								<ArrowUpRight className="size-3" />
							</Link>
						}
					/>
					<div className="mt-1 divide-y">
						{data.recentSessions.map((session) => (
							<Link
								key={session.key}
								to={`/sessions/${session.harness}/${encodeURIComponent(session.sessionId)}`}
								className="flex items-center gap-2.5 py-2.5 transition-colors hover:underline"
							>
								<HarnessDot harness={session.harness} />
								<div className="min-w-0 flex-1">
									<div className="truncate text-[12px] font-medium">
										{localizeLabel(t, session.title)}
									</div>
									<div className="truncate text-[11px] text-muted-foreground">
										{localizeLabel(t, session.projectName)}
									</div>
								</div>
								<div className="text-right">
									<div className="tabular">
										{formatCost(
											session.totals.costUsd,
											session.totals.estimatedRequests > 0,
										)}
									</div>
									<div className="text-[10px] text-muted-foreground">
										{formatRelativeTime(session.lastActivityAt)}
									</div>
								</div>
							</Link>
						))}
					</div>
					{!data.recentSessions.length ? (
						<p className="py-8 text-center text-[12px] text-muted-foreground">
							{t("empty.sessionsInRange")}
						</p>
					) : null}
				</div>
			</div>
		</PageContainer>
	);
}

function OverviewSkeleton() {
	return (
		<PageContainer>
			<Skeleton className="h-6 w-32" />
			<div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-5">
				{Array.from({ length: 4 }, (_, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
					<Skeleton key={index} className="h-[104px] rounded-lg" />
				))}
			</div>
			<div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)]">
				<Skeleton className="h-[340px] rounded-lg" />
				<div className="flex flex-col gap-3">
					<Skeleton className="h-[160px] rounded-lg" />
					<Skeleton className="h-[168px] rounded-lg" />
				</div>
			</div>
		</PageContainer>
	);
}
