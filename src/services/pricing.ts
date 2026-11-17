import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { HarnessId, HarnessName, UsageRecord } from "../../shared/types";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../platform/paths";
import { applyCatalog, readCatalog, resolveModel } from "../pricing/modelsdev";

export interface Rates {
	input: number;
	output: number;
	reasoning: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
}

export interface CatalogEntry {
	provider: string;
	id: string;
	canonicalId: string | null;
	family: string | null;
	name: string;
	releaseDate: string;
	rates: Rates | null;
}

export interface Catalog {
	providers: Set<string>;
	byProviderModel: Map<string, CatalogEntry>;
	byModel: Map<string, CatalogEntry[]>;
}

export interface CatalogCache {
	fetchedAt: number;
	data: unknown;
}

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

export const STATIC_FALLBACK_RATES: Record<string, Rates> = {
	"claude-3-5-sonnet": {
		input: 3.0,
		output: 15.0,
		reasoning: 15.0,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"claude-3-7-sonnet": {
		input: 3.0,
		output: 15.0,
		reasoning: 15.0,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"gpt-4o": {
		input: 2.5,
		output: 10.0,
		reasoning: 10.0,
		cacheRead: 1.25,
		cacheWrite: 2.5,
	},
	"gpt-4o-mini": {
		input: 0.15,
		output: 0.6,
		reasoning: 0.6,
		cacheRead: 0.075,
		cacheWrite: 0.15,
	},
	"deepseek-chat": {
		input: 0.14,
		output: 0.28,
		reasoning: 0.28,
		cacheRead: 0.014,
		cacheWrite: 0.14,
	},
	"deepseek-reasoner": {
		input: 0.55,
		output: 2.19,
		reasoning: 2.19,
		cacheRead: 0.14,
		cacheWrite: 0.55,
	},
	"deepseek-v3": {
		input: 0.14,
		output: 0.28,
		reasoning: 0.28,
		cacheRead: 0.014,
		cacheWrite: 0.14,
	},
	"deepseek-r1": {
		input: 0.55,
		output: 2.19,
		reasoning: 2.19,
		cacheRead: 0.14,
		cacheWrite: 0.55,
	},
	"gemini-1.5-pro": {
		input: 1.25,
		output: 5.0,
		reasoning: 5.0,
		cacheRead: 0.3125,
		cacheWrite: 1.25,
	},
	"gemini-1.5-flash": {
		input: 0.075,
		output: 0.3,
		reasoning: 0.3,
		cacheRead: 0.01875,
		cacheWrite: 0.075,
	},
	"gemini-2.0-flash": {
		input: 0.1,
		output: 0.4,
		reasoning: 0.4,
		cacheRead: 0.025,
		cacheWrite: 0.1,
	},
};

export const STATIC_MODEL_RATES = STATIC_FALLBACK_RATES;

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
			} catch {}
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
			} catch {}
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
		}

		// Fallback to static rates for any record that remains un-estimated/unpriced
		for (const record of records) {
			const needsEstimate =
				record.costUsd === null ||
				(record.costUsd === 0 &&
					!record.costEstimated &&
					(record.inputTokens > 0 ||
						record.outputTokens > 0 ||
						(record.reasoningTokens ?? 0) > 0));
			if (needsEstimate) {
				if (
					record.inputTokens === 0 &&
					record.outputTokens === 0 &&
					(record.reasoningTokens ?? 0) === 0
				) {
					record.costUsd = 0;
					continue;
				}
				const rates = this.getModelRates(record.model, record.harness);
				if (rates && (rates.input > 0 || rates.output > 0)) {
					const netOutput = Math.max(
						0,
						record.outputTokens - (record.reasoningTokens ?? 0),
					);
					const reasoningRate = rates.reasoning ?? rates.output;
					const readRate = rates.cacheRead ?? rates.input;
					const writeRate = rates.cacheWrite ?? rates.input;
					record.costUsd =
						(record.inputTokens * rates.input +
							netOutput * rates.output +
							(record.reasoningTokens ?? 0) * reasoningRate +
							(record.cacheReadTokens ?? 0) * readRate +
							(record.cacheWriteTokens ?? 0) * writeRate) /
						1_000_000;
					record.costEstimated = true;
				}
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

		const netOutput = Math.max(0, outputTokens - reasoningTokens);
		const reasoningRate = rates.reasoning ?? rates.output;
		const readRate = rates.cacheRead ?? rates.input;
		const writeRate = rates.cacheWrite ?? rates.input;

		const total =
			(inputTokens * rates.input +
				netOutput * rates.output +
				reasoningTokens * reasoningRate +
				cacheReadTokens * readRate +
				cacheWriteTokens * writeRate) /
			1_000_000;

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

		const normalized = model
			.toLowerCase()
			.replace(/[\s_.]+/g, "-")
			.trim();
		if (!normalized) return null;
		for (const [key, rates] of Object.entries(STATIC_FALLBACK_RATES)) {
			if (
				normalized === key ||
				normalized.includes(key) ||
				(normalized.length >= 3 && key.includes(normalized))
			) {
				return rates;
			}
		}

		return null;
	}

	resolveModelName(model: string, harness?: HarnessId): string {
		if (this.catalog) {
			const entry = resolveModel(
				model,
				(harness ?? "codex") as HarnessName,
				this.catalog,
			);
			if (entry?.name) return entry.name;
		}
		return model;
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
