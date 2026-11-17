import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatLatency, formatThroughput } from "../../../app/lib/format";
import type { TurnSummary, UsageRecord } from "../../../shared/types";
import {
	computeSessionGenerationMetrics,
	computeToolCallDurations,
	MAX_STEP_GAP_MS,
	MAX_TOOL_DURATION_MS,
	MAX_TTFT_MS,
	mergeIntervals,
} from "../../../src/metrics/generation";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { readClaudeSingleTranscriptSync } from "../../../src/providers/claude/transcripts";
import type { TranscriptSession } from "../../../src/transcripts/shared";
import { MockOsEnvProvider } from "../../fixtures/helpers/mock-env";

function makeUsageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		harness: "claude",
		sessionId: "sess-1",
		messageId: "msg-1",
		cwd: "/tmp/proj",
		model: "claude-sonnet-4",
		timestamp: 10_000,
		inputTokens: 100,
		outputTokens: 200,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: 0.01,
		costEstimated: false,
		...overrides,
	};
}

function makeTurn(overrides: Partial<TurnSummary> = {}): TurnSummary {
	return {
		id: "t1",
		index: 0,
		startedAt: 1000,
		endedAt: 6000,
		requests: 1,
		totals: {
			sessions: 1,
			messages: 1,
			requests: 1,
			inputTokens: 100,
			outputTokens: 200,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.01,
			estimatedRequests: 0,
			unpricedRequests: 0,
		},
		models: ["claude-sonnet-4"],
		...overrides,
	};
}

describe("Generation metrics", () => {
	test("mergeIntervals merges overlapping and disjoint intervals", () => {
		expect(mergeIntervals([])).toBe(0);
		expect(
			mergeIntervals([
				[1000, 3000],
				[2000, 5000],
				[6000, 7500],
				[7000, 7000],
			]),
		).toBe(5500);
	});

	test("computeToolCallDurations handles explicit timestamps, fallbacks, and limits", () => {
		const session: TranscriptSession = {
			harness: "codex",
			sessionId: "s-tools",
			cwd: "/tmp/proj",
			startedAt: 1000,
			items: [
				{
					id: "u1",
					order: 0,
					turnId: "t1",
					role: "user",
					kind: "message",
					phase: "final",
					text: "run checks",
					timestamp: 1000,
				},
				{
					id: "c1",
					order: 1,
					turnId: "t1",
					role: "tool",
					kind: "tool_call",
					phase: "intermediate",
					name: "bash",
					toolCallId: "call-1",
					timestamp: 2000,
				},
				{
					id: "r1",
					order: 2,
					turnId: "t1",
					role: "tool",
					kind: "tool_result",
					phase: "intermediate",
					toolCallId: "call-1",
					timestamp: 4500,
				},
				{
					id: "c2",
					order: 3,
					turnId: "t1",
					role: "tool",
					kind: "tool_call",
					phase: "intermediate",
					name: "read",
					toolCallId: "call-2",
					timestamp: 5000,
				},
				{
					id: "r2",
					order: 4,
					turnId: "t1",
					role: "tool",
					kind: "tool_result",
					phase: "intermediate",
					toolCallId: "call-2",
					timestamp: null,
				},
				{
					id: "a1",
					order: 5,
					turnId: "t1",
					role: "assistant",
					kind: "message",
					phase: "final",
					text: "done",
					timestamp: 6200,
				},
				// Exceeds MAX_TOOL_DURATION_MS -> ignored
				{
					id: "c3",
					order: 6,
					turnId: "t2",
					role: "tool",
					kind: "tool_call",
					phase: "intermediate",
					name: "long",
					toolCallId: "call-3",
					timestamp: 10_000,
				},
				{
					id: "r3",
					order: 7,
					turnId: "t2",
					role: "tool",
					kind: "tool_result",
					phase: "intermediate",
					toolCallId: "call-3",
					timestamp: 10_000 + MAX_TOOL_DURATION_MS + 1000,
				},
				// Followed only by user message -> no fallback attribution
				{
					id: "c4",
					order: 8,
					turnId: "t3",
					role: "tool",
					kind: "tool_call",
					phase: "intermediate",
					name: "orphan",
					toolCallId: "call-4",
					timestamp: 20_000,
				},
				{
					id: "u2",
					order: 9,
					turnId: "t3",
					role: "user",
					kind: "message",
					phase: "final",
					text: "interrupted",
					timestamp: 25_000,
				},
			],
		};

		const durations = computeToolCallDurations(session.items);
		const getDuration = (id: string) => {
			const item = session.items.find((entry) => entry.id === id);
			return item ? durations.get(item) : undefined;
		};
		expect(getDuration("c1")).toBe(2500);
		expect(getDuration("c2")).toBe(1200);
		expect(getDuration("c3")).toBeUndefined();
		expect(getDuration("c4")).toBeUndefined();
	});

	test("computeSessionGenerationMetrics calculates TTFT, throughput, model and tool durations", () => {
		const session: TranscriptSession = {
			harness: "claude",
			sessionId: "sess-metrics",
			cwd: "/tmp/proj",
			startedAt: 1000,
			items: [
				// Turn 1: user at 1000, thinking at 1800 (TTFT = 800ms),
				// tool call 2000..4000 (2000ms), final assistant at 6000.
				// Active duration = 5000ms, tool = 2000ms, model = 3000ms.
				{
					id: "u1",
					order: 0,
					turnId: "t1",
					role: "user",
					kind: "message",
					phase: "final",
					text: "hello",
					timestamp: 1000,
				},
				{
					id: "th1",
					order: 1,
					turnId: "t1",
					role: "other",
					kind: "other",
					phase: "intermediate",
					text: "thinking...",
					timestamp: 1800,
				},
				{
					id: "tc1",
					order: 2,
					turnId: "t1",
					role: "tool",
					kind: "tool_call",
					phase: "intermediate",
					name: "read",
					toolCallId: "c1",
					timestamp: 2000,
				},
				{
					id: "tr1",
					order: 3,
					turnId: "t1",
					role: "tool",
					kind: "tool_result",
					phase: "intermediate",
					toolCallId: "c1",
					timestamp: 4000,
				},
				{
					id: "a1",
					order: 4,
					turnId: "t1",
					role: "assistant",
					kind: "message",
					phase: "final",
					text: "answer 1",
					timestamp: 6000,
				},
				// Turn 2: user at 100_000, assistant at 102_000 (TTFT = 2000ms),
				// active duration = 2000ms, tool = null, model = 2000ms.
				// Output tokens = 100 -> 50 tok/s for turn 2.
				// Combined output = 150 + 100 = 250 over 5s = 50.0 tok/s.
				{
					id: "u2",
					order: 5,
					turnId: "t2",
					role: "user",
					kind: "message",
					phase: "final",
					text: "second",
					timestamp: 100_000,
				},
				{
					id: "a2",
					order: 6,
					turnId: "t2",
					role: "assistant",
					kind: "message",
					phase: "final",
					text: "answer 2",
					timestamp: 102_000,
				},
			],
		};

		const records: UsageRecord[] = [
			makeUsageRecord({ turnId: "t1", timestamp: 6000, outputTokens: 150 }),
			makeUsageRecord({
				messageId: "msg-2",
				turnId: "t2",
				timestamp: 102_000,
				outputTokens: 100,
			}),
		];
		const rawTurns: TurnSummary[] = [
			makeTurn({
				id: "t1",
				index: 0,
				totals: { ...makeTurn().totals, outputTokens: 150 },
			}),
			makeTurn({
				id: "t2",
				index: 1,
				startedAt: 100_000,
				endedAt: 102_000,
				totals: { ...makeTurn().totals, outputTokens: 100 },
			}),
		];

		const res = computeSessionGenerationMetrics(session, records, rawTurns);
		expect(res.turns[0]?.ttftMs).toBe(800);
		expect(res.turns[0]?.durationMs).toBe(5000);
		expect(res.turns[0]?.toolDurationMs).toBe(2000);
		expect(res.turns[0]?.modelDurationMs).toBe(3000);
		expect(res.turns[0]?.tokensPerSecond).toBe(50);

		expect(res.turns[1]?.ttftMs).toBe(2000);
		expect(res.turns[1]?.durationMs).toBe(2000);
		expect(res.turns[1]?.toolDurationMs).toBeNull();
		expect(res.turns[1]?.modelDurationMs).toBe(2000);
		expect(res.turns[1]?.tokensPerSecond).toBe(50);

		expect(res.metrics.avgTtftMs).toBe(1400);
		expect(res.metrics.p50TtftMs).toBe(1400);
		expect(res.metrics.modelDurationMs).toBe(5000);
		expect(res.metrics.toolDurationMs).toBe(2000);
		expect(res.metrics.measuredToolCalls).toBe(1);
		expect(res.metrics.avgToolDurationMs).toBe(2000);
		expect(res.metrics.tokensPerSecond).toBe(50);
		expect(res.metrics.measuredTurns).toBe(2);
	});

	test("excludes idle gaps exceeding MAX_STEP_GAP_MS and TTFT exceeding MAX_TTFT_MS", () => {
		const session: TranscriptSession = {
			harness: "claude",
			sessionId: "sess-gaps",
			cwd: null,
			startedAt: 1000,
			items: [
				{
					id: "u1",
					order: 0,
					turnId: "t1",
					role: "user",
					kind: "message",
					phase: "final",
					text: "hi",
					timestamp: 1000,
				},
				{
					id: "a1",
					order: 1,
					turnId: "t1",
					role: "assistant",
					kind: "message",
					phase: "final",
					text: "late reply",
					timestamp: 1000 + MAX_STEP_GAP_MS + 60_000,
				},
			],
		};
		expect(MAX_STEP_GAP_MS).toBeGreaterThan(MAX_TTFT_MS);
		const res = computeSessionGenerationMetrics(session, [], [makeTurn()]);
		expect(res.turns[0]?.ttftMs).toBeNull();
		expect(res.turns[0]?.durationMs).toBeNull();
		expect(res.metrics.avgTtftMs).toBeNull();
		expect(res.metrics.tokensPerSecond).toBeNull();
	});

	test("Claude transcript reader captures user-row tool_result and assistant thinking timestamps", () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "claude-metrics-"));
		try {
			const projectsDir = path.join(tmpDir, ".claude", "projects", "-proj");
			mkdirSync(projectsDir, { recursive: true });
			const events = [
				{
					type: "user",
					sessionId: "s1",
					uuid: "u-1",
					timestamp: "2026-10-01T10:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "Check" }] },
				},
				{
					type: "assistant",
					sessionId: "s1",
					uuid: "a-1",
					parentUuid: "u-1",
					timestamp: "2026-10-01T10:00:01.200Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Let me inspect" },
							{
								type: "tool_use",
								id: "tool-1",
								name: "read_file",
								input: { path: "a.ts" },
							},
						],
					},
				},
				{
					type: "user",
					sessionId: "s1",
					uuid: "u-2",
					parentUuid: "u-1",
					timestamp: "2026-10-01T10:00:03.700Z",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-1",
								content: "file contents",
							},
						],
					},
				},
				{
					type: "assistant",
					sessionId: "s1",
					uuid: "a-2",
					parentUuid: "u-1",
					timestamp: "2026-10-01T10:00:05.200Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done checking." }],
					},
				},
			];
			writeFileSync(
				path.join(projectsDir, "s1.jsonl"),
				events.map((e) => JSON.stringify(e)).join("\n"),
			);
			const paths = new DefaultPlatformPathService(
				new MockOsEnvProvider({ platform: "darwin", homeDir: tmpDir }),
			);
			const session = readClaudeSingleTranscriptSync(paths, "s1");
			expect(session).not.toBeNull();
			if (!session) throw new Error("Expected session");
			const result = computeSessionGenerationMetrics(
				session,
				[
					makeUsageRecord({
						sessionId: "s1",
						turnId: "u-1",
						timestamp: Date.parse("2026-10-01T10:00:05.200Z"),
						outputTokens: 135,
					}),
				],
				[
					makeTurn({
						id: "u-1",
						totals: { ...makeTurn().totals, outputTokens: 135 },
					}),
				],
			);
			expect(result.metrics.avgTtftMs).toBe(1200);
			expect(result.metrics.toolDurationMs).toBe(2500);
			expect(result.metrics.modelDurationMs).toBe(2700);
			expect(result.metrics.tokensPerSecond).toBe(50);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("formatLatency and formatThroughput render expected human strings", () => {
		expect(formatLatency(null)).toBe("—");
		expect(formatLatency(420)).toBe("420ms");
		expect(formatLatency(1250)).toBe("1.25s");
		expect(formatLatency(14250)).toBe("14.3s");
		expect(formatLatency(75_000)).toBe("1m");
		expect(formatThroughput(null)).toBe("—");
		expect(formatThroughput(0)).toBe("—");
		expect(formatThroughput(48.2)).toBe("48.2 tok/s");
	});
});
