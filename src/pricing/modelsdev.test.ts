import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "../types";
import { usageRecord } from "../util";
import { applyCatalog, readCatalog, resolveModel } from "./modelsdev";

const catalog = readCatalog({
	google: {
		models: {
			"gemini-3.8-flash": {
				id: "gemini-3.8-flash",
				name: "Gemini 3.8 Flash",
				release_date: "2026-01-01",
				cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
			},
		},
	},
	"reseller-a": {
		models: {
			"openai/gpt-5.1-codex-mini": {
				id: "openai/gpt-5.1-codex-mini",
				name: "GPT-5.1 Codex mini",
				canonical_model_id: "openai/gpt-5.1-codex-mini",
				release_date: "2025-11-13",
				cost: { input: 0.25, output: 2, cache_read: 0.025 },
			},
		},
	},
	"reseller-b": {
		models: {
			"gpt-5.1-codex-mini": {
				id: "gpt-5.1-codex-mini",
				name: "GPT-5.1 Codex mini",
				canonical_model_id: "openai/gpt-5.1-codex-mini",
				release_date: "2025-11-13",
				cost: { input: 0.25, output: 2, cache_read: 0.03 },
			},
		},
	},
	free: {
		models: {
			"minimax-m2.5-free": {
				id: "minimax-m2.5-free",
				name: "MiniMax-M2.5 Free",
				cost: { input: 0, output: 0, cache_read: 0 },
			},
		},
	},
});

function record(
	model: string,
	costUsd: number | null,
	input = 1_000_000,
): UsageRecord {
	return usageRecord(
		{
			harness: "opencode",
			sessionId: "session",
			messageId: "message",
			cwd: null,
			model,
			timestamp: 0,
		},
		{ input, cost: costUsd ?? undefined },
	);
}

describe("model pricing", () => {
	test("resolves canonical provider models listed only by resellers", () => {
		const match = resolveModel("gpt-5.1-codex-mini", "codex", catalog);

		expect(match?.rates?.input).toBe(0.25);
		expect(match?.rates?.output).toBe(2);
	});

	test("estimates a zero recorded cost when the model has real rates", () => {
		const usage = record("chn-gemini/gemini-3.8-flash", 0);

		applyCatalog([usage], catalog, null);

		expect(usage.model).toBe("Gemini 3.8 Flash");
		expect(usage.costUsd).toBeCloseTo(0.75, 6);
		expect(usage.costEstimated).toBe(true);
	});

	test("keeps zero cost for free models with zero rates", () => {
		const usage = record("free/minimax-m2.5-free", 0);

		applyCatalog([usage], catalog, null);

		expect(usage.costUsd).toBe(0);
		expect(usage.costEstimated).toBe(false);
	});

	test("does not overwrite a recorded non-zero cost", () => {
		const usage = record("chn-gemini/gemini-3.8-flash", 0.5);

		applyCatalog([usage], catalog, null);

		expect(usage.costUsd).toBe(0.5);
		expect(usage.costEstimated).toBe(false);
	});
});
