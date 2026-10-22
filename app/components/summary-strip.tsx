import { cn } from "cn";
import type { ReactNode } from "react";

export function SummaryStrip({
	items,
	columns = 4,
}: {
	items: Array<{ label: string; value: ReactNode; detail?: ReactNode }>;
	columns?: 4 | 5;
}) {
	return (
		<div
			className={cn(
				"mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border",
				columns === 5 ? "sm:grid-cols-5" : "sm:grid-cols-4",
			)}
		>
			{items.map((item) => (
				<div key={item.label} className="bg-card px-4 py-3">
					<div className="text-[11px] text-muted-foreground">{item.label}</div>
					<div className="mt-1 text-[16px] font-medium leading-none tracking-[-0.02em] tabular">
						{item.value}
					</div>
					{item.detail ? (
						<div className="mt-1 text-[10px] text-muted-foreground">
							{item.detail}
						</div>
					) : null}
				</div>
			))}
		</div>
	);
}
