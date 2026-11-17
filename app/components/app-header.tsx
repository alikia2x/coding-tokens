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

export function AppHeader({ status }: { status: StatusPayload }) {
	const location = useLocation();
	const t = useT();
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);
	const isDetail = /^\/sessions\/[^/]+\/[^/]+/u.test(location.pathname);
	const hasTrafficLights = status.desktopPlatform === "darwin";
	return (
		<header className="drag-region sticky top-0 z-40 border-b bg-background">
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
				<nav
					className="no-drag hidden items-center gap-0.5 md:flex"
					aria-label={t("nav.primary")}
				>
					{tabs.map((tab) => (
						<NavLink
							key={tab.to}
							to={`${tab.to}?${rangeQuery}`}
							end={tab.end}
							className={({ isActive }) =>
								cn(
									"relative flex h-16 items-center px-3 text-[13px] font-medium leading-5 text-muted-foreground transition-colors after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:origin-left after:scale-x-0 after:bg-foreground after:transition-transform after:duration-150 hover:text-foreground",
									isActive && "text-foreground after:scale-x-100",
								)
							}
						>
							{t(tab.label)}
						</NavLink>
					))}
				</nav>
				<div className="no-drag ml-auto flex items-center gap-1.5">
					<CommandSearch />
					{isDetail ? null : <TimeRangePicker />}
					<RefreshButton status={status} />
					<LanguageToggle />
					<Link
						to="/settings"
						aria-label={t("nav.settings")}
						className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
					>
						<Settings className="size-4" />
					</Link>
					<ThemeToggle />
				</div>
			</div>
			<nav
				className="no-scrollbar flex items-center gap-1 overflow-x-auto border-t px-4 md:hidden"
				aria-label={t("nav.primary")}
			>
				{tabs.map((tab) => (
					<NavLink
						key={tab.to}
						to={`${tab.to}?${rangeQuery}`}
						end={tab.end}
						className={({ isActive }) =>
							cn(
								"relative flex h-10 shrink-0 items-center px-2 text-[12px] font-medium text-muted-foreground transition-colors after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:origin-left after:scale-x-0 after:bg-foreground after:transition-transform after:duration-150",
								isActive && "text-foreground after:scale-x-100",
							)
						}
					>
						{t(tab.label)}
					</NavLink>
				))}
			</nav>
		</header>
	);
}
