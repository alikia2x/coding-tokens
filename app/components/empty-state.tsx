import { cn } from "cn";
import type { ReactNode } from "react";

export function EmptyState({
	title,
	description,
	action,
	className,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center",
				className,
			)}
		>
			<p className="text-sm font-medium">{title}</p>
			{description ? (
				<p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
					{description}
				</p>
			) : null}
			{action ? <div className="mt-4">{action}</div> : null}
		</div>
	);
}
