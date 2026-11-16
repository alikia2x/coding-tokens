import { describe, expect, test } from "bun:test";
import {
	BUILTIN_HARNESS_METADATA,
	colorForKey,
	colorForSeries,
	generateOklchColor,
	getAllHarnessMetadata,
	getHarnessLabel,
	getHarnessMetadata,
	getHarnessShortLabel,
	HARNESS_LABELS,
	HARNESS_SHORT_LABELS,
	harnessColor,
	isKnownHarness,
	registerHarness,
	resetHarnessRegistry,
	tokenColors,
	unregisterHarness,
} from "../../../shared/colors";

describe("Models: Dynamic Harness Registry & Colors (Feature 4)", () => {
	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F4-T1-01: BUILTIN_HARNESS_METADATA completeness for 15 mainstream harnesses", () => {
		expect(BUILTIN_HARNESS_METADATA.length).toBe(15);
		const expectedIds = [
			"codex",
			"dsh",
			"opencode",
			"commandcode",
			"antigravity",
			"claude",
			"cline",
			"roo",
			"continue",
			"cursor",
			"copilot",
			"aider",
			"windsurf",
			"goose",
			"openhands",
		];
		const ids = BUILTIN_HARNESS_METADATA.map((m) => m.id);
		for (const id of expectedIds) {
			expect(ids).toContain(id);
			const meta = BUILTIN_HARNESS_METADATA.find((m) => m.id === id);
			expect(meta).toBeDefined();
			expect(meta?.displayName.length).toBeGreaterThan(0);
			expect(meta?.shortLabel.length).toBeGreaterThan(0);
			expect(meta?.color.length).toBeGreaterThan(0);
		}
	});

	test("F4-T1-02: Dynamic harness registration and metadata lookup", () => {
		resetHarnessRegistry();
		registerHarness({
			id: "kilo-code",
			displayName: "Kilo Code",
			shortLabel: "KC",
			color: "#123456",
			description: "Custom harness",
		});

		expect(isKnownHarness("kilo-code")).toBe(true);
		const meta = getHarnessMetadata("kilo-code");
		expect(meta).toBeDefined();
		expect(meta?.displayName).toBe("Kilo Code");
		expect(meta?.shortLabel).toBe("KC");
		expect(meta?.color).toBe("#123456");

		// Clean up
		unregisterHarness("kilo-code");
	});

	test("F4-T1-03: Dynamic unregistration and registry reset restores defaults", () => {
		registerHarness({
			id: "temp-agent",
			displayName: "Temp Agent",
			shortLabel: "TA",
			color: "#998877",
		});
		expect(isKnownHarness("temp-agent")).toBe(true);

		const unregistered = unregisterHarness("temp-agent");
		expect(unregistered).toBe(true);
		expect(isKnownHarness("temp-agent")).toBe(false);

		// Unregistering a non-existent harness returns false
		expect(unregisterHarness("non-existent-agent")).toBe(false);

		// Resetting registry restores original 15 builtins
		resetHarnessRegistry();
		expect(getAllHarnessMetadata().length).toBe(15);
	});

	test("F4-T1-06: Deterministic series color assignment by dimension (colorForSeries & colorForKey)", () => {
		// Harness dimension: returns registered color
		expect(colorForSeries("codex", 0, "harness")).toBe("var(--chart-1)");
		expect(colorForKey("dsh", "harness")).toBe("var(--chart-2)");
		expect(colorForKey("claude", "harness")).toBe("var(--chart-6)");

		// Token dimension: returns predefined token color
		expect(colorForSeries("input", 0, "token")).toBe(tokenColors.input ?? "");
		expect(colorForSeries("output", 1, "token")).toBe(tokenColors.output ?? "");
		expect(colorForSeries("cacheRead", 2, "token")).toBe(
			tokenColors.cacheRead ?? "",
		);
		expect(colorForSeries("cacheWrite", 3, "token")).toBe(
			tokenColors.cacheWrite ?? "",
		);
		expect(colorForSeries("reasoning", 4, "token")).toBe("var(--chart-other)");

		// Other dimension: returns otherColor
		expect(colorForSeries("__other", 0, "model")).toBe("var(--chart-other)");

		// Custom model or project dimension: derives stable OKLCH
		const color1 = colorForSeries("gpt-4o", 0, "model");
		const color2 = colorForSeries("gpt-4o", 0, "model");
		expect(color1).toBe(color2);
		expect(color1).toMatch(/^light-dark\(oklch\(/u);
	});

	// =========================================================================
	// Tier 2: Boundary & Formatting Cases
	// =========================================================================

	test("F4-T2-01: Fallback display label formatting for unregistered harness slugs", () => {
		expect(getHarnessLabel("my-custom-agent")).toBe("My Custom Agent");
		expect(getHarnessLabel("deep_harness")).toBe("Deep Harness");
		expect(getHarnessLabel("simple")).toBe("Simple");
		expect(getHarnessLabel("camelCaseSlug")).toBe("CamelCaseSlug");
	});

	test("F4-T2-02: Fallback short label generation for multi-part and short IDs", () => {
		// Short strings (<= 3 chars) are uppercased
		expect(getHarnessShortLabel("cat")).toBe("CAT");
		expect(getHarnessShortLabel("ai")).toBe("AI");

		// Multi-part hyphenated slugs take initial letters
		expect(getHarnessShortLabel("super-ai-agent")).toBe("SAA");
		expect(getHarnessShortLabel("my-custom-tool")).toBe("MCT");

		// Single word takes first two letters
		expect(getHarnessShortLabel("singleword")).toBe("SI");
	});

	test("F4-T2-03: Deterministic OKLCH color stability and format", () => {
		const seedA = "agent:alpha";
		const seedB = "agent:beta";

		const colorA1 = generateOklchColor(seedA);
		const colorA2 = generateOklchColor(seedA);
		const colorB = generateOklchColor(seedB);

		expect(colorA1).toBe(colorA2);
		expect(colorA1).not.toBe(colorB);
		expect(colorA1).toMatch(
			/^light-dark\(oklch\(0\.[0-9]+ 0\.[0-9]+ [0-9.]+\), oklch\(0\.[0-9]+ 0\.[0-9]+ [0-9.]+\)\)$/u,
		);
	});

	test("F4-T2-04: Proxy object reflection and undefined key safety", () => {
		resetHarnessRegistry();

		// Property reads on proxy
		expect(harnessColor.codex).toBe("var(--chart-1)");
		expect(HARNESS_LABELS.codex).toBe("Codex");
		expect(HARNESS_SHORT_LABELS.codex).toBe("Codex");

		// Dynamic property reads for unregistered keys return deterministic fallbacks
		const unregisteredColor = (harnessColor as Record<string, string>)[
			"unregistered-agent"
		];
		expect(unregisteredColor).toMatch(/^light-dark\(oklch\(/u);

		const unregisteredLabel = (HARNESS_LABELS as Record<string, string>)[
			"unregistered-agent"
		];
		expect(unregisteredLabel).toBe("Unregistered Agent");

		const unregisteredShort = (HARNESS_SHORT_LABELS as Record<string, string>)[
			"unregistered-agent"
		];
		expect(unregisteredShort).toBe("UA");

		// Reflection: 'in' operator
		expect("codex" in harnessColor).toBe(true);
		expect("claude" in HARNESS_LABELS).toBe(true);
		expect("unregistered-agent" in harnessColor).toBe(false);

		// Reflection: Object.keys() returns built-in keys
		const keys = Object.keys(harnessColor);
		expect(keys.length).toBe(15);
		expect(keys).toContain("codex");
		expect(keys).toContain("antigravity");
	});
});
