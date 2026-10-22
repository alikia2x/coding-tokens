import { cn } from "cn";
import type { ReactNode } from "react";

export function PageContainer({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"mx-auto w-full max-w-[1480px] px-5 pb-20 pt-7 sm:px-8",
				className,
			)}
		>
			{children}
		</div>
	);
}
