import type {
	CustomModelPriceRule,
	ModelReportRow,
	PricingCatalogSearchItem,
	TokenRates,
} from "@shared/types";
import { cn } from "cn";
import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { formatCost } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import {
	useDeletePricingRule,
	useSearchPricingCatalog,
	useUpsertPricingRule,
} from "~/lib/queries";
import {
	estimateRowCostFromRates,
	formatRatePair,
	formatUnitRate,
} from "./pricing-format";

type EditorMode = "auto" | "alias" | "rates";

function parseNonNeg(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rateToInput(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "";
	return String(value);
}

export function ModelPricingDialog({
	open,
	onOpenChange,
	row,
	initialRule = null,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	row: ModelReportRow | null;
	initialRule?: CustomModelPriceRule | null;
}) {
	const t = useT();
	const upsertRule = useUpsertPricingRule();
	const deleteRule = useDeletePricingRule();

	const existingRule = row?.pricing?.customRule ?? initialRule ?? null;
	const isNewRule = !row && !initialRule;

	const [modelName, setModelName] = useState("");
	const [mode, setMode] = useState<EditorMode>("auto");
	const [inputStr, setInputStr] = useState("");
	const [outputStr, setOutputStr] = useState("");
	const [cacheReadStr, setCacheReadStr] = useState("");
	const [cacheWriteStr, setCacheWriteStr] = useState("");
	const [reasoningStr, setReasoningStr] = useState("");
	const [aliasTarget, setAliasTarget] = useState("");
	const [overrideRecorded, setOverrideRecorded] = useState(false);
	const [catalogQuery, setCatalogQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [selectedAliasItem, setSelectedAliasItem] =
		useState<PricingCatalogSearchItem | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const timer = window.setTimeout(() => setDebouncedQuery(catalogQuery), 160);
		return () => window.clearTimeout(timer);
	}, [catalogQuery]);

	useEffect(() => {
		if (!open) return;
		const rule = row?.pricing?.customRule ?? initialRule ?? null;
		setModelName(row?.model ?? rule?.model ?? "");
		setMode(rule ? rule.mode : row ? "auto" : "rates");
		setInputStr(rule?.mode === "rates" ? rateToInput(rule.rates?.input) : "");
		setOutputStr(rule?.mode === "rates" ? rateToInput(rule.rates?.output) : "");
		setCacheReadStr(
			rule?.mode === "rates" ? rateToInput(rule.rates?.cacheRead) : "",
		);
		setCacheWriteStr(
			rule?.mode === "rates" ? rateToInput(rule.rates?.cacheWrite) : "",
		);
		setReasoningStr(
			rule?.mode === "rates" ? rateToInput(rule.rates?.reasoning) : "",
		);
		setAliasTarget(rule?.mode === "alias" ? (rule.aliasTarget ?? "") : "");
		setOverrideRecorded(rule?.overrideRecorded ?? false);
		setCatalogQuery("");
		setDebouncedQuery("");
		setSelectedAliasItem(null);
		setError(null);
	}, [open, row, initialRule]);

	const catalogSearch = useSearchPricingCatalog(
		debouncedQuery,
		open && mode === "alias",
	);

	const parsedRates = useMemo<TokenRates | null>(() => {
		if (mode !== "rates") return null;
		const input = parseNonNeg(inputStr);
		const output = parseNonNeg(outputStr);
		if (input === null || output === null) return null;
		const cacheRead = cacheReadStr.trim() ? parseNonNeg(cacheReadStr) : null;
		const cacheWrite = cacheWriteStr.trim() ? parseNonNeg(cacheWriteStr) : null;
		const reasoning = reasoningStr.trim() ? parseNonNeg(reasoningStr) : null;
		if (cacheReadStr.trim() && cacheRead === null) return null;
		if (cacheWriteStr.trim() && cacheWrite === null) return null;
		if (reasoningStr.trim() && reasoning === null) return null;
		return { input, output, cacheRead, cacheWrite, reasoning };
	}, [mode, inputStr, outputStr, cacheReadStr, cacheWriteStr, reasoningStr]);

	const previewRates = useMemo<TokenRates | null>(() => {
		if (mode === "rates") return parsedRates;
		if (mode === "alias") {
			if (selectedAliasItem?.rates) return selectedAliasItem.rates;
			const matched = catalogSearch.data?.items.find(
				(item) => item.key === aliasTarget,
			);
			if (matched?.rates) return matched.rates;
			if (
				row?.pricing?.source === "custom_alias" &&
				row.pricing.customRule?.aliasTarget === aliasTarget
			) {
				return row.pricing.effectiveRates;
			}
		}
		if (mode === "auto") {
			return row?.pricing?.catalogRates ?? null;
		}
		return null;
	}, [
		mode,
		parsedRates,
		selectedAliasItem,
		catalogSearch.data,
		aliasTarget,
		row,
	]);

	const previewCost = useMemo(() => {
		if (!row || !previewRates) return null;
		if (!overrideRecorded && (row.pricing?.recordedRequests ?? 0) > 0) {
			return null;
		}
		return estimateRowCostFromRates(row.totals, previewRates);
	}, [row, previewRates, overrideRecorded]);

	const canSave = useMemo(() => {
		const trimmedName = modelName.trim();
		if (!trimmedName) return false;
		if (mode === "auto") return true;
		if (mode === "alias") return aliasTarget.trim().length > 0;
		return parsedRates !== null;
	}, [modelName, mode, aliasTarget, parsedRates]);

	function handleCopyCatalog(): void {
		const rates = row?.pricing?.catalogRates ?? row?.pricing?.effectiveRates;
		if (!rates) return;
		setInputStr(String(rates.input));
		setOutputStr(String(rates.output));
		setCacheReadStr(rateToInput(rates.cacheRead));
		setCacheWriteStr(rateToInput(rates.cacheWrite));
		setReasoningStr(rateToInput(rates.reasoning));
	}

	function handleMarkFree(): void {
		setInputStr("0");
		setOutputStr("0");
		setCacheReadStr("0");
		setCacheWriteStr("0");
		setReasoningStr("0");
	}

	async function handleSave(): Promise<void> {
		setError(null);
		const trimmedName = modelName.trim();
		if (!trimmedName) return;
		try {
			if (mode === "auto") {
				if (existingRule) {
					await deleteRule.mutateAsync(existingRule.model);
				}
				onOpenChange(false);
				return;
			}
			if (mode === "alias") {
				await upsertRule.mutateAsync({
					model: trimmedName,
					mode: "alias",
					aliasTarget: aliasTarget.trim(),
					overrideRecorded,
				});
				onOpenChange(false);
				return;
			}
			if (!parsedRates) return;
			await upsertRule.mutateAsync({
				model: trimmedName,
				mode: "rates",
				rates: parsedRates,
				overrideRecorded,
			});
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleResetAuto(): Promise<void> {
		if (!existingRule) return;
		setError(null);
		try {
			await deleteRule.mutateAsync(existingRule.model);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	const pricing = row?.pricing;
	const distinctRawIds = (pricing?.rawModelIds ?? []).filter(
		(id) => id && id !== row?.model,
	);
	const busy = upsertRule.isPending || deleteRule.isPending;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[468px]">
				<DialogHeader>
					<DialogTitle className="text-[15px]">
						{isNewRule
							? t("pricing.editor.addTitle")
							: localizeLabel(t, row?.model ?? initialRule?.model ?? "")}
					</DialogTitle>
					{row?.provider ? (
						<DialogDescription className="text-[12px]">
							{row.provider}
						</DialogDescription>
					) : null}
				</DialogHeader>

				{row && pricing ? (
					<div className="space-y-2 rounded-md border bg-muted/40 p-3 text-[11px]">
						{distinctRawIds.length > 0 ? (
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="text-muted-foreground">
									{t("pricing.editor.rawIds")}
								</span>
								<div className="flex flex-wrap justify-end gap-1">
									{distinctRawIds.slice(0, 4).map((rawId) => (
										<code
											key={rawId}
											className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px]"
										>
											{rawId}
										</code>
									))}
								</div>
							</div>
						) : null}
						<div className="flex items-center justify-between gap-2">
							<span className="text-muted-foreground">
								{t("pricing.editor.catalogMatch")}
							</span>
							{pricing.matchedCatalogId ? (
								<span className="truncate font-mono text-[10px]">
									{pricing.matchedCatalogId}
								</span>
							) : (
								<span className="text-muted-foreground">
									{t("pricing.editor.noCatalogMatch")}
								</span>
							)}
						</div>
						{pricing.effectiveRates ? (
							<div className="border-t pt-2">
								<div className="mb-1 text-[10px] text-muted-foreground">
									{t("pricing.editor.effectiveRates")}
								</div>
								<div className="grid grid-cols-5 gap-1 font-mono text-[10px] tabular">
									<div>
										<div className="text-muted-foreground">In</div>
										<div>{formatUnitRate(pricing.effectiveRates.input)}</div>
									</div>
									<div>
										<div className="text-muted-foreground">Out</div>
										<div>{formatUnitRate(pricing.effectiveRates.output)}</div>
									</div>
									<div>
										<div className="text-muted-foreground">Cache R</div>
										<div>
											{formatUnitRate(
												pricing.effectiveRates.cacheRead ??
													pricing.effectiveRates.input,
											)}
										</div>
									</div>
									<div>
										<div className="text-muted-foreground">Cache W</div>
										<div>
											{formatUnitRate(
												pricing.effectiveRates.cacheWrite ??
													pricing.effectiveRates.input,
											)}
										</div>
									</div>
									<div>
										<div className="text-muted-foreground">Reason</div>
										<div>
											{formatUnitRate(
												pricing.effectiveRates.reasoning ??
													pricing.effectiveRates.output,
											)}
										</div>
									</div>
								</div>
							</div>
						) : null}
					</div>
				) : null}

				{isNewRule ? (
					<div className="space-y-1.5">
						<Label htmlFor="pricing-model-name" className="text-[12px]">
							{t("pricing.editor.modelName")}
						</Label>
						<Input
							id="pricing-model-name"
							value={modelName}
							onChange={(event) => setModelName(event.target.value)}
							placeholder={t("pricing.editor.modelPlaceholder")}
							className="h-8 text-[12px]"
						/>
					</div>
				) : null}

				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={mode}
					onValueChange={(value) => {
						if (!value) return;
						setMode(value as EditorMode);
					}}
					className="w-full"
				>
					{row ? (
						<ToggleGroupItem value="auto" className="flex-1 text-[11px]">
							{t("pricing.editor.modeAuto")}
						</ToggleGroupItem>
					) : null}
					<ToggleGroupItem value="alias" className="flex-1 text-[11px]">
						{t("pricing.editor.modeAlias")}
					</ToggleGroupItem>
					<ToggleGroupItem value="rates" className="flex-1 text-[11px]">
						{t("pricing.editor.modeCustom")}
					</ToggleGroupItem>
				</ToggleGroup>

				{mode === "auto" ? (
					<p className="rounded-md border px-3 py-2.5 text-[11px] text-muted-foreground">
						{t("pricing.editor.autoDescription")}
					</p>
				) : null}

				{mode === "alias" ? (
					<div className="space-y-2">
						<div className="relative">
							<Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
							<Input
								value={catalogQuery}
								onChange={(event) => setCatalogQuery(event.target.value)}
								placeholder={t("pricing.editor.searchCatalog")}
								className="h-8 pl-8 text-[12px]"
							/>
						</div>
						{aliasTarget ? (
							<div className="flex items-center justify-between rounded-md border bg-muted/40 px-2.5 py-1.5 text-[11px]">
								<span className="text-muted-foreground">
									{t("pricing.editor.selectedAlias")}
								</span>
								<code className="font-mono text-[11px]">{aliasTarget}</code>
							</div>
						) : null}
						<div className="max-h-44 divide-y overflow-y-auto rounded-md border">
							{(catalogSearch.data?.items ?? []).map((item) => {
								const selected = aliasTarget === item.key;
								return (
									<button
										key={item.key}
										type="button"
										onClick={() => {
											setAliasTarget(item.key);
											setSelectedAliasItem(item);
										}}
										className={cn(
											"flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] transition-colors hover:bg-hover",
											selected && "bg-accent",
										)}
									>
										<span className="min-w-0">
											<span className="flex items-center gap-1.5 font-medium">
												{selected ? (
													<Check className="size-3 shrink-0" />
												) : null}
												<span className="truncate">{item.name}</span>
											</span>
											<span className="block truncate font-mono text-[10px] text-muted-foreground">
												{item.key}
											</span>
										</span>
										<span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular">
											{formatRatePair(item.rates) ?? "—"}
										</span>
									</button>
								);
							})}
							{!catalogSearch.isLoading &&
							(catalogSearch.data?.items.length ?? 0) === 0 ? (
								<p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
									{t("pricing.editor.noCatalogResults")}
								</p>
							) : null}
						</div>
					</div>
				) : null}

				{mode === "rates" ? (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="xs"
								onClick={handleMarkFree}
							>
								{t("pricing.editor.markFree")}
							</Button>
							{row?.pricing?.catalogRates || row?.pricing?.effectiveRates ? (
								<Button
									type="button"
									variant="outline"
									size="xs"
									onClick={handleCopyCatalog}
								>
									{t("pricing.editor.copyCatalog")}
								</Button>
							) : null}
						</div>

						<div className="grid grid-cols-2 gap-2.5">
							<div className="space-y-1">
								<Label htmlFor="rate-input" className="text-[11px]">
									{t("pricing.editor.inputRate")}
								</Label>
								<Input
									id="rate-input"
									type="number"
									min="0"
									step="any"
									value={inputStr}
									onChange={(event) => setInputStr(event.target.value)}
									placeholder="0.00"
									className="h-8 font-mono text-[12px] tabular"
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="rate-output" className="text-[11px]">
									{t("pricing.editor.outputRate")}
								</Label>
								<Input
									id="rate-output"
									type="number"
									min="0"
									step="any"
									value={outputStr}
									onChange={(event) => setOutputStr(event.target.value)}
									placeholder="0.00"
									className="h-8 font-mono text-[12px] tabular"
								/>
							</div>
						</div>

						<div className="grid grid-cols-3 gap-2">
							<div className="space-y-1">
								<Label
									htmlFor="rate-cache-read"
									className="text-[11px] text-muted-foreground"
								>
									{t("pricing.editor.cacheReadRate")}
								</Label>
								<Input
									id="rate-cache-read"
									type="number"
									min="0"
									step="any"
									value={cacheReadStr}
									onChange={(event) => setCacheReadStr(event.target.value)}
									placeholder={t("pricing.editor.sameAsInput")}
									className="h-7 font-mono text-[11px] tabular"
								/>
							</div>
							<div className="space-y-1">
								<Label
									htmlFor="rate-cache-write"
									className="text-[11px] text-muted-foreground"
								>
									{t("pricing.editor.cacheWriteRate")}
								</Label>
								<Input
									id="rate-cache-write"
									type="number"
									min="0"
									step="any"
									value={cacheWriteStr}
									onChange={(event) => setCacheWriteStr(event.target.value)}
									placeholder={t("pricing.editor.sameAsInput")}
									className="h-7 font-mono text-[11px] tabular"
								/>
							</div>
							<div className="space-y-1">
								<Label
									htmlFor="rate-reasoning"
									className="text-[11px] text-muted-foreground"
								>
									{t("pricing.editor.reasoningRate")}
								</Label>
								<Input
									id="rate-reasoning"
									type="number"
									min="0"
									step="any"
									value={reasoningStr}
									onChange={(event) => setReasoningStr(event.target.value)}
									placeholder={t("pricing.editor.sameAsOutput")}
									className="h-7 font-mono text-[11px] tabular"
								/>
							</div>
						</div>
					</div>
				) : null}

				{mode !== "auto" &&
				(isNewRule ||
					(pricing?.recordedRequests ?? 0) > 0 ||
					Boolean(existingRule?.overrideRecorded)) ? (
					<div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2.5">
						<div className="space-y-0.5">
							<Label htmlFor="override-recorded" className="text-[12px]">
								{t("pricing.editor.overrideRecorded")}
							</Label>
							<p className="text-[11px] text-muted-foreground">
								{t("pricing.editor.overrideHelper")}
							</p>
						</div>
						<Switch
							id="override-recorded"
							checked={overrideRecorded}
							onCheckedChange={setOverrideRecorded}
						/>
					</div>
				) : null}

				{previewCost !== null && row ? (
					<div className="flex items-center justify-between text-[11px] text-muted-foreground tabular">
						<span>{t("pricing.editor.preview")}</span>
						<span>
							{formatCost(row.totals.costUsd, true)} →{" "}
							<strong className="font-medium text-foreground">
								{formatCost(previewCost, true)}
							</strong>
						</span>
					</div>
				) : null}

				{error ? <p className="text-[11px] text-destructive">{error}</p> : null}

				<DialogFooter className="sm:justify-between">
					<div>
						{existingRule ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={handleResetAuto}
							>
								{t("pricing.editor.resetAuto")}
							</Button>
						) : null}
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => onOpenChange(false)}
						>
							{t("common.cancel")}
						</Button>
						<Button
							type="button"
							size="sm"
							disabled={!canSave || busy}
							onClick={handleSave}
						>
							{t("pricing.editor.save")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
