import type { HarnessMetadata, HarnessName } from "./types";

export type ColorDimension = "harness" | "project" | "model" | "token";

export const categoricalColors = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--chart-6)",
	"var(--chart-7)",
	"var(--chart-8)",
	"var(--chart-9)",
	"var(--chart-10)",
];

export const otherColor = "var(--chart-other)";

export interface TokenColors {
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
	[key: string]: string | undefined;
}

export const tokenColors: TokenColors = {
	input: "var(--chart-1)",
	output: "var(--chart-2)",
	cacheRead: "var(--chart-7)",
	cacheWrite: "var(--chart-4)",
};

/**
 * Default built-in harness metadata definitions.
 */
export const BUILTIN_HARNESS_METADATA: readonly HarnessMetadata[] = [
	{
		id: "codex",
		displayName: "Codex",
		shortLabel: "Codex",
		color: "var(--chart-1)",
		description: "OpenAI Codex CLI",
		defaultEnabled: true,
	},
	{
		id: "dsh",
		displayName: "DSH",
		shortLabel: "DSH",
		color: "var(--chart-2)",
		description: "DeepSeek Harness",
		defaultEnabled: true,
	},
	{
		id: "opencode",
		displayName: "OpenCode",
		shortLabel: "OC",
		color: "var(--chart-3)",
		description: "OpenCode assistant",
		defaultEnabled: true,
	},
	{
		id: "commandcode",
		displayName: "Command Code",
		shortLabel: "CC",
		color: "var(--chart-4)",
		description: "Command Code terminal assistant",
		defaultEnabled: true,
	},
	{
		id: "antigravity",
		displayName: "Antigravity",
		shortLabel: "AG",
		color: "var(--chart-5)",
		description: "Google Antigravity / Gemini",
		defaultEnabled: true,
	},
	{
		id: "claude",
		displayName: "Claude Code",
		shortLabel: "Claude",
		color: "var(--chart-6)",
		description: "Anthropic Claude Code CLI",
		defaultEnabled: true,
	},
	{
		id: "cline",
		displayName: "Cline",
		shortLabel: "Cline",
		color: "var(--chart-7)",
		description: "Cline VS Code autonomous coding agent",
		defaultEnabled: true,
	},
	{
		id: "roo",
		displayName: "Roo Code",
		shortLabel: "Roo",
		color: "var(--chart-8)",
		description: "Roo Code mode-aware AI coding agent",
		defaultEnabled: true,
	},
	{
		id: "continue",
		displayName: "Continue",
		shortLabel: "Cont",
		color: "var(--chart-9)",
		description: "Continue open-source AI code assistant",
		defaultEnabled: true,
	},
	{
		id: "cursor",
		displayName: "Cursor",
		shortLabel: "Cur",
		color: "var(--chart-10)",
		description: "Cursor AI IDE Composer and Agent",
		defaultEnabled: true,
	},
	{
		id: "copilot",
		displayName: "GitHub Copilot",
		shortLabel: "GH",
		color: "light-dark(oklch(0.6 0.15 250), oklch(0.7 0.14 250))",
		description: "GitHub Copilot chat and CLI",
		defaultEnabled: true,
	},
	{
		id: "aider",
		displayName: "Aider",
		shortLabel: "Aid",
		color: "light-dark(oklch(0.62 0.16 140), oklch(0.72 0.15 140))",
		description: "Aider AI pair programming in terminal",
		defaultEnabled: true,
	},
	{
		id: "windsurf",
		displayName: "Windsurf",
		shortLabel: "Wind",
		color: "light-dark(oklch(0.58 0.16 200), oklch(0.68 0.15 200))",
		description: "Windsurf / Codeium Cascade agent",
		defaultEnabled: true,
	},
	{
		id: "goose",
		displayName: "Goose",
		shortLabel: "Goose",
		color: "light-dark(oklch(0.64 0.17 65), oklch(0.74 0.16 65))",
		description: "Block Goose open source agent",
		defaultEnabled: true,
	},
	{
		id: "openhands",
		displayName: "OpenHands",
		shortLabel: "OH",
		color: "light-dark(oklch(0.6 0.18 30), oklch(0.7 0.17 30))",
		description: "OpenHands software dev agent",
		defaultEnabled: true,
	},
];

const registry = new Map<string, HarnessMetadata>();

function initRegistry(): void {
	registry.clear();
	for (const meta of BUILTIN_HARNESS_METADATA) {
		registry.set(meta.id, { ...meta });
	}
}
initRegistry();

export function registerHarness(meta: HarnessMetadata): void {
	registry.set(meta.id, {
		...meta,
		color: meta.color || generateOklchColor(`harness:${meta.id}`),
		shortLabel:
			meta.shortLabel ||
			(meta.displayName.length <= 3
				? meta.displayName.toUpperCase()
				: meta.displayName.slice(0, 2).toUpperCase()),
	});
}

export function unregisterHarness(id: string): boolean {
	return registry.delete(id);
}

export function getHarnessMetadata(
	harness: string,
): HarnessMetadata | undefined {
	return registry.get(harness);
}

export function getAllHarnessMetadata(): HarnessMetadata[] {
	return Array.from(registry.values());
}

export function isKnownHarness(harness: string): boolean {
	return registry.has(harness);
}

export function resetHarnessRegistry(): void {
	initRegistry();
}

function formatFallbackLabel(id: string): string {
	if (!id) return "Unknown";
	return id
		.split(/[-_]/)
		.map((part) => (part ? part[0]?.toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function formatFallbackShortLabel(id: string): string {
	if (!id) return "??";
	if (id.length <= 3) return id.toUpperCase();
	const parts = id.split(/[-_]/);
	if (parts.length >= 2) {
		return parts
			.slice(0, 3)
			.map((p) => p[0]?.toUpperCase() ?? "")
			.join("");
	}
	return id.slice(0, 2).toUpperCase();
}

const GOLDEN_ANGLE = 137.50776405003785;

function hashColorSeed(seed: string): number {
	let hash = 2166136261;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 2246822507) >>> 0;
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 3266489909) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

export function generateOklchColor(seed: string): string {
	const hash = hashColorSeed(seed);
	const hue = Number(
		(((hash / 0x100000000) * 360 + GOLDEN_ANGLE) % 360).toFixed(1),
	);
	const band = (hash >>> 24) % 3;
	const lightL = (0.58 + band * 0.035).toFixed(3);
	const darkL = (0.7 + band * 0.03).toFixed(3);
	const lightC = (0.145 - band * 0.01).toFixed(3);
	const darkC = (0.135 - band * 0.008).toFixed(3);
	return `light-dark(oklch(${lightL} ${lightC} ${hue}), oklch(${darkL} ${darkC} ${hue}))`;
}

export function getHarnessColor(harness: string): string {
	const meta = registry.get(harness);
	if (meta?.color) return meta.color;
	return generateOklchColor(`harness:${harness}`);
}

export function getHarnessLabel(harness: string): string {
	const meta = registry.get(harness);
	if (meta?.displayName) return meta.displayName;
	return formatFallbackLabel(harness);
}

export function getHarnessShortLabel(harness: string): string {
	const meta = registry.get(harness);
	if (meta?.shortLabel) return meta.shortLabel;
	return formatFallbackShortLabel(harness);
}

export const harnessColor: Record<HarnessName, string> = new Proxy(
	{} as Record<HarnessName, string>,
	{
		get(_target, prop: string | symbol) {
			if (typeof prop !== "string") return undefined;
			return getHarnessColor(prop);
		},
		has(_target, prop: string | symbol) {
			if (typeof prop !== "string") return false;
			return isKnownHarness(prop);
		},
		ownKeys() {
			return Array.from(registry.keys());
		},
		getOwnPropertyDescriptor(_target, prop: string | symbol) {
			if (typeof prop === "string" && registry.has(prop)) {
				return {
					enumerable: true,
					configurable: true,
					value: getHarnessColor(prop),
					writable: false,
				};
			}
			return undefined;
		},
	},
);

export const HARNESS_LABELS: Record<HarnessName, string> = new Proxy(
	{} as Record<HarnessName, string>,
	{
		get(_target, prop: string | symbol) {
			if (typeof prop !== "string") return undefined;
			return getHarnessLabel(prop);
		},
		has(_target, prop: string | symbol) {
			if (typeof prop !== "string") return false;
			return isKnownHarness(prop);
		},
		ownKeys() {
			return Array.from(registry.keys());
		},
		getOwnPropertyDescriptor(_target, prop: string | symbol) {
			if (typeof prop === "string" && registry.has(prop)) {
				return {
					enumerable: true,
					configurable: true,
					value: getHarnessLabel(prop),
					writable: false,
				};
			}
			return undefined;
		},
	},
);

export const HARNESS_SHORT_LABELS: Record<HarnessName, string> = new Proxy(
	{} as Record<HarnessName, string>,
	{
		get(_target, prop: string | symbol) {
			if (typeof prop !== "string") return undefined;
			return getHarnessShortLabel(prop);
		},
		has(_target, prop: string | symbol) {
			if (typeof prop !== "string") return false;
			return isKnownHarness(prop);
		},
		ownKeys() {
			return Array.from(registry.keys());
		},
		getOwnPropertyDescriptor(_target, prop: string | symbol) {
			if (typeof prop === "string" && registry.has(prop)) {
				return {
					enumerable: true,
					configurable: true,
					value: getHarnessShortLabel(prop),
					writable: false,
				};
			}
			return undefined;
		},
	},
);

export function colorForSeries(
	key: string,
	_index?: number,
	dimension?: ColorDimension | null,
): string {
	if (key === "__other") return otherColor;
	if (dimension === "token") return tokenColors[key] ?? otherColor;
	if (dimension === "harness") {
		return getHarnessColor(key);
	}
	if (!key || key === "all" || key === "value")
		return categoricalColors[0] as string;
	return generateOklchColor(`${dimension ?? "series"}:${key}`);
}

export function colorForKey(
	key: string,
	dimension?: ColorDimension | null,
	_index?: number,
): string {
	return colorForSeries(key, undefined, dimension);
}
