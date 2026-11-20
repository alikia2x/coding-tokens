import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Route, Routes, useLocation } from "react-router";
import { AppHeader } from "~/components/app-header";
import { KeyboardShortcutsDialog } from "~/components/keyboard-shortcuts-dialog";
import { LoadingScreen } from "~/components/loading-screen";
import { ScrollArea, type ScrollAreaHandle } from "~/components/ui/scroll-area";
import { useResolvedRange } from "~/lib/hooks";
import { setAppLocale } from "~/lib/i18n";
import { usePrefetchTabs, useRefreshData, useStatus } from "~/lib/queries";
import { useSettings } from "~/lib/settings";
import { useTheme } from "~/lib/theme";
import { useAppShortcuts } from "~/lib/use-app-shortcuts";
import { ExplorePage } from "~/pages/explore";
import { HarnessesPage } from "~/pages/harnesses";
import { ModelsPage } from "~/pages/models";
import { NotFoundPage } from "~/pages/not-found";
import { OverviewPage } from "~/pages/overview";
import { ProjectsPage } from "~/pages/projects";
import { SessionDetailPage } from "~/pages/session-detail";
import { SessionsPage } from "~/pages/sessions";
import { SettingsPage } from "~/pages/settings";

export function App() {
	const status = useStatus();
	const queryClient = useQueryClient();
	const location = useLocation();
	const range = useResolvedRange();
	const shortcuts = useAppShortcuts();
	const { settings, loaded: settingsLoaded } = useSettings();
	const { setMode } = useTheme();
	const refresh = useRefreshData();
	const mutateRefresh = refresh.mutate;
	useEffect(() => {
		if (settingsLoaded) setMode(settings.theme);
	}, [settingsLoaded, settings.theme, setMode]);
	useEffect(() => {
		if (settingsLoaded) setAppLocale(settings.locale);
	}, [settingsLoaded, settings.locale]);
	useEffect(() => {
		const minutes = settings.autoRefreshMinutes;
		if (!settingsLoaded || !minutes) return;
		const timer = window.setInterval(() => mutateRefresh(), minutes * 60_000);
		return () => window.clearInterval(timer);
	}, [settingsLoaded, settings.autoRefreshMinutes, mutateRefresh]);
	usePrefetchTabs(range, Boolean(status.data?.ready));
	const indexedAt = status.data?.indexedAt ?? null;
	const pricingVersion = status.data?.pricingVersion ?? 0;
	const dataVersion = indexedAt ? `${indexedAt}:${pricingVersion}` : null;
	const previousDataVersion = useRef<string | null | undefined>(undefined);
	const scrollRef = useRef<ScrollAreaHandle>(null);
	const previousPathname = useRef(location.pathname);

	useLayoutEffect(() => {
		if (previousPathname.current === location.pathname) return;
		previousPathname.current = location.pathname;
		if (location.hash) return;
		const viewport = scrollRef.current?.getViewport();
		if (viewport) viewport.scrollTop = 0;
	}, [location.pathname, location.hash]);

	useEffect(() => {
		if (!status.data) return;
		if (
			dataVersion &&
			previousDataVersion.current !== undefined &&
			dataVersion !== previousDataVersion.current
		) {
			void queryClient.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] !== "status" && query.queryKey[0] !== "settings",
			});
		}
		previousDataVersion.current = dataVersion;
	}, [status.data, dataVersion, queryClient]);

	if (status.isError && !status.data)
		return (
			<LoadingScreen
				phase="Failed"
				progress={{ completed: 0, total: 5 }}
				error={status.error.message}
				onRetry={() => void status.refetch()}
			/>
		);
	if (!status.data)
		return (
			<LoadingScreen phase="Starting" progress={{ completed: 0, total: 5 }} />
		);
	if (!status.data.ready)
		return (
			<LoadingScreen
				phase={status.data.phase}
				progress={status.data.progress}
				error={status.data.error}
				onRetry={() => {
					if (status.data?.error) mutateRefresh();
					else void status.refetch();
				}}
			/>
		);

	return (
		<div className="flex h-screen flex-col overflow-hidden bg-background">
			<AppHeader status={status.data} />
			<ScrollArea
				ref={scrollRef}
				className="min-h-0 flex-1"
				overflow="y"
				defer={false}
			>
				<main key={location.pathname} className="page-enter">
					<Routes>
						<Route path="/" element={<OverviewPage />} />
						<Route path="/explore" element={<ExplorePage />} />
						<Route path="/sessions" element={<SessionsPage />} />
						<Route
							path="/sessions/:harness/:sessionId"
							element={<SessionDetailPage />}
						/>
						<Route path="/projects" element={<ProjectsPage />} />
						<Route path="/models" element={<ModelsPage />} />
						<Route path="/harnesses" element={<HarnessesPage />} />
						<Route path="/settings" element={<SettingsPage />} />
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
				</main>
			</ScrollArea>
			<KeyboardShortcutsDialog
				open={shortcuts.helpOpen}
				onOpenChange={shortcuts.setHelpOpen}
			/>
		</div>
	);
}
