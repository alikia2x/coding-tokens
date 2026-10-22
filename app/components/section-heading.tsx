import { cn } from "cn";
import type { ReactNode } from "react";

export function SectionHeading({
	title,
	description,
	actions,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-end justify-between gap-3",
				className,
			)}
		>
			<div className="min-w-0">
				<h2 className="text-[15px] font-semibold tracking-[-0.01em]">
					{title}
				</h2>
				{description ? (
					<p className="mt-0.5 text-[13px] text-muted-foreground">
						{description}
					</p>
				) : null}
			</div>
			{actions ? (
				<div className="flex items-center gap-2">{actions}</div>
			) : null}
		</div>
	);
}
