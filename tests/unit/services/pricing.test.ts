import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageRecord } from "@shared/types";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import {
	applyCatalog,
	enrichWithModelsDev,
	readCatalog,
	resolveModel,
} from "../../../src/pricing/modelsdev";
import {
	createPricingService,
	DefaultPricingService,
	defaultPricingService,
	resolveModelsDevCachePath,
	STATIC_MODEL_RATES,
} from "../../../src/services/pricing";

describe("Services: PricingService & models.dev Modernization (Feature 8)", () => {
	const sampleCatalogData = {
		openai: {
			models: {
				"gpt-4o": {
					id: "gpt-4o",
					name: "GPT-4o",
					cost: {
						input: 2.5, // $2.50 per 1M tokens
						output: 10.0, // $10.00 per 1M tokens
						reasoning: 10.0,
						cache_read: 1.25,
						cache_write: 2.5,
					},
				},
				"free-model": {
					id: "free-model",
					name: "Free Model",
					cost: {
						input: 0,
						output: 0,
						reasoning: 0,
						cache_read: 0,
						cache_write: 0,
					},
				},
			},
		},
		anthropic: {
			models: {
				"claude-3-5-sonnet": {
					id: "claude-3-5-sonnet",
					name: "Claude 3.5 Sonnet",
					cost: {
						input: 3.0,
						output: 15.0,
						cache_read: 0.3,
						cache_write: 3.75,
					},
				},
			},
		},
		deepseek: {
			models: {
				"deepseek-chat": {
					id: "deepseek-chat",
					name: "DeepSeek Chat",
					cost: {
						input: 0.14,
						output: 0.28,
						cache_read: 0.014,
					},
				},
			},
		},
		moonshot: {
			models: {
				"moonshot-v1": {
					id: "moonshot-v1",
					name: "Moonshot V1",
					cost: {
						input: 1.0,
						output: 1.0,
					},
				},
			},
		},
		reseller: {
			models: {
				"resold-gpt4o": {
					id: "resold-gpt4o",
					name: "Resold GPT-4o",
					canonical_model_id: "openai/gpt-4o",
					cost: {
						input: 5.0,
						output: 20.0,
					},
				},
			},
		},
	};

	const catalog = readCatalog(sampleCatalogData);

	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F8-T1-01: Multi-dimensional token cost estimation formula calculation", () => {
		// Formula:
		// (input * rates.input +
		//  output * rates.output +
		//  reasoning * rates.reasoning +
		//  cacheRead * rates.cacheRead +
		//  cacheWrite * rates.cacheWrite) / 1_000_000
		const record: UsageRecord = {
			harness: "codex",
			sessionId: "sess-1",
			messageId: "msg-1",
			cwd: null,
			model: "gpt-4o",
			timestamp: 1700000000000,
			inputTokens: 1000,
			outputTokens: 500, // total output
			reasoningTokens: 200, // net output = 500 - 200 = 300
			cacheReadTokens: 300,
			cacheWriteTokens: 100,
			costUsd: null,
			costEstimated: false,
		};

		applyCatalog([record], catalog, null);

		// gpt-4o rates: input=2.5, output=10.0, reasoning=10.0, cacheRead=1.25, cacheWrite=2.5
		// Expected:
		// (1000 * 2.5 + 300 * 10.0 + 200 * 10.0 + 300 * 1.25 + 100 * 2.5) / 1,000,000
		// = (2500 + 3000 + 2000 + 375 + 250) / 1,000,000
		// = 8125 / 1,000,000 = 0.008125
		expect(record.costUsd).toBeCloseTo(0.008125, 6);
		expect(record.costEstimated).toBe(true);
		expect(record.model).toBe("GPT-4o");
	});

	test("F8-T1-02: Provider aliases resolution (deepseek-ai and moonshot-ai)", () => {
		const deepseekEntry = resolveModel(
			"deepseek-ai/deepseek-chat",
			"dsh",
			catalog,
		);
		expect(deepseekEntry).toBeDefined();
		expect(deepseekEntry?.provider).toBe("deepseek");
		expect(deepseekEntry?.name).toBe("DeepSeek Chat");

		const moonshotEntry = resolveModel(
			"moonshot-ai/moonshot-v1",
			"opencode",
			catalog,
		);
		expect(moonshotEntry).toBeDefined();
		expect(moonshotEntry?.provider).toBe("moonshot");
		expect(moonshotEntry?.name).toBe("Moonshot V1");
	});

	test("F8-T1-03: Model variant stripping and suffix normalization", () => {
		const resolvedLatest = resolveModel(
			"claude-3-5-sonnet-latest",
			"antigravity",
			catalog,
		);
		expect(resolvedLatest).toBeDefined();
		expect(resolvedLatest?.name).toBe("Claude 3.5 Sonnet");

		const resolvedHashed = resolveModel(
			"gpt-4o#experimental",
			"codex",
			catalog,
		);
		expect(resolvedHashed).toBeDefined();
		expect(resolvedHashed?.name).toBe("GPT-4o");
	});

	test("F8-T1-04: Upstream reseller canonical model ID matching", () => {
		const resellerEntry = resolveModel(
			"reseller/resold-gpt4o",
			"opencode",
			catalog,
		);
		expect(resellerEntry).toBeDefined();
		expect(resellerEntry?.canonicalId).toBe("openai/gpt-4o");
		expect(resellerEntry?.name).toBe("Resold GPT-4o");
	});

	test("F8-T1-05: Batch enrichment marks costEstimated flag and sets costUsd", () => {
		const records: UsageRecord[] = [
			{
				harness: "codex",
				sessionId: "s1",
				messageId: "m1",
				cwd: null,
				model: "gpt-4o",
				timestamp: 1000,
				inputTokens: 10000,
				outputTokens: 2000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				costEstimated: false,
			},
			{
				harness: "antigravity",
				sessionId: "s2",
				messageId: "m2",
				cwd: null,
				model: "claude-3-5-sonnet",
				timestamp: 2000,
				inputTokens: 5000,
				outputTokens: 1000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				costEstimated: false,
			},
		];

		const warning = applyCatalog(records, catalog, "Existing warning");
		expect(warning).toBe("Existing warning");

		expect(records[0]?.costEstimated).toBe(true);
		expect(records[0]?.costUsd).toBeGreaterThan(0);
		expect(records[1]?.costEstimated).toBe(true);
		expect(records[1]?.costUsd).toBeGreaterThan(0);
	});

	// =========================================================================
	// Tier 2: Boundary, Failure & Edge Cases
	// =========================================================================

	test("F8-T2-01: Network failure / timeout or cached catalog fallback returns cleanly without crashing", async () => {
		const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "ct-pricing-net-"));
		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: isolatedHome,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);
		const mockFailingFetch = ((..._args: unknown[]) => {
			throw new Error("Network timeout simulated");
		}) as unknown as typeof fetch;

		try {
			const record: UsageRecord = {
				harness: "codex",
				sessionId: "sess-offline",
				messageId: "msg-offline",
				cwd: null,
				model: "gpt-4o",
				timestamp: 1000,
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				costEstimated: false,
			};

			const warning = await enrichWithModelsDev([record], {
				paths: mockPaths,
				fetchFn: mockFailingFetch,
			});
			// With isolated cache and simulated network failure, fallback warning must be returned
			expect(warning).toContain("models.dev pricing could not be reached");
			expect(record.costUsd).toBeNull();
			expect(record.costEstimated).toBe(false);
		} finally {
			rmSync(isolatedHome, { recursive: true, force: true });
		}
	});

	test("F8-T2-02: Zero-cost models (free tiers) preserve costUsd = 0 without estimating", () => {
		const record: UsageRecord = {
			harness: "codex",
			sessionId: "free-sess",
			messageId: "free-msg",
			cwd: null,
			model: "free-model",
			timestamp: 1000,
			inputTokens: 50000,
			outputTokens: 10000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0,
			costEstimated: false,
		};

		applyCatalog([record], catalog, null);
		expect(record.costUsd).toBe(0);
		expect(record.costEstimated).toBe(false);
	});

	test("F8-T2-03: Existing positive cost records remain immutable", () => {
		const record: UsageRecord = {
			harness: "codex",
			sessionId: "paid-sess",
			messageId: "paid-msg",
			cwd: null,
			model: "gpt-4o",
			timestamp: 1000,
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.12345, // Pre-existing authoritative cost
			costEstimated: false,
		};

		applyCatalog([record], catalog, null);
		// Pre-existing authoritative cost must NOT be overwritten
		expect(record.costUsd).toBe(0.12345);
		expect(record.costEstimated).toBe(false);
	});

	test("F8-T2-04: Corrupted / invalid catalog data safely returns empty structure", async () => {
		const emptyCat = readCatalog(null);
		expect(emptyCat.providers.size).toBe(0);
		expect(emptyCat.byProviderModel.size).toBe(0);

		const malformedCat = readCatalog("not an object");
		expect(malformedCat.providers.size).toBe(0);

		// Empty array input to enrichWithModelsDev returns null immediately
		await expect(enrichWithModelsDev([])).resolves.toBeNull();
	});

	test("F8-T2-05: Unresolvable model graceful pass-through without throwing", () => {
		const record: UsageRecord = {
			harness: "codex",
			sessionId: "unknown-sess",
			messageId: "unknown-msg",
			cwd: null,
			model: "completely-unknown-model-xyz",
			timestamp: 1000,
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: null,
			costEstimated: false,
		};

		// Should not throw or crash
		expect(() => {
			applyCatalog([record], catalog, null);
		}).not.toThrow();

		// Model remains unmodified and unpriced
		expect(record.costUsd).toBeNull();
		expect(record.costEstimated).toBe(false);
	});

	test("F8-T2-06: Rate fallback calculation when reasoning and cacheWrite rates are omitted", () => {
		// claude-3-5-sonnet has reasoning rate omitted -> falls back to output rate ($15.0/M)
		const claudeRecord: UsageRecord = {
			harness: "antigravity",
			sessionId: "sess-claude",
			messageId: "msg-claude",
			cwd: null,
			model: "claude-3-5-sonnet",
			timestamp: 1700000000000,
			inputTokens: 1000,
			outputTokens: 500,
			reasoningTokens: 200, // net output = 300
			cacheReadTokens: 100,
			cacheWriteTokens: 50,
			costUsd: null,
			costEstimated: false,
		};

		applyCatalog([claudeRecord], catalog, null);
		// claude-3-5-sonnet rates: input=3.0, output=15.0, reasoningFallback=15.0, cacheRead=0.3, cacheWrite=3.75
		// Cost: (1000 * 3.0 + 300 * 15.0 + 200 * 15.0 + 100 * 0.3 + 50 * 3.75) / 1,000,000
		// = (3000 + 4500 + 3000 + 30 + 187.5) / 1,000,000 = 10717.5 / 1,000,000 = 0.0107175
		expect(claudeRecord.costUsd).toBeCloseTo(0.0107175, 7);
		expect(claudeRecord.costEstimated).toBe(true);

		// deepseek-chat has cache_write omitted -> falls back to input rate ($0.14/M)
		const deepseekRecord: UsageRecord = {
			harness: "dsh",
			sessionId: "sess-ds",
			messageId: "msg-ds",
			cwd: null,
			model: "deepseek-chat",
			timestamp: 1700000000000,
			inputTokens: 10000,
			outputTokens: 2000,
			reasoningTokens: 0,
			cacheReadTokens: 5000,
			cacheWriteTokens: 1000, // fallback to input rate = 0.14
			costUsd: null,
			costEstimated: false,
		};

		applyCatalog([deepseekRecord], catalog, null);
		// deepseek-chat rates: input=0.14, output=0.28, cacheRead=0.014, cacheWriteFallback=0.14
		// Cost: (10000 * 0.14 + 2000 * 0.28 + 0 + 5000 * 0.014 + 1000 * 0.14) / 1,000,000
		// = (1400 + 560 + 70 + 140) / 1,000,000 = 2170 / 1,000,000 = 0.00217
		expect(deepseekRecord.costUsd).toBeCloseTo(0.00217, 6);
		expect(deepseekRecord.costEstimated).toBe(true);
	});
});

describe("Services: DefaultPricingService (Feature 8)", () => {
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
		const isolatedDir = path.join(tmpRoot, "pricing-enrich");
		mkdirSync(isolatedDir, { recursive: true });
		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: isolatedDir,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);
		const mockFailingFetch = (async () => {
			throw new Error("Offline test");
		}) as unknown as typeof fetch;

		const service = new DefaultPricingService({
			paths: mockPaths,
			fetchFn: mockFailingFetch,
		});

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
