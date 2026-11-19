import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CustomModelPriceRule, UsageRecord } from "@shared/types";
import { openStoreDatabase } from "../../../server/data/database";
import {
	applyPricingToRecords,
	buildModelPricingMeta,
	PricingCatalogManager,
	resolveEffectivePricing,
	searchCatalogEntries,
	summarizeActiveModelsPricing,
} from "../../../src/pricing/engine";
import { readCatalog } from "../../../src/pricing/modelsdev";

const sampleCatalog = readCatalog({
	anthropic: {
		models: {
			"claude-sonnet-4": {
				id: "claude-sonnet-4",
				name: "Claude Sonnet 4",
				release_date: "2025-05-01",
				cost: {
					input: 3.0,
					output: 15.0,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
		},
	},
	google: {
		models: {
			"gemini-2.5-pro": {
				id: "gemini-2.5-pro",
				name: "Gemini 2.5 Pro",
				release_date: "2025-03-01",
				cost: {
					input: 1.25,
					output: 10.0,
					cache_read: 0.3125,
				},
			},
		},
	},
});

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		harness: "opencode",
		sessionId: "sess-1",
		messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
		cwd: "/workspace/app",
		model: "gemini-4-neon",
		timestamp: 1_700_000_000_000,
		inputTokens: 1_000_000,
		outputTokens: 500_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: null,
		costEstimated: false,
		...overrides,
	};
}

describe("Pricing Engine: Custom Rules, Alias Mapping, Lossless Un-override & Fetch History", () => {
	const tmpDir = path.join(
		os.tmpdir(),
		`ct-pricing-engine-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	afterAll(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	test("custom $0 free rate marks unpriced local models as $0 estimated without losing raw state", () => {
		const record = makeRecord({
			harness: "continue",
			model: "qwen2.5-coder-1.5b-instruct-mlx",
			costUsd: null,
		});
		const rules: Record<string, CustomModelPriceRule> = {
			"qwen2.5-coder-1.5b-instruct-mlx": {
				model: "qwen2.5-coder-1.5b-instruct-mlx",
				mode: "rates",
				rates: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 0,
				},
				overrideRecorded: false,
				updatedAt: Date.now(),
			},
		};

		const { changed } = applyPricingToRecords([record], {
			catalog: sampleCatalog,
			rules,
		});
		expect(changed).toHaveLength(1);
		expect(record.costUsd).toBe(0);
		expect(record.costEstimated).toBe(true);
		expect(record.rawCostUsd).toBeNull();

		// Removing the rule restores original unpriced state cleanly
		applyPricingToRecords([record], {
			catalog: sampleCatalog,
			rules: {},
		});
		expect(record.costUsd).toBeNull();
		expect(record.costEstimated).toBe(false);
	});

	test("custom unit rates fall back cacheRead/cacheWrite to input and reasoning to output", () => {
		const record = makeRecord({
			model: "Minimax M2.7",
			inputTokens: 1_000_000,
			outputTokens: 500_000, // 200k reasoning + 300k net output
			reasoningTokens: 200_000,
			cacheReadTokens: 500_000,
			cacheWriteTokens: 100_000,
			costUsd: null,
		});
		const rules: Record<string, CustomModelPriceRule> = {
			"minimax m2.7": {
				model: "Minimax M2.7",
				mode: "rates",
				rates: {
					input: 1.0,
					output: 4.0,
					cacheRead: null,
					cacheWrite: null,
					reasoning: null,
				},
				overrideRecorded: false,
				updatedAt: Date.now(),
			},
		};

		applyPricingToRecords([record], { catalog: sampleCatalog, rules });
		// (1M * 1.0) + (300k * 4.0) + (200k * 4.0) + (500k * 1.0) + (100k * 1.0) = 1.0 + 1.2 + 0.8 + 0.5 + 0.1 = 3.6
		expect(record.costUsd).toBeCloseTo(3.6, 6);
		expect(record.costEstimated).toBe(true);
	});

	test("alias mapping uses catalog rates while preserving model display identity", () => {
		const record = makeRecord({
			harness: "antigravity",
			model: "gemini-4-neon",
			costUsd: null,
		});
		const rules: Record<string, CustomModelPriceRule> = {
			"gemini 4 neon": {
				model: "Gemini 4 Neon",
				mode: "alias",
				aliasTarget: "google/gemini-2.5-pro",
				overrideRecorded: false,
				updatedAt: Date.now(),
			},
		};

		applyPricingToRecords([record], { catalog: sampleCatalog, rules });
		expect(record.model).toBe("Gemini 4 Neon");
		// 1M * 1.25 + 500k * 10 = 6.25
		expect(record.costUsd).toBeCloseTo(6.25, 6);
		expect(record.costEstimated).toBe(true);

		const meta = buildModelPricingMeta("Gemini 4 Neon", [record], {
			catalog: sampleCatalog,
			rules,
		});
		expect(meta.source).toBe("custom_alias");
		expect(meta.matchedCatalogId).toBe("google/gemini-2.5-pro");
		expect(meta.effectiveRates?.input).toBe(1.25);
	});

	test("overrideRecorded: false preserves positive rawCostUsd while overrideRecorded: true overrides and un-override restores it", () => {
		const recordedRec = makeRecord({
			model: "claude-sonnet-4",
			costUsd: 2.5,
			costEstimated: false,
		});
		const unpricedRec = makeRecord({
			model: "claude-sonnet-4",
			costUsd: 0,
			costEstimated: false,
		});

		const nonOverriding: Record<string, CustomModelPriceRule> = {
			"claude sonnet 4": {
				model: "Claude Sonnet 4",
				mode: "rates",
				rates: {
					input: 10,
					output: 20,
					cacheRead: null,
					cacheWrite: null,
					reasoning: null,
				},
				overrideRecorded: false,
				updatedAt: Date.now(),
			},
		};

		applyPricingToRecords([recordedRec, unpricedRec], {
			catalog: sampleCatalog,
			rules: nonOverriding,
		});
		expect(recordedRec.costUsd).toBe(2.5);
		expect(recordedRec.costEstimated).toBe(false);
		expect(recordedRec.rawCostUsd).toBe(2.5);
		// unpricedRec (0 cost) gets custom rate: 1M*10 + 500k*20 = 20
		expect(unpricedRec.costUsd).toBeCloseTo(20, 6);
		expect(unpricedRec.costEstimated).toBe(true);

		const baseRule = nonOverriding["claude sonnet 4"];
		if (!baseRule) throw new Error("Expected base rule");
		const overriding: Record<string, CustomModelPriceRule> = {
			"claude sonnet 4": {
				...baseRule,
				overrideRecorded: true,
			},
		};
		applyPricingToRecords([recordedRec, unpricedRec], {
			catalog: sampleCatalog,
			rules: overriding,
		});
		expect(recordedRec.costUsd).toBeCloseTo(20, 6);
		expect(recordedRec.costEstimated).toBe(true);
		expect(recordedRec.rawCostUsd).toBe(2.5);

		// Delete rule -> recordedRec restores 2.5 losslessly, unpricedRec uses models.dev (1M*3 + 500k*15 = 10.5)
		applyPricingToRecords([recordedRec, unpricedRec], {
			catalog: sampleCatalog,
			rules: {},
		});
		expect(recordedRec.costUsd).toBe(2.5);
		expect(recordedRec.costEstimated).toBe(false);
		expect(unpricedRec.costUsd).toBeCloseTo(10.5, 6);
		expect(unpricedRec.costEstimated).toBe(true);
	});

	test("searchCatalogEntries and summarizeActiveModelsPricing categorize sources accurately", () => {
		const hits = searchCatalogEntries(sampleCatalog, "sonnet", 10);
		expect(hits.length).toBe(1);
		expect(hits[0]?.key).toBe("anthropic/claude-sonnet-4");

		const records = [
			makeRecord({ model: "claude-sonnet-4", costUsd: null }),
			makeRecord({ model: "gemini-4-neon", costUsd: null }),
			makeRecord({ model: "custom-model", costUsd: 1.23 }),
		];
		applyPricingToRecords(records, { catalog: sampleCatalog, rules: {} });
		const summary = summarizeActiveModelsPricing(records, {
			catalog: sampleCatalog,
			rules: {},
		});
		expect(summary.activeModels).toBe(3);
		expect(summary.catalogModels).toBe(1);
		expect(summary.unpricedModels).toBe(1);
		expect(summary.recordedOnlyModels).toBe(1);

		const resolved = resolveEffectivePricing({
			model: "claude-sonnet-4",
			harness: "opencode",
			catalog: sampleCatalog,
			rules: {},
		});
		expect(resolved.source).toBe("models_dev");
		expect(resolved.canonicalName).toBe("Claude Sonnet 4");
	});

	test("PricingCatalogManager records fetch history, respects offline mode, and deduplicates concurrent fetches", async () => {
		mkdirSync(tmpDir, { recursive: true });
		const dbPath = path.join(tmpDir, "pricing-mgr.sqlite");
		const db = openStoreDatabase(dbPath);
		const manager = new PricingCatalogManager();
		manager.loadLocalState(db);

		// Offline mode disables auto-refresh
		manager.saveSettings(db, {
			...manager.getSettings(),
			autoFetch: false,
		});
		expect(manager.needsAutoRefresh()).toBe(false);

		manager.saveSettings(db, {
			...manager.getSettings(),
			autoFetch: true,
			endpoint: "https://example.invalid/api.json",
		});

		let fetchCalls = 0;
		const slowFailingFetch = (async () => {
			fetchCalls += 1;
			await new Promise((resolve) => setTimeout(resolve, 25));
			return new Response("Not Found", {
				status: 404,
				statusText: "Not Found",
			});
		}) as unknown as typeof fetch;

		const [res1, res2] = await Promise.all([
			manager.refreshCatalog({
				trigger: "manual",
				fetchFn: slowFailingFetch,
				persistHistory: (h) => manager.writeHistory(db, h),
			}),
			manager.refreshCatalog({
				trigger: "manual",
				fetchFn: slowFailingFetch,
				persistHistory: (h) => manager.writeHistory(db, h),
			}),
		]);

		expect(fetchCalls).toBe(1);
		expect(res1.updated).toBe(false);
		expect(res2.updated).toBe(false);
		expect(res1.attempt.status).toBe("error");
		expect(res1.attempt.httpStatus).toBe(404);

		const statusAfterErr = manager.buildStatus({
			activeModels: 0,
			customModels: 0,
			catalogModels: 0,
			recordedOnlyModels: 0,
			fallbackModels: 0,
			unpricedModels: 0,
			unpricedRequests: 0,
		});
		expect(statusAfterErr.history).toHaveLength(1);
		expect(statusAfterErr.lastError).toContain("404");

		// Reload from SQLite verifies history persisted
		const manager2 = new PricingCatalogManager();
		manager2.loadLocalState(db);
		const reloadedStatus = manager2.buildStatus(statusAfterErr.summary);
		expect(reloadedStatus.history).toHaveLength(1);
		expect(reloadedStatus.history[0]?.httpStatus).toBe(404);

		db.close();
	});

	test("custom rule keyed by catalog canonical display name preserves identity and matches rawModel records", () => {
		const aliasedCatalog = readCatalog({
			"llmgateway-providers": {
				models: {
					"minimax/minimax-m2": {
						id: "minimax/minimax-m2",
						name: "MiniMax M2 (MiniMax)",
						release_date: "2025-10-01",
						cost: {
							input: 0.2,
							output: 1.0,
							cache_read: 0.03,
						},
					},
				},
			},
		});

		// First apply catalog pricing without custom rules (produces canonical display name)
		const initialRecord = makeRecord({
			harness: "opencode",
			model: "cline/minimax/minimax-m2",
			inputTokens: 1_000_000,
			outputTokens: 500_000,
			costUsd: null,
		});
		applyPricingToRecords([initialRecord], {
			catalog: aliasedCatalog,
			rules: {},
		});
		expect(initialRecord.model).toBe("Minimax M2 (minimax)");

		// Create custom rule under the displayed row model name
		const rules: Record<string, CustomModelPriceRule> = {
			"minimax m2 (minimax)": {
				model: "Minimax M2 (minimax)",
				mode: "rates",
				rates: {
					input: 10,
					output: 20,
					cacheRead: 5,
					cacheWrite: 10,
					reasoning: 20,
				},
				overrideRecorded: true,
				updatedAt: 200,
			},
		};

		// Re-applying pricing preserves the canonical model name and applies custom rates
		applyPricingToRecords([initialRecord], {
			catalog: aliasedCatalog,
			rules,
		});
		expect(initialRecord.model).toBe("Minimax M2 (minimax)");
		expect(initialRecord.costUsd).toBeCloseTo(20, 6);

		// A fresh unnormalized record with the same rawModel also matches via canonicalName lookup
		const freshRecord = makeRecord({
			harness: "opencode",
			model: "cline/minimax/minimax-m2",
			rawModel: "cline/minimax/minimax-m2",
			inputTokens: 1_000_000,
			outputTokens: 500_000,
			costUsd: null,
		});
		applyPricingToRecords([freshRecord], {
			catalog: aliasedCatalog,
			rules,
		});
		expect(freshRecord.model).toBe("Minimax M2 (minimax)");
		expect(freshRecord.costUsd).toBeCloseTo(20, 6);

		const summary = summarizeActiveModelsPricing([initialRecord, freshRecord], {
			catalog: aliasedCatalog,
			rules,
		});
		expect(summary.customModels).toBe(1);
		expect(
			buildModelPricingMeta(initialRecord.model, [initialRecord, freshRecord], {
				catalog: aliasedCatalog,
				rules,
			}).source,
		).toBe("custom");
	});

	test("searchCatalogEntries supports multi-token non-contiguous queries", () => {
		const multiCatalog = readCatalog({
			google: {
				models: {
					"gemini-4-neon": {
						id: "gemini-4-neon",
						name: "Gemini 4 Neon",
						release_date: "2025-11-01",
						cost: { input: 3, output: 15 },
					},
				},
			},
		});
		const results = searchCatalogEntries(multiCatalog, "Gemini Neon", 10);
		expect(results.map((item) => item.key)).toContain("google/gemini-4-neon");
	});
});
