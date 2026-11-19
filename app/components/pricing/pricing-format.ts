import type { TokenRates } from "@shared/types";

export function formatUnitRate(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "$0";
	if (value >= 1) {
		const fixed = value
			.toFixed(2)
			.replace(/\.00$/u, "")
			.replace(/(\.\d)0$/u, "$1");
		return `$${fixed}`;
	}
	const fixed = value.toFixed(4).replace(/\.?0+$/u, "");
	return `$${fixed}`;
}

export function isFreeRates(rates: TokenRates | null | undefined): boolean {
	if (!rates) return false;
	return (
		rates.input === 0 &&
		rates.output === 0 &&
		(rates.cacheRead ?? 0) === 0 &&
		(rates.cacheWrite ?? 0) === 0 &&
		(rates.reasoning ?? 0) === 0
	);
}

export function formatRatePair(
	rates: TokenRates | null | undefined,
): string | null {
	if (!rates) return null;
	if (isFreeRates(rates)) return "$0";
	return `${formatUnitRate(rates.input)} / ${formatUnitRate(rates.output)}`;
}

export function estimateRowCostFromRates(
	totals: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		reasoningTokens: number;
	},
	rates: TokenRates,
): number {
	const netOutput = Math.max(0, totals.outputTokens - totals.reasoningTokens);
	const reasoningRate = rates.reasoning ?? rates.output;
	const readRate = rates.cacheRead ?? rates.input;
	const writeRate = rates.cacheWrite ?? rates.input;
	return (
		(totals.inputTokens * rates.input +
			netOutput * rates.output +
			totals.reasoningTokens * reasoningRate +
			totals.cacheReadTokens * readRate +
			totals.cacheWriteTokens * writeRate) /
		1_000_000
	);
}
