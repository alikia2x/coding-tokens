import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { normalizeModelName } from "../../shared/models";
import type { TokenRates } from "../../shared/types";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../platform/paths";
import type { HarnessName, UsageRecord } from "../types";
import { objectOrEmpty } from "../util";

export const DEFAULT_MODELS_DEV_ENDPOINT = "https://models.dev/api.json";

function resolveCacheFile(
	paths: PlatformPathService = defaultPlatformPathService,
): string {
	const newCache = path.join(
		paths.getCacheDir("coding-tokens"),
		"models.dev.json",
	);
	const legacyCache = path.join(
		paths.getHomeDir(),
		"Library",
		"Caches",
		"harness-token-usage",
		"models.dev.json",
	);
	if (!existsSync(newCache) && existsSync(legacyCache)) {
		try {
			mkdirSync(path.dirname(newCache), { recursive: true });
			copyFileSync(legacyCache, newCache);
			return newCache;
		} catch {
			return legacyCache;
		}
	}
	return newCache;
}

export function getModelsDevCachePath(paths?: PlatformPathService): string {
	return resolveCacheFile(paths);
}

const cacheTtl = 24 * 60 * 60 * 1000;
const wrappers = new Set([
	"command-code",
	"commandcode",
	"codex",
	"dsh",
	"antigravity",
]);
const providerAliases: Record<string, string[]> = {
	"command-code": ["commandcode"],
	commandcode: ["command-code"],
	moonshot: ["moonshotai"],
	"deepseek-ai": ["deepseek"],
	"deepseek-official": ["deepseek"],
	"google-ai": ["google"],
	"google-gemini": ["google"],
	"open-ai": ["openai"],
	"xiaomi-ai": ["xiaomi"],
	"moonshot-ai": ["moonshot"],
	moonshotai: ["moonshot"],
	zai: ["zhipu", "zhipuai"],
	"zai-org": ["zai", "zhipu", "zhipuai"],
	zhipuai: ["zhipu"],
	qwen: ["alibaba", "dashscope"],
	"x-ai": ["xai"],
};

export type Rates = TokenRates;

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

export function lookupFallbackRates(name: string): Rates | null {
	const clean = name
		.toLowerCase()
		.replace(/[\s_.]+/g, "-")
		.trim();
	if (!clean) return null;
	for (const [key, rates] of Object.entries(STATIC_FALLBACK_RATES)) {
		if (
			clean === key ||
			clean.includes(key) ||
			(clean.length >= 3 && key.includes(clean))
		) {
			return rates;
		}
	}
	return null;
}

function normalized(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replaceAll("_", "-")
		.replace(/\s+/gu, "-")
		.replace(/\\/gu, "/")
		.replace(/\/{2,}/gu, "/");
}

function variants(value: string): string[] {
	const original = normalized(value);
	const result = new Set<string>([original]);
	let parts = original.split("/").filter(Boolean);
	while (parts.length > 0) {
		const first = parts[0] ?? "";
		if (wrappers.has(first) || first === "model" || first === "models") {
			parts = parts.slice(1);
			result.add(parts.join("/"));
		} else {
			break;
		}
	}
	for (const variant of [...result]) {
		result.add(variant.replace(/#[^/]+$/u, ""));
		result.add(variant.replace(/(?::|@)(?:latest|stable)$/u, ""));
		result.add(variant.replace(/-(?:latest|stable)$/u, ""));
		result.add(variant.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6})$/u, ""));
		result.add(variant.replace(/v(\d)(\d)(?=-|$)/gu, "v$1.$2"));
		result.add(
			variant.replace(
				/-(?:low|medium|high|tiered|control|trial|n|s|thinking)$/u,
				"",
			),
		);
		result.add(variant.replace(/(\d)-(\d)/gu, "$1.$2"));
		result.add(variant.replace(/(\d)\.(\d)/gu, "$1-$2"));
	}
	for (const variant of [...result]) {
		result.add(
			variant.replace(
				/-(?:low|medium|high|tiered|control|trial|n|s|thinking)$/u,
				"",
			),
		);
		result.add(variant.replace(/(\d)-(\d)/gu, "$1.$2"));
		result.add(variant.replace(/(\d)\.(\d)/gu, "$1-$2"));
	}
	return [...result].filter(Boolean);
}

function numeric(value: unknown): number | null {
	if (typeof value !== "number" && typeof value !== "string") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function ratesOf(value: unknown): Rates | null {
	const cost = objectOrEmpty(value);
	const input = numeric(cost.input);
	const output = numeric(cost.output);
	if (input === null || output === null) return null;
	return {
		input,
		output,
		reasoning: numeric(cost.reasoning),
		cacheRead: numeric(cost.cache_read),
		cacheWrite: numeric(cost.cache_write),
	};
}

function addIndex(
	index: Map<string, CatalogEntry[]>,
	key: string,
	entry: CatalogEntry,
) {
	const id = normalized(key);
	const matches = index.get(id) ?? [];
	matches.push(entry);
	index.set(id, matches);
}

export function readCatalog(value: unknown): Catalog {
	const root = objectOrEmpty(value);
	const providers = new Set(Object.keys(root).map(normalized));
	const byProviderModel = new Map<string, CatalogEntry>();
	const byModel = new Map<string, CatalogEntry[]>();

	for (const [providerKey, providerValue] of Object.entries(root)) {
		const provider = objectOrEmpty(providerValue);
		for (const [modelKey, modelValue] of Object.entries(
			objectOrEmpty(provider.models),
		)) {
			const model = objectOrEmpty(modelValue);
			const rates = ratesOf(model.cost);
			const id = normalized(typeof model.id === "string" ? model.id : modelKey);
			const entry: CatalogEntry = {
				provider: normalized(providerKey),
				id,
				canonicalId:
					typeof model.canonical_model_id === "string"
						? normalized(model.canonical_model_id)
						: null,
				family:
					typeof model.family === "string" ? normalized(model.family) : null,
				name: typeof model.name === "string" ? model.name : id,
				releaseDate:
					typeof model.release_date === "string" ? model.release_date : "",
				rates,
			};
			byProviderModel.set(`${entry.provider}/${entry.id}`, entry);
			addIndex(byModel, entry.id, entry);
			addIndex(byModel, entry.name, entry);
		}
	}
	return { providers, byProviderModel, byModel };
}

interface ParsedCatalogMemo {
	file: string;
	mtimeMs: number;
	size: number;
	fetchedAt: number;
	catalog: Catalog;
}

let parsedCatalogMemo: ParsedCatalogMemo | null = null;

function loadValidatedCache(
	paths?: PlatformPathService,
): { fetchedAt: number; catalog: Catalog } | null {
	const cacheFile = resolveCacheFile(paths);
	try {
		const stat = statSync(cacheFile);
		if (
			parsedCatalogMemo &&
			parsedCatalogMemo.file === cacheFile &&
			parsedCatalogMemo.mtimeMs === stat.mtimeMs &&
			parsedCatalogMemo.size === stat.size
		) {
			return {
				fetchedAt: parsedCatalogMemo.fetchedAt,
				catalog: parsedCatalogMemo.catalog,
			};
		}
		const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as CatalogCache;
		if (
			typeof cache.fetchedAt !== "number" ||
			!Number.isFinite(cache.fetchedAt) ||
			!Number.isFinite(new Date(cache.fetchedAt).getTime())
		) {
			return null;
		}
		const catalog = readCatalog(cache.data);
		if (catalog.byProviderModel.size === 0) return null;
		parsedCatalogMemo = {
			file: cacheFile,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			fetchedAt: cache.fetchedAt,
			catalog,
		};
		return { fetchedAt: cache.fetchedAt, catalog };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ENOENT") {
			console.warn(
				`models.dev: failed to load cache ${cacheFile}: ${String(err)}`,
			);
		}
		return null;
	}
}

export function loadCachedCatalogWithMeta(paths?: PlatformPathService): {
	fetchedAt: number;
	catalog: Catalog;
} | null {
	return loadValidatedCache(paths);
}

export function loadCachedCatalog(paths?: PlatformPathService): Catalog | null {
	return loadValidatedCache(paths)?.catalog ?? null;
}

export function catalogStats(catalog: Catalog | null): {
	modelCount: number;
	providerCount: number;
} {
	if (!catalog) return { modelCount: 0, providerCount: 0 };
	return {
		modelCount: catalog.byProviderModel.size,
		providerCount: catalog.providers.size,
	};
}

function writeCache(
	data: unknown,
	fetchedAt = Date.now(),
	paths?: PlatformPathService,
): boolean {
	const cacheFile = resolveCacheFile(paths);
	try {
		mkdirSync(path.dirname(cacheFile), { recursive: true });
		const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
		writeFileSync(temporaryFile, JSON.stringify({ fetchedAt, data }));
		renameSync(temporaryFile, cacheFile);
		parsedCatalogMemo = null;
		return true;
	} catch {
		return false;
	}
}

function providerId(value: string, catalog: Catalog): string | null {
	const key = normalized(value);
	const aliases = [key, ...(providerAliases[key] ?? [])];
	for (const candidate of [...aliases]) {
		for (const suffix of ["-official", "-api", "-ai"]) {
			if (candidate.endsWith(suffix))
				aliases.push(candidate.slice(0, -suffix.length));
		}
	}
	return aliases.find((alias) => catalog.providers.has(alias)) ?? null;
}

const providerRules: Array<[RegExp, string[]]> = [
	[/^(?:gpt-|o[134](?:-|$)|codex-)/u, ["openai"]],
	[/^(?:claude-)/u, ["anthropic"]],
	[/^(?:gemini-|gemma-)/u, ["google"]],
	[/^deepseek-/u, ["deepseek"]],
	[/^(?:mimo-|xiaomi-)/u, ["xiaomi"]],
	[/^(?:grok-|xai-)/u, ["xai"]],
	[/^(?:llama-|meta-llama-)/u, ["meta"]],
	[/^(?:qwen|qwq)/u, ["alibaba", "qwen", "dashscope"]],
	[/^(?:kimi-|moonshot-)/u, ["moonshot", "moonshotai"]],
	[/^(?:glm-|chatglm-)/u, ["zhipu", "zhipuai", "zai"]],
	[/^minimax-/u, ["minimax"]],
	[/^(?:mistral-|codestral-)/u, ["mistral"]],
	[/^(?:command-r|aya-)/u, ["cohere"]],
	[/^jamba-/u, ["ai21"]],
	[/^nova-/u, ["amazon"]],
	[/^phi-/u, ["microsoft"]],
	[/^nemotron-/u, ["nvidia"]],
	[/^yi-/u, ["01-ai"]],
	[/^ernie-/u, ["baidu"]],
	[/^hunyuan-/u, ["tencent"]],
	[/^step-/u, ["stepfun"]],
	[/^doubao-/u, ["volcengine", "bytedance"]],
	[/^internlm-/u, ["internlm"]],
];

/** Provider names inferred from a model slug, whether or not models.dev has a
 * native provider entry for them. Reseller catalogs still carry the upstream
 * canonical id, so these names are useful for canonical matching. */
function inferredProviderNames(value: string): string[] {
	const slug = normalized(value).split("/").at(-1) ?? "";
	for (const [pattern, candidates] of providerRules) {
		if (pattern.test(slug)) return candidates;
	}
	return [];
}

function providerHints(
	name: string,
	harness: HarnessName,
	catalog: Catalog,
): string[] {
	const hints: string[] = [];
	for (const variant of variants(name)) {
		for (const part of variant.split("/")) {
			const found = providerId(part, catalog);
			if (found && !hints.includes(found)) hints.push(found);
		}
		for (const inferred of inferredProviderNames(variant)) {
			if (!hints.includes(inferred)) hints.push(inferred);
		}
	}
	if (harness === "codex") {
		const openai = providerId("openai", catalog) ?? "openai";
		if (!hints.includes(openai)) hints.push(openai);
	}
	return hints;
}

function modelHints(name: string): string[] {
	const hints = new Set<string>();
	for (const variant of variants(name)) {
		const parts = variant.split("/");
		for (let index = 0; index < parts.length; index += 1) {
			hints.add(parts.slice(index).join("/"));
		}
	}
	return [...hints].filter(Boolean);
}

function sameRates(entries: CatalogEntry[]): boolean {
	const first = JSON.stringify(entries[0]?.rates);
	return entries.every((entry) => JSON.stringify(entry.rates) === first);
}

function versionNumbers(value: string): number[] {
	return (value.match(/\d+(?:\.\d+)*/gu) ?? []).flatMap((part) =>
		part.split(".").map(Number),
	);
}

function newest(entries: CatalogEntry[]): CatalogEntry | null {
	const sorted = [...entries].sort((left, right) => {
		const dateOrder = right.releaseDate.localeCompare(left.releaseDate);
		if (dateOrder) return dateOrder;
		const a = versionNumbers(left.id);
		const b = versionNumbers(right.id);
		for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
			const difference = (b[index] ?? 0) - (a[index] ?? 0);
			if (difference) return difference;
		}
		return 0;
	});
	if (sorted.length === 1) return sorted[0] ?? null;
	const [first, second] = sorted;
	if (!first || !second || first.id === second.id) return null;
	if (first.releaseDate && first.releaseDate !== second.releaseDate)
		return first;
	const a = versionNumbers(first.id);
	const b = versionNumbers(second.id);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) return first;
	}
	return null;
}

function choose(
	entries: CatalogEntry[],
	hints: string[],
	preferNewest = false,
): CatalogEntry | null {
	let matches = [...new Set(entries)];
	for (const hint of hints) {
		const preferred = matches.filter((entry) => entry.provider === hint);
		if (preferred.length) {
			matches = preferred;
			break;
		}
	}
	if (matches.length === 1) return matches[0] ?? null;
	const first = matches[0];
	const canonicalId =
		first?.canonicalId ??
		matches.find((entry) => entry.canonicalId !== null)?.canonicalId ??
		null;
	const firstName = normalized(first?.name ?? "");
	const sameModel = Boolean(
		first &&
			(canonicalId
				? matches.every((entry) =>
						entry.canonicalId
							? entry.canonicalId === canonicalId
							: normalized(entry.name) === firstName,
					)
				: matches.every(
						(entry) =>
							!entry.canonicalId && normalized(entry.name) === firstName,
					)),
	);
	if (sameModel) {
		// Resellers often list the same canonical model under their own provider
		// id, so the original provider hint does not match any entry. The canonical
		// id still names the upstream provider; use it so Codex models such as
		// gpt-5.1-codex-mini resolve even when OpenAI itself has no catalog row.
		for (const hint of hints) {
			const canonical = matches.find(
				(entry) => entry.canonicalId?.split("/")[0] === hint,
			);
			if (canonical) return canonical;
		}
		if (sameRates(matches)) return first ?? null;
	}
	return preferNewest ? newest(matches) : null;
}

function family(value: string, provider: string | null): string {
	let slug = normalized(value).split("/").at(-1) ?? "";
	const providerSlug = provider?.split("/").at(-1);
	if (providerSlug && slug.startsWith(`${providerSlug}-`)) {
		slug = slug.slice(providerSlug.length + 1);
	}
	return slug
		.split("-")
		.filter((part) => !/^(?:v?\d+(?:\.\d+)*)$/u.test(part))
		.join("-");
}

export function resolveModel(
	name: string,
	harness: HarnessName,
	catalog: Catalog,
): CatalogEntry | null {
	const hints = providerHints(name, harness, catalog);
	for (const variant of variants(name)) {
		const parts = variant.split("/");
		for (let split = 1; split < parts.length; split += 1) {
			const provider = providerId(parts.slice(0, split).join("/"), catalog);
			if (!provider) continue;
			const id = parts.slice(split).join("/");
			const exact = catalog.byProviderModel.get(`${provider}/${id}`);
			if (exact) return exact;
		}
	}

	for (const hint of modelHints(name)) {
		const exact = catalog.byModel.get(normalized(hint));
		if (exact?.length) {
			const match = choose(exact, hints);
			if (match) return match;
		}
	}

	const hasVersion = /\d/u.test(name);
	if (hasVersion) return null;
	for (const hint of modelHints(name)) {
		const key = family(hint, hints[0] ?? null);
		if (!key) continue;
		const matches = [...catalog.byProviderModel.values()].filter(
			(entry) =>
				family(entry.id, entry.provider) === key ||
				(entry.family !== null && family(entry.family, null) === key),
		);
		const match = choose(matches, hints, true);
		if (match) return match;
	}
	return null;
}

export function calculateTokensCost(
	tokens: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	},
	rates: Rates,
): number {
	const input = tokens.inputTokens ?? 0;
	const reasoning = tokens.reasoningTokens ?? 0;
	const cacheRead = tokens.cacheReadTokens ?? 0;
	const cacheWrite = tokens.cacheWriteTokens ?? 0;
	const output = Math.max(0, (tokens.outputTokens ?? 0) - reasoning);
	const reasoningRate = rates.reasoning ?? rates.output;
	return (
		(input * rates.input +
			output * rates.output +
			reasoning * reasoningRate +
			cacheRead * (rates.cacheRead ?? rates.input) +
			cacheWrite * (rates.cacheWrite ?? rates.input)) /
		1_000_000
	);
}

export function estimateTokensCost(record: UsageRecord, rates: Rates): number {
	return calculateTokensCost(record, rates);
}

export function hasPositiveRates(rates: Rates): boolean {
	return (
		rates.input > 0 ||
		rates.output > 0 ||
		(rates.reasoning ?? 0) > 0 ||
		(rates.cacheRead ?? 0) > 0 ||
		(rates.cacheWrite ?? 0) > 0
	);
}

export interface FetchCatalogResult {
	catalog: Catalog | null;
	fetchedAt: number | null;
	httpStatus: number | null;
	durationMs: number;
	modelCount: number;
	providerCount: number;
	error: string | null;
	cacheWriteError: string | null;
}

export async function fetchAndCacheCatalog(
	options: {
		endpoint?: string;
		timeoutMs?: number;
		fetchFn?: typeof fetch;
		paths?: PlatformPathService;
	} = {},
): Promise<FetchCatalogResult> {
	const targetEndpoint =
		options.endpoint?.trim() || DEFAULT_MODELS_DEV_ENDPOINT;
	const timeoutMs = options.timeoutMs ?? 8000;
	const fetcher = options.fetchFn ?? globalThis.fetch;
	const startedAt = Date.now();
	let httpStatus: number | null = null;
	let response: Response;
	try {
		response = await fetcher(targetEndpoint, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		httpStatus = response.status;
	} catch (error) {
		const message =
			error instanceof Error && error.message
				? error.message
				: String(error || "Network error");
		return {
			catalog: null,
			fetchedAt: null,
			httpStatus: null,
			durationMs: Date.now() - startedAt,
			modelCount: 0,
			providerCount: 0,
			error: message,
			cacheWriteError: null,
		};
	}

	if (!response.ok) {
		return {
			catalog: null,
			fetchedAt: null,
			httpStatus: response.status,
			durationMs: Date.now() - startedAt,
			modelCount: 0,
			providerCount: 0,
			error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
			cacheWriteError: null,
		};
	}

	try {
		const data: unknown = await response.json();
		const freshCatalog = readCatalog(data);
		if (!freshCatalog.byProviderModel.size) {
			throw new Error("Catalog returned 0 models");
		}
		const fetchedAt = Date.now();
		const wrote = writeCache(data, fetchedAt, options.paths);
		return {
			catalog: freshCatalog,
			fetchedAt,
			httpStatus,
			durationMs: Date.now() - startedAt,
			modelCount: freshCatalog.byProviderModel.size,
			providerCount: freshCatalog.providers.size,
			error: null,
			cacheWriteError: wrote ? null : "models.dev catalog could not be cached",
		};
	} catch (error) {
		const message =
			error instanceof Error && error.message
				? error.message
				: "Invalid catalog JSON";
		return {
			catalog: null,
			fetchedAt: null,
			httpStatus,
			durationMs: Date.now() - startedAt,
			modelCount: 0,
			providerCount: 0,
			error: message,
			cacheWriteError: null,
		};
	}
}

let inFlightRefresh: Promise<FetchCatalogResult> | null = null;

export async function enrichWithModelsDev(
	records: UsageRecord[],
	options?: {
		paths?: PlatformPathService;
		fetchFn?: typeof fetch;
	},
): Promise<string | null> {
	if (!records.length) return null;
	const needsPricing = records.some(
		(record) => record.costUsd === null || record.costUsd === 0,
	);
	const cached = loadValidatedCache(options?.paths);
	const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
	const cacheIsFresh = age >= 0 && age < cacheTtl;
	let catalog = cached?.catalog ?? null;
	const cachedStamp: CatalogCache | null = cached
		? { fetchedAt: cached.fetchedAt, data: null }
		: null;
	let warning: string | null = null;

	if (!cacheIsFresh) {
		const fetchOptions = {
			endpoint: DEFAULT_MODELS_DEV_ENDPOINT,
			timeoutMs: 5000,
			fetchFn: options?.fetchFn,
			paths: options?.paths,
		};
		let fetched: FetchCatalogResult;
		if (options?.paths || options?.fetchFn) {
			fetched = await fetchAndCacheCatalog(fetchOptions);
		} else {
			if (!inFlightRefresh) {
				inFlightRefresh = fetchAndCacheCatalog(fetchOptions).finally(() => {
					inFlightRefresh = null;
				});
			}
			fetched = await inFlightRefresh;
		}
		if (fetched.catalog) {
			catalog = fetched.catalog;
			if (fetched.cacheWriteError) warning = fetched.cacheWriteError;
		} else if (fetched.httpStatus !== null) {
			const msg = `models.dev returned HTTP ${fetched.httpStatus}`;
			if (!catalog) {
				return needsPricing ? msg : `${msg}; model ids remain unchanged`;
			}
			return applyCatalog(records, catalog, cacheWarning(cachedStamp, msg));
		} else if (
			fetched.error &&
			(fetched.error.includes("0 models") ||
				fetched.error.toLowerCase().includes("json"))
		) {
			if (!catalog) {
				return needsPricing
					? "models.dev returned invalid pricing data"
					: "models.dev returned invalid catalog data; model ids remain unchanged";
			}
			return applyCatalog(records, catalog, cacheWarning(cachedStamp));
		} else {
			if (!catalog) {
				return needsPricing
					? "models.dev pricing could not be reached"
					: "models.dev catalog could not be reached; model ids remain unchanged";
			}
			return applyCatalog(records, catalog, cacheWarning(cachedStamp));
		}
	}
	if (!catalog) return "models.dev returned no model data";
	return applyCatalog(records, catalog, warning);
}

function cacheWarning(
	cached: CatalogCache | null,
	refreshError = "models.dev pricing could not be refreshed",
): string {
	const date = cached
		? new Date(cached.fetchedAt).toISOString().slice(0, 10)
		: "";
	return date
		? `${refreshError}, using cached prices from ${date}`
		: refreshError;
}

export function applyCatalog(
	records: UsageRecord[],
	catalog: Catalog,
	warning: string | null,
): string | null {
	// Model resolution walks a large catalog. Session logs repeat the same few
	// model ids tens of thousands of times, so resolve each distinct harness and
	// model pair once instead of once per request.
	const resolved = new Map<string, CatalogEntry | null>();
	const fallbackMemo = new Map<string, Rates | null>();
	for (const record of records) {
		if (record.rawModel === undefined || record.rawModel === null) {
			record.rawModel = record.pricingModel ?? record.model;
		}
		const rawModel = record.rawModel;
		const key = `${record.harness}\u0000${rawModel}\u0000${record.pricingModel ?? ""}\u0000${record.model}`;
		let model = resolved.get(key);
		if (model === undefined) {
			model =
				(record.pricingModel
					? resolveModel(record.pricingModel, record.harness, catalog)
					: null) ??
				resolveModel(rawModel, record.harness, catalog) ??
				resolveModel(record.model, record.harness, catalog);
			resolved.set(key, model);
		}

		record.model = normalizeModelName(model?.name ?? rawModel ?? record.model);

		let rates: Rates | null = model?.rates ?? null;
		if (!rates) {
			let fallback = fallbackMemo.get(key);
			if (fallback === undefined) {
				fallback =
					(record.pricingModel
						? lookupFallbackRates(record.pricingModel)
						: null) ??
					lookupFallbackRates(rawModel) ??
					lookupFallbackRates(record.model);
				fallbackMemo.set(key, fallback);
			}
			rates = fallback;
		}
		if (!rates) continue;

		// A recorded zero is only authoritative when the model also prices at
		// zero (free tiers, coding plans, local providers). Unknown providers
		// and missing entries often leave cost at 0 while the resolved model has
		// real rates; estimate those instead of showing $0.
		const shouldEstimate =
			record.costUsd === null ||
			(record.costUsd === 0 && hasPositiveRates(rates));
		if (shouldEstimate) {
			record.costUsd = estimateTokensCost(record, rates);
			record.costEstimated = true;
		}
	}
	return warning;
}
