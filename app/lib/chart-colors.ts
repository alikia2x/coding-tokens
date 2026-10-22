import type { HarnessName } from "@shared/types";
import { harnessColor } from "~/components/harness-badge";

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

const GOLDEN_ANGLE = 137.50776405003785;

/**
 * Generates a perceptually uniform OKLCH color using golden-angle hue stepping
 * that adapts automatically to light and dark modes via CSS `light-dark()`.
 */
export function generateOklchColor(index: number): string {
	const hue = Number(((258 + index * GOLDEN_ANGLE) % 360).toFixed(1));
	const band = index % 3;
	const lightL = (0.58 + band * 0.035).toFixed(3);
	const darkL = (0.7 + band * 0.03).toFixed(3);
	const lightC = (0.145 - band * 0.01).toFixed(3);
	const darkC = (0.135 - band * 0.008).toFixed(3);
	return `light-dark(oklch(${lightL} ${lightC} ${hue}), oklch(${darkL} ${darkC} ${hue}))`;
}

export function colorForSeries(
	key: string,
	index: number,
	dimension?: "harness" | "project" | "model" | "token" | null,
): string {
	if (key === "__other") return otherColor;
	if (dimension === "token") return tokenColors[key] ?? otherColor;
	if (dimension === "harness") {
		const color = harnessColor[key as HarnessName];
		if (color) return color;
	}
	if (!key || key === "all" || key === "value")
		return categoricalColors[0] as string;
	if (index < categoricalColors.length)
		return categoricalColors[index] as string;
	return generateOklchColor(index);
}

export function colorForKey(
	key: string,
	dimension?: "harness" | "project" | "model" | "token" | null,
	index?: number,
): string {
	if (index !== undefined) return colorForSeries(key, index, dimension);
	if (key === "__other") return otherColor;
	if (dimension === "harness") {
		const color = harnessColor[key as HarnessName];
		if (color) return color;
	}
	if (!key || key === "all" || key === "value")
		return categoricalColors[0] as string;
	let hash = 2166136261;
	for (let i = 0; i < key.length; i += 1) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return categoricalColors[hash % categoricalColors.length] as string;
}
