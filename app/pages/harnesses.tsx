import { matchesTextQuery, parseSearchQuery } from "@shared/search";
import type { HarnessReportRow } from "@shared/types";
import { cn } from "cn";
import { AlertTriangle, ChevronRight, Search } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { EmptyState } from "~/components/empty-state";
import { HarnessDot } from "~/components/harness-badge";
import { PageContainer } from "~/components/page-container";
import { SectionHeading } from "~/components/section-heading";
import { SummaryStrip } from "~/components/summary-strip";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
	formatCost,
	formatNumber,
	formatPercent,
	formatTokens,
	totalTokens,
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { useHarnesses } from "~/lib/queries";
import { useAppStore } from "~/lib/store";
import { type ResolvedRange, sessionsPath } from "~/lib/time-range";

export function HarnessesPage() {
	const range = useResolvedRange();
	const harnesses = useHarnesses(range);
	const query = useAppStore((state) => state.harnessesPage.query);
	const openList = useAppStore((state) => state.harnessesPage.open);
	const setQuery = useAppStore((state) => state.setHarnessesQuery);
	const toggleHarnessOpen = useAppStore((state) => state.toggleHarnessOpen);
	const open = useMemo(() => new Set(openList), [openList]);
	const t = useT();
	const parsed = useMemo(() => parseSearchQuery(query), [query]);
	const rows = useMemo(
		() =>
			(harnesses.data?.rows ?? [])
				.filter((row) => row.totals.sessions > 0 || row.totals.requests > 0)
				.filter((row) =>
					matchesTextQuery(
						parsed,
						[
							row.label,
							row.harness,
							...row.paths,
							...row.topModels.map((model) => model.model),
						],
						{
							harness: [row.label, row.harness],
							model: row.topModels.map((model) => model.model),
						},
					),
				),
		[harnesses.data, parsed],
	);
	const totals = harnesses.data?.totals;

	function toggle(harness: string): void {
		toggleHarnessOpen(harness);
	}

	if (harnesses.isLoading && !harnesses.data) {
		return (
			<PageContainer>
				<Skeleton className="h-6 w-32" />
				<Skeleton className="mt-3 h-20 rounded-lg" />
				<div className="mt-3 space-y-2">
					{Array.from({ length: 5 }, (_, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
						<Skeleton key={index} className="h-16 rounded-md" />
					))}
				</div>
			</PageContainer>
		);
	}

	if (harnesses.isError && !harnesses.data) {
		return (
			<PageContainer>
				<div className="rounded-lg border border-destructive/30 bg-destructive-surface p-4 text-sm text-destructive">
					{t("error.usageLoad")} {harnesses.error.message}
				</div>
			</PageContainer>
		);
	}

	return (
		<PageContainer>
			<SectionHeading title={t("common.harnesses")} />
			<SummaryStrip
				items={[
					{
						label: t("metric.cost"),
						value: formatCost(totals?.costUsd ?? 0),
					},
					{
						label: t("metric.tokens"),
						value: formatTokens(totals ? totalTokens(totals) : 0),
					},
					{
						label: t("metric.requests"),
						value: formatNumber(totals?.requests ?? 0),
					},
					{
						label: t("common.sessions"),
						value: formatNumber(totals?.sessions ?? 0),
					},
				]}
			/>
			<div className="mt-3">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("harnesses.search")}
						className="pl-8 text-[12px]"
						data-search-input
					/>
				</div>
			</div>

			{harnesses.isError ? (
				<div className="mt-3 rounded-lg border border-destructive/30 bg-destructive-surface p-4 text-sm text-destructive">
					{t("error.usageLoad")} {harnesses.error.message}
				</div>
			) : null}

			{rows.length === 0 ? (
				<EmptyState
					className="mt-3"
					title={t("empty.results")}
					description={t("empty.widenSearch")}
				/>
			) : (
				<div className="mt-3 rounded-lg border bg-card">
					<div className="grid grid-cols-[minmax(160px,1.4fr)_80px_80px_90px_90px_24px] gap-2 border-b px-4 py-2 text-[10px] text-muted-foreground max-lg:hidden">
						<span>{t("common.harness")}</span>
						<span className="text-right">{t("common.sessions")}</span>
						<span className="text-right">{t("metric.requests")}</span>
						<span className="text-right">{t("metric.tokens")}</span>
						<span className="text-right">{t("metric.cost")}</span>
						<span />
					</div>
					<div className="divide-y">
						{rows.map((row) => (
							<HarnessRow
								key={row.harness}
								row={row}
								open={open.has(row.harness)}
								range={range}
								onToggle={() => toggle(row.harness)}
							/>
						))}
					</div>
				</div>
			)}
		</PageContainer>
	);
}

function HarnessRow({
	row,
	open,
	range,
	onToggle,
}: {
	row: HarnessReportRow;
	open: boolean;
	range: ResolvedRange;
	onToggle: () => void;
}) {
	const t = useT();
	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="grid w-full grid-cols-[minmax(160px,1.4fr)_80px_80px_90px_90px_24px] items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-hover max-lg:grid-cols-[minmax(0,1fr)_auto]"
			>
				<span className="flex min-w-0 flex-col">
					<span className="flex items-center gap-2">
						<HarnessDot harness={row.harness} />
						<span className="truncate text-[12px] font-medium">
							{row.label}
						</span>
					</span>
					{row.paths[0] ? (
						<span
							className="mt-0.5 truncate pl-4 font-mono text-[10px] text-muted-foreground"
							title={row.paths[0]}
						>
							{row.paths[0]}
						</span>
					) : null}
				</span>
				<span className="text-right text-[11px] tabular max-lg:hidden">
					{formatNumber(row.totals.sessions)}
				</span>
				<span className="text-right text-[11px] tabular max-lg:hidden">
					{formatNumber(row.totals.requests)}
				</span>
				<span className="text-right text-[11px] tabular max-lg:hidden">
					{formatTokens(totalTokens(row.totals))}
				</span>
				<span className="text-right text-[11px] tabular max-lg:hidden">
					{formatCost(row.totals.costUsd)}
				</span>
				<ChevronRight
					className={cn(
						"size-3.5 justify-self-end text-muted-foreground transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
			</button>
			<div className="collapse-grid" data-open={open}>
				<div>
					<div className="grid gap-5 border-t px-4 py-3 lg:grid-cols-[1.1fr_1fr]">
						<div>
							<div className="flex items-center justify-between text-[11px]">
								<span className="text-muted-foreground">
									{t("metric.costShare")}
								</span>
								<span className="tabular">{formatPercent(row.costShare)}</span>
							</div>
							<div className="mt-1.5 h-1.5 overflow-hidden rounded-[1px] bg-muted">
								<div
									className="h-full bg-chart-1"
									style={{
										width:
											row.costShare > 0
												? `${Math.max(1, row.costShare * 100)}%`
												: "0%",
									}}
								/>
							</div>
							<div className="mt-3 text-[10px] text-muted-foreground">
								{t("harnesses.dataSources")}
							</div>
							<div className="mt-1 space-y-1">
								{row.paths.map((path) => (
									<div
										key={path}
										className="truncate font-mono text-[10px] text-muted-foreground"
										title={path}
									>
										{path}
									</div>
								))}
							</div>
							{row.warnings.length ? (
								<div className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
									<AlertTriangle className="mt-0.5 size-3 shrink-0" />
									<span>{row.warnings[0]}</span>
								</div>
							) : null}
						</div>
						<div>
							<div className="flex items-center justify-between text-[11px]">
								<span className="text-muted-foreground">
									{t("overview.topModels")}
								</span>
								<Link
									to={sessionsPath(range, { harness: row.harness })}
									className="text-muted-foreground hover:text-foreground"
								>
									{t("harnesses.viewSessions")}
								</Link>
							</div>
							<div className="mt-1 divide-y">
								{row.topModels.map((model) => (
									<Link
										key={model.model}
										to={sessionsPath(range, {
											harness: row.harness,
											model: model.model,
										})}
										className="grid grid-cols-[minmax(0,1fr)_80px_84px] items-center gap-3 py-1.5 text-[11px] hover:underline"
									>
										<span className="truncate">{model.model}</span>
										<span className="text-right text-muted-foreground tabular">
											{formatTokens(model.tokens)}
										</span>
										<span className="text-right tabular">
											{formatCost(model.costUsd)}
										</span>
									</Link>
								))}
								{!row.topModels.length ? (
									<p className="py-3 text-[11px] text-muted-foreground">
										{t("empty.modelUsage")}
									</p>
								) : null}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
