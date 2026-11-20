import type { UsageTotals } from "@shared/types";
import { ChevronDown } from "lucide-react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import { tokenColors } from "~/lib/chart-colors";
import { formatPercent, formatTokens, totalTokens } from "~/lib/format";
import { useT } from "~/lib/i18n";

type TokenTotals = Pick<
	UsageTotals,
	"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

const parts = [
	{ key: "inputTokens", label: "metric.input", color: tokenColors.input },
	{ key: "outputTokens", label: "metric.output", color: tokenColors.output },
	{
		key: "cacheReadTokens",
		label: "metric.cacheRead",
		color: tokenColors.cacheRead,
	},
	{
		key: "cacheWriteTokens",
		label: "metric.cacheWrite",
		color: tokenColors.cacheWrite,
	},
] as const;

export function TokenTotal({ totals }: { totals: TokenTotals }) {
	const t = useT();
	const total = totalTokens(totals);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="group inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					{formatTokens(total)}
					<ChevronDown className="size-3 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-3">
				<div className="flex items-baseline justify-between">
					<span className="text-[11px] font-medium">
						{t("metric.tokenBreakdown")}
					</span>
					<span className="text-[11px] text-muted-foreground tabular">
						{formatTokens(total)}
					</span>
				</div>
				<div className="mt-2 flex h-1.5 overflow-hidden rounded-[1px] bg-muted">
					{parts.map((part) => (
						<div
							key={part.key}
							style={{
								width: `${total > 0 ? (totals[part.key] / total) * 100 : 0}%`,
								background: part.color,
							}}
						/>
					))}
				</div>
				<div className="mt-2 divide-y">
					{parts.map((part) => (
						<div
							key={part.key}
							className="flex items-baseline gap-2 py-1.5 text-[11px]"
						>
							<span
								className="size-1.5 shrink-0 rounded-[1px]"
								style={{ background: part.color }}
							/>
							<span className="flex-1 text-muted-foreground">
								{t(part.label)}
							</span>
							<span className="tabular">{formatTokens(totals[part.key])}</span>
							<span className="w-12 text-right text-muted-foreground tabular">
								{formatPercent(total > 0 ? totals[part.key] / total : 0)}
							</span>
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
