import type { StatusPayload } from "@shared/types";
import { RotateCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { formatRelativeTime } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { useRefreshData } from "~/lib/queries";

export function RefreshButton({ status }: { status: StatusPayload }) {
	const refresh = useRefreshData();
	const t = useT();
	const busy = status.indexing || refresh.isPending;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("status.refresh")}
					disabled={busy}
					onClick={() => refresh.mutate()}
					className={
						refresh.isError && !busy ? "relative text-destructive" : undefined
					}
				>
					<RotateCw className={busy ? "animate-spin" : undefined} />
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				{busy
					? t("status.refreshing")
					: refresh.isError
						? refresh.error.message
						: `${t("status.lastIndexed")} ${formatRelativeTime(status.indexedAt)}`}
			</TooltipContent>
		</Tooltip>
	);
}
