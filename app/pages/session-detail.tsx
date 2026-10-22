import type {
	DetailItem,
	SessionDetailLevel,
	TurnSummary,
} from "@shared/types";
import {
	ChevronDown,
	ChevronLeft,
	ChevronUp,
	Download,
	Search,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { CopyButton } from "~/components/copy-button";
import { DetailLevelControl } from "~/components/detail-level-control";
import { EmptyState } from "~/components/empty-state";
import { HarnessBadge } from "~/components/harness-badge";
import { PageContainer } from "~/components/page-container";
import { SessionTurn } from "~/components/session-turn";
import { SessionUsagePanel } from "~/components/session-usage-panel";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { api } from "~/lib/api";
import { formatDateTime } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useSessionDetail } from "~/lib/queries";
import { useSettings } from "~/lib/settings";

export function SessionDetailPage() {
	const { harness = "", sessionId = "" } = useParams();
	const [searchParams, setSearchParams] = useSearchParams();
	const { settings, update: updateSettings } = useSettings();
	const t = useT();
	const level = (searchParams.get("level") ??
		settings.defaultDetailLevel) as SessionDetailLevel;
	const detail = useSessionDetail(harness, sessionId, level);
	const [exporting, setExporting] = useState(false);
	const [exportedPath, setExportedPath] = useState<string | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [findOpen, setFindOpen] = useState(() => searchParams.has("find"));
	const [findQuery, setFindQuery] = useState(
		() => searchParams.get("find") ?? "",
	);
	const [matchIndex, setMatchIndex] = useState(0);
	const findRef = useRef<HTMLInputElement>(null);

	const conversationRef = useRef<HTMLDivElement>(null);
	const rangesRef = useRef<Range[]>([]);
	const lastQueryRef = useRef("");
	const [matchCount, setMatchCount] = useState(0);
	async function exportMarkdown(): Promise<void> {
		setExporting(true);
		setExportError(null);
		try {
			const result = await api.exportSession(harness, sessionId, level);
			setExportedPath(result.path);
		} catch (error) {
			setExportError(error instanceof Error ? error.message : String(error));
		} finally {
			setExporting(false);
		}
	}

	const contentVersion = detail.data
		? `${detail.data.items.length}:${detail.data.summary.lastActivityAt ?? 0}`
		: "";

	useEffect(() => {
		const ranges: Range[] = [];
		const root = conversationRef.current;
		const needle = findQuery.trim().toLowerCase();
		if (root && needle && contentVersion) {
			for (const message of root.querySelectorAll("[data-item-id]")) {
				const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
				let node = walker.nextNode();
				while (node) {
					const text = node.nodeValue ?? "";
					const lower = text.toLowerCase();
					let at = lower.indexOf(needle);
					while (at >= 0) {
						const range = document.createRange();
						range.setStart(node, at);
						range.setEnd(node, at + needle.length);
						ranges.push(range);
						at = lower.indexOf(needle, at + needle.length);
					}
					node = walker.nextNode();
				}
			}
		}
		rangesRef.current = ranges;
		setMatchCount(ranges.length);
		const queryChanged = lastQueryRef.current !== findQuery;
		lastQueryRef.current = findQuery;

		const highlights = (
			CSS as unknown as {
				highlights?: {
					set: (name: string, highlight: unknown) => void;
					delete: (name: string) => void;
				};
			}
		).highlights;
		const HighlightCtor = (
			window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
		).Highlight;
		if (!highlights) return;
		highlights.delete("transcript-search");
		highlights.delete("transcript-search-current");
		if (!HighlightCtor || !ranges.length) return;
		highlights.set("transcript-search", new HighlightCtor(...ranges));
		const current = ranges[Math.min(matchIndex, ranges.length - 1)];
		if (current) {
			highlights.set("transcript-search-current", new HighlightCtor(current));
			if (!queryChanged)
				current.startContainer.parentElement?.scrollIntoView({
					block: "center",
					behavior: "smooth",
				});
		}
		return () => {
			highlights.delete("transcript-search");
			highlights.delete("transcript-search-current");
		};
	}, [findQuery, contentVersion, matchIndex]);

	useEffect(() => {
		const open = (): void => {
			setFindOpen(true);
			window.requestAnimationFrame(() => findRef.current?.focus());
		};
		window.addEventListener("coding-tokens:find", open);
		return () => window.removeEventListener("coding-tokens:find", open);
	}, []);

	useEffect(() => {
		if (findOpen) findRef.current?.focus();
	}, [findOpen]);

	if (detail.isLoading && !detail.data) {
		return (
			<PageContainer>
				<Skeleton className="h-6 w-80" />
				<Skeleton className="mt-3 h-40 rounded-lg" />
				<Skeleton className="mt-3 h-[420px] rounded-lg" />
			</PageContainer>
		);
	}
	if (detail.isError) {
		return (
			<PageContainer>
				<EmptyState
					title={t("error.sessionLoad")}
					description={detail.error.message}
					action={
						<Button variant="outline" size="sm" asChild>
							<Link to="/sessions">{t("nav.backToSessions")}</Link>
						</Button>
					}
				/>
			</PageContainer>
		);
	}
	const data = detail.data;
	if (!data) return null;
	const summary = data.summary;
	const itemsByTurn = new Map<string, DetailItem[]>();
	for (const item of data.items) {
		const list = itemsByTurn.get(item.turnId) ?? [];
		list.push(item);
		itemsByTurn.set(item.turnId, list);
	}
	const orderedTurns = data.turns.filter((turn) => itemsByTurn.has(turn.id));
	const untracked = itemsByTurn.get("untracked");

	return (
		<PageContainer className="pt-5">
			<div className="mx-auto w-full max-w-[1040px]">
				<Link
					to="/sessions"
					className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
				>
					<ChevronLeft className="size-3.5" />
					{t("common.sessions")}
				</Link>

				<div className="mt-3 flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<h1
							className="line-clamp-2 max-w-4xl text-[22px] font-semibold leading-7 tracking-[-0.025em]"
							title={summary.title}
						>
							{localizeLabel(t, summary.title)}
						</h1>
						<div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
							<HarnessBadge harness={summary.harness} />
							<span className="truncate">
								{localizeLabel(t, summary.projectName)}
							</span>
							<span className="tabular">
								{formatDateTime(summary.startedAt)}
							</span>
							{summary.isReview ? (
								<Badge variant="outline" className="rounded text-[9px]">
									{t("session.review")}
								</Badge>
							) : summary.isSubagent ? (
								<Badge variant="outline" className="rounded text-[9px]">
									{t("session.subagent")}
								</Badge>
							) : null}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							variant={findOpen ? "secondary" : "outline"}
							size="sm"
							onClick={() => setFindOpen((open) => !open)}
							aria-pressed={findOpen}
						>
							<Search />
							{t("common.find")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={exporting}
							onClick={() => void exportMarkdown()}
						>
							<Download />
							{exporting ? t("common.exporting") : t("common.export")}
						</Button>
						<DetailLevelControl
							level={level}
							onChange={(next) => {
								const params = new URLSearchParams(searchParams);
								params.set("level", next);
								setSearchParams(params, { replace: true });
								updateSettings({ defaultDetailLevel: next });
							}}
						/>
					</div>
				</div>

				{findOpen ? (
					<div className="mt-3 flex items-center gap-2 rounded-md border bg-card px-2 py-1">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							ref={findRef}
							value={findQuery}
							onChange={(event) => {
								setFindQuery(event.target.value);
								setMatchIndex(0);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									if (!matchCount) return;
									setMatchIndex((current) =>
										event.shiftKey
											? (current - 1 + matchCount) % matchCount
											: (current + 1) % matchCount,
									);
								}
								if (event.key === "Escape") setFindOpen(false);
							}}
							placeholder={t("session.findInConversation")}
							className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
							data-conversation-search
						/>
						<span className="shrink-0 text-[11px] text-muted-foreground tabular">
							{findQuery.trim()
								? matchCount
									? `${matchIndex + 1} / ${matchCount}`
									: t("empty.matches")
								: ""}
						</span>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={!matchCount}
							onClick={() =>
								setMatchIndex(
									(current) =>
										(current - 1 + matchCount) % Math.max(1, matchCount),
								)
							}
							aria-label={t("session.previousMatch")}
						>
							<ChevronUp />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={!matchCount}
							onClick={() =>
								setMatchIndex(
									(current) => (current + 1) % Math.max(1, matchCount),
								)
							}
							aria-label={t("session.nextMatch")}
						>
							<ChevronDown />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => {
								setFindOpen(false);
								setFindQuery("");
							}}
							aria-label={t("common.close")}
						>
							<X />
						</Button>
					</div>
				) : null}

				<div className="mt-3">
					<SessionUsagePanel
						summary={summary}
						stats={data.stats}
						turns={data.turns}
					/>
				</div>

				{data.warnings.map((warning) => (
					<div
						key={warning}
						className="mt-2 rounded-md bg-warning-surface px-3 py-2 text-[11px] text-warning"
					>
						{warning}
					</div>
				))}

				{data.items.length === 0 ? (
					<EmptyState
						className="mt-4"
						title={t("empty.messagesAtLevel")}
						description={t("session.moveSlider")}
					/>
				) : (
					<div className="mt-2" ref={conversationRef}>
						{orderedTurns.map((turn) => (
							<TurnWithItems
								key={turn.id}
								turn={turn}
								items={itemsByTurn.get(turn.id) ?? []}
								level={level}
							/>
						))}
						{untracked ? (
							<TurnWithItems
								turn={{
									id: "untracked",
									index: -1,
									startedAt: null,
									endedAt: null,
									requests: 0,
									totals: summary.totals,
									models: [],
								}}
								items={untracked}
								level={level}
							/>
						) : null}
					</div>
				)}
			</div>
			<Dialog
				open={Boolean(exportedPath || exportError)}
				onOpenChange={(open) => {
					if (open) return;
					setExportedPath(null);
					setExportError(null);
				}}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{exportError
								? t("common.exportFailed")
								: t("common.exportMarkdown")}
						</DialogTitle>
					</DialogHeader>
					{exportError ? (
						<p className="text-[12px] text-destructive">{exportError}</p>
					) : (
						<div>
							<p className="text-[11px] text-muted-foreground">
								{t("common.savedTo")}
							</p>
							<p className="mt-1 break-all font-mono text-[11px]">
								{exportedPath}
							</p>
							<div className="mt-4 flex items-center justify-end gap-2">
								<CopyButton
									value={exportedPath ?? ""}
									label={t("common.copyPath")}
								/>
								<Button size="sm" onClick={() => setExportedPath(null)}>
									{t("common.done")}
								</Button>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</PageContainer>
	);
}

function TurnWithItems({
	turn,
	items,
	level,
}: {
	turn: TurnSummary;
	items: DetailItem[];
	level: SessionDetailLevel;
}) {
	return <SessionTurn turn={turn} items={items} level={level} />;
}
