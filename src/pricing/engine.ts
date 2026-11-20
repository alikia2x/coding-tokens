import type { StoreDatabase } from "../../server/data/database";
import { readSetting, writeSetting } from "../../server/data/database";
import { normalizeModelName } from "../../shared/models";
import {
	type CustomModelPriceRule,
	DEFAULT_PRICING_SETTINGS,
	type HarnessName,
	type ModelPricingMeta,
	type ModelPricingSource,
	type PricingCatalogSearchItem,
	type PricingCatalogStatus,
	type PricingCatalogSummary,
	type PricingFetchAttempt,
	type PricingSettings,
	type TokenRates,
	type UsageRecord,
} from "../../shared/types";
import {
	type Catalog,
	type CatalogEntry,
	catalogStats,
	DEFAULT_MODELS_DEV_ENDPOINT,
	estimateTokensCost,
	fetchAndCacheCatalog,
	getModelsDevCachePath,
	hasPositiveRates,
	loadCachedCatalogWithMeta,
	lookupFallbackRates,
	resolveModel,
} from "./modelsdev";

const PRICING_SETTINGS_KEY = "pricing_settings";
const PRICING_HISTORY_KEY = "pricing_fetch_history";
const MAX_FETCH_HISTORY = 10;
const AUTO_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export function normalizeRuleKey(name: string): string {
	return name.trim().toLowerCase();
}

export function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function finiteNonNegative(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function sanitizeTokenRates(raw: unknown): TokenRates | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const input = finiteNonNegative(obj.input);
	const output = finiteNonNegative(obj.output);
	if (input === null || output === null) return undefined;
	return {
		input,
		output,
		cacheRead: finiteNonNegative(obj.cacheRead),
		cacheWrite: finiteNonNegative(obj.cacheWrite),
		reasoning: finiteNonNegative(obj.reasoning),
	};
}

export function sanitizeCustomRule(
	fallbackKey: string,
	raw: unknown,
): CustomModelPriceRule | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const model =
		typeof obj.model === "string" && obj.model.trim()
			? obj.model.trim()
			: fallbackKey.trim();
	if (!model) return null;
	const mode = obj.mode === "alias" ? "alias" : "rates";
	const overrideRecorded = Boolean(obj.overrideRecorded);
	const note =
		typeof obj.note === "string" && obj.note.trim()
			? obj.note.trim()
			: undefined;
	const updatedAt =
		typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt)
			? obj.updatedAt
			: Date.now();
	if (mode === "rates") {
		const rates = sanitizeTokenRates(obj.rates);
		if (!rates) return null;
		return {
			model,
			mode,
			rates,
			overrideRecorded,
			...(note ? { note } : {}),
			updatedAt,
		};
	}
	const aliasTarget =
		typeof obj.aliasTarget === "string" ? obj.aliasTarget.trim() : "";
	if (!aliasTarget) return null;
	return {
		model,
		mode,
		aliasTarget,
		overrideRecorded,
		...(note ? { note } : {}),
		updatedAt,
	};
}

export function normalizePricingSettings(raw: unknown): PricingSettings {
	if (!raw || typeof raw !== "object") {
		return { ...DEFAULT_PRICING_SETTINGS, customRules: {} };
	}
	const obj = raw as Record<string, unknown>;
	const autoFetch =
		typeof obj.autoFetch === "boolean"
			? obj.autoFetch
			: DEFAULT_PRICING_SETTINGS.autoFetch;
	const endpoint =
		typeof obj.endpoint === "string" && isValidHttpUrl(obj.endpoint)
			? obj.endpoint.trim()
			: DEFAULT_MODELS_DEV_ENDPOINT;
	const rawTtl =
		typeof obj.cacheTtlHours === "number"
			? obj.cacheTtlHours
			: Number(obj.cacheTtlHours);
	const cacheTtlHours =
		Number.isFinite(rawTtl) && rawTtl >= 1
			? Math.min(720, Math.round(rawTtl))
			: DEFAULT_PRICING_SETTINGS.cacheTtlHours;
	const customRules: Record<string, CustomModelPriceRule> = {};
	if (obj.customRules && typeof obj.customRules === "object") {
		for (const [key, value] of Object.entries(
			obj.customRules as Record<string, unknown>,
		)) {
			const clean = sanitizeCustomRule(key, value);
			if (!clean) continue;
			customRules[normalizeRuleKey(clean.model)] = clean;
		}
	}
	return {
		autoFetch,
		endpoint,
		cacheTtlHours,
		customRules,
	};
}

export { lookupFallbackRates };

export function resolveCustomRule(
	model: string,
	rawModel: string | null | undefined,
	rules: Record<string, CustomModelPriceRule>,
	canonicalName?: string | null,
): CustomModelPriceRule | null {
	const candidates = new Set<string>();
	const addCandidate = (value: string | null | undefined) => {
		if (!value) return;
		const trimmed = value.trim();
		if (!trimmed) return;
		candidates.add(trimmed);
		const normalizedDisplay = normalizeModelName(trimmed);
		if (normalizedDisplay) candidates.add(normalizedDisplay);
	};
	addCandidate(model);
	addCandidate(rawModel);
	addCandidate(canonicalName);
	for (const candidate of candidates) {
		const hit = rules[normalizeRuleKey(candidate)];
		if (hit) return hit;
	}
	return null;
}

export function resolveCatalogEntryByTarget(
	catalog: Catalog | null,
	target: string,
): CatalogEntry | null {
	if (!catalog) return null;
	const trimmed = target.trim().toLowerCase();
	if (!trimmed) return null;
	const exact = catalog.byProviderModel.get(trimmed);
	if (exact) return exact;
	return resolveModel(target, "codex", catalog);
}

export interface EffectivePricingResolution {
	source: ModelPricingSource;
	matchedCatalogId: string | null;
	matchedCatalogName: string | null;
	effectiveRates: TokenRates | null;
	catalogRates: TokenRates | null;
	customRule: CustomModelPriceRule | null;
	canonicalName: string | null;
}

export function resolveEffectivePricing(options: {
	model: string;
	rawModel?: string | null;
	pricingModel?: string | null;
	harness: HarnessName;
	catalog: Catalog | null;
	rules: Record<string, CustomModelPriceRule>;
}): EffectivePricingResolution {
	const { model, rawModel, pricingModel, harness, catalog, rules } = options;
	const catalogMatch = catalog
		? ((pricingModel ? resolveModel(pricingModel, harness, catalog) : null) ??
			(rawModel ? resolveModel(rawModel, harness, catalog) : null) ??
			resolveModel(model, harness, catalog))
		: null;
	const defaultCatalogId = catalogMatch
		? `${catalogMatch.provider}/${catalogMatch.id}`
		: null;
	const defaultCatalogName = catalogMatch?.name ?? null;
	const defaultCatalogRates = catalogMatch?.rates ?? null;

	const customRule = resolveCustomRule(
		model,
		rawModel ?? pricingModel,
		rules,
		defaultCatalogName,
	);
	if (customRule) {
		if (customRule.mode === "rates" && customRule.rates) {
			return {
				source: "custom",
				matchedCatalogId: defaultCatalogId,
				matchedCatalogName: defaultCatalogName,
				effectiveRates: customRule.rates,
				catalogRates: defaultCatalogRates,
				customRule,
				canonicalName: defaultCatalogName,
			};
		}
		if (customRule.mode === "alias" && customRule.aliasTarget) {
			const aliasMatch = resolveCatalogEntryByTarget(
				catalog,
				customRule.aliasTarget,
			);
			return {
				source: "custom_alias",
				matchedCatalogId: aliasMatch
					? `${aliasMatch.provider}/${aliasMatch.id}`
					: customRule.aliasTarget,
				matchedCatalogName: aliasMatch?.name ?? null,
				effectiveRates: aliasMatch?.rates ?? null,
				catalogRates: defaultCatalogRates,
				customRule,
				canonicalName: defaultCatalogName,
			};
		}
	}

	if (catalogMatch && defaultCatalogRates) {
		return {
			source: "models_dev",
			matchedCatalogId: defaultCatalogId,
			matchedCatalogName: defaultCatalogName,
			effectiveRates: defaultCatalogRates,
			catalogRates: defaultCatalogRates,
			customRule: null,
			canonicalName: catalogMatch.name,
		};
	}

	const fallback =
		(rawModel ? lookupFallbackRates(rawModel) : null) ??
		lookupFallbackRates(model);
	if (fallback) {
		return {
			source: "fallback",
			matchedCatalogId: defaultCatalogId,
			matchedCatalogName: defaultCatalogName,
			effectiveRates: fallback,
			catalogRates: defaultCatalogRates,
			customRule: null,
			canonicalName: defaultCatalogName,
		};
	}

	if (catalogMatch) {
		return {
			source: "models_dev",
			matchedCatalogId: defaultCatalogId,
			matchedCatalogName: defaultCatalogName,
			effectiveRates: null,
			catalogRates: null,
			customRule: null,
			canonicalName: catalogMatch.name,
		};
	}

	return {
		source: "unpriced",
		matchedCatalogId: null,
		matchedCatalogName: null,
		effectiveRates: null,
		catalogRates: null,
		customRule: null,
		canonicalName: null,
	};
}

function costsEqual(a: number | null, b: number | null): boolean {
	if (a === null || b === null) return a === b;
	return Math.abs(a - b) <= 1e-12;
}

export function applyPricingToRecords(
	records: UsageRecord[],
	options: {
		catalog: Catalog | null;
		rules: Record<string, CustomModelPriceRule>;
	},
): { changed: UsageRecord[] } {
	const changed: UsageRecord[] = [];
	if (!records.length) return { changed };

	const cache = new Map<string, EffectivePricingResolution>();

	for (const record of records) {
		const prevModel = record.model;
		const prevCostUsd = record.costUsd;
		const prevCostEstimated = record.costEstimated;

		if (record.rawModel === undefined || record.rawModel === null) {
			record.rawModel = record.pricingModel ?? record.model;
		}
		if (record.rawCostUsd === undefined) {
			record.rawCostUsd = record.costEstimated ? null : record.costUsd;
		}

		const rawModel = record.rawModel;
		const cacheKey = `${record.harness}\u0000${rawModel}\u0000${record.pricingModel ?? ""}\u0000${record.model}`;
		let resolution = cache.get(cacheKey);
		if (!resolution) {
			resolution = resolveEffectivePricing({
				model: record.model,
				rawModel,
				pricingModel: record.pricingModel,
				harness: record.harness,
				catalog: options.catalog,
				rules: options.rules,
			});
			cache.set(cacheKey, resolution);
		}

		const nextModel = normalizeModelName(
			resolution.canonicalName ?? rawModel ?? record.model,
		);
		const rawCostUsd = record.rawCostUsd ?? null;
		let nextCostUsd: number | null = rawCostUsd;
		let nextCostEstimated = false;

		if (resolution.customRule) {
			if (resolution.effectiveRates) {
				if (
					resolution.customRule.overrideRecorded ||
					rawCostUsd === null ||
					rawCostUsd === 0
				) {
					nextCostUsd = estimateTokensCost(record, resolution.effectiveRates);
					nextCostEstimated = true;
				}
			}
		} else if (resolution.effectiveRates) {
			const shouldEstimate =
				rawCostUsd === null ||
				(rawCostUsd === 0 && hasPositiveRates(resolution.effectiveRates));
			if (shouldEstimate) {
				nextCostUsd = estimateTokensCost(record, resolution.effectiveRates);
				nextCostEstimated = true;
			}
		}

		record.model = nextModel;
		record.costUsd = nextCostUsd;
		record.costEstimated = nextCostEstimated;

		if (
			nextModel !== prevModel ||
			!costsEqual(nextCostUsd, prevCostUsd) ||
			nextCostEstimated !== prevCostEstimated
		) {
			changed.push(record);
		}
	}

	return { changed };
}

export function buildModelPricingMeta(
	model: string,
	records: readonly UsageRecord[],
	options: {
		catalog: Catalog | null;
		rules: Record<string, CustomModelPriceRule>;
	},
): ModelPricingMeta {
	const rawModelIds = new Set<string>();
	let recordedRequests = 0;
	let estimatedRequests = 0;
	let unpricedRequests = 0;
	let primaryHarness: HarnessName = records[0]?.harness ?? "codex";
	let sampleRawModel: string | null = null;
	let samplePricingModel: string | null = null;

	for (const record of records) {
		if (record.rawModel && rawModelIds.size < 8) {
			rawModelIds.add(record.rawModel);
		}
		if (!sampleRawModel && record.rawModel) sampleRawModel = record.rawModel;
		if (!samplePricingModel && record.pricingModel) {
			samplePricingModel = record.pricingModel;
		}
		primaryHarness = record.harness;
		if (record.costUsd === null) {
			unpricedRequests += 1;
		} else if (record.costEstimated) {
			estimatedRequests += 1;
		} else {
			recordedRequests += 1;
		}
	}

	const resolution = resolveEffectivePricing({
		model,
		rawModel: sampleRawModel,
		pricingModel: samplePricingModel,
		harness: primaryHarness,
		catalog: options.catalog,
		rules: options.rules,
	});

	let source = resolution.source;
	if (source === "unpriced" && recordedRequests > 0 && unpricedRequests === 0) {
		source = "recorded";
	} else if (
		(source === "models_dev" || source === "fallback") &&
		recordedRequests > 0 &&
		estimatedRequests === 0 &&
		unpricedRequests === 0
	) {
		source = "recorded";
	}

	return {
		source,
		matchedCatalogId: resolution.matchedCatalogId,
		matchedCatalogName: resolution.matchedCatalogName,
		effectiveRates: resolution.effectiveRates,
		catalogRates: resolution.catalogRates,
		customRule: resolution.customRule,
		rawModelIds: [...rawModelIds],
		recordedRequests,
		estimatedRequests,
		unpricedRequests,
	};
}

export function summarizeActiveModelsPricing(
	records: readonly UsageRecord[],
	options: {
		catalog: Catalog | null;
		rules: Record<string, CustomModelPriceRule>;
	},
): PricingCatalogSummary {
	const byModel = new Map<string, UsageRecord[]>();
	let unpricedRequests = 0;
	for (const record of records) {
		if (record.costUsd === null) unpricedRequests += 1;
		const list = byModel.get(record.model) ?? [];
		list.push(record);
		byModel.set(record.model, list);
	}
	let customModels = 0;
	let catalogModels = 0;
	let recordedOnlyModels = 0;
	let fallbackModels = 0;
	let unpricedModels = 0;

	for (const [model, group] of byModel) {
		const meta = buildModelPricingMeta(model, group, options);
		if (meta.source === "custom" || meta.source === "custom_alias") {
			customModels += 1;
		} else if (meta.source === "models_dev") {
			catalogModels += 1;
		} else if (meta.source === "fallback") {
			fallbackModels += 1;
		} else if (meta.source === "recorded") {
			recordedOnlyModels += 1;
		} else {
			unpricedModels += 1;
		}
	}

	return {
		activeModels: byModel.size,
		customModels,
		catalogModels,
		recordedOnlyModels,
		fallbackModels,
		unpricedModels,
		unpricedRequests,
	};
}

export function searchCatalogEntries(
	catalog: Catalog | null,
	query: string,
	limit = 25,
): PricingCatalogSearchItem[] {
	if (!catalog) return [];
	const needle = query.trim().toLowerCase();
	const tokens = needle.split(/[\s/_-]+/u).filter(Boolean);
	const capped = Math.max(1, Math.min(100, limit));
	const scored: Array<{ score: number; item: PricingCatalogSearchItem }> = [];

	for (const [key, entry] of catalog.byProviderModel) {
		if (!entry.rates) continue;
		const lowerName = entry.name.toLowerCase();
		const lowerId = entry.id.toLowerCase();
		const lowerProvider = entry.provider.toLowerCase();
		const haystack = `${key} ${lowerName} ${lowerProvider}`;
		const nameOrId = `${lowerId} ${lowerName}`;
		let score = 0;
		if (!needle) {
			score = hasPositiveRates(entry.rates) ? 1 : 0;
		} else if (key === needle || lowerId === needle || lowerName === needle) {
			score = 120;
		} else if (
			lowerId.startsWith(needle) ||
			lowerName.startsWith(needle) ||
			key.startsWith(needle)
		) {
			score = 80;
		} else if (
			key.includes(needle) ||
			lowerName.includes(needle) ||
			lowerProvider.includes(needle)
		) {
			score = 60;
		} else if (
			tokens.length > 1 &&
			tokens.every((token) => nameOrId.includes(token))
		) {
			score = 45;
		} else if (
			tokens.length > 1 &&
			tokens.every((token) => haystack.includes(token))
		) {
			score = 25;
		} else {
			continue;
		}
		scored.push({
			score,
			item: {
				key,
				provider: entry.provider,
				id: entry.id,
				name: entry.name,
				rates: entry.rates,
			},
		});
	}

	scored.sort(
		(left, right) =>
			right.score - left.score ||
			left.item.key.length - right.item.key.length ||
			left.item.key.localeCompare(right.item.key),
	);
	return scored.slice(0, capped).map((entry) => entry.item);
}

function parseHistory(raw: string | null): PricingFetchAttempt[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item): item is PricingFetchAttempt =>
					Boolean(item) &&
					typeof item === "object" &&
					typeof (item as PricingFetchAttempt).timestamp === "number" &&
					typeof (item as PricingFetchAttempt).endpoint === "string",
			)
			.slice(0, MAX_FETCH_HISTORY);
	} catch {
		return [];
	}
}

export class PricingCatalogManager {
	private settings: PricingSettings = {
		...DEFAULT_PRICING_SETTINGS,
		customRules: {},
	};
	private catalog: Catalog | null = null;
	private fetchedAt: number | null = null;
	private history: PricingFetchAttempt[] = [];
	private lastError: string | null = null;
	private lastAutoErrorAt: number | null = null;
	private fetching = false;
	private inFlight: Promise<{
		attempt: PricingFetchAttempt;
		updated: boolean;
	}> | null = null;

	loadLocalState(db: StoreDatabase): void {
		const rawSettings = readSetting(db, PRICING_SETTINGS_KEY);
		if (rawSettings) {
			try {
				this.settings = normalizePricingSettings(JSON.parse(rawSettings));
			} catch {
				this.settings = { ...DEFAULT_PRICING_SETTINGS, customRules: {} };
			}
		} else {
			this.settings = { ...DEFAULT_PRICING_SETTINGS, customRules: {} };
		}
		this.history = parseHistory(readSetting(db, PRICING_HISTORY_KEY));
		const cached = loadCachedCatalogWithMeta();
		if (cached) {
			this.catalog = cached.catalog;
			this.fetchedAt = cached.fetchedAt;
		} else {
			this.catalog = null;
			this.fetchedAt = null;
		}
		const latest = this.history[0];
		if (latest?.status === "error") {
			this.lastError = latest.error;
			if (latest.trigger === "auto") {
				this.lastAutoErrorAt = latest.timestamp;
			}
		} else if (latest?.status === "ok") {
			this.lastError = null;
		}
	}

	reloadCacheFromDisk(): void {
		const cached = loadCachedCatalogWithMeta();
		if (cached) {
			this.catalog = cached.catalog;
			this.fetchedAt = cached.fetchedAt;
		}
	}

	getSettings(): PricingSettings {
		return {
			...this.settings,
			customRules: { ...this.settings.customRules },
		};
	}

	getCatalog(): Catalog | null {
		return this.catalog;
	}

	getFetchedAt(): number | null {
		return this.fetchedAt;
	}

	getLastError(): string | null {
		return this.lastError;
	}

	isFetching(): boolean {
		return this.fetching;
	}

	saveSettings(db: StoreDatabase, next: PricingSettings): PricingSettings {
		this.settings = normalizePricingSettings(next);
		writeSetting(db, PRICING_SETTINGS_KEY, JSON.stringify(this.settings));
		return this.getSettings();
	}

	needsAutoRefresh(now = Date.now()): boolean {
		if (!this.settings.autoFetch || this.fetching) return false;
		const ttlMs = this.settings.cacheTtlHours * 60 * 60 * 1000;
		const fresh =
			this.catalog !== null &&
			this.fetchedAt !== null &&
			now - this.fetchedAt >= 0 &&
			now - this.fetchedAt < ttlMs;
		if (fresh) return false;
		if (
			this.lastAutoErrorAt !== null &&
			now - this.lastAutoErrorAt < AUTO_RETRY_COOLDOWN_MS
		) {
			return false;
		}
		return true;
	}

	async refreshCatalog(options: {
		trigger: "auto" | "manual";
		persistHistory?: (history: PricingFetchAttempt[]) => void;
		fetchFn?: typeof fetch;
		timeoutMs?: number;
	}): Promise<{ attempt: PricingFetchAttempt; updated: boolean }> {
		if (this.inFlight) return this.inFlight;
		const run = (async () => {
			this.fetching = true;
			const targetEndpoint =
				this.settings.endpoint || DEFAULT_MODELS_DEV_ENDPOINT;
			try {
				const res = await fetchAndCacheCatalog({
					endpoint: targetEndpoint,
					timeoutMs: options.timeoutMs ?? 8000,
					fetchFn: options.fetchFn,
				});
				const attempt: PricingFetchAttempt = {
					timestamp: Date.now(),
					trigger: options.trigger,
					endpoint: targetEndpoint,
					status: res.catalog ? "ok" : "error",
					httpStatus: res.httpStatus,
					durationMs: res.durationMs,
					modelCount: res.catalog ? res.modelCount : null,
					providerCount: res.catalog ? res.providerCount : null,
					error: res.catalog ? res.cacheWriteError : res.error,
				};
				this.history = [attempt, ...this.history].slice(0, MAX_FETCH_HISTORY);
				options.persistHistory?.(this.history);
				if (res.catalog) {
					this.catalog = res.catalog;
					this.fetchedAt = res.fetchedAt ?? Date.now();
					this.lastError = res.cacheWriteError;
					this.lastAutoErrorAt = null;
					return { attempt, updated: true };
				}
				this.lastError = res.error ?? "Failed to fetch price catalog";
				if (options.trigger === "auto") {
					this.lastAutoErrorAt = attempt.timestamp;
				}
				return { attempt, updated: false };
			} finally {
				this.fetching = false;
			}
		})();

		this.inFlight = run.finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	writeHistory(db: StoreDatabase, history: PricingFetchAttempt[]): void {
		writeSetting(db, PRICING_HISTORY_KEY, JSON.stringify(history));
	}

	buildStatus(summary: PricingCatalogSummary): PricingCatalogStatus {
		const ttlMs = this.settings.cacheTtlHours * 60 * 60 * 1000;
		const now = Date.now();
		let state: PricingCatalogStatus["state"] = "missing";
		if (this.fetching) {
			state = "fetching";
		} else if (!this.catalog) {
			state = this.settings.autoFetch ? "missing" : "offline";
		} else if (!this.settings.autoFetch) {
			state = "offline";
		} else if (
			this.fetchedAt !== null &&
			now - this.fetchedAt >= 0 &&
			now - this.fetchedAt < ttlMs
		) {
			state = "fresh";
		} else {
			state = "stale";
		}
		const stats = catalogStats(this.catalog);
		return {
			state,
			endpoint: this.settings.endpoint,
			cachePath: getModelsDevCachePath(),
			autoFetch: this.settings.autoFetch,
			cacheTtlHours: this.settings.cacheTtlHours,
			fetchedAt: this.fetchedAt,
			expiresAt: this.fetchedAt !== null ? this.fetchedAt + ttlMs : null,
			modelCount: stats.modelCount,
			providerCount: stats.providerCount,
			lastError: this.lastError,
			fetching: this.fetching,
			history: [...this.history],
			summary,
		};
	}
}
