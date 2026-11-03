import { describe, expect, test } from "bun:test";
import { hasTokenUsage, usageRecord } from "./util";

function record(inputTokens: number, outputTokens = 0) {
	return usageRecord(
		{
			harness: "opencode",
			sessionId: "session",
			messageId: `${inputTokens}:${outputTokens}`,
			cwd: null,
			model: "model",
			timestamp: null,
		},
		{ input: inputTokens, output: outputTokens },
	);
}

describe("hasTokenUsage", () => {
	test("rejects records whose counters are all zero", () => {
		expect(hasTokenUsage(record(0))).toBe(false);
		expect(
			hasTokenUsage({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
			}),
		).toBe(false);
	});

	test("accepts a record when any counter moved", () => {
		expect(hasTokenUsage(record(1))).toBe(true);
		expect(hasTokenUsage(record(0, 1))).toBe(true);
		expect(
			hasTokenUsage({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 1,
			}),
		).toBe(true);
	});
});
