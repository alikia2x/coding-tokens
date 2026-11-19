import { matchesSessionQuery, parseSearchQuery } from "@shared/search";
import type { HarnessName, SessionSummary } from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import { Download, Search, X } from "lucide-react";
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useSearchParams } from "react-router";
import type { FacetOption } from "~/components/facet-filter";
import { PageContainer } from "~/components/page-container";
import { BatchExportDialog } from "~/components/sessions/batch-export-dialog";
import {
	SessionList,
	sessionTotalTokens,
} from "~/components/sessions/session-list";
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
import { useResolvedRange } from "~/lib/hooks";
import { type TranslationKey, useT } from "~/lib/i18n";
import { useSessions, useSessionsSearch, useStatus } from "~/lib/queries";
import { useRangeLabel } from "~/lib/range";
import { useSettings } from "~/lib/settings";

type SortKey = "recent" | "cost" | "tokens" | "requests" | "title";

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
			return sessionTotalTokens(right) - sessionTotalTokens(left);
		}
		if (key === "requests") return right.totals.requests - left.totals.requests;
		return (
			(right.lastActivityAt ?? right.startedAt ?? 0) -
			(left.lastActivityAt ?? left.startedAt ?? 0)
		);
	});
}

export function SessionsPage() {
	const range = useResolvedRange();
	const sessions = useSessions(range);
	const status = useStatus();
	const [searchParams, setSearchParams] = useSearchParams();
	const harness = searchParams.get("harness") as HarnessName | null;
	const projects = searchParams.getAll("project");
	const models = searchParams.getAll("model");
	const { settings, update: updateSettings } = useSettings();
	const t = useT();
	const rangeLabel = useRangeLabel();
	const includeInternal = searchParams.has("internal")
		? searchParams.get("internal") === "1"
		: settings.includeInternal;
	const showEmpty = searchParams.get("empty") === "1";

	const urlQuery = searchParams.get("q") ?? "";
	const [draftQuery, setDraftQuery] = useState(urlQuery);
	const [committedQuery, setCommittedQuery] = useState(urlQuery);

	useEffect(() => {
		setDraftQuery(urlQuery);
		setCommittedQuery(urlQuery);
	}, [urlQuery]);

	const bodySearch = useSessionsSearch(
		range,
		committedQuery,
		Boolean(committedQuery.trim()),
	);
	const [grouped, setGrouped] = useState(true);
	const [sort, setSort] = useState<SortKey>("recent");
	const [exportDialogOpen, setExportDialogOpen] = useState(false);
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
		() => new Set(),
	);

	const parsed = useMemo(
		() => parseSearchQuery(committedQuery),
		[committedQuery],
	);
	const hasFreshBodySearch =
		Boolean(committedQuery.trim()) && bodySearch.data?.query === committedQuery;
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
				(!session.cwd || !projectSet.has(session.cwd))
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
			if (!committedQuery.trim()) return true;
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
			const key = session.cwd ?? "unknown";
			const list = map.get(key) ?? [];
			list.push(session);
			map.set(key, list);
		}
		return [...map.entries()].sort(
			(left, right) =>
				(right[1][0]?.lastActivityAt ?? 0) - (left[1][0]?.lastActivityAt ?? 0),
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
			if (session.cwd && !labels.has(session.cwd)) {
				labels.set(session.cwd, session.projectName);
			}
		}
		const map = new Map<string, FacetOption>();
		for (const session of all) {
			if (!matchesFilters(session, "project")) continue;
			if (!session.cwd) continue;
			const current = map.get(session.cwd);
			if (current) current.count += 1;
			else {
				map.set(session.cwd, {
					value: session.cwd,
					label: session.projectName,
					count: 1,
				});
			}
		}
		for (const selectedCwd of projects) {
			if (!map.has(selectedCwd)) {
				map.set(selectedCwd, {
					value: selectedCwd,
					label:
						labels.get(selectedCwd) ??
						(selectedCwd.split("/").at(-1) || selectedCwd),
					count: 0,
				});
			}
		}
		return [...map.values()].sort((left, right) => right.count - left.count);
	}, [all, matchesFilters, projects]);

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
			committedQuery.trim(),
	);

	const defaultExpanded = useRef(false);
	useEffect(() => {
		if (defaultExpanded.current || !grouped || !groups?.length) return;
		defaultExpanded.current = true;
		setExpandedGroups(new Set([groups[0]?.[0] ?? ""]));
	}, [groups, grouped]);

	const allGroupKeys = groups?.map(([key]) => key) ?? [];
	const allExpanded =
		allGroupKeys.length > 0 &&
		allGroupKeys.every((key) => expandedGroups.has(key));

	function setParam(key: string, value: string | null): void {
		const next = new URLSearchParams(searchParams);
		if (value) next.set(key, value);
		else next.delete(key);
		setSearchParams(next, { replace: true });
	}

	function setListParam(key: string, values: string[]): void {
		const next = new URLSearchParams(searchParams);
		next.delete(key);
		for (const value of values) next.append(key, value);
		setSearchParams(next, { replace: true });
	}

	function commitSearch(value: string): void {
		const trimmed = value.trim();
		setCommittedQuery(trimmed);
		setParam("q", trimmed || null);
	}

	function clearSearch(): void {
		setDraftQuery("");
		setCommittedQuery("");
		setParam("q", null);
	}

	function clearFilters(): void {
		setDraftQuery("");
		setCommittedQuery("");
		const next = new URLSearchParams();
		for (const key of ["range", "from", "to"]) {
			const value = searchParams.get(key);
			if (value) next.set(key, value);
		}
		setSearchParams(next, { replace: true });
	}

	function toggleGroup(key: string): void {
		setExpandedGroups((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
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
					onSelectHarness={(next) => setParam("harness", next)}
					onSetProjects={(values) => setListParam("project", values)}
					onSetModels={(values) => setListParam("model", values)}
					onToggleInternal={() => {
						const next = !includeInternal;
						setParam("internal", next ? "1" : null);
						updateSettings({ includeInternal: next });
					}}
					onToggleEmpty={() => setParam("empty", showEmpty ? null : "1")}
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
							onValueChange={(value) => setSort(value as SortKey)}
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
								onCheckedChange={setGrouped}
								aria-label={t("sessions.groupByProject")}
							/>
							{t("sessions.group")}
						</div>

						{grouped ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setExpandedGroups(
										allExpanded ? new Set() : new Set(allGroupKeys),
									)
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
						loading={sessions.isLoading && !sessions.data}
						filtered={deferredFiltered}
						groups={deferredGroups}
						expandedGroups={expandedGroups}
						forceExpand={Boolean(committedQuery.trim())}
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
