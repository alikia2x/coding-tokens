import { matchesTextQuery, parseSearchQuery } from "@shared/search";
import { HARNESS_LABELS, type ProjectReportRow } from "@shared/types";
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
	formatRelativeTime,
	formatTokens,
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useProjects } from "~/lib/queries";
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

function compareProjects(
	left: ProjectReportRow,
	right: ProjectReportRow,
	key: string,
): number {
	switch (key) {
		case "name":
			return left.name.localeCompare(right.name);
		case "sessions":
			return left.totals.sessions - right.totals.sessions;
		case "requests":
			return left.totals.requests - right.totals.requests;
		case "tokens":
			return tokenTotal(left) - tokenTotal(right);
		case "recent":
			return (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0);
		default:
			return left.totals.costUsd - right.totals.costUsd;
	}
}

export function ProjectsPage() {
	const range = useResolvedRange();
	const projects = useProjects(range);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortState>({
		key: "cost",
		direction: "desc",
	});
	const t = useT();
	const rangeQuery = rangeQueryString(range);
	const parsed = useMemo(() => parseSearchQuery(query), [query]);

	const rows = useMemo(() => {
		const filtered = (projects.data?.rows ?? []).filter((row) => {
			const localized = localizeLabel(t, row.name);
			const harnessLabels = row.harnesses.map(
				(harness) => HARNESS_LABELS[harness] ?? harness,
			);
			return matchesTextQuery(
				parsed,
				[
					row.name,
					localized,
					row.cwd ?? "",
					...row.models,
					...row.harnesses,
					...harnessLabels,
				],
				{
					project: [row.name, localized, row.cwd ?? ""],
					model: row.models,
					harness: [...row.harnesses, ...harnessLabels],
				},
			);
		});
		const direction = sort.direction === "asc" ? 1 : -1;
		return [...filtered].sort(
			(left, right) => compareProjects(left, right, sort.key) * direction,
		);
	}, [projects.data, parsed, sort, t]);

	const summary = useMemo(
		() =>
			rows.reduce(
				(acc, row) => ({
					sessions: acc.sessions + row.totals.sessions,
					requests: acc.requests + row.totals.requests,
					tokens: acc.tokens + tokenTotal(row),
					cost: acc.cost + row.totals.costUsd,
				}),
				{ sessions: 0, requests: 0, tokens: 0, cost: 0 },
			),
		[rows],
	);

	function onSort(key: string): void {
		setSort((current) =>
			current.key === key
				? { key, direction: current.direction === "desc" ? "asc" : "desc" }
				: { key, direction: key === "name" ? "asc" : "desc" },
		);
	}

	const isInitialLoading = projects.isLoading && !projects.data;

	return (
		<PageContainer>
			<SectionHeading
				title={t("common.projects")}
				description={t("count.activeProjects", {
					count: rows.length,
					formatted: formatNumber(rows.length),
				})}
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
						label: t("common.sessions"),
						value: formatNumber(summary.sessions),
					},
				]}
			/>
			<div className="mt-3">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("projects.search")}
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
			{!isInitialLoading && rows.length === 0 && (
				<EmptyState
					className="mt-3"
					title={t("empty.projectsInRange")}
					description={t("empty.widenSearch")}
				/>
			)}
			{!isInitialLoading && rows.length > 0 && (
				<div className="mt-3 rounded-lg border bg-card px-2">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<SortableHead
									label={t("common.project")}
									sortKey="name"
									sort={sort}
									onSort={onSort}
									align="left"
									className="px-0"
								/>
								<TableHead className="h-9 text-[11px]">
									{t("common.harnesses")}
								</TableHead>
								<SortableHead
									label={t("common.sessions")}
									sortKey="sessions"
									sort={sort}
									onSort={onSort}
								/>
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
									label={t("metric.cost")}
									sortKey="cost"
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
								<TableRow key={row.cwd ?? row.name} className="text-[12px]">
									<TableCell className="px-2 py-2">
										<Link
											to={`/sessions?${rangeQuery}${row.cwd ? `&project=${encodeURIComponent(row.cwd)}` : ""}`}
											className="block max-w-72 truncate font-medium hover:underline"
										>
											{localizeLabel(t, row.name)}
										</Link>
										<span className="block max-w-72 truncate font-mono text-[10px] text-muted-foreground">
											{row.cwd}
										</span>
									</TableCell>
									<TableCell className="py-2 text-[10px] text-muted-foreground">
										{row.harnesses
											.map((harness) => HARNESS_LABELS[harness])
											.join(", ")}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatNumber(row.totals.sessions)}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatNumber(row.totals.requests)}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatTokens(tokenTotal(row))}
									</TableCell>
									<TableCell className="py-2 text-right tabular">
										{formatCost(
											row.totals.costUsd,
											row.totals.estimatedRequests > 0,
										)}
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
