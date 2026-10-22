import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Route, Routes, useLocation } from "react-router";
import { AppHeader } from "~/components/app-header";
import { KeyboardShortcutsDialog } from "~/components/keyboard-shortcuts-dialog";
import { LoadingScreen } from "~/components/loading-screen";
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
	const previousIndexedAt = useRef<number | null>(null);

	useEffect(() => {
		if (
			indexedAt &&
			previousIndexedAt.current &&
			indexedAt !== previousIndexedAt.current
		) {
			void queryClient.invalidateQueries({
				predicate: (query) => query.queryKey[0] !== "status",
			});
		}
		previousIndexedAt.current = indexedAt;
	}, [indexedAt, queryClient]);

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
			/>
		);

	return (
		<div className="min-h-screen bg-background">
			<AppHeader status={status.data} />
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
			<KeyboardShortcutsDialog
				open={shortcuts.helpOpen}
				onOpenChange={shortcuts.setHelpOpen}
			/>
		</div>
	);
}
