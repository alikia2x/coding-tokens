import type { BreakdownRow, ProjectSummary } from "@shared/types";
import { Link } from "react-router";
import { HarnessDot, harnessColor } from "~/components/harness-badge";
import { formatCost, formatPercent } from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { rangeQueryString } from "~/lib/time-range";

const PROJECT_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--chart-6)",
];

export function HarnessShare({
	rows,
	projectRows = [],
	dimension = "project",
	onToggleDimension,
}: {
	rows: BreakdownRow[];
	projectRows?: ProjectSummary[];
	dimension?: "project" | "harness";
	onToggleDimension?: () => void;
}) {
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);
	const t = useT();
	const mappedProjects: BreakdownRow[] = projectRows.map((project) => ({
		key: project.cwd ?? project.name,
		label: project.name,
		totals: project.totals,
	}));
	const allRowsForTotal = dimension === "project" ? mappedProjects : rows;
	const total = allRowsForTotal.reduce(
		(sum, row) => sum + row.totals.costUsd,
		0,
	);
	const nonZeroRows = allRowsForTotal.filter((row) => row.totals.costUsd > 0);
	const topRows = nonZeroRows.slice(0, 5);
	const overflowRows = nonZeroRows.slice(5);
	const overflowCost = overflowRows.reduce(
		(sum, row) => sum + row.totals.costUsd,
		0,
	);
	const displayRows: BreakdownRow[] =
		overflowCost > 0
			? [
					...topRows,
					{
						key: "__other__",
						label: t("common.other"),
						totals: {
							inputTokens: 0,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							reasoningTokens: 0,
							costUsd: overflowCost,
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
			? t("projects.costByProject")
			: t("harnesses.costByHarness");

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
					{formatCost(total, true)}
				</span>
			</div>
			<div className="mt-3 flex h-2 overflow-hidden rounded-[2px] bg-muted">
				{visible.map((row, index) => (
					<div
						key={row.key}
						style={{
							width: `${total > 0 ? (row.totals.costUsd / total) * 100 : 0}%`,
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
			<div className="mt-3 max-h-[260px] divide-y overflow-y-auto">
				{displayRows.map((row, index) => {
					const share = total > 0 ? row.totals.costUsd / total : 0;
					const isOther = row.key === "__other__";
					const harness = row.key as keyof typeof harnessColor;
					const target = isOther
						? dimension === "harness"
							? `/harnesses?${rangeQuery}`
							: `/projects?${rangeQuery}`
						: dimension === "harness"
							? `/sessions?${rangeQuery}&harness=${row.key}`
							: `/sessions?${rangeQuery}&project=${encodeURIComponent(row.key)}`;
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
								{formatCost(row.totals.costUsd, true)}
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
			</div>
		</div>
	);
}
