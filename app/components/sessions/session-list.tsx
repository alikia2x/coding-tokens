import type { SessionSummary } from "@shared/types";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "~/components/empty-state";
import { HarnessDot } from "~/components/harness-badge";
import { Highlight } from "~/components/highlight";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
	formatCost,
	formatNumber,
	formatRelativeTime,
	formatTokens,
} from "~/lib/format";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";

export function sessionTotalTokens(session: SessionSummary): number {
	return (
		session.totals.inputTokens +
		session.totals.outputTokens +
		session.totals.cacheReadTokens +
		session.totals.cacheWriteTokens
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

function SessionRoleBadge({ session }: { session: SessionSummary }) {
	const t = useT();
	if (session.isReview) {
		return (
			<Badge variant="outline" className="rounded text-[9px]">
				{t("session.review")}
			</Badge>
		);
	}
	if (session.isSubagent) {
		return (
			<Badge variant="outline" className="rounded text-[9px]">
				{t("session.subagent")}
			</Badge>
		);
	}
	return null;
}

function SessionRow({
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
			className="group flex items-center gap-3 px-2 py-2.5 transition-colors hover:bg-hover"
		>
			<HarnessDot harness={session.harness} />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] font-medium group-hover:underline">
						<Highlight text={localizeLabel(t, session.title)} terms={terms} />
					</span>
					<SessionRoleBadge session={session} />
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
				<div className="w-20">{formatTokens(sessionTotalTokens(session))}</div>
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

export function SessionList({
	loading,
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
		return (
			<>
				<SessionListHeader />
				<div className="mt-3 divide-y rounded-lg border bg-card px-3">
					{filtered.map((session) => (
						<SessionRow
							key={session.key}
							session={session}
							snippet={snippets[session.key]}
							terms={terms}
						/>
					))}
				</div>
			</>
		);
	}

	return (
		<>
			<SessionListHeader />
			<div className="mt-3">
				{groups.map(([cwd, rows]) => {
					const open = forceExpand || expandedGroups.has(cwd);
					const cost = rows.reduce(
						(sum, session) => sum + session.totals.costUsd,
						0,
					);
					const tokens = rows.reduce(
						(sum, session) => sum + sessionTotalTokens(session),
						0,
					);
					return (
						<div key={cwd} className="mb-2">
							<button
								type="button"
								onClick={() => onToggleGroup(cwd)}
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
									<span>{formatCost(cost, true)}</span>
								</span>
							</button>
							<div className="collapse-grid" data-open={open}>
								<div>
									<div className="divide-y">
										{rows.map((session) => (
											<SessionRow
												key={session.key}
												session={session}
												snippet={snippets[session.key]}
												terms={terms}
											/>
										))}
									</div>
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</>
	);
}
