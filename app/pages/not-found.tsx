import { Link } from "react-router";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import { useResolvedRange } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { rangeQueryString } from "~/lib/time-range";

export function NotFoundPage() {
	const t = useT();
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);
	return (
		<PageContainer>
			<div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
				<p className="text-[11px] tabular text-muted-foreground">404</p>
				<h1 className="mt-2 text-[20px] font-semibold">
					{t("error.pageNotFound")}
				</h1>
				<Button className="mt-4" variant="outline" size="sm" asChild>
					<Link to={rangeQuery ? `/?${rangeQuery}` : "/"}>
						{t("nav.backToOverview")}
					</Link>
				</Button>
			</div>
		</PageContainer>
	);
}
