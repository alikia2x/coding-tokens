import { cn } from "cn";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { formatDelta } from "~/lib/format";

export function KpiCard({
	label,
	value,
	detail,
	previous,
	className,
}: {
	label: string;
	value: ReactNode;
	detail?: ReactNode;
	previous?: { current: number; previous: number | null };
	className?: string;
}) {
	const delta = previous
		? formatDelta(previous.current, previous.previous)
		: null;
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col justify-between rounded-lg border bg-card px-4 py-3.5",
				className,
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="text-[12px] font-medium text-muted-foreground">
					{label}
				</div>
				{delta ? (
					<span
						className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground tabular"
						title="Compared with the previous period"
					>
						{delta.direction === "up" ? (
							<ArrowUpRight className="size-3" />
						) : delta.direction === "down" ? (
							<ArrowDownRight className="size-3" />
						) : null}
						{delta.label}
					</span>
				) : null}
			</div>
			<div className="mt-2 text-[26px] font-medium leading-none tracking-[-0.03em] tabular">
				{value}
			</div>
			{detail ? (
				<div className="mt-2 text-[12px] leading-4 text-muted-foreground">
					{detail}
				</div>
			) : null}
		</div>
	);
}
