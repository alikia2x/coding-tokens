import { matchesSessionQuery, parseSearchQuery } from "@shared/search";
import type { HarnessName, SessionSummary } from "@shared/types";
import { HARNESS_LABELS, HARNESS_NAMES } from "@shared/types";
import { cn } from "cn";
import { ChevronRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { EmptyState } from "~/components/empty-state";
import { FacetFilter, type FacetOption } from "~/components/facet-filter";
import { HarnessDot } from "~/components/harness-badge";
import { PageContainer } from "~/components/page-container";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import {
	formatCost,
	formatNumber,
	formatRelativeTime,
	formatTokens,
} from "~/lib/format";
import { useResolvedRange } from "~/lib/hooks";
import { type TranslationKey, useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useSessions, useStatus } from "~/lib/queries";
import { useRangeLabel } from "~/lib/range";
import { useSettings } from "~/lib/settings";

type SortKey = "recent" | "cost" | "tokens" | "requests" | "title";

const sortLabels: Record<SortKey, TranslationKey> = {
	recent: "sessions.sortRecent",
	cost: "metric.cost",
	tokens: "metric.tokens",
	requests: "metric.requests",
	title: "sessions.sortTitle",
};

function totalTokens(session: SessionSummary): number {
	return (
		session.totals.inputTokens +
		session.totals.outputTokens +
		session.totals.cacheReadTokens +
		session.totals.cacheWriteTokens
	);
}

function sortSessions(rows: SessionSummary[], key: SortKey): SessionSummary[] {
	return [...rows].sort((left, right) => {
		if (key === "title") return left.title.localeCompare(right.title);
		if (key === "cost") return right.totals.costUsd - left.totals.costUsd;
		if (key === "tokens") return totalTokens(right) - totalTokens(left);
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
	const [query, setQuery] = useState(searchParams.get("q") ?? "");
	const [grouped, setGrouped] = useState(true);
	const [sort, setSort] = useState<SortKey>("recent");
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
		() => new Set(),
	);
	const parsed = useMemo(() => parseSearchQuery(query), [query]);

	const all = sessions.data?.sessions ?? [];
	const filtered = useMemo(() => {
		const rows = all.filter((session) => {
			if (harness && session.harness !== harness) return false;
			if (projects.length && (!session.cwd || !projects.includes(session.cwd)))
				return false;
			if (
				models.length &&
				!session.models.some((model) => models.includes(model))
			)
				return false;
			if (!includeInternal && (session.isSubagent || session.isReview))
				return false;
			if (!showEmpty && session.totals.requests === 0) return false;
			if (!query.trim()) return true;
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
		});
		return sortSessions(rows, sort);
	}, [
		all,
		harness,
		projects,
		models,
		includeInternal,
		showEmpty,
		query,
		parsed,
		sort,
	]);

	const baseSessions = useMemo(
		() =>
			all.filter(
				(session) =>
					(includeInternal || (!session.isSubagent && !session.isReview)) &&
					(showEmpty || session.totals.requests > 0),
			),
		[all, includeInternal, showEmpty],
	);
	const counts = useMemo(() => {
		const map = new Map<HarnessName, number>();
		for (const session of baseSessions) {
			map.set(session.harness, (map.get(session.harness) ?? 0) + 1);
		}
		return map;
	}, [baseSessions]);

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

	function clearFilters(): void {
		setQuery("");
		const next = new URLSearchParams();
		for (const key of ["range", "from", "to"]) {
			const value = searchParams.get(key);
			if (value) next.set(key, value);
		}
		setSearchParams(next, { replace: true });
	}

	const projectOptions = useMemo<FacetOption[]>(() => {
		const map = new Map<string, FacetOption>();
		for (const session of baseSessions) {
			if (!session.cwd) continue;
			const current = map.get(session.cwd);
			if (current) current.count += 1;
			else
				map.set(session.cwd, {
					value: session.cwd,
					label: session.projectName,
					count: 1,
				});
		}
		return [...map.values()].sort((left, right) => right.count - left.count);
	}, [baseSessions]);

	const modelOptions = useMemo<FacetOption[]>(() => {
		const map = new Map<string, FacetOption>();
		for (const session of baseSessions) {
			for (const model of session.models) {
				const current = map.get(model);
				if (current) current.count += 1;
				else map.set(model, { value: model, label: model, count: 1 });
			}
		}
		return [...map.values()].sort((left, right) => right.count - left.count);
	}, [baseSessions]);

	const hasFilters = Boolean(
		harness ||
			projects.length ||
			models.length ||
			includeInternal ||
			showEmpty ||
			query.trim(),
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
				<aside className="lg:sticky lg:top-20 lg:self-start">
					<div className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">
						{t("common.harnesses")}
					</div>
					<div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
						<button
							type="button"
							onClick={() => setParam("harness", null)}
							className={cn(
								"flex h-8 shrink-0 items-center gap-2 rounded px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
								!harness && "bg-muted text-foreground",
							)}
						>
							<span className="flex-1">{t("filters.allHarnesses")}</span>
							<span className="tabular">{baseSessions.length}</span>
						</button>
						{HARNESS_NAMES.map((name) => {
							const info = status.data?.harnesses.find(
								(item) => item.harness === name,
							);
							return (
								<button
									key={name}
									type="button"
									onClick={() => setParam("harness", name)}
									className={cn(
										"flex h-8 shrink-0 items-center gap-2 rounded px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
										harness === name && "bg-muted text-foreground",
									)}
									title={
										info?.available ? undefined : t("harnesses.notInstalled")
									}
								>
									<HarnessDot harness={name} />
									<span className="flex-1">{HARNESS_LABELS[name]}</span>
									<span className="tabular">{counts.get(name) ?? 0}</span>
								</button>
							);
						})}
					</div>
					<div className="mt-4 border-t pt-3">
						<div className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">
							{t("common.filters")}
						</div>
						<div className="grid gap-1.5">
							<div className="[&>button]:w-full [&>button]:justify-between">
								<FacetFilter
									label={t("common.project")}
									options={projectOptions}
									values={projects}
									onChange={(values) => setListParam("project", values)}
								/>
							</div>
							<div className="[&>button]:w-full [&>button]:justify-between">
								<FacetFilter
									label={t("common.model")}
									options={modelOptions}
									values={models}
									onChange={(values) => setListParam("model", values)}
								/>
							</div>
							<Button
								variant={includeInternal ? "secondary" : "outline"}
								size="sm"
								className="w-full justify-start"
								onClick={() => {
									const next = !includeInternal;
									setParam("internal", next ? "1" : null);
									updateSettings({ includeInternal: next });
								}}
							>
								{includeInternal
									? t("sessions.internalShown")
									: t("sessions.internal")}
							</Button>
							<Button
								variant={showEmpty ? "secondary" : "outline"}
								size="sm"
								className="w-full justify-start"
								aria-pressed={showEmpty}
								onClick={() => setParam("empty", showEmpty ? null : "1")}
							>
								{t("sessions.empty")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="w-full justify-start"
								disabled={!hasFilters}
								onClick={clearFilters}
							>
								<X />
								{t("common.clear")}
							</Button>
						</div>
						<div className="mt-2 flex flex-wrap gap-1.5">
							{projects.map((cwd) => (
								<Badge
									key={cwd}
									variant="outline"
									className="gap-1 rounded font-mono text-[10px]"
								>
									{cwd.split("/").at(-1) ?? cwd}
									<button
										type="button"
										aria-label={t("sessions.clearProjectFilter")}
										onClick={() =>
											setListParam(
												"project",
												projects.filter((value) => value !== cwd),
											)
										}
									>
										<X className="size-3" />
									</button>
								</Badge>
							))}
							{models.map((model) => (
								<Badge
									key={model}
									variant="outline"
									className="gap-1 rounded text-[10px]"
								>
									{model}
									<button
										type="button"
										aria-label={t("sessions.clearModelFilter")}
										onClick={() =>
											setListParam(
												"model",
												models.filter((value) => value !== model),
											)
										}
									>
										<X className="size-3" />
									</button>
								</Badge>
							))}
						</div>
					</div>
					<div className="mt-4 hidden border-t pt-3 lg:block">
						<div className="text-[11px] text-muted-foreground">
							{formatNumber(filtered.length)} {t("metric.sessionsLower")}
						</div>
						<div className="mt-1 text-[11px] text-muted-foreground">
							{rangeLabel}
						</div>
					</div>
				</aside>

				<section className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-48 flex-1">
							<Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
							<Input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={t("sessions.search")}
								className="pl-8 text-[12px]"
								data-search-input
							/>
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
					</div>

					{!sessions.isLoading && filtered.length > 0 ? (
						<SessionListHeader />
					) : null}

					{sessions.isLoading && !sessions.data ? (
						<div className="mt-4 space-y-2">
							{Array.from({ length: 8 }, (_, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
								<Skeleton key={index} className="h-16 rounded-md" />
							))}
						</div>
					) : filtered.length === 0 ? (
						<EmptyState
							className="mt-4"
							title={t("empty.sessionsFilters")}
							description={t("empty.trySearch")}
							action={
								hasFilters ? (
									<Button variant="outline" size="sm" onClick={clearFilters}>
										Clear filters
									</Button>
								) : undefined
							}
						/>
					) : groups ? (
						<div className="mt-3">
							{groups.map(([cwd, rows]) => {
								const open = query.trim() ? true : expandedGroups.has(cwd);
								const cost = rows.reduce(
									(sum, session) => sum + session.totals.costUsd,
									0,
								);
								const tokens = rows.reduce(
									(sum, session) => sum + totalTokens(session),
									0,
								);
								return (
									<div key={cwd} className="mb-2">
										<button
											type="button"
											onClick={() => toggleGroup(cwd)}
											aria-expanded={open}
											className="sticky top-[96px] z-10 flex w-full items-center gap-2 border-b bg-background px-2 py-2 text-left transition-colors hover:bg-hover md:top-14"
										>
											<ChevronRight
												className={cn(
													"size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
													open && "rotate-90",
												)}
											/>
											<span className="text-[12px] font-medium">
												{localizeLabel(t, rows[0]?.projectName)}
											</span>
											<span className="truncate font-mono text-[10px] text-muted-foreground">
												{cwd === "unknown" ? "" : cwd}
											</span>
											<span className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground tabular">
												<span>
													{rows.length} {t("metric.sessionsLower")}
												</span>
												<span>
													{formatTokens(tokens)} {t("metric.tokensLower")}
												</span>
												<span>{formatCost(cost, true)}</span>
											</span>
										</button>
										<div className="collapse-grid" data-open={open}>
											<div>
												<div className="divide-y">
													{rows.map((session) => (
														<SessionRow key={session.key} session={session} />
													))}
												</div>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<div className="mt-3 divide-y rounded-lg border bg-card px-3">
							{filtered.map((session) => (
								<SessionRow key={session.key} session={session} />
							))}
						</div>
					)}
				</section>
			</div>
		</PageContainer>
	);
}

function SessionListHeader() {
	const t = useT();
	return (
		<div className="mt-3 flex items-center gap-3 border-b px-2 pb-1.5 text-[10px] text-muted-foreground">
			<span className="min-w-0 flex-1">{t("common.sessions")}</span>
			<div className="hidden items-center gap-5 sm:flex">
				<span className="w-20 text-right">{t("metric.tokens")}</span>
				<span className="w-16 text-right">{t("metric.cost")}</span>
				<span className="w-10 text-right">{t("metric.requests")}</span>
			</div>
		</div>
	);
}

function SessionRow({ session }: { session: SessionSummary }) {
	const t = useT();
	return (
		<Link
			to={`/sessions/${session.harness}/${encodeURIComponent(session.sessionId)}`}
			className="group flex items-center gap-3 px-2 py-2.5 transition-colors hover:bg-hover"
		>
			<HarnessDot harness={session.harness} />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] font-medium group-hover:underline">
						{localizeLabel(t, session.title)}
					</span>
					{session.isReview ? (
						<Badge variant="outline" className="rounded text-[9px]">
							{t("session.review")}
						</Badge>
					) : session.isSubagent ? (
						<Badge variant="outline" className="rounded text-[9px]">
							{t("session.subagent")}
						</Badge>
					) : null}
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="truncate">
						{localizeLabel(t, session.projectName)}
					</span>
					<span className="truncate">
						{session.models.length
							? session.models
									.slice(0, 2)
									.map((model) => localizeLabel(t, model))
									.join(", ")
							: "—"}
					</span>
					<span>{formatRelativeTime(session.lastActivityAt)}</span>
				</div>
			</div>
			<div className="hidden items-center gap-5 text-right text-[12px] tabular sm:flex">
				<div className="w-20">{formatTokens(totalTokens(session))}</div>
				<div className="w-16">
					{formatCost(
						session.totals.costUsd,
						session.totals.estimatedRequests > 0,
					)}
				</div>
				<div className="w-10">{formatNumber(session.totals.requests)}</div>
			</div>
		</Link>
	);
}
