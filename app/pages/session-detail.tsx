import type {
	DetailItem,
	SessionDetailLevel,
	TurnSummary,
} from "@shared/types";
import { ChevronLeft, Download, Search } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { CopyButton } from "~/components/copy-button";
import { DetailLevelControl } from "~/components/detail-level-control";
import { EmptyState } from "~/components/empty-state";
import { HarnessBadge } from "~/components/harness-badge";
import { PageContainer } from "~/components/page-container";
import { SessionFindBar } from "~/components/session-find-bar";
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
import { useSessionFind } from "~/lib/use-session-find";

function SessionRoleBadge({
	isReview,
	isSubagent,
}: {
	isReview: boolean;
	isSubagent: boolean;
}) {
	const t = useT();
	if (isReview) {
		return (
			<Badge variant="outline" className="rounded text-[9px]">
				{t("session.review")}
			</Badge>
		);
	}
	if (isSubagent) {
		return (
			<Badge variant="outline" className="rounded text-[9px]">
				{t("session.subagent")}
			</Badge>
		);
	}
	return null;
}

function ExportResultDialog({
	exportedPath,
	exportError,
	onClose,
}: {
	exportedPath: string | null;
	exportError: string | null;
	onClose: () => void;
}) {
	const t = useT();
	const open = Boolean(exportedPath || exportError);
	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) onClose();
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
							<Button size="sm" onClick={onClose}>
								{t("common.done")}
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

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

	const conversationRef = useRef<HTMLDivElement>(null);
	const contentVersion = detail.data
		? `${detail.data.items.length}:${detail.data.summary.lastActivityAt ?? 0}`
		: "";
	const find = useSessionFind({
		containerRef: conversationRef,
		contentVersion,
		searchParams,
		setSearchParams,
	});

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

	const untrackedTurn: TurnSummary = {
		id: "untracked",
		index: -1,
		startedAt: null,
		endedAt: null,
		requests: 0,
		totals: summary.totals,
		models: [],
	};

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
							<SessionRoleBadge
								isReview={summary.isReview}
								isSubagent={summary.isSubagent}
							/>
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							variant={find.open ? "secondary" : "outline"}
							size="sm"
							onClick={find.toggle}
							aria-pressed={find.open}
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
							<SessionTurn
								key={turn.id}
								turn={turn}
								items={itemsByTurn.get(turn.id) ?? []}
								level={level}
							/>
						))}
						{untracked ? (
							<SessionTurn
								turn={untrackedTurn}
								items={untracked}
								level={level}
							/>
						) : null}
					</div>
				)}
			</div>

			<SessionFindBar
				open={find.open}
				draftQuery={find.draftQuery}
				committedQuery={find.committedQuery}
				matchIndex={find.matchIndex}
				matchCount={find.matchCount}
				inputRef={find.inputRef}
				onDraftChange={find.setDraftQuery}
				onSubmit={find.submit}
				onStep={find.step}
				onClear={find.clear}
			/>

			<ExportResultDialog
				exportedPath={exportedPath}
				exportError={exportError}
				onClose={() => {
					setExportedPath(null);
					setExportError(null);
				}}
			/>
		</PageContainer>
	);
}
