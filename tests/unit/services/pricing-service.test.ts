import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageRecord } from "../../../shared/types";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import {
	createPricingService,
	DefaultPricingService,
	defaultPricingService,
	resolveModelsDevCachePath,
	STATIC_MODEL_RATES,
} from "../../../src/services/pricing";

describe("Services: PricingService Modernization (Feature 8)", () => {
	const tmpRoot = path.join(
		os.tmpdir(),
		`ct-pricing-service-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	afterAll(() => {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	});

	test("F8-T1-01: Cache path resolution and legacy macOS migration", () => {
		const mockHome = path.join(tmpRoot, "mock-home-pricing");
		const legacyDir = path.join(
			mockHome,
			"Library",
			"Caches",
			"harness-token-usage",
		);
		mkdirSync(legacyDir, { recursive: true });

		const legacyFile = path.join(legacyDir, "models.dev.json");
		const sampleCatalog = JSON.stringify({
			openai: {
				models: {
					"gpt-4o": {
						id: "gpt-4o",
						cost: { input: 2.5, output: 10.0 },
					},
				},
			},
		});
		writeFileSync(legacyFile, sampleCatalog);

		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: mockHome,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);

		const cachePath = resolveModelsDevCachePath(mockPaths);
		expect(existsSync(cachePath)).toBe(true);
		expect(readFileSync(cachePath, "utf-8")).toBe(sampleCatalog);
	});

	test("F8-T1-02: Built-in static fallback rates cover major LLM architectures", () => {
		expect(STATIC_MODEL_RATES["claude-3-5-sonnet"]).toBeDefined();
		expect(STATIC_MODEL_RATES["gpt-4o"]).toBeDefined();
		expect(STATIC_MODEL_RATES["deepseek-v3"]).toBeDefined();
		expect(STATIC_MODEL_RATES["deepseek-r1"]).toBeDefined();
		expect(STATIC_MODEL_RATES["gemini-1.5-pro"]).toBeDefined();
		expect(STATIC_MODEL_RATES["gemini-2.0-flash"]).toBeDefined();

		const sonnet = STATIC_MODEL_RATES["claude-3-5-sonnet"];
		expect(sonnet?.input).toBe(3.0);
		expect(sonnet?.output).toBe(15.0);
		expect(sonnet?.cacheRead).toBe(0.3);
		expect(sonnet?.cacheWrite).toBe(3.75);
	});

	test("F8-T1-03: Cost calculation formula handles reasoning deduction and cache tiers", () => {
		const service = new DefaultPricingService();

		// Case 1: GPT-4o calculation
		// Rates: input=2.5, output=10.0, cacheRead=1.25, cacheWrite=2.5 per 1M tokens
		// 1,000,000 input = $2.50
		// 500,000 output = $5.00
		// Total = $7.50
		const costGpt = service.calculateCost("gpt-4o", 1_000_000, 500_000);
		expect(costGpt).toBeCloseTo(7.5, 4);

		// Case 2: DeepSeek R1 reasoning deduction
		// DeepSeek R1: input=0.55, output=2.19, reasoning=2.19, cacheRead=0.14
		// 100k input ($0.055) + 50k output with 30k reasoning
		const costR1 = service.calculateCost(
			"deepseek-r1",
			100_000,
			50_000,
			0,
			0,
			30_000,
		);
		expect(costR1).toBeDefined();
		expect(costR1 ?? 0).toBeGreaterThan(0);

		// Case 3: Unknown model returns null
		const costUnknown = service.calculateCost(
			"completely-unknown-model-xyz",
			100,
			100,
		);
		expect(costUnknown).toBeNull();
	});

	test("F8-T1-04: enrichRecords populates missing costUsd and marks costEstimated", async () => {
		const service = new DefaultPricingService();

		const records: UsageRecord[] = [
			{
				harness: "codex",
				sessionId: "s1",
				messageId: "m1",
				turnId: undefined,
				isSubagent: false,
				cwd: "/home/app",
				model: "gpt-4o",
				timestamp: 1000,
				inputTokens: 100_000,
				outputTokens: 50_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				costEstimated: false,
			},
			{
				harness: "codex",
				sessionId: "s2",
				messageId: "m2",
				turnId: undefined,
				isSubagent: false,
				cwd: "/home/app",
				model: "gpt-4o",
				timestamp: 2000,
				inputTokens: 100_000,
				outputTokens: 50_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 1.23, // Already has exact cost
				costEstimated: false,
			},
		];

		const enriched = await service.enrichRecords(records);
		expect(enriched).toHaveLength(2);

		// Record 1 was estimated
		expect(enriched[0]?.costUsd).toBeCloseTo(0.75, 2);
		expect(enriched[0]?.costEstimated).toBe(true);

		// Record 2 preserved existing cost
		expect(enriched[1]?.costUsd).toBe(1.23);
		expect(enriched[1]?.costEstimated).toBe(false);
	});

	test("F8-T1-05: Network error falls back gracefully to stale cache / static fallback", async () => {
		const mockFailingFetch = async () => {
			throw new Error("DNS lookup failure");
		};

		const isolatedDir = path.join(tmpRoot, "pricing-offline");
		mkdirSync(isolatedDir, { recursive: true });

		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: isolatedDir,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);

		const service = new DefaultPricingService({
			paths: mockPaths,
			fetchFn: mockFailingFetch as unknown as typeof fetch,
		});

		// init should not throw on network failure
		await service.init();

		// Should still calculate cost using static baseline
		const cost = service.calculateCost("gpt-4o", 10_000, 5_000);
		expect(cost).toBeDefined();
		expect(cost ?? 0).toBeGreaterThan(0);
	});

	test("F8-T1-06: Factory createPricingService and defaultPricingService singleton", () => {
		const custom = createPricingService();
		expect(custom).toBeInstanceOf(DefaultPricingService);
		expect(defaultPricingService).toBeInstanceOf(DefaultPricingService);
	});
});
