import type { BreakdownRow } from "@shared/types";
import { Link } from "react-router";
import { formatCost, formatTokens, totalTokens } from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { sessionsPath } from "~/lib/time-range";

export function TopModels({
	rows,
	metric = "cost",
	onToggleMetric,
}: {
	rows: BreakdownRow[];
	metric?: "cost" | "tokens";
	onToggleMetric?: () => void;
}) {
	const range = useResolvedRange();
	const t = useT();
	const sorted = [...rows]
		.sort((left, right) =>
			metric === "tokens"
				? totalTokens(right.totals) - totalTokens(left.totals)
				: right.totals.costUsd - left.totals.costUsd,
		)
		.slice(0, 5);
	const rawMax = Math.max(
		0,
		...sorted.map((row) =>
			metric === "tokens" ? totalTokens(row.totals) : row.totals.costUsd,
		),
	);
	const max = rawMax > 0 ? rawMax : 1;
	return (
		<div>
			<div className="flex items-baseline justify-between">
				<h2 className="text-[13px] font-semibold">{t("overview.topModels")}</h2>
				{onToggleMetric ? (
					<button
						type="button"
						onClick={onToggleMetric}
						className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
					>
						{metric === "tokens" ? t("chart.byTokens") : t("chart.byCost")}
					</button>
				) : (
					<span className="text-[11px] text-muted-foreground">
						{metric === "tokens" ? t("chart.byTokens") : t("chart.byCost")}
					</span>
				)}
			</div>
			<div className="mt-2 divide-y">
				{sorted.map((row) => {
					const tokens = totalTokens(row.totals);
					const primaryValue =
						metric === "tokens"
							? formatTokens(tokens)
							: formatCost(row.totals.costUsd);
					const secondaryValue =
						metric === "tokens"
							? formatCost(row.totals.costUsd)
							: formatTokens(tokens);
					const ratio =
						metric === "tokens" ? tokens / max : row.totals.costUsd / max;
					return (
						<Link
							key={row.key}
							to={sessionsPath(range, { model: row.key })}
							className="block py-2 transition-colors hover:underline"
						>
							<div className="flex items-baseline justify-between gap-2">
								<span className="truncate text-[12px] font-medium">
									{localizeLabel(t, row.label)}
								</span>
								<span className="shrink-0 tabular">{primaryValue}</span>
							</div>
							<div className="mt-1 flex items-center gap-2">
								<div className="h-1 flex-1 overflow-hidden rounded-[1px] bg-muted">
									<div
										className="h-full bg-chart-1"
										style={{
											width: ratio > 0 ? `${Math.max(2, ratio * 100)}%` : "0%",
										}}
									/>
								</div>
								<span className="w-16 text-right text-[10px] text-muted-foreground tabular">
									{secondaryValue}
								</span>
							</div>
						</Link>
					);
				})}
				{!sorted.length ? (
					<p className="py-6 text-center text-[12px] text-muted-foreground">
						{t("empty.models")}
					</p>
				) : null}
			</div>
		</div>
	);
}
