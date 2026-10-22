import type { BreakdownRow } from "@shared/types";
import { Link } from "react-router";
import { HarnessDot, harnessColor } from "~/components/harness-badge";
import { formatCost, formatPercent } from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { rangeQueryString } from "~/lib/time-range";

export function HarnessShare({ rows }: { rows: BreakdownRow[] }) {
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);
	const t = useT();
	const total = rows.reduce((sum, row) => sum + row.totals.costUsd, 0);
	const visible = rows.filter((row) => row.totals.costUsd > 0);
	return (
		<div>
			<div className="flex items-baseline justify-between">
				<h2 className="text-[13px] font-semibold">
					{t("harnesses.costByHarness")}
				</h2>
				<span className="text-[11px] text-muted-foreground tabular">
					{formatCost(total, true)}
				</span>
			</div>
			<div className="mt-3 flex h-2 overflow-hidden rounded-[2px] bg-muted">
				{visible.map((row) => (
					<div
						key={row.key}
						style={{
							width: `${total > 0 ? (row.totals.costUsd / total) * 100 : 0}%`,
							background: harnessColor[row.key as keyof typeof harnessColor],
						}}
						title={row.label}
					/>
				))}
			</div>
			<div className="mt-3 divide-y">
				{rows.map((row) => {
					const share = total > 0 ? row.totals.costUsd / total : 0;
					const harness = row.key as keyof typeof harnessColor;
					return (
						<Link
							key={row.key}
							to={`/sessions?${rangeQuery}&harness=${row.key}`}
							className="flex items-center gap-2 py-2 text-[12px] transition-colors hover:underline"
						>
							<HarnessDot harness={harness} />
							<span className="flex-1 truncate">{row.label}</span>
							<span className="text-muted-foreground tabular">
								{formatPercent(share)}
							</span>
							<span className="w-20 text-right tabular">
								{formatCost(row.totals.costUsd, true)}
							</span>
						</Link>
					);
				})}
				{!rows.length ? (
					<p className="py-6 text-center text-[12px] text-muted-foreground">
						{t("empty.harnesses")}
					</p>
				) : null}
			</div>
		</div>
	);
}
