import { describe, expect, test } from "bun:test";
import {
	colorForKey,
	colorForSeries,
	generateOklchColor,
	harnessColor,
	otherColor,
	tokenColors,
} from "@shared/colors";

describe("deterministic series colors", () => {
	test("keeps the same color when a series moves position", () => {
		const first = colorForSeries("project-a", 0, "project");
		const later = colorForSeries("project-a", 42, "project");

		expect(later).toBe(first);
		expect(colorForKey("project-a", "project")).toBe(first);
	});

	test("separates different keys and dimensions", () => {
		const project = colorForSeries("codex", 0, "project");
		const model = colorForSeries("codex", 0, "model");
		const otherProject = colorForSeries("dsh", 0, "project");

		expect(project).not.toBe(model);
		expect(project).not.toBe(otherProject);
		expect(project).toMatch(/^light-dark\(oklch\(/u);
	});

	test("derives a stable color from the complete seed", () => {
		expect(generateOklchColor("project:/work/app")).toBe(
			generateOklchColor("project:/work/app"),
		);
		expect(generateOklchColor("project:/work/app")).not.toBe(
			generateOklchColor("project:/work/other"),
		);
	});

	test("keeps fixed harness, token and placeholder colors", () => {
		expect(colorForSeries("codex", 0, "harness")).toBe(
			harnessColor.codex as string,
		);
		expect(colorForSeries("cacheRead", 0, "token")).toBe(
			tokenColors.cacheRead as string,
		);
		expect(colorForSeries("__other", 0, "model")).toBe(otherColor);
		expect(colorForSeries("value", 0)).toBe("var(--chart-1)");
	});
});
