import {
	type BatchSessionExportResult,
	SESSION_DETAIL_LEVELS,
	type SessionDetailLevel,
} from "@shared/types";
import { useEffect, useState } from "react";
import { CopyButton } from "~/components/copy-button";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
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
	const [level, setLevel] = useState<SessionDetailLevel>(defaultDetailLevel);
	const [includeTimestamps, setIncludeTimestamps] = useState(true);
	const [includeTokenStats, setIncludeTokenStats] = useState(true);
	const [exporting, setExporting] = useState(false);
	const [result, setResult] = useState<BatchSessionExportResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setLevel(defaultDetailLevel);
		setResult(null);
		setError(null);
		setExporting(false);
	}, [open, defaultDetailLevel]);

	async function handleExport(): Promise<void> {
		if (sessionKeys.length === 0 || exporting) return;
		setExporting(true);
		setError(null);
		try {
			const exported = await api.exportSessionsBatch({
				keys: sessionKeys,
				level,
				includeTimestamps,
				includeTokenStats,
			});
			setResult(exported);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setExporting(false);
		}
	}

	const count = sessionKeys.length;
	const formattedCount = formatNumber(count);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
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
								{result.directory}
							</p>
						</div>
						{result.warnings.length > 0 ? (
							<div className="max-h-24 overflow-auto rounded-md bg-warning-surface px-2.5 py-2 text-[11px] text-warning">
								{result.warnings[0]}
							</div>
						) : null}
						<div className="flex items-center justify-end gap-2 pt-2">
							<CopyButton
								value={result.directory}
								label={t("common.copyPath")}
							/>
							<Button size="sm" onClick={() => onOpenChange(false)}>
								{t("common.done")}
							</Button>
						</div>
					</div>
				) : (
					<div className="space-y-4">
						<div className="flex items-center justify-between gap-4">
							<span className="text-[12px] text-muted-foreground">
								{t("sessions.exportDetailLevel")}
							</span>
							<Select
								value={level}
								onValueChange={(value) => setLevel(value as SessionDetailLevel)}
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
								{t("sessions.exportIncludeTimestamps")}
							</span>
							<Switch
								checked={includeTimestamps}
								onCheckedChange={setIncludeTimestamps}
								aria-label={t("sessions.exportIncludeTimestamps")}
							/>
						</div>

						<div className="flex items-center justify-between gap-4">
							<span className="text-[12px] text-muted-foreground">
								{t("sessions.exportIncludeTokenStats")}
							</span>
							<Switch
								checked={includeTokenStats}
								onCheckedChange={setIncludeTokenStats}
								aria-label={t("sessions.exportIncludeTokenStats")}
							/>
						</div>

						{error ? (
							<p className="text-[12px] text-destructive">{error}</p>
						) : null}

						<div className="flex items-center justify-end gap-2 pt-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => onOpenChange(false)}
								disabled={exporting}
							>
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
