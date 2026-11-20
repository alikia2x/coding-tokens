import type { CustomModelPriceRule, ModelReportRow } from "@shared/types";
import { cn } from "cn";
import {
	Download,
	FolderOpen,
	Pencil,
	Plus,
	RotateCw,
	Trash2,
	Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { api, triggerBlobDownload } from "~/lib/api";
import { formatDateTime, formatNumber, formatRelativeTime } from "~/lib/format";
import { useT } from "~/lib/i18n";
import {
	useDeletePricingRule,
	useImportPricingRules,
	usePricing,
	useRefreshPricing,
	useUpdatePricingSettings,
} from "~/lib/queries";
import { ModelPricingDialog } from "./model-pricing-dialog";
import { formatRatePair, isFreeRates } from "./pricing-format";

const DEFAULT_CATALOG_URL = "https://models.dev/api.json";

const TTL_OPTIONS = [6, 12, 24, 72, 168] as const;

export function PricingCatalogDialog({
	open,
	onOpenChange,
	activeRows = [],
	initialTab = "rules",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	activeRows?: ModelReportRow[];
	initialTab?: "rules" | "source";
}) {
	const t = useT();
	const pricing = usePricing();
	const refreshPricing = useRefreshPricing();
	const updateSettings = useUpdatePricingSettings();
	const importRules = useImportPricingRules();
	const deleteRule = useDeletePricingRule();

	const [tab, setTab] = useState<"rules" | "source">(initialTab);
	const [autoFetch, setAutoFetch] = useState(true);
	const [endpoint, setEndpoint] = useState(DEFAULT_CATALOG_URL);
	const [cacheTtlHours, setCacheTtlHours] = useState("24");
	const [sourceError, setSourceError] = useState<string | null>(null);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [rulesNotice, setRulesNotice] = useState<string | null>(null);
	const [rulesError, setRulesError] = useState<string | null>(null);

	const [editorOpen, setEditorOpen] = useState(false);
	const [editingRow, setEditingRow] = useState<ModelReportRow | null>(null);
	const [editingRule, setEditingRule] = useState<CustomModelPriceRule | null>(
		null,
	);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const wasOpenRef = useRef(false);
	const initializedSettingsRef = useRef(false);

	const status = pricing.data?.status;
	const settings = pricing.data?.settings;

	useEffect(() => {
		if (!open) {
			wasOpenRef.current = false;
			initializedSettingsRef.current = false;
			return;
		}
		if (!wasOpenRef.current) {
			wasOpenRef.current = true;
			setTab(initialTab);
			setSourceError(null);
			setRefreshError(null);
			setRulesNotice(null);
			setRulesError(null);
		}
		if (settings && !initializedSettingsRef.current) {
			initializedSettingsRef.current = true;
			setAutoFetch(settings.autoFetch);
			setEndpoint(settings.endpoint);
			setCacheTtlHours(String(settings.cacheTtlHours));
		}
	}, [open, initialTab, settings]);

	const customRuleList = useMemo(() => {
		const map = settings?.customRules ?? {};
		return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
	}, [settings]);

	async function handleRefreshCatalog(): Promise<void> {
		setRefreshError(null);
		try {
			await refreshPricing.mutateAsync();
		} catch (err) {
			setRefreshError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleDeleteRule(model: string): Promise<void> {
		setRulesError(null);
		try {
			await deleteRule.mutateAsync(model);
		} catch (err) {
			setRulesError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleSaveSource(andRefresh: boolean): Promise<void> {
		setSourceError(null);
		const trimmed = endpoint.trim();
		if (!/^https?:\/\//iu.test(trimmed)) {
			setSourceError(t("pricing.error.invalidEndpoint"));
			return;
		}
		try {
			await updateSettings.mutateAsync({
				autoFetch,
				endpoint: trimmed,
				cacheTtlHours: Number(cacheTtlHours),
			});
			if (andRefresh) {
				await refreshPricing.mutateAsync();
			}
		} catch (err) {
			setSourceError(err instanceof Error ? err.message : String(err));
		}
	}

	function handleExportRules(): void {
		if (!settings) return;
		const blob = new Blob([JSON.stringify(settings.customRules, null, 2)], {
			type: "application/json",
		});
		triggerBlobDownload(blob, "coding-tokens-model-prices.json");
	}

	async function handleImportFile(
		event: React.ChangeEvent<HTMLInputElement>,
	): Promise<void> {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		setRulesError(null);
		setRulesNotice(null);
		try {
			const text = await file.text();
			const parsed = JSON.parse(text) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(t("pricing.error.invalidRulesJson"));
			}
			const record = parsed as Record<string, CustomModelPriceRule>;
			await importRules.mutateAsync({ rules: record, replace: false });
			setRulesNotice(
				t("pricing.rules.imported", { count: Object.keys(record).length }),
			);
		} catch (err) {
			setRulesError(
				err instanceof Error ? err.message : t("pricing.rules.importError"),
			);
		}
	}

	function openEditRule(rule: CustomModelPriceRule): void {
		const matchedRow =
			activeRows.find(
				(r) => r.model.toLowerCase() === rule.model.toLowerCase(),
			) ?? null;
		setEditingRow(matchedRow);
		setEditingRule(rule);
		setEditorOpen(true);
	}

	function openAddRule(): void {
		setEditingRow(null);
		setEditingRule(null);
		setEditorOpen(true);
	}

	const unpricedModels = status?.summary.unpricedModels ?? 0;

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-[520px]">
					<DialogHeader>
						<DialogTitle className="text-[15px]">
							{t("pricing.title")}
						</DialogTitle>
					</DialogHeader>

					<div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2 text-[12px]">
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										status?.lastError || status?.state === "missing"
											? "bg-destructive"
											: status?.state === "offline"
												? "bg-muted-foreground/60"
												: status?.state === "stale"
													? "bg-warning"
													: "bg-success",
									)}
								/>
								<span className="font-medium text-foreground">
									{status?.lastError
										? t("pricing.pillSyncFailed")
										: status?.state === "offline"
											? t("pricing.status.offline")
											: !status ||
													status.state === "missing" ||
													status.modelCount === 0
												? t("pricing.pillMissing")
												: "models.dev"}
								</span>
								{unpricedModels > 0 ? (
									<span className="rounded-full bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning tabular">
										{t("models.unpricedCount", {
											formatted: formatNumber(unpricedModels),
										})}
									</span>
								) : null}
							</div>
							{status?.lastError ? (
								<div
									className="mt-0.5 truncate text-[11px] text-destructive"
									title={status.lastError}
								>
									{status.lastError}
								</div>
							) : status?.fetchedAt ? (
								<div
									className="mt-0.5 truncate text-[11px] text-muted-foreground tabular"
									title={formatDateTime(status.fetchedAt)}
								>
									{t("pricing.updatedAgo", {
										time: formatRelativeTime(status.fetchedAt),
									})}
								</div>
							) : null}
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={refreshPricing.isPending || status?.fetching}
							onClick={() => void handleRefreshCatalog()}
						>
							<RotateCw
								className={
									refreshPricing.isPending || status?.fetching
										? "animate-spin"
										: undefined
								}
							/>
							{refreshPricing.isPending || status?.fetching
								? t("pricing.refreshing")
								: t("pricing.refreshNow")}
						</Button>
					</div>
					{refreshError ? (
						<p className="text-[11px] text-destructive">{refreshError}</p>
					) : null}

					<Tabs
						value={tab}
						onValueChange={(value) => setTab(value as "rules" | "source")}
					>
						<TabsList className="grid w-full grid-cols-2">
							<TabsTrigger value="rules" className="text-[12px]">
								{t("pricing.tab.rules")}
								{customRuleList.length > 0 ? (
									<span className="ml-1 rounded-full bg-background/80 px-1.5 text-[10px] tabular">
										{customRuleList.length}
									</span>
								) : null}
							</TabsTrigger>
							<TabsTrigger value="source" className="text-[12px]">
								{t("pricing.tab.source")}
							</TabsTrigger>
						</TabsList>

						<TabsContent value="rules" className="mt-3 space-y-3">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={openAddRule}
								>
									<Plus className="size-3.5" />
									{t("pricing.rules.add")}
								</Button>
								<div className="flex items-center gap-1.5">
									<input
										ref={fileInputRef}
										type="file"
										accept=".json,application/json"
										onChange={handleImportFile}
										className="hidden"
									/>
									<Button
										type="button"
										size="xs"
										variant="ghost"
										disabled={importRules.isPending}
										onClick={() => fileInputRef.current?.click()}
									>
										<Upload className="size-3" />
										{t("pricing.rules.importJson")}
									</Button>
									<Button
										type="button"
										size="xs"
										variant="ghost"
										disabled={customRuleList.length === 0}
										onClick={handleExportRules}
									>
										<Download className="size-3" />
										{t("pricing.rules.exportJson")}
									</Button>
								</div>
							</div>

							{rulesNotice ? (
								<p className="text-[11px] text-success">{rulesNotice}</p>
							) : null}
							{rulesError ? (
								<p className="text-[11px] text-destructive">{rulesError}</p>
							) : null}

							<ScrollArea
								className="max-h-72 rounded-md border"
								overflow="y"
								contentClassName="divide-y"
							>
								{customRuleList.length === 0 ? (
									<p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
										{t("pricing.rules.empty")}
									</p>
								) : (
									customRuleList.map((rule) => (
										<div
											key={rule.model}
											className="flex items-center justify-between gap-3 py-2.5 pl-3 pr-4 text-[12px]"
										>
											<div className="min-w-0">
												<div className="flex items-center gap-2">
													<span className="truncate font-medium">
														{rule.model}
													</span>
													{rule.overrideRecorded ? (
														<Badge
															variant="secondary"
															className="h-4 px-1.5 text-[10px]"
														>
															{t("pricing.rules.override")}
														</Badge>
													) : null}
												</div>
												<div className="mt-0.5 truncate text-[11px] text-muted-foreground tabular">
													{rule.mode === "alias"
														? t("pricing.rules.mappedTo", {
																target: rule.aliasTarget ?? "",
															})
														: isFreeRates(rule.rates)
															? `${t("models.free")} ($0)`
															: `${formatRatePair(rule.rates) ?? "—"} / 1M`}
												</div>
											</div>
											<div className="flex shrink-0 items-center gap-1">
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													aria-label={`${t("common.edit")} ${rule.model}`}
													onClick={() => openEditRule(rule)}
												>
													<Pencil className="size-3.5" />
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													aria-label={`${t("common.delete")} ${rule.model}`}
													disabled={deleteRule.isPending}
													onClick={() => void handleDeleteRule(rule.model)}
												>
													<Trash2 className="size-3.5 text-muted-foreground" />
												</Button>
											</div>
										</div>
									))
								)}
							</ScrollArea>
						</TabsContent>

						<TabsContent value="source" className="mt-3 space-y-3">
							<div className="divide-y rounded-md border">
								<div className="flex items-center justify-between gap-4 px-3 py-2.5">
									<Label
										htmlFor="pricing-auto-fetch"
										className="text-[12px] font-normal text-muted-foreground"
									>
										{t("pricing.source.autoFetch")}
									</Label>
									<Switch
										id="pricing-auto-fetch"
										checked={autoFetch}
										onCheckedChange={setAutoFetch}
									/>
								</div>
								<div className="space-y-1.5 px-3 py-2.5">
									<div className="flex items-center justify-between gap-2">
										<Label
											htmlFor="pricing-endpoint"
											className="text-[12px] font-normal text-muted-foreground"
										>
											{t("pricing.source.endpoint")}
										</Label>
										{endpoint !== DEFAULT_CATALOG_URL ? (
											<button
												type="button"
												onClick={() => setEndpoint(DEFAULT_CATALOG_URL)}
												className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
											>
												{t("pricing.source.resetUrl")}
											</button>
										) : null}
									</div>
									<Input
										id="pricing-endpoint"
										value={endpoint}
										onChange={(event) => setEndpoint(event.target.value)}
										className="h-8 font-mono text-[11px]"
									/>
								</div>
								<div className="flex items-center justify-between gap-4 px-3 py-2.5">
									<Label
										htmlFor="pricing-cache-ttl"
										className="text-[12px] font-normal text-muted-foreground"
									>
										{t("pricing.source.cacheTtl")}
									</Label>
									<Select
										value={cacheTtlHours}
										onValueChange={setCacheTtlHours}
									>
										<SelectTrigger
											id="pricing-cache-ttl"
											size="sm"
											className="w-[140px] text-[12px]"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											{TTL_OPTIONS.map((hours) => (
												<SelectItem key={hours} value={String(hours)}>
													{hours >= 24 && hours % 24 === 0
														? t("pricing.source.daysCount", {
																count: hours / 24,
															})
														: t("pricing.source.hoursCount", { count: hours })}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								{status?.cachePath ? (
									<div className="flex items-center justify-between gap-4 px-3 py-2">
										<span className="text-[12px] text-muted-foreground">
											{t("pricing.cachePath")}
										</span>
										<Button
											type="button"
											variant="ghost"
											size="xs"
											title={status.cachePath}
											onClick={() =>
												void api.revealPath(status.cachePath).catch(() => {})
											}
										>
											<FolderOpen className="size-3.5" />
											{t("pricing.openCacheFolder")}
										</Button>
									</div>
								) : null}
							</div>

							{sourceError ? (
								<p className="text-[11px] text-destructive">{sourceError}</p>
							) : null}

							<div className="flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={
										updateSettings.isPending || refreshPricing.isPending
									}
									onClick={() => void handleSaveSource(false)}
								>
									{t("pricing.source.save")}
								</Button>
								<Button
									type="button"
									size="sm"
									disabled={
										updateSettings.isPending || refreshPricing.isPending
									}
									onClick={() => void handleSaveSource(true)}
								>
									{t("pricing.source.saveAndRefresh")}
								</Button>
							</div>
						</TabsContent>
					</Tabs>
				</DialogContent>
			</Dialog>

			<ModelPricingDialog
				open={editorOpen}
				onOpenChange={setEditorOpen}
				row={editingRow}
				initialRule={editingRule}
			/>
		</>
	);
}
