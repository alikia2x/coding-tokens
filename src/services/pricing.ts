import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { normalizeModelName } from "../../shared/models";
import type { HarnessId, HarnessName, UsageRecord } from "../../shared/types";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../platform/paths";
import {
	applyCatalog,
	type Catalog,
	type CatalogCache,
	type CatalogEntry,
	calculateTokensCost,
	estimateTokensCost,
	hasPositiveRates,
	lookupFallbackRates,
	type Rates,
	readCatalog,
	resolveModel,
	STATIC_FALLBACK_RATES,
	STATIC_MODEL_RATES,
} from "../pricing/modelsdev";

export type { Catalog, CatalogCache, CatalogEntry, Rates };
export { STATIC_FALLBACK_RATES, STATIC_MODEL_RATES };

export interface PricingServiceOptions {
	paths?: PlatformPathService;
	fetchFn?: typeof fetch;
	endpoint?: string;
	cacheTtlMs?: number;
}

export interface PricingService {
	init(): Promise<void>;
	enrichRecords(records: UsageRecord[]): Promise<UsageRecord[]>;
	calculateCost(
		model: string,
		inputTokens: number,
		outputTokens: number,
		cacheReadTokens?: number,
		cacheWriteTokens?: number,
		reasoningTokens?: number,
	): number | null;
	getModelRates(model: string, harness?: HarnessId): Rates | null;
	resolveModelName(model: string, harness?: HarnessId): string;
	refreshCatalog(
		force?: boolean,
	): Promise<{ success: boolean; warning: string | null }>;
	getWarnings(): string[];
	getCatalog(): Catalog | null;
}

export class DefaultPricingService implements PricingService {
	private catalog: Catalog | null = null;
	private warnings: string[] = [];
	private initialized = false;
	private readonly paths: PlatformPathService;
	private readonly fetchFn: typeof fetch;
	private readonly endpoint: string;
	private readonly cacheTtlMs: number;

	constructor(options: PricingServiceOptions = {}) {
		this.paths = options.paths ?? defaultPlatformPathService;
		this.fetchFn = options.fetchFn ?? globalThis.fetch;
		this.endpoint = options.endpoint ?? "https://models.dev/api.json";
		this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
	}

	getCacheFilePath(): string {
		const cacheDir = this.paths.getCacheDir("coding-tokens");
		return path.join(cacheDir, "models.dev.json");
	}

	getLegacyCacheFilePath(): string {
		return path.join(
			this.paths.getHomeDir(),
			"Library",
			"Caches",
			"harness-token-usage",
			"models.dev.json",
		);
	}

	private readCache(): CatalogCache | null {
		const targetFile = this.getCacheFilePath();
		const legacyFile = this.getLegacyCacheFilePath();

		let fileToRead = targetFile;
		if (!existsSync(targetFile) && existsSync(legacyFile)) {
			try {
				mkdirSync(path.dirname(targetFile), { recursive: true });
				copyFileSync(legacyFile, targetFile);
				fileToRead = targetFile;
			} catch {
				fileToRead = legacyFile;
			}
		}

		if (!existsSync(fileToRead)) return null;

		try {
			const parsed = JSON.parse(readFileSync(fileToRead, "utf8")) as {
				fetchedAt?: unknown;
				data?: unknown;
			};
			if (typeof parsed?.fetchedAt !== "number" || parsed.data === undefined) {
				return null;
			}
			return { fetchedAt: parsed.fetchedAt, data: parsed.data };
		} catch {
			return null;
		}
	}

	private writeCache(data: unknown): boolean {
		const targetFile = this.getCacheFilePath();
		try {
			mkdirSync(path.dirname(targetFile), { recursive: true });
			const payload: CatalogCache = { fetchedAt: Date.now(), data };
			const serialized = JSON.stringify(payload);
			const tmpFile = `${targetFile}.${process.pid}.tmp`;
			writeFileSync(tmpFile, serialized, "utf8");
			renameSync(tmpFile, targetFile);
			return true;
		} catch {
			return false;
		}
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		await this.refreshCatalog(false);
		this.initialized = true;
	}

	async refreshCatalog(
		force = false,
	): Promise<{ success: boolean; warning: string | null }> {
		const cached = this.readCache();
		const age = cached
			? Date.now() - cached.fetchedAt
			: Number.POSITIVE_INFINITY;
		const cacheIsFresh = !force && age >= 0 && age < this.cacheTtlMs;

		if (cacheIsFresh && cached) {
			try {
				this.catalog = readCatalog(cached.data);
				return { success: true, warning: null };
			} catch (err) {
				this.warnings.push(
					`models.dev cached catalog could not be parsed (${String(err)})`,
				);
			}
		}

		// Try network fetch
		try {
			const response = await this.fetchFn(this.endpoint, {
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				const data = (await response.json()) as unknown;
				const freshCatalog = readCatalog(data);
				if (freshCatalog.byProviderModel.size > 0) {
					this.writeCache(data);
					this.catalog = freshCatalog;
					return { success: true, warning: null };
				}
			}
		} catch (_error) {
			// Network failed
		}

		// Fallback to stale cache
		if (cached) {
			try {
				this.catalog = readCatalog(cached.data);
				const date = new Date(cached.fetchedAt).toISOString().slice(0, 10);
				const warning = `models.dev pricing could not be refreshed; using cached prices from ${date}`;
				this.warnings.push(warning);
				return { success: true, warning };
			} catch (err) {
				this.warnings.push(
					`models.dev stale cache could not be parsed (${String(err)})`,
				);
			}
		}

		const warning =
			"models.dev pricing could not be reached; using offline baseline rates";
		this.warnings.push(warning);
		return { success: false, warning };
	}

	async enrichRecords(records: UsageRecord[]): Promise<UsageRecord[]> {
		if (!records.length) return records;
		if (!this.catalog) {
			await this.init();
		}

		if (this.catalog) {
			applyCatalog(records, this.catalog, null);
			return records;
		}

		// No catalog loaded (offline with no cache): normalize model names and apply static fallback rates
		for (const record of records) {
			if (record.rawModel === undefined || record.rawModel === null) {
				record.rawModel = record.pricingModel ?? record.model;
			}
			const rawModel = record.rawModel;
			record.model = normalizeModelName(rawModel ?? record.model);
			const needsEstimate =
				record.costUsd === null ||
				(record.costUsd === 0 &&
					!record.costEstimated &&
					(record.inputTokens > 0 ||
						record.outputTokens > 0 ||
						(record.reasoningTokens ?? 0) > 0));
			if (!needsEstimate) continue;

			if (
				record.inputTokens === 0 &&
				record.outputTokens === 0 &&
				(record.reasoningTokens ?? 0) === 0
			) {
				record.costUsd = 0;
				continue;
			}
			const rates =
				(record.pricingModel
					? this.getModelRates(record.pricingModel, record.harness)
					: null) ?? this.getModelRates(rawModel, record.harness);
			if (rates && hasPositiveRates(rates)) {
				record.costUsd = estimateTokensCost(record, rates);
				record.costEstimated = true;
			}
		}

		return records;
	}

	calculateCost(
		model: string,
		inputTokens: number,
		outputTokens: number,
		cacheReadTokens = 0,
		cacheWriteTokens = 0,
		reasoningTokens = 0,
	): number | null {
		const rates = this.getModelRates(model);
		if (!rates) return null;

		const total = calculateTokensCost(
			{
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				reasoningTokens,
			},
			rates,
		);

		return Number(total.toFixed(8));
	}

	getModelRates(model: string, harness?: HarnessId): Rates | null {
		if (this.catalog) {
			const entry = resolveModel(
				model,
				(harness ?? "codex") as HarnessName,
				this.catalog,
			);
			if (entry?.rates) return entry.rates;
		}

		return lookupFallbackRates(model);
	}

	resolveModelName(model: string, harness?: HarnessId): string {
		if (this.catalog) {
			const entry = resolveModel(
				model,
				(harness ?? "codex") as HarnessName,
				this.catalog,
			);
			if (entry?.name) return normalizeModelName(entry.name);
		}
		return normalizeModelName(model);
	}

	getWarnings(): string[] {
		return [...this.warnings];
	}

	getCatalog(): Catalog | null {
		return this.catalog;
	}
}

export function resolveModelsDevCachePath(
	paths: PlatformPathService = defaultPlatformPathService,
): string {
	const targetFile = path.join(
		paths.getCacheDir("coding-tokens"),
		"models.dev.json",
	);
	const legacyFile = path.join(
		paths.getHomeDir(),
		"Library",
		"Caches",
		"harness-token-usage",
		"models.dev.json",
	);
	if (!existsSync(targetFile) && existsSync(legacyFile)) {
		try {
			mkdirSync(path.dirname(targetFile), { recursive: true });
			copyFileSync(legacyFile, targetFile);
		} catch {}
	}
	return targetFile;
}

export function createPricingService(
	options?: PricingServiceOptions,
): PricingService {
	return new DefaultPricingService(options);
}

export const defaultPricingService = new DefaultPricingService();
