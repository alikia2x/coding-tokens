import { matchesTextQuery, parseSearchQuery } from "@shared/search";
import { HARNESS_LABELS, type ModelReportRow } from "@shared/types";
import { cn } from "cn";
import { Pencil, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Sparkline } from "~/components/charts/sparkline";
import { EmptyState } from "~/components/empty-state";
import { PageContainer } from "~/components/page-container";
import { ModelPricingDialog } from "~/components/pricing/model-pricing-dialog";
import { PricingCatalogDialog } from "~/components/pricing/pricing-catalog-dialog";
import { PricingStatusPill } from "~/components/pricing/pricing-status-pill";
import { SectionHeading } from "~/components/section-heading";
import { SortableHead, type SortState } from "~/components/sortable-head";
import { SummaryStrip } from "~/components/summary-strip";
import { Input } from "~/components/ui/input";
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
	totalTokens,
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useModels } from "~/lib/queries";
import { sessionsPath } from "~/lib/time-range";

function isRowUnpriced(row: ModelReportRow): boolean {
	return (
		row.pricing?.source === "unpriced" ||
		(row.totals.requests > 0 &&
			row.totals.unpricedRequests >= row.totals.requests)
	);
}

function compareNullable(
	left: number | null,
	right: number | null,
	direction: "asc" | "desc",
): number {
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	return direction === "asc" ? left - right : right - left;
}

function compareModels(
	left: ModelReportRow,
	right: ModelReportRow,
	key: string,
	direction: "asc" | "desc",
): number {
	if (key === "cache") {
		return compareNullable(
			left.cacheReadShare,
			right.cacheReadShare,
			direction,
		);
	}
	if (key === "efficiency") {
		return compareNullable(
			left.costPerMillionTokens,
			right.costPerMillionTokens,
			direction,
		);
	}
	if (key === "recent") {
		return compareNullable(
			left.lastActivityAt,
			right.lastActivityAt,
			direction,
		);
	}
	const sign = direction === "asc" ? 1 : -1;
	switch (key) {
		case "model":
			return left.model.localeCompare(right.model) * sign;
		case "requests":
			return (left.totals.requests - right.totals.requests) * sign;
		case "tokens":
			return (totalTokens(left.totals) - totalTokens(right.totals)) * sign;
		default:
			return (left.totals.costUsd - right.totals.costUsd) * sign;
	}
}

export function ModelsPage() {
	const range = useResolvedRange();
	const models = useModels(range);
	const [query, setQuery] = useState("");
	const [unpricedOnly, setUnpricedOnly] = useState(false);
	const [editingRow, setEditingRow] = useState<ModelReportRow | null>(null);
	const [catalogDialogOpen, setCatalogDialogOpen] = useState(false);
	const [sort, setSort] = useState<SortState>({
		key: "cost",
		direction: "desc",
	});
	const t = useT();
	const parsed = useMemo(() => parseSearchQuery(query), [query]);

	const allRows = models.data?.rows ?? [];
	const unpricedModelCount = useMemo(
		() => allRows.filter((row) => isRowUnpriced(row)).length,
		[allRows],
	);

	const rows = useMemo(() => {
		const filtered = allRows.filter((row) => {
			if (unpricedOnly && !isRowUnpriced(row)) {
				return false;
			}
			const localized = localizeLabel(t, row.model);
			const harnessLabels = row.harnesses.map(
				(harness) => HARNESS_LABELS[harness] ?? harness,
			);
			return matchesTextQuery(
				parsed,
				[
					row.model,
					localized,
					row.provider ?? "",
					...(row.pricing?.rawModelIds ?? []),
					...row.harnesses,
					...harnessLabels,
				],
				{
					model: [row.model, localized, ...(row.pricing?.rawModelIds ?? [])],
					harness: [...row.harnesses, ...harnessLabels],
				},
			);
		});
		return [...filtered].sort((left, right) =>
			compareModels(left, right, sort.key, sort.direction),
		);
	}, [allRows, unpricedOnly, parsed, sort, t]);

	const summary = useMemo(
		() =>
			rows.reduce(
				(acc, row) => ({
					requests: acc.requests + row.totals.requests,
					tokens: acc.tokens + totalTokens(row.totals),
					cacheRead: acc.cacheRead + row.totals.cacheReadTokens,
					cost: acc.cost + row.totals.costUsd,
				}),
				{ requests: 0, tokens: 0, cacheRead: 0, cost: 0 },
			),
		[rows],
	);
	const cacheShare =
		summary.tokens > 0 ? summary.cacheRead / summary.tokens : 0;

	function onSort(key: string): void {
		setSort((current) =>
			current.key === key
				? { key, direction: current.direction === "desc" ? "asc" : "desc" }
				: { key, direction: key === "model" ? "asc" : "desc" },
		);
	}

	const isInitialLoading = models.isLoading && !models.data;

	return (
		<PageContainer>
			<SectionHeading
				title={t("common.models")}
				description={
					<span className="inline-flex flex-wrap items-center gap-2">
						<span>
							{t("count.activeModels", {
								count: rows.length,
								formatted: formatNumber(rows.length),
							})}
						</span>
						{unpricedModelCount > 0 ? (
							<button
								type="button"
								onClick={() => setUnpricedOnly((current) => !current)}
								className={cn(
									"inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
									unpricedOnly
										? "border-warning/50 bg-warning/15 text-warning"
										: "border-warning/30 bg-warning/10 text-warning hover:bg-warning/15",
								)}
							>
								{t("models.unpricedCount", {
									formatted: formatNumber(unpricedModelCount),
								})}
							</button>
						) : null}
					</span>
				}
				actions={
					<PricingStatusPill onClick={() => setCatalogDialogOpen(true)} />
				}
			/>
			<SummaryStrip
				items={[
					{ label: t("metric.cost"), value: formatCost(summary.cost) },
					{ label: t("metric.tokens"), value: formatTokens(summary.tokens) },
					{
						label: t("metric.requests"),
						value: formatNumber(summary.requests),
					},
					{
						label: t("metric.cacheRead"),
						value: formatPercent(cacheShare),
					},
				]}
			/>
			<div className="mt-3">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("models.search")}
						className="pl-8 text-[12px]"
						data-search-input
					/>
				</div>
			</div>

			{isInitialLoading && (
				<div className="mt-3 space-y-2">
					{Array.from({ length: 8 }, (_, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
						<Skeleton key={index} className="h-12 rounded-md" />
					))}
				</div>
			)}
			{models.isError && (
				<div className="mt-3 rounded-lg border border-destructive/30 bg-destructive-surface p-4 text-sm text-destructive">
					{t("error.usageLoad")} {models.error.message}
				</div>
			)}
			{!isInitialLoading && !models.isError && rows.length === 0 && (
				<EmptyState
					className="mt-3"
					title={t("empty.modelsInRange")}
					description={t("empty.widenSearch")}
				/>
			)}
			{!isInitialLoading && rows.length > 0 && (
				<div className="mt-3 rounded-lg border bg-card px-2">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<SortableHead
									label={t("common.model")}
									sortKey="model"
									sort={sort}
									onSort={onSort}
									align="left"
									className="px-0"
								/>
								<TableHead className="h-9 text-[11px]">
									{t("common.harnesses")}
								</TableHead>
								<SortableHead
									label={t("metric.requests")}
									sortKey="requests"
									sort={sort}
									onSort={onSort}
								/>
								<SortableHead
									label={t("metric.tokens")}
									sortKey="tokens"
									sort={sort}
									onSort={onSort}
								/>
								<SortableHead
									label={t("metric.cacheRead")}
									sortKey="cache"
									sort={sort}
									onSort={onSort}
								/>
								<SortableHead
									label={t("metric.cost")}
									sortKey="cost"
									sort={sort}
									onSort={onSort}
								/>
								<SortableHead
									label={t("metric.costPerMillion")}
									sortKey="efficiency"
									sort={sort}
									onSort={onSort}
								/>
								<SortableHead
									label={t("common.last")}
									sortKey="recent"
									sort={sort}
									onSort={onSort}
								/>
								<TableHead className="h-9 w-28 text-right text-[11px]">
									{t("common.trend")}
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => {
								const isUnpriced = isRowUnpriced(row);
								const exceptionLabel = isUnpriced
									? t("pricing.source.unpriced")
									: null;
								return (
									<TableRow key={row.model} className="group text-[12px]">
										<TableCell className="px-2 py-2">
											<Link
												to={sessionsPath(range, { model: row.model })}
												className="block max-w-80 truncate font-medium hover:underline"
											>
												{localizeLabel(t, row.model)}
											</Link>
											{row.provider || exceptionLabel ? (
												<span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
													{row.provider ? <span>{row.provider}</span> : null}
													{exceptionLabel ? (
														<span className="rounded bg-warning/10 px-1 py-px text-[9.5px] font-medium leading-tight text-warning">
															{exceptionLabel}
														</span>
													) : null}
												</span>
											) : null}
										</TableCell>
										<TableCell className="py-2 text-[10px] text-muted-foreground">
											{row.harnesses
												.map((harness) => HARNESS_LABELS[harness])
												.join(", ")}
										</TableCell>
										<TableCell className="py-2 text-right tabular">
											{formatNumber(row.totals.requests)}
										</TableCell>
										<TableCell className="py-2 text-right tabular">
											{formatTokens(totalTokens(row.totals))}
										</TableCell>
										<TableCell className="py-2 text-right tabular">
											{formatPercent(row.cacheReadShare)}
										</TableCell>
										<TableCell className="py-2 text-right tabular">
											{isUnpriced ? (
												<button
													type="button"
													onClick={() => setEditingRow(row)}
													className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning/10"
												>
													{t("models.setPrice")}
												</button>
											) : (
												<button
													type="button"
													onClick={() => setEditingRow(row)}
													title={t("models.editPrice")}
													className="-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-hover"
												>
													<Pencil className="size-2.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
													<span>{formatCost(row.totals.costUsd)}</span>
												</button>
											)}
										</TableCell>
										<TableCell className="py-2 text-right tabular">
											{row.costPerMillionTokens === null
												? "—"
												: formatCost(row.costPerMillionTokens)}
										</TableCell>
										<TableCell className="py-2 text-right text-[11px] text-muted-foreground">
											{formatRelativeTime(row.lastActivityAt)}
										</TableCell>
										<TableCell className="py-2 pr-2 text-right">
											<Sparkline
												values={row.sparkline}
												className="ml-auto h-5 w-24"
											/>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			)}

			<ModelPricingDialog
				open={Boolean(editingRow)}
				onOpenChange={(next) => {
					if (!next) setEditingRow(null);
				}}
				row={editingRow}
			/>
			<PricingCatalogDialog
				open={catalogDialogOpen}
				onOpenChange={setCatalogDialogOpen}
				activeRows={allRows}
			/>
		</PageContainer>
	);
}
