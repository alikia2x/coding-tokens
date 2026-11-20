import { Badge } from "~/components/ui/badge";
import { useT } from "~/lib/i18n";

export function SessionRoleBadge({
	isReview,
	isSubagent,
}: {
	isReview: boolean;
	isSubagent: boolean;
}) {
	const t = useT();
	if (isReview) {
		return (
			<Badge variant="outline" className="rounded text-[9px]">
				{t("session.review")}
			</Badge>
		);
	}
	if (isSubagent) {
		return (
			<Badge variant="outline" className="rounded text-[9px]">
				{t("session.subagent")}
			</Badge>
		);
	}
	return null;
}
