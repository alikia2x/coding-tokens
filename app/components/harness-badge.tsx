import { harnessColor } from "@shared/colors";
import type { HarnessName } from "@shared/types";
import { HARNESS_LABELS, HARNESS_SHORT_LABELS } from "@shared/types";
import { cn } from "cn";
import { Badge } from "~/components/ui/badge";

export { harnessColor };

export function HarnessDot({
	harness,
	className,
}: {
	harness: HarnessName;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn("inline-block size-2 shrink-0 rounded-[2px]", className)}
			style={{ background: harnessColor[harness] }}
		/>
	);
}

export function HarnessBadge({
	harness,
	short = false,
	className,
}: {
	harness: HarnessName;
	short?: boolean;
	className?: string;
}) {
	return (
		<Badge variant="outline" className={cn("rounded gap-1.5", className)}>
			<HarnessDot harness={harness} />
			{short ? HARNESS_SHORT_LABELS[harness] : HARNESS_LABELS[harness]}
		</Badge>
	);
}
