import { cn } from "cn";
import { RotateCw, SlidersHorizontal } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useT } from "~/lib/i18n";
import { usePricing } from "~/lib/queries";

export function PricingStatusPill({
	onClick,
	className,
}: {
	onClick: () => void;
	className?: string;
}) {
	const t = useT();
	const pricing = usePricing();
	const status = pricing.data?.status;
	const isFetching = Boolean(status?.fetching || status?.state === "fetching");
	const hasError = Boolean(status?.lastError);

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={onClick}
			className={cn("h-8 gap-1.5 text-[12px]", className)}
		>
			{isFetching ? (
				<RotateCw className="size-3.5 animate-spin text-muted-foreground" />
			) : hasError ? (
				<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
			) : (
				<SlidersHorizontal className="size-3.5 text-muted-foreground" />
			)}
			<span>{isFetching ? t("pricing.refreshing") : t("pricing.title")}</span>
		</Button>
	);
}
