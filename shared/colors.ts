import type { HarnessName } from "./types";

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

export const tokenColors: Record<string, string> = {
	input: "var(--chart-1)",
	output: "var(--chart-2)",
	cacheRead: "var(--chart-7)",
	cacheWrite: "var(--chart-4)",
};

export const harnessColor: Record<HarnessName, string> = {
	codex: "var(--chart-1)",
	dsh: "var(--chart-2)",
	opencode: "var(--chart-3)",
	commandcode: "var(--chart-4)",
	antigravity: "var(--chart-5)",
};

const GOLDEN_ANGLE = 137.50776405003785;

/**
 * FNV-1a with a final avalanche step. Unlike a palette index, the hash depends
 * only on the category and key, so the same category keeps its color when the
 * data is re-sorted, filtered or split across charts and legends.
 */
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

/**
 * Generates a perceptually uniform OKLCH color from a stable seed. The hue is
 * derived from the seed so unrelated categories do not drift into neighboring
 * palette slots; the band varies lightness and chroma to keep colors legible
 * in both themes.
 */
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

/**
 * Deterministically maps a series key to a color. The optional index is kept
 * for callers that still pass a display position, but it never affects the
 * result: identity, not ordering, chooses the color.
 */
export function colorForSeries(
	key: string,
	_index?: number,
	dimension?: ColorDimension | null,
): string {
	if (key === "__other") return otherColor;
	if (dimension === "token") return tokenColors[key] ?? otherColor;
	if (dimension === "harness") {
		const color = harnessColor[key as HarnessName];
		if (color) return color;
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
