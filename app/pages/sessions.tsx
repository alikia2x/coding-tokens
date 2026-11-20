import { matchesSessionQuery, parseSearchQuery } from "@shared/search";
import type { HarnessName, SessionSummary } from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import { Download, Search, X } from "lucide-react";
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigationType, useSearchParams } from "react-router";
import type { FacetOption } from "~/components/facet-filter";
import { PageContainer } from "~/components/page-container";
import { BatchExportDialog } from "~/components/sessions/batch-export-dialog";
import { SessionList } from "~/components/sessions/session-list";
import { SessionsSidebar } from "~/components/sessions/sessions-sidebar";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { totalTokens } from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { type TranslationKey, useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useSessions, useSessionsSearch, useStatus } from "~/lib/queries";
import { useRangeLabel } from "~/lib/range";
import { useSettings } from "~/lib/settings";
import { type SessionSortKey, useAppStore } from "~/lib/store";
import { UNKNOWN_PROJECT_KEY } from "~/lib/time-range";

type SortKey = SessionSortKey;

const SESSION_FILTER_KEYS = [
	"harness",
	"project",
	"model",
	"q",
	"internal",
	"empty",
] as const;

function hasUrlSessionFilters(params: URLSearchParams): boolean {
	return SESSION_FILTER_KEYS.some((key) => params.has(key));
}

const EMPTY_SNIPPETS: Record<string, string> = {};

const sortLabels: Record<SortKey, TranslationKey> = {
	recent: "sessions.sortRecent",
	cost: "metric.cost",
	tokens: "metric.tokens",
	requests: "metric.requests",
	title: "sessions.sortTitle",
};

function sortSessions(rows: SessionSummary[], key: SortKey): SessionSummary[] {
	return [...rows].sort((left, right) => {
		if (key === "title") return left.title.localeCompare(right.title);
		if (key === "cost") return right.totals.costUsd - left.totals.costUsd;
		if (key === "tokens") {
			return totalTokens(right.totals) - totalTokens(left.totals);
		}
		if (key === "requests") return right.totals.requests - left.totals.requests;
		return (
			(right.lastActivityAt ?? right.startedAt ?? 0) -
			(left.lastActivityAt ?? left.startedAt ?? 0)
		);
	});
}

function groupMaxActivity(rows: SessionSummary[]): number {
	let max = 0;
	for (const row of rows) {
		const ts = row.lastActivityAt ?? row.startedAt ?? 0;
		if (ts > max) max = ts;
	}
	return max;
}

export function SessionsPage() {
	const range = useResolvedRange();
	const sessions = useSessions(range);
	const status = useStatus();
	const [searchParams, setSearchParams] = useSearchParams();
	const navigationType = useNavigationType();
	const { settings, update: updateSettings } = useSettings();
	const t = useT();
	const rangeLabel = useRangeLabel();

	const storeSessions = useAppStore((state) => state.sessions);
	const applySessionsUrlFilters = useAppStore(
		(state) => state.applySessionsUrlFilters,
	);
	const setSessionsPatch = useAppStore((state) => state.setSessionsPatch);
	const clearSessionsFilters = useAppStore(
		(state) => state.clearSessionsFilters,
	);
	const setSessionsExpanded = useAppStore((state) => state.setSessionsExpanded);
	const toggleSessionGroup = useAppStore((state) => state.toggleSessionGroup);

	const ownSyncRef = useRef<string | null>(null);
	const mountedRef = useRef(false);

	const buildSessionParams = useCallback(
		(
			base: URLSearchParams,
			slice: {
				harness: HarnessName | null;
				projects: string[];
				models: string[];
				query: string;
				includeInternal: boolean | null;
				showEmpty: boolean;
			},
		): URLSearchParams => {
			const next = new URLSearchParams();
			for (const key of ["range", "from", "to"]) {
				const value = base.get(key);
				if (value) next.set(key, value);
			}
			if (slice.harness) next.set("harness", slice.harness);
			for (const project of slice.projects) next.append("project", project);
			for (const model of slice.models) next.append("model", model);
			if (slice.query) next.set("q", slice.query);
			if (slice.includeInternal === true) next.set("internal", "1");
			else if (slice.includeInternal === false) next.set("internal", "0");
			if (slice.showEmpty) next.set("empty", "1");
			return next;
		},
		[],
	);

	useLayoutEffect(() => {
		const rawSearch = searchParams.toString();
		if (ownSyncRef.current === rawSearch) {
			ownSyncRef.current = null;
			mountedRef.current = true;
			return;
		}
		if (
			hasUrlSessionFilters(searchParams) &&
			(!mountedRef.current || navigationType !== "POP")
		) {
			mountedRef.current = true;
			applySessionsUrlFilters({
				harness: (searchParams.get("harness") as HarnessName | null) ?? null,
				projects: searchParams.getAll("project"),
				models: searchParams.getAll("model"),
				query: (searchParams.get("q") ?? "").trim(),
				includeInternal: searchParams.has("internal")
					? searchParams.get("internal") === "1"
					: null,
				showEmpty: searchParams.get("empty") === "1",
			});
			return;
		}
		mountedRef.current = true;
		const current = useAppStore.getState().sessions;
		const mirrored = buildSessionParams(searchParams, current);
		const mirroredStr = mirrored.toString();
		if (mirroredStr !== rawSearch) {
			ownSyncRef.current = mirroredStr;
			setSearchParams(mirrored, { replace: true });
		}
	}, [
		searchParams,
		navigationType,
		applySessionsUrlFilters,
		buildSessionParams,
		setSearchParams,
	]);

	const harness = storeSessions.harness;
	const projects = storeSessions.projects;
	const models = storeSessions.models;
	const includeInternal =
		storeSessions.includeInternal !== null
			? storeSessions.includeInternal
			: settings.includeInternal;
	const showEmpty = storeSessions.showEmpty;
	const committedQuery = storeSessions.query;
	const [draftQuery, setDraftQuery] = useState(committedQuery);

	useEffect(() => {
		setDraftQuery(committedQuery);
	}, [committedQuery]);

	const bodySearch = useSessionsSearch(
		range,
		committedQuery,
		Boolean(committedQuery),
	);
	const grouped = storeSessions.grouped;
	const sort = storeSessions.sort;
	const [exportDialogOpen, setExportDialogOpen] = useState(false);
	const expandedGroups = useMemo(
		() => new Set(storeSessions.expandedGroups),
		[storeSessions.expandedGroups],
	);

	const parsed = useMemo(
		() => parseSearchQuery(committedQuery),
		[committedQuery],
	);
	const hasFreshBodySearch =
		Boolean(committedQuery) && bodySearch.data?.query.trim() === committedQuery;
	const isBodySearching =
		Boolean(committedQuery) &&
		!hasFreshBodySearch &&
		!bodySearch.isError &&
		(bodySearch.isLoading || bodySearch.isFetching);
	const bodyMatchKeys = useMemo(() => {
		if (!hasFreshBodySearch || !bodySearch.data) return null;
		return new Set(bodySearch.data.keys);
	}, [hasFreshBodySearch, bodySearch.data]);
	const bodySnippets =
		hasFreshBodySearch && bodySearch.data
			? bodySearch.data.snippets
			: EMPTY_SNIPPETS;

	const all = sessions.data?.sessions ?? [];
	const projectSet = useMemo(() => new Set(projects), [projects]);
	const modelSet = useMemo(() => new Set(models), [models]);

	const matchesFilters = useCallback(
		(
			session: SessionSummary,
			omit?: "harness" | "project" | "model",
		): boolean => {
			if (omit !== "harness" && harness && session.harness !== harness)
				return false;
			if (
				omit !== "project" &&
				projectSet.size &&
				!projectSet.has(session.cwd ?? UNKNOWN_PROJECT_KEY)
			)
				return false;
			if (
				omit !== "model" &&
				modelSet.size &&
				!session.models.some((model) => modelSet.has(model))
			)
				return false;
			if (!includeInternal && (session.isSubagent || session.isReview))
				return false;
			if (!showEmpty && session.totals.requests === 0) return false;
			if (!committedQuery) return true;
			if (bodyMatchKeys) return bodyMatchKeys.has(session.key);
			return matchesSessionQuery(
				{
					title: session.title,
					projectName: session.projectName,
					cwd: session.cwd,
					harness: `${session.harness} ${HARNESS_LABELS[session.harness]}`,
					models: session.models,
					sessionId: session.sessionId,
					isSubagent: session.isSubagent,
					hasTranscript: session.hasTranscript,
					costUsd: session.totals.costUsd,
				},
				parsed,
			);
		},
		[
			harness,
			projectSet,
			modelSet,
			includeInternal,
			showEmpty,
			committedQuery,
			bodyMatchKeys,
			parsed,
		],
	);

	const filtered = useMemo(() => {
		const rows = all.filter((session) => matchesFilters(session));
		return sortSessions(rows, sort);
	}, [all, matchesFilters, sort]);

	const harnessBaseSessions = useMemo(
		() => all.filter((session) => matchesFilters(session, "harness")),
		[all, matchesFilters],
	);

	const counts = useMemo(() => {
		const map = new Map<HarnessName, number>();
		for (const session of harnessBaseSessions) {
			map.set(session.harness, (map.get(session.harness) ?? 0) + 1);
		}
		return map;
	}, [harnessBaseSessions]);

	const groups = useMemo(() => {
		if (!grouped) return null;
		const map = new Map<string, SessionSummary[]>();
		for (const session of filtered) {
			const key = session.cwd ?? UNKNOWN_PROJECT_KEY;
			const list = map.get(key) ?? [];
			list.push(session);
			map.set(key, list);
		}
		return [...map.entries()].sort(
			(left, right) => groupMaxActivity(right[1]) - groupMaxActivity(left[1]),
		);
	}, [filtered, grouped]);

	const deferredFiltered = useDeferredValue(filtered);
	const deferredGroups = useDeferredValue(groups);
	const exportSessionKeys = useMemo(
		() => (exportDialogOpen ? filtered.map((session) => session.key) : []),
		[exportDialogOpen, filtered],
	);

	const projectOptions = useMemo<FacetOption[]>(() => {
		const labels = new Map<string, string>();
		for (const session of all) {
			const projectKey = session.cwd ?? UNKNOWN_PROJECT_KEY;
			if (!labels.has(projectKey)) {
				labels.set(
					projectKey,
					session.cwd
						? localizeLabel(t, session.projectName)
						: t("projects.unknown"),
				);
			}
		}
		const map = new Map<string, FacetOption>();
		for (const session of all) {
			if (!matchesFilters(session, "project")) continue;
			const projectKey = session.cwd ?? UNKNOWN_PROJECT_KEY;
			const current = map.get(projectKey);
			if (current) current.count += 1;
			else {
				map.set(projectKey, {
					value: projectKey,
					label: session.cwd
						? localizeLabel(t, session.projectName)
						: t("projects.unknown"),
					count: 1,
				});
			}
		}
		for (const selectedCwd of projects) {
			if (!map.has(selectedCwd)) {
				map.set(selectedCwd, {
					value: selectedCwd,
					label:
						selectedCwd === UNKNOWN_PROJECT_KEY
							? t("projects.unknown")
							: (labels.get(selectedCwd) ??
								(selectedCwd.split("/").at(-1) || selectedCwd)),
					count: 0,
				});
			}
		}
		return [...map.values()].sort((left, right) => right.count - left.count);
	}, [all, matchesFilters, projects, t]);

	const modelOptions = useMemo<FacetOption[]>(() => {
		const map = new Map<string, FacetOption>();
		for (const session of all) {
			if (!matchesFilters(session, "model")) continue;
			for (const model of session.models) {
				const current = map.get(model);
				if (current) current.count += 1;
				else map.set(model, { value: model, label: model, count: 1 });
			}
		}
		for (const selectedModel of models) {
			if (!map.has(selectedModel)) {
				map.set(selectedModel, {
					value: selectedModel,
					label: selectedModel,
					count: 0,
				});
			}
		}
		return [...map.values()].sort((left, right) => right.count - left.count);
	}, [all, matchesFilters, models]);

	const hasFilters = Boolean(
		harness ||
			projects.length ||
			models.length ||
			includeInternal ||
			showEmpty ||
			committedQuery,
	);

	const filterSignature = `${range.from ?? ""}\n${range.until ?? ""}\n${harness ?? ""}\n${projects.join(",")}\n${models.join(",")}\n${includeInternal}\n${showEmpty}\n${committedQuery}`;
	useEffect(() => {
		if (!grouped || !groups?.length) return;
		if (storeSessions.expandedSignature === filterSignature) return;
		const firstGroup = groups[0]?.[0];
		setSessionsExpanded(firstGroup ? [firstGroup] : [], filterSignature);
	}, [
		filterSignature,
		storeSessions.expandedSignature,
		grouped,
		groups,
		setSessionsExpanded,
	]);

	const allGroupKeys = groups?.map(([key]) => key) ?? [];
	const allExpanded =
		allGroupKeys.length > 0 &&
		allGroupKeys.every((key) => expandedGroups.has(key));

	function updateSessionFilters(
		patch: Partial<{
			harness: HarnessName | null;
			projects: string[];
			models: string[];
			query: string;
			includeInternal: boolean | null;
			showEmpty: boolean;
		}>,
	): void {
		setSessionsPatch({
			...patch,
			groupLimit: 30,
			ungroupedLimit: 80,
			expandedGroupLimits: {},
		});
		const nextSlice = { ...useAppStore.getState().sessions, ...patch };
		const nextParams = buildSessionParams(searchParams, nextSlice);
		ownSyncRef.current = nextParams.toString();
		setSearchParams(nextParams, { replace: true });
	}

	function commitSearch(value: string): void {
		const trimmed = value.trim();
		updateSessionFilters({ query: trimmed });
	}

	function clearSearch(): void {
		setDraftQuery("");
		updateSessionFilters({ query: "" });
	}

	function clearFilters(): void {
		setDraftQuery("");
		clearSessionsFilters();
		const next = new URLSearchParams();
		for (const key of ["range", "from", "to"]) {
			const value = searchParams.get(key);
			if (value) next.set(key, value);
		}
		ownSyncRef.current = next.toString();
		setSearchParams(next, { replace: true });
	}

	function toggleGroup(key: string): void {
		toggleSessionGroup(key);
	}

	return (
		<PageContainer className="pt-6">
			<div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
				<SessionsSidebar
					harness={harness}
					projects={projects}
					models={models}
					includeInternal={includeInternal}
					showEmpty={showEmpty}
					hasFilters={hasFilters}
					totalFiltered={filtered.length}
					totalBase={harnessBaseSessions.length}
					counts={counts}
					projectOptions={projectOptions}
					modelOptions={modelOptions}
					status={status.data}
					rangeLabel={rangeLabel}
					onSelectHarness={(next) => updateSessionFilters({ harness: next })}
					onSetProjects={(values) => updateSessionFilters({ projects: values })}
					onSetModels={(values) => updateSessionFilters({ models: values })}
					onToggleInternal={() => {
						const next = !includeInternal;
						updateSessionFilters({ includeInternal: next });
						updateSettings({ includeInternal: next });
					}}
					onToggleEmpty={() => updateSessionFilters({ showEmpty: !showEmpty })}
					onClearFilters={clearFilters}
				/>

				<section className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-48 flex-1">
							<Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
							<Input
								value={draftQuery}
								onChange={(event) => {
									const next = event.target.value;
									setDraftQuery(next);
									if (!next && committedQuery) clearSearch();
								}}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "Enter") {
										event.preventDefault();
										commitSearch(draftQuery);
									}
									if (
										event.key === "Escape" &&
										(draftQuery || committedQuery)
									) {
										event.preventDefault();
										clearSearch();
									}
								}}
								placeholder={t("sessions.search")}
								className="pl-8 pr-14 text-[12px]"
								data-search-input
							/>
							{draftQuery || committedQuery ? (
								<div className="absolute right-1.5 top-1 flex items-center gap-0.5">
									{draftQuery.trim() !== committedQuery ? (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="h-6 w-6 text-[10px] text-muted-foreground"
											onClick={() => commitSearch(draftQuery)}
											aria-label={t("common.search")}
										>
											↵
										</Button>
									) : null}
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="h-6 w-6 text-muted-foreground"
										onClick={clearSearch}
										aria-label={t("common.clear")}
									>
										<X className="size-3.5" />
									</Button>
								</div>
							) : null}
						</div>

						<Select
							value={sort}
							onValueChange={(value) =>
								setSessionsPatch({ sort: value as SortKey })
							}
						>
							<SelectTrigger size="sm" className="w-[124px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								{Object.entries(sortLabels).map(([value, label]) => (
									<SelectItem key={value} value={value}>
										{t(label)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>

						<div className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-[12px] text-muted-foreground">
							<Switch
								checked={grouped}
								onCheckedChange={(checked) =>
									setSessionsPatch({ grouped: checked })
								}
								aria-label={t("sessions.groupByProject")}
							/>
							{t("sessions.group")}
						</div>

						{grouped ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setSessionsExpanded(allExpanded ? [] : allGroupKeys)
								}
							>
								{allExpanded
									? t("sessions.collapseAll")
									: t("sessions.expandAll")}
							</Button>
						) : null}

						<Button
							variant="outline"
							size="sm"
							className="ml-auto"
							disabled={filtered.length === 0}
							onClick={() => setExportDialogOpen(true)}
						>
							<Download className="size-3.5" />
							{t("common.export")}
						</Button>
					</div>

					<SessionList
						loading={(sessions.isLoading && !sessions.data) || isBodySearching}
						error={
							sessions.isError
								? sessions.error.message
								: committedQuery && bodySearch.isError
									? bodySearch.error.message
									: null
						}
						filtered={deferredFiltered}
						groups={deferredGroups}
						expandedGroups={expandedGroups}
						forceExpand={Boolean(committedQuery)}
						snippets={bodySnippets}
						terms={parsed.terms}
						hasFilters={hasFilters}
						onToggleGroup={toggleGroup}
						onClearFilters={clearFilters}
					/>
				</section>
			</div>

			<BatchExportDialog
				open={exportDialogOpen}
				sessionKeys={exportSessionKeys}
				defaultDetailLevel={settings.defaultDetailLevel}
				onOpenChange={setExportDialogOpen}
			/>
		</PageContainer>
	);
}
