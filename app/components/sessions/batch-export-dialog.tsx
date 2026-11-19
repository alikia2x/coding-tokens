import {
	type BatchExportOrganization,
	type BatchSessionExportResult,
	SESSION_DETAIL_LEVELS,
	type SessionDetailLevel,
} from "@shared/types";
import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { api } from "~/lib/api";
import { formatNumber } from "~/lib/format";
import { type TranslationKey, useT } from "~/lib/i18n";
import { useSettings } from "~/lib/settings";

const MAGIC_TOKENS = [
	"{harness}",
	"{project}",
	"{year}",
	"{month}",
	"{day}",
	"{date}",
	"{title}",
	"{id}",
] as const;

const ORGANIZATION_OPTIONS: Array<{
	value: BatchExportOrganization;
	labelKey: TranslationKey;
}> = [
	{ value: "flat", labelKey: "sessions.exportOrgFlat" },
	{ value: "harness", labelKey: "sessions.exportOrgHarness" },
	{ value: "date", labelKey: "sessions.exportOrgDate" },
	{ value: "project", labelKey: "sessions.exportOrgProject" },
	{ value: "custom", labelKey: "sessions.exportOrgCustom" },
];

export function BatchExportDialog({
	open,
	sessionKeys,
	defaultDetailLevel,
	onOpenChange,
}: {
	open: boolean;
	sessionKeys: string[];
	defaultDetailLevel: SessionDetailLevel;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const { settings, update: updateSettings } = useSettings();
	const [level, setLevel] = useState<SessionDetailLevel>(
		settings.batchExportDetailLevel ?? defaultDetailLevel,
	);
	const [includeTimestamps, setIncludeTimestamps] = useState(
		settings.batchExportIncludeTimestamps,
	);
	const [includeTokenStats, setIncludeTokenStats] = useState(
		settings.batchExportIncludeTokenStats,
	);
	const [asZip, setAsZip] = useState(settings.batchExportAsZip);
	const [organization, setOrganization] = useState<BatchExportOrganization>(
		settings.batchExportOrganization,
	);
	const [pathTemplate, setPathTemplate] = useState(
		settings.batchExportPathTemplate,
	);
	const [exporting, setExporting] = useState(false);
	const [progress, setProgress] = useState<{
		completed: number;
		total: number;
		currentTitle?: string;
	} | null>(null);
	const [result, setResult] = useState<BatchSessionExportResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const wasOpenRef = useRef(false);

	useEffect(() => {
		if (!open) {
			wasOpenRef.current = false;
			abortRef.current?.abort();
			abortRef.current = null;
			return;
		}
		if (!wasOpenRef.current) {
			wasOpenRef.current = true;
			setLevel(settings.batchExportDetailLevel ?? defaultDetailLevel);
			setIncludeTimestamps(settings.batchExportIncludeTimestamps);
			setIncludeTokenStats(settings.batchExportIncludeTokenStats);
			setAsZip(settings.batchExportAsZip);
			setOrganization(settings.batchExportOrganization);
			setPathTemplate(settings.batchExportPathTemplate);
			setResult(null);
			setError(null);
			setProgress(null);
			setExporting(false);
		}
	}, [
		open,
		defaultDetailLevel,
		settings.batchExportDetailLevel,
		settings.batchExportIncludeTimestamps,
		settings.batchExportIncludeTokenStats,
		settings.batchExportAsZip,
		settings.batchExportOrganization,
		settings.batchExportPathTemplate,
	]);

	function handleCancel(): void {
		abortRef.current?.abort();
		abortRef.current = null;
		setExporting(false);
		setProgress(null);
		onOpenChange(false);
	}

	async function handleExport(): Promise<void> {
		if (sessionKeys.length === 0 || exporting) return;
		setError(null);
		if (
			organization === "custom" &&
			pathTemplate !== settings.batchExportPathTemplate
		) {
			updateSettings({ batchExportPathTemplate: pathTemplate });
		}
		let chosenDirectory: string | undefined;
		let useBrowserDownload = false;
		try {
			const picked = await api.chooseExportDirectory();
			if (picked.supported) {
				if (picked.cancelled || !picked.path) return;
				chosenDirectory = picked.path;
			} else {
				useBrowserDownload = true;
			}
		} catch {
			// Fallback to default server directory if dialog API is unavailable
		}

		const controller = new AbortController();
		abortRef.current = controller;
		setExporting(true);
		setProgress({ completed: 0, total: sessionKeys.length });
		try {
			const exported = await api.exportSessionsBatchStream({
				keys: sessionKeys,
				level,
				includeTimestamps,
				includeTokenStats,
				directory: chosenDirectory,
				asZip,
				organization,
				pathTemplate: organization === "custom" ? pathTemplate : undefined,
				download: useBrowserDownload,
				signal: controller.signal,
				onProgress: (next) => setProgress(next),
			});
			setResult(exported);
			const revealTarget = exported.outputPath || exported.directory;
			if (!useBrowserDownload && revealTarget) {
				void api.revealPath(revealTarget).catch(() => {});
			}
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null;
			}
			setExporting(false);
		}
	}

	const count = sessionKeys.length;
	const formattedCount = formatNumber(count);
	const progressPercent =
		progress && progress.total > 0
			? Math.min(100, Math.round((progress.completed / progress.total) * 100))
			: 0;

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					handleCancel();
					return;
				}
				onOpenChange(nextOpen);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("sessions.batchExportTitle")}</DialogTitle>
					<DialogDescription>
						{t("sessions.exportFilteredCount", {
							count,
							formatted: formattedCount,
						})}
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<div className="space-y-3">
						<div className="text-[12px] font-medium">
							{t("sessions.exportSuccessCount", {
								count: result.filesWritten,
								formatted: formatNumber(result.filesWritten),
							})}
						</div>
						{result.skippedCount > 0 ? (
							<div className="text-[11px] text-muted-foreground">
								{t("sessions.exportSkippedCount", {
									count: result.skippedCount,
									formatted: formatNumber(result.skippedCount),
								})}
							</div>
						) : null}
						<div>
							<p className="text-[11px] text-muted-foreground">
								{t("common.savedTo")}
							</p>
							<p className="mt-1 break-all font-mono text-[11px]">
								{result.outputPath || result.filename}
							</p>
						</div>
						{result.warnings.length > 0 ? (
							<div className="max-h-24 overflow-auto rounded-md bg-warning-surface px-2.5 py-2 text-[11px] text-warning">
								{result.warnings[0]}
							</div>
						) : null}
						<div className="flex items-center justify-end gap-2 pt-2">
							{result.outputPath || result.directory ? (
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										void api
											.revealPath(result.outputPath || result.directory)
											.catch(() => {})
									}
								>
									<FolderOpen />
									{t("common.revealInFolder")}
								</Button>
							) : null}
							<Button size="sm" onClick={() => onOpenChange(false)}>
								{t("common.done")}
							</Button>
						</div>
					</div>
				) : (
					<div className="min-w-0 space-y-4">
						<div className="flex items-center justify-between gap-4">
							<span className="text-[12px] text-muted-foreground">
								{t("sessions.exportDetailLevel")}
							</span>
							<Select
								value={level}
								onValueChange={(value) => {
									const next = value as SessionDetailLevel;
									setLevel(next);
									updateSettings({ batchExportDetailLevel: next });
								}}
							>
								<SelectTrigger size="sm" className="w-[180px] text-[12px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									{SESSION_DETAIL_LEVELS.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{t(item.label as TranslationKey)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex items-center justify-between gap-4">
							<span className="text-[12px] text-muted-foreground">
								{t("sessions.exportOrganization")}
							</span>
							<Select
								value={organization}
								onValueChange={(value) => {
									const next = value as BatchExportOrganization;
									setOrganization(next);
									updateSettings({ batchExportOrganization: next });
								}}
							>
								<SelectTrigger size="sm" className="w-[180px] text-[12px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									{ORGANIZATION_OPTIONS.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{t(item.labelKey)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{organization === "custom" ? (
							<div className="space-y-2 rounded-md border bg-surface/40 p-3">
								<div className="text-[11px] font-medium text-muted-foreground">
									{t("sessions.exportPathTemplate")}
								</div>
								<Input
									value={pathTemplate}
									onChange={(event) => setPathTemplate(event.target.value)}
									onBlur={() => {
										if (pathTemplate !== settings.batchExportPathTemplate) {
											updateSettings({
												batchExportPathTemplate: pathTemplate,
											});
										}
									}}
									placeholder="{harness}/{year}/{month}/{title}-{id}.md"
									className="h-8 font-mono text-[11px]"
								/>
								<div className="flex flex-wrap items-center gap-1">
									<span className="mr-1 text-[10px] text-muted-foreground">
										{t("sessions.exportTemplateTokens")}:
									</span>
									{MAGIC_TOKENS.map((token) => (
										<button
											key={token}
											type="button"
											onClick={() => {
												const next =
													pathTemplate.endsWith("/") || !pathTemplate
														? `${pathTemplate}${token}`
														: `${pathTemplate}/${token}`;
												setPathTemplate(next);
												updateSettings({ batchExportPathTemplate: next });
											}}
											className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
										>
											{token}
										</button>
									))}
								</div>
							</div>
						) : null}

						<div className="flex items-center justify-between gap-4">
							<span className="text-[12px] text-muted-foreground">
								{t("sessions.exportIncludeTimestamps")}
							</span>
							<Switch
								checked={includeTimestamps}
								onCheckedChange={(checked) => {
									setIncludeTimestamps(checked);
									updateSettings({ batchExportIncludeTimestamps: checked });
								}}
								aria-label={t("sessions.exportIncludeTimestamps")}
							/>
						</div>

						<div className="flex items-center justify-between gap-4">
							<span className="text-[12px] text-muted-foreground">
								{t("sessions.exportIncludeTokenStats")}
							</span>
							<Switch
								checked={includeTokenStats}
								onCheckedChange={(checked) => {
									setIncludeTokenStats(checked);
									updateSettings({ batchExportIncludeTokenStats: checked });
								}}
								aria-label={t("sessions.exportIncludeTokenStats")}
							/>
						</div>

						<div className="flex items-center justify-between gap-4">
							<span className="text-[12px] text-muted-foreground">
								{t("sessions.exportAsZip")}
							</span>
							<Switch
								checked={asZip}
								onCheckedChange={(checked) => {
									setAsZip(checked);
									updateSettings({ batchExportAsZip: checked });
								}}
								aria-label={t("sessions.exportAsZip")}
							/>
						</div>

						{exporting && progress ? (
							<div className="min-w-0 space-y-1.5 pt-1">
								<div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
									<span className="min-w-0 flex-1 truncate">
										{progress.currentTitle || t("common.exporting")}
									</span>
									<span className="shrink-0 tabular">
										{formatNumber(progress.completed)} /{" "}
										{formatNumber(progress.total)} ({progressPercent}%)
									</span>
								</div>
								<div className="h-1.5 overflow-hidden rounded-full bg-muted">
									<div
										className="h-full bg-foreground transition-[width] duration-150"
										style={{ width: `${Math.max(4, progressPercent)}%` }}
									/>
								</div>
							</div>
						) : null}

						{error ? (
							<p className="text-[12px] text-destructive">{error}</p>
						) : null}

						<div className="flex items-center justify-end gap-2 pt-2">
							<Button variant="outline" size="sm" onClick={handleCancel}>
								{t("common.cancel")}
							</Button>
							<Button
								size="sm"
								disabled={count === 0 || exporting}
								onClick={() => void handleExport()}
							>
								{exporting
									? t("common.exporting")
									: t("sessions.exportStart", {
											count,
											formatted: formattedCount,
										})}
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
