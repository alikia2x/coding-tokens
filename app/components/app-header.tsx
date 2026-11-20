import type { StatusPayload } from "@shared/types";
import { cn } from "cn";
import { Settings } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router";
import { CommandSearch } from "~/components/command-search";
import { LanguageToggle } from "~/components/language-toggle";
import { RefreshButton } from "~/components/refresh-button";
import { ThemeToggle } from "~/components/theme-toggle";
import { TimeRangePicker } from "~/components/time-range-picker";
import { useResolvedRange } from "~/lib/hooks";
import { type TranslationKey, useT } from "~/lib/i18n";
import { rangeQueryString } from "~/lib/time-range";

const tabs: Array<{ to: string; label: TranslationKey; end?: boolean }> = [
	{ to: "/", label: "nav.overview", end: true },
	{ to: "/explore", label: "nav.explore" },
	{ to: "/sessions", label: "common.sessions" },
	{ to: "/projects", label: "common.projects" },
	{ to: "/models", label: "common.models" },
	{ to: "/harnesses", label: "common.harnesses" },
];

function NavTabs({
	rangeQuery,
	pricingError,
	mobile = false,
}: {
	rangeQuery: string;
	pricingError?: string | null;
	mobile?: boolean;
}) {
	const t = useT();
	return (
		<nav
			className={
				mobile
					? "no-scrollbar flex items-center gap-1 overflow-x-auto border-t px-4 md:hidden"
					: "no-drag hidden items-center gap-0.5 md:flex"
			}
			aria-label={t("nav.primary")}
		>
			{tabs.map((tab) => (
				<NavLink
					key={tab.to}
					to={`${tab.to}?${rangeQuery}`}
					end={tab.end}
					className={({ isActive }) =>
						cn(
							"relative flex items-center gap-1.5 font-medium text-muted-foreground transition-colors after:absolute after:-bottom-px after:h-0.5 after:origin-left after:scale-x-0 after:bg-foreground after:transition-transform after:duration-150",
							mobile
								? "h-10 shrink-0 px-2 text-[12px] after:inset-x-2"
								: "h-16 px-3 text-[13px] leading-5 after:inset-x-3 hover:text-foreground",
							isActive && "text-foreground after:scale-x-100",
						)
					}
				>
					<span>{t(tab.label)}</span>
					{tab.to === "/models" && pricingError ? (
						<span
							className="size-1.5 rounded-full bg-warning"
							title={pricingError}
						/>
					) : null}
				</NavLink>
			))}
		</nav>
	);
}

export function AppHeader({ status }: { status: StatusPayload }) {
	const location = useLocation();
	const t = useT();
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);
	const isDetail = /^\/sessions\/[^/]+\/[^/]+/u.test(location.pathname);
	const hasTrafficLights = status.desktopPlatform === "darwin";
	const pricingError = status.pricing?.lastError;
	return (
		<header className="drag-region relative z-40 shrink-0 border-b bg-background">
			<div
				className={cn(
					"mx-auto flex h-16 max-w-[1480px] items-center gap-5 pr-5 sm:pr-8",
					hasTrafficLights ? "pl-[96px]" : "pl-5 sm:pl-8",
				)}
			>
				<Link
					to={`/?${rangeQuery}`}
					className="no-drag flex shrink-0 items-center"
				>
					<span className="font-display text-[16px] font-medium leading-5 tracking-[-0.01em]">
						Coding Tokens
					</span>
				</Link>
				<NavTabs rangeQuery={rangeQuery} pricingError={pricingError} />
				<div className="no-drag ml-auto flex items-center gap-1.5">
					<CommandSearch />
					{isDetail ? null : <TimeRangePicker />}
					<RefreshButton status={status} />
					<LanguageToggle />
					<NavLink
						to={`/settings?${rangeQuery}`}
						aria-label={t("nav.settings")}
						className={({ isActive }) =>
							cn(
								"inline-flex size-8 items-center justify-center rounded-md transition-colors",
								isActive
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-hover hover:text-foreground",
							)
						}
					>
						<Settings className="size-4" />
					</NavLink>
					<ThemeToggle />
				</div>
			</div>
			<NavTabs rangeQuery={rangeQuery} pricingError={pricingError} mobile />
		</header>
	);
}
