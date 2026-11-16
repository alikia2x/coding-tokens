import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { defaultPlatformPathService } from "../platform/paths";
import type { HarnessName, UsageRecord } from "../types";
import { objectOrEmpty } from "../util";

const endpoint = "https://models.dev/api.json";

function resolveCacheFile(): string {
	const newCache = path.join(
		defaultPlatformPathService.getCacheDir("coding-tokens"),
		"models.dev.json",
	);
	const legacyCache = path.join(
		defaultPlatformPathService.getHomeDir(),
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

const cacheFile = resolveCacheFile();
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

interface Rates {
	input: number;
	output: number;
	reasoning: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
}

interface CatalogEntry {
	provider: string;
	id: string;
	canonicalId: string | null;
	family: string | null;
	name: string;
	releaseDate: string;
	rates: Rates | null;
}

interface Catalog {
	providers: Set<string>;
	byProviderModel: Map<string, CatalogEntry>;
	byModel: Map<string, CatalogEntry[]>;
}

interface CatalogCache {
	fetchedAt: number;
	data: unknown;
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

export function loadCachedCatalog(): Catalog | null {
	const cached = readCache();
	return cached ? readCatalog(cached.data) : null;
}

function readCache(): CatalogCache | null {
	try {
		const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as CatalogCache;
		if (
			typeof cache.fetchedAt !== "number" ||
			!Number.isFinite(cache.fetchedAt) ||
			!Number.isFinite(new Date(cache.fetchedAt).getTime()) ||
			readCatalog(cache.data).byProviderModel.size === 0
		) {
			return null;
		}
		return cache;
	} catch {
		return null;
	}
}

function writeCache(data: unknown): boolean {
	try {
		mkdirSync(path.dirname(cacheFile), { recursive: true });
		const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
		writeFileSync(
			temporaryFile,
			JSON.stringify({ fetchedAt: Date.now(), data }),
		);
		renameSync(temporaryFile, cacheFile);
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

function estimate(record: UsageRecord, rates: Rates): number {
	const input = record.inputTokens ?? 0;
	const reasoning = record.reasoningTokens ?? 0;
	const cacheRead = record.cacheReadTokens ?? 0;
	const cacheWrite = record.cacheWriteTokens ?? 0;
	const output = Math.max(0, (record.outputTokens ?? 0) - reasoning);
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

function hasPositiveRates(rates: Rates): boolean {
	return (
		rates.input > 0 ||
		rates.output > 0 ||
		(rates.reasoning ?? 0) > 0 ||
		(rates.cacheRead ?? 0) > 0 ||
		(rates.cacheWrite ?? 0) > 0
	);
}

export async function enrichWithModelsDev(
	records: UsageRecord[],
): Promise<string | null> {
	if (!records.length) return null;
	const needsPricing = records.some(
		(record) => record.costUsd === null || record.costUsd === 0,
	);
	const cached = readCache();
	const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
	const cacheIsFresh = age >= 0 && age < cacheTtl;
	let catalog = cached ? readCatalog(cached.data) : null;
	let warning: string | null = null;

	if (!cacheIsFresh) {
		let response: Response;
		try {
			response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
		} catch {
			if (!catalog) {
				return needsPricing
					? "models.dev pricing could not be reached"
					: "models.dev catalog could not be reached; model ids remain unchanged";
			}
			return applyCatalog(records, catalog, cacheWarning(cached));
		}
		if (!response.ok) {
			if (!catalog) {
				return needsPricing
					? `models.dev returned HTTP ${response.status}`
					: `models.dev returned HTTP ${response.status}; model ids remain unchanged`;
			}
			return applyCatalog(
				records,
				catalog,
				cacheWarning(cached, `models.dev returned HTTP ${response.status}`),
			);
		}

		try {
			const data: unknown = await response.json();
			const freshCatalog = readCatalog(data);
			if (!freshCatalog.byProviderModel.size) throw new Error("empty catalog");
			if (!writeCache(data)) warning = "models.dev catalog could not be cached";
			catalog = freshCatalog;
		} catch {
			if (!catalog) {
				return needsPricing
					? "models.dev returned invalid pricing data"
					: "models.dev returned invalid catalog data; model ids remain unchanged";
			}
			return applyCatalog(records, catalog, cacheWarning(cached));
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
		? `${refreshError}; using cached prices from ${date}`
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
	for (const record of records) {
		const key = `${record.harness}\u0000${record.model}`;
		let model = resolved.get(key);
		if (model === undefined) {
			model = resolveModel(
				record.pricingModel ?? record.model,
				record.harness,
				catalog,
			);
			resolved.set(key, model);
		}
		if (!model) continue;
		record.model = model.name;
		// A recorded zero is only authoritative when the catalog also prices the
		// model at zero (free tiers, coding plans, local providers). Unknown
		// providers and missing catalog entries often leave cost at 0 while the
		// resolved model has real rates; estimate those instead of showing $0.
		const shouldEstimate =
			record.costUsd === null ||
			(record.costUsd === 0 &&
				model.rates !== null &&
				hasPositiveRates(model.rates));
		if (shouldEstimate && model.rates) {
			record.costUsd = estimate(record, model.rates);
			record.costEstimated = true;
		}
	}
	return warning;
}
