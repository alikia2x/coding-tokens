import { matchesTextQuery, parseSearchQuery } from "@shared/search";
import { HARNESS_LABELS } from "@shared/types";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Sparkline } from "~/components/charts/sparkline";
import { EmptyState } from "~/components/empty-state";
import { PageContainer } from "~/components/page-container";
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
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useModels } from "~/lib/queries";
import { rangeQueryString } from "~/lib/time-range";

function tokenTotal(row: {
	totals: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
}): number {
	return (
		row.totals.inputTokens +
		row.totals.outputTokens +
		row.totals.cacheReadTokens +
		row.totals.cacheWriteTokens
	);
}

export function ModelsPage() {
	const range = useResolvedRange();
	const models = useModels(range);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortState>({
		key: "cost",
		direction: "desc",
	});
	const t = useT();
	const rangeQuery = rangeQueryString(range);
	const parsed = useMemo(() => parseSearchQuery(query), [query]);

	const rows = useMemo(() => {
		const filtered = (models.data?.rows ?? []).filter((row) =>
			matchesTextQuery(parsed, [row.model, row.provider ?? ""]),
		);
		const direction = sort.direction === "asc" ? 1 : -1;
		return [...filtered].sort((left, right) => {
			const result =
				sort.key === "model"
					? left.model.localeCompare(right.model)
					: sort.key === "requests"
						? left.totals.requests - right.totals.requests
						: sort.key === "tokens"
							? tokenTotal(left) - tokenTotal(right)
							: sort.key === "cache"
								? (left.cacheReadShare ?? 0) - (right.cacheReadShare ?? 0)
								: sort.key === "efficiency"
									? (left.costPerMillionTokens ?? 0) -
										(right.costPerMillionTokens ?? 0)
									: sort.key === "recent"
										? (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0)
										: left.totals.costUsd - right.totals.costUsd;
			return result * direction;
		});
	}, [models.data, parsed, sort]);

	const summary = useMemo(
		() =>
			rows.reduce(
				(acc, row) => ({
					requests: acc.requests + row.totals.requests,
					tokens: acc.tokens + tokenTotal(row),
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

	return (
		<PageContainer>
			<SectionHeading
				title={t("common.models")}
				description={`${formatNumber(rows.length)} ${t("models.withActivity")}`}
			/>
			<SummaryStrip
				items={[
					{ label: t("metric.cost"), value: formatCost(summary.cost, true) },
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
				<div className="relative max-w-xl">
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

			{models.isLoading && !models.data ? (
				<div className="mt-3 space-y-2">
					{Array.from({ length: 8 }, (_, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
						<Skeleton key={index} className="h-12 rounded-md" />
					))}
				</div>
			) : rows.length === 0 ? (
				<EmptyState
					className="mt-3"
					title={t("empty.modelsInRange")}
					description={t("empty.widenSearch")}
				/>
			) : (
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
							{rows.map((row) => (
								<TableRow key={row.model} className="text-[12px]">
									<TableCell className="px-2 py-2">
										<Link
											to={`/sessions?${rangeQuery}&model=${encodeURIComponent(row.model)}`}
											className="block max-w-80 truncate font-medium hover:underline"
										>
											{localizeLabel(t, row.model)}
										</Link>
										{row.provider ? (
											<span className="text-[10px] text-muted-foreground">
												{row.provider}
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
										{formatTokens(tokenTotal(row))}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatPercent(row.cacheReadShare)}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{row.totals.requests > 0 &&
										row.totals.unpricedRequests >= row.totals.requests
											? "—"
											: formatCost(
													row.totals.costUsd,
													row.totals.estimatedRequests > 0,
												)}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{row.costPerMillionTokens === null
											? "—"
											: formatCost(row.costPerMillionTokens, true)}
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
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</PageContainer>
	);
}
