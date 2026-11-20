import type { SessionSummary } from "@shared/types";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { memo } from "react";
import { Link } from "react-router";
import { EmptyState } from "~/components/empty-state";
import { HarnessDot } from "~/components/harness-badge";
import { Highlight } from "~/components/highlight";
import { SessionRoleBadge } from "~/components/session-role-badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
	formatCost,
	formatNumber,
	formatRelativeTime,
	formatTokens,
	totalTokens,
} from "~/lib/format";
import { useProgressiveLimit } from "~/lib/hooks";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useAppStore } from "~/lib/store";
import { UNKNOWN_PROJECT_KEY } from "~/lib/time-range";

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

const SessionRow = memo(function SessionRow({
	session,
	snippet,
	terms,
}: {
	session: SessionSummary;
	snippet?: string;
	terms: string[];
}) {
	const t = useT();
	const findParam = terms[0] ? `?find=${encodeURIComponent(terms[0])}` : "";
	const modelSummary = session.models.length
		? session.models
				.slice(0, 2)
				.map((model) => localizeLabel(t, model))
				.join(", ")
		: "—";

	return (
		<Link
			to={`/sessions/${session.harness}/${encodeURIComponent(session.sessionId)}${findParam}`}
			className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
		>
			<HarnessDot harness={session.harness} />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] font-medium group-hover:underline">
						<Highlight text={localizeLabel(t, session.title)} terms={terms} />
					</span>
					<SessionRoleBadge
						isReview={session.isReview}
						isSubagent={session.isSubagent}
					/>
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="truncate">
						{localizeLabel(t, session.projectName)}
					</span>
					<span className="truncate">{modelSummary}</span>
					<span>{formatRelativeTime(session.lastActivityAt)}</span>
				</div>
				{snippet ? (
					<div className="mt-1 truncate text-[11px] text-muted-foreground/90">
						<Highlight text={snippet} terms={terms} />
					</div>
				) : null}
			</div>
			<div className="hidden items-center gap-5 text-right text-[12px] tabular sm:flex">
				<div className="w-20">{formatTokens(totalTokens(session.totals))}</div>
				<div className="w-16">{formatCost(session.totals.costUsd)}</div>
				<div className="w-10">{formatNumber(session.totals.requests)}</div>
			</div>
		</Link>
	);
});

function ExpandedGroupRows({
	cwd,
	rows,
	snippets,
	terms,
}: {
	cwd: string;
	rows: SessionSummary[];
	snippets: Record<string, string>;
	terms: string[];
}) {
	const storedLimit = useAppStore(
		(state) => state.sessions.expandedGroupLimits[cwd] ?? 60,
	);
	const setExpandedGroupRowLimit = useAppStore(
		(state) => state.setExpandedGroupRowLimit,
	);
	const { limit, hasMore, sentinelRef } = useProgressiveLimit(
		rows.length,
		60,
		60,
		terms.length > 0,
		undefined,
		{
			limit: storedLimit,
			onLimitChange: (next) => setExpandedGroupRowLimit(cwd, next),
		},
	);
	const visible = rows.slice(0, limit);
	return (
		<div className="divide-y">
			{visible.map((session) => (
				<SessionRow
					key={session.key}
					session={session}
					snippet={snippets[session.key]}
					terms={terms}
				/>
			))}
			{hasMore ? <div ref={sentinelRef} className="h-px" /> : null}
		</div>
	);
}

export function SessionList({
	loading,
	error,
	filtered,
	groups,
	expandedGroups,
	forceExpand,
	snippets,
	terms,
	hasFilters,
	onToggleGroup,
	onClearFilters,
}: {
	loading: boolean;
	error?: string | null;
	filtered: SessionSummary[];
	groups: Array<[string, SessionSummary[]]> | null;
	expandedGroups: Set<string>;
	forceExpand: boolean;
	snippets: Record<string, string>;
	terms: string[];
	hasFilters: boolean;
	onToggleGroup: (cwd: string) => void;
	onClearFilters: () => void;
}) {
	const t = useT();
	const ungroupedLimit = useAppStore((state) => state.sessions.ungroupedLimit);
	const groupLimit = useAppStore((state) => state.sessions.groupLimit);
	const setSessionUngroupedLimit = useAppStore(
		(state) => state.setSessionUngroupedLimit,
	);
	const setSessionGroupLimit = useAppStore(
		(state) => state.setSessionGroupLimit,
	);
	const ungroupedWindow = useProgressiveLimit(
		filtered.length,
		80,
		80,
		false,
		undefined,
		{ limit: ungroupedLimit, onLimitChange: setSessionUngroupedLimit },
	);
	const groupWindow = useProgressiveLimit(
		groups?.length ?? 0,
		30,
		30,
		false,
		undefined,
		{ limit: groupLimit, onLimitChange: setSessionGroupLimit },
	);

	if (loading) {
		return (
			<div className="mt-4 space-y-2">
				{Array.from({ length: 8 }, (_, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
					<Skeleton key={index} className="h-16 rounded-md" />
				))}
			</div>
		);
	}

	if (error) {
		return (
			<div className="mt-4 rounded-lg border border-destructive/30 bg-destructive-surface p-4 text-sm text-destructive">
				{t("error.usageLoad")} {error}
			</div>
		);
	}

	if (filtered.length === 0) {
		return (
			<EmptyState
				className="mt-4"
				title={t("empty.sessionsFilters")}
				description={t("empty.trySearch")}
				action={
					hasFilters ? (
						<Button variant="outline" size="sm" onClick={onClearFilters}>
							{t("common.clear")}
						</Button>
					) : undefined
				}
			/>
		);
	}

	if (!groups) {
		const visibleRows = filtered.slice(0, ungroupedWindow.limit);
		return (
			<>
				<SessionListHeader />
				<div className="mt-3 divide-y overflow-hidden rounded-lg border bg-card">
					{visibleRows.map((session) => (
						<SessionRow
							key={session.key}
							session={session}
							snippet={snippets[session.key]}
							terms={terms}
						/>
					))}
				</div>
				{ungroupedWindow.hasMore ? (
					<div ref={ungroupedWindow.sentinelRef} className="h-px" />
				) : null}
			</>
		);
	}

	const visibleGroups = groups.slice(0, groupWindow.limit);
	return (
		<>
			<SessionListHeader />
			<div className="mt-3">
				{visibleGroups.map(([cwd, rows]) => {
					const open = forceExpand || expandedGroups.has(cwd);
					const cost = rows.reduce(
						(sum, session) => sum + session.totals.costUsd,
						0,
					);
					const tokens = rows.reduce(
						(sum, session) => sum + totalTokens(session.totals),
						0,
					);
					return (
						<div key={cwd} className="mb-2">
							<button
								type="button"
								onClick={() => onToggleGroup(cwd)}
								aria-expanded={open}
								className="sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-background px-2 py-2 text-left transition-colors hover:bg-hover"
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
									{cwd === UNKNOWN_PROJECT_KEY ? "" : cwd}
								</span>
								<span className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground tabular">
									<span>
										{t("count.sessions", {
											count: rows.length,
											formatted: formatNumber(rows.length),
										})}
									</span>
									<span>
										{t("count.tokens", {
											count: tokens,
											formatted: formatTokens(tokens),
										})}
									</span>
									<span>{formatCost(cost)}</span>
								</span>
							</button>
							{open ? (
								<ExpandedGroupRows
									cwd={cwd}
									rows={rows}
									snippets={snippets}
									terms={terms}
								/>
							) : null}
						</div>
					);
				})}
				{groupWindow.hasMore ? (
					<div ref={groupWindow.sentinelRef} className="h-px" />
				) : null}
			</div>
		</>
	);
}
