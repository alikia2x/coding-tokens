import { describe, expect, test } from "bun:test";
import {
	buildAdditiveStackedAreaPaths,
	computeMonotoneSlopes,
	evaluateHermiteSegment,
} from "../../../app/lib/stacked-area";

describe("Additive Monotone Stacked Area Geometry", () => {
	test("guarantees non-crossing and non-negative stacked boundaries across adversarial spikes", () => {
		const xs = [0, 40, 80, 120, 160, 200, 240];
		// Scenarios reproducing the screenshot glitches:
		// - index 1..3: V-valley in layer 0 while layer 1 spikes then drops to 0
		// - index 4..6: layer 0 peaks at 65 -> 0 while layer 2 plunges 75 -> 0 -> 0
		const layer0 = [30, 10, 40, 2, 40, 65, 0];
		const layer1 = [5, 25, 0, 0.3, 15, 0, 0];
		const layer2 = [0, 0, 18, 0, 75, 0, 0];
		const layers = [layer0, layer1, layer2];

		const slopesByLayer = layers.map((ys) => computeMonotoneSlopes(xs, ys));

		for (let i = 0; i < xs.length - 1; i += 1) {
			const dx = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
			for (let step = 0; step <= 20; step += 1) {
				const t = step / 20;
				let cumulative = 0;
				for (let s = 0; s < layers.length; s += 1) {
					const ys = layers[s] ?? [];
					const ms = slopesByLayer[s] ?? [];
					const value = evaluateHermiteSegment(
						ys[i] ?? 0,
						ys[i + 1] ?? 0,
						ms[i] ?? 0,
						ms[i + 1] ?? 0,
						dx,
						t,
					);
					expect(value).toBeGreaterThanOrEqual(-1e-9);
					const nextCumulative = cumulative + value;
					expect(nextCumulative).toBeGreaterThanOrEqual(cumulative - 1e-9);
					cumulative = nextCumulative;
				}
			}
		}
	});

	test("suppresses top stroke on pure-zero and sub-pixel dust intervals while keeping visible bands crisp", () => {
		const xs = [0, 50, 100, 150, 200];
		const layer0 = [20, 20, 20, 20, 20];
		const dustOnly = [0, 0.4, 0, 0, 0];
		const normalIsland = [0, 0, 0, 35, 0];

		const paths = buildAdditiveStackedAreaPaths(
			xs,
			[layer0, dustOnly, normalIsland],
			300,
			1.2,
		);

		expect(paths[0]?.fillPath.startsWith("M0.00,280.00")).toBe(true);
		expect(paths[0]?.strokePath).toContain("M0.00,280.00");

		// Dust layer (< 1.2px) keeps fill polygon for hover/accuracy but omits stray wire stroke
		expect(paths[1]?.fillPath.length).toBeGreaterThan(0);
		expect(paths[1]?.strokePath).toBe("");

		// Active island starts stroke only at rising edge (index 2 -> 3 -> 4), omitting flat 0..2
		expect(paths[2]?.strokePath.startsWith("M100.00,")).toBe(true);
		expect(paths[2]?.strokePath).not.toContain("M0.00,");
		expect(paths[2]?.strokePath).not.toContain("M50.00,");
	});
});
