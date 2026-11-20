import type { BreakdownRow, ProjectSummary } from "@shared/types";
import { Link } from "react-router";
import { HarnessDot, harnessColor } from "~/components/harness-badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { categoricalColors } from "~/lib/chart-colors";
import {
	formatCost,
	formatPercent,
	formatTokens,
	totalTokens,
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import {
	rangeQueryString,
	sessionsPath,
	UNKNOWN_PROJECT_KEY,
} from "~/lib/time-range";

function rowMetricValue(row: BreakdownRow, metric: "cost" | "tokens"): number {
	return metric === "tokens" ? totalTokens(row.totals) : row.totals.costUsd;
}

const PROJECT_COLORS = categoricalColors.slice(0, 6);

export function HarnessShare({
	rows,
	projectRows = [],
	dimension = "project",
	metric = "cost",
	onToggleDimension,
}: {
	rows: BreakdownRow[];
	projectRows?: ProjectSummary[];
	dimension?: "project" | "harness";
	metric?: "cost" | "tokens";
	onToggleDimension?: () => void;
}) {
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);
	const t = useT();
	const mappedProjects: BreakdownRow[] = projectRows.map((project) => ({
		key: project.cwd ?? UNKNOWN_PROJECT_KEY,
		label: project.name,
		totals: project.totals,
	}));
	const allRowsForTotal = [
		...(dimension === "project" ? mappedProjects : rows),
	].sort(
		(left, right) =>
			rowMetricValue(right, metric) - rowMetricValue(left, metric),
	);
	const total = allRowsForTotal.reduce(
		(sum, row) => sum + rowMetricValue(row, metric),
		0,
	);
	const nonZeroRows = allRowsForTotal.filter(
		(row) => rowMetricValue(row, metric) > 0,
	);
	const topRows = nonZeroRows.slice(0, 5);
	const overflowRows = nonZeroRows.slice(5);
	const overflowValue = overflowRows.reduce(
		(sum, row) => sum + rowMetricValue(row, metric),
		0,
	);
	const displayRows: BreakdownRow[] =
		overflowValue > 0
			? [
					...topRows,
					{
						key: "__other__",
						label: t("common.other"),
						totals: {
							inputTokens: metric === "tokens" ? overflowValue : 0,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							reasoningTokens: 0,
							costUsd: metric === "cost" ? overflowValue : 0,
							requests: 0,
							sessions: 0,
							messages: 0,
							estimatedRequests: 0,
							unpricedRequests: 0,
						},
					},
				]
			: topRows;
	const visible = displayRows;
	const title =
		dimension === "project"
			? metric === "tokens"
				? t("projects.tokensByProject")
				: t("projects.costByProject")
			: metric === "tokens"
				? t("harnesses.tokensByHarness")
				: t("harnesses.costByHarness");
	const formatValue = (value: number) =>
		metric === "tokens" ? formatTokens(value) : formatCost(value);

	return (
		<div>
			<div className="flex items-baseline justify-between">
				{onToggleDimension ? (
					<button
						type="button"
						onClick={onToggleDimension}
						className="text-[13px] font-semibold hover:underline"
					>
						{title}
					</button>
				) : (
					<h2 className="text-[13px] font-semibold">{title}</h2>
				)}
				<span className="text-[11px] text-muted-foreground tabular">
					{formatValue(total)}
				</span>
			</div>
			<div className="mt-3 flex h-2 overflow-hidden rounded-[2px] bg-muted">
				{visible.map((row, index) => (
					<div
						key={row.key}
						style={{
							width: `${total > 0 ? (rowMetricValue(row, metric) / total) * 100 : 0}%`,
							background:
								row.key === "__other__"
									? "var(--muted-foreground)"
									: dimension === "harness"
										? harnessColor[row.key as keyof typeof harnessColor]
										: PROJECT_COLORS[index % PROJECT_COLORS.length],
						}}
						title={localizeLabel(t, row.label)}
					/>
				))}
			</div>
			<ScrollArea
				className="mt-3 max-h-[260px]"
				overflow="y"
				contentClassName="divide-y pr-3"
			>
				{displayRows.map((row, index) => {
					const value = rowMetricValue(row, metric);
					const share = total > 0 ? value / total : 0;
					const isOther = row.key === "__other__";
					const harness = row.key as keyof typeof harnessColor;
					const target = isOther
						? dimension === "harness"
							? `/harnesses?${rangeQuery}`
							: `/projects?${rangeQuery}`
						: dimension === "harness"
							? sessionsPath(range, { harness: row.key })
							: sessionsPath(range, { project: row.key });
					return (
						<Link
							key={row.key}
							to={target}
							className="flex items-center gap-2 py-2 text-[12px] transition-colors hover:underline"
						>
							{isOther ? (
								<span className="size-1.5 shrink-0 rounded-[2px] bg-muted-foreground/60" />
							) : dimension === "harness" ? (
								<HarnessDot harness={harness} />
							) : (
								<span
									className="size-1.5 shrink-0 rounded-[2px]"
									style={{
										background: PROJECT_COLORS[index % PROJECT_COLORS.length],
									}}
								/>
							)}
							<span className="flex-1 truncate">
								{isOther ? row.label : localizeLabel(t, row.label)}
							</span>
							<span className="text-muted-foreground tabular">
								{formatPercent(share)}
							</span>
							<span className="w-20 text-right tabular">
								{formatValue(value)}
							</span>
						</Link>
					);
				})}
				{!displayRows.length ? (
					<p className="py-6 text-center text-[12px] text-muted-foreground">
						{dimension === "project"
							? t("empty.results")
							: t("empty.harnesses")}
					</p>
				) : null}
			</ScrollArea>
		</div>
	);
}
