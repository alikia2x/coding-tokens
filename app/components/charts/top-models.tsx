import type { BreakdownRow } from "@shared/types";
import { Link } from "react-router";
import { formatCost, formatTokens } from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { rangeQueryString } from "~/lib/time-range";

export function TopModels({ rows }: { rows: BreakdownRow[] }) {
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);
	const t = useT();
	const max = Math.max(1, ...rows.map((row) => row.totals.costUsd));
	return (
		<div>
			<div className="flex items-baseline justify-between">
				<h2 className="text-[13px] font-semibold">{t("overview.topModels")}</h2>
				<span className="text-[11px] text-muted-foreground">
					{t("chart.byCost")}
				</span>
			</div>
			<div className="mt-2 divide-y">
				{rows.map((row) => (
					<Link
						key={row.key}
						to={`/sessions?${rangeQuery}&model=${encodeURIComponent(row.key)}`}
						className="block py-2 transition-colors hover:underline"
					>
						<div className="flex items-baseline justify-between gap-2">
							<span className="truncate text-[12px] font-medium">
								{row.label}
							</span>
							<span className="shrink-0 tabular">
								{formatCost(row.totals.costUsd, true)}
							</span>
						</div>
						<div className="mt-1 flex items-center gap-2">
							<div className="h-1 flex-1 overflow-hidden rounded-[1px] bg-muted">
								<div
									className="h-full bg-chart-1"
									style={{
										width: `${Math.max(2, (row.totals.costUsd / max) * 100)}%`,
									}}
								/>
							</div>
							<span className="w-16 text-right text-[10px] text-muted-foreground tabular">
								{formatTokens(
									row.totals.inputTokens +
										row.totals.outputTokens +
										row.totals.cacheReadTokens +
										row.totals.cacheWriteTokens,
								)}
							</span>
						</div>
					</Link>
				))}
				{!rows.length ? (
					<p className="py-6 text-center text-[12px] text-muted-foreground">
						{t("empty.models")}
					</p>
				) : null}
			</div>
		</div>
	);
}
