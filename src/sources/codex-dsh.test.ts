import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readCodex } from "./codex";
import { readDsh } from "./dsh";

const directories: string[] = [];
const original = {
	CODEX_HOME: process.env.CODEX_HOME,
	DSH_HOME: process.env.DSH_HOME,
};

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "coding-tokens-src-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	if (original.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = original.CODEX_HOME;
	if (original.DSH_HOME === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = original.DSH_HOME;
});

describe("Codex and DSH source reader accuracy", () => {
	test("deduplicates consecutive identical Codex token_count snapshots", () => {
		const codexHome = temporaryDirectory();
		process.env.CODEX_HOME = codexHome;
		const dayDir = path.join(codexHome, "sessions", "2026", "11", "15");
		mkdirSync(dayDir, { recursive: true });

		const snapshot = {
			type: "event_msg",
			timestamp: "2026-11-15T03:00:01Z",
			payload: {
				type: "token_count",
				info: {
					last_token_usage: {
						input_tokens: 1200,
						output_tokens: 300,
						cached_input_tokens: 800,
						reasoning_output_tokens: 50,
					},
					total_token_usage: {
						input_tokens: 1200,
						output_tokens: 300,
						cached_input_tokens: 800,
						reasoning_output_tokens: 50,
					},
				},
			},
		};
		const nextTurn = {
			type: "event_msg",
			timestamp: "2026-11-15T03:01:00Z",
			payload: {
				type: "token_count",
				info: {
					last_token_usage: {
						input_tokens: 400,
						output_tokens: 100,
						cached_input_tokens: 200,
						reasoning_output_tokens: 0,
					},
					total_token_usage: {
						input_tokens: 1600,
						output_tokens: 400,
						cached_input_tokens: 1000,
						reasoning_output_tokens: 50,
					},
				},
			},
		};

		const lines = [
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "thread-1",
					cwd: "/repo",
					timestamp: "2026-11-15T03:00:00Z",
				},
			}),
			JSON.stringify({
				type: "turn_context",
				payload: { model: "gpt-5", cwd: "/repo" },
			}),
			JSON.stringify(snapshot),
			JSON.stringify(snapshot),
			JSON.stringify(nextTurn),
		];
		writeFileSync(
			path.join(dayDir, "rollout-thread-1.jsonl"),
			`${lines.join("\n")}\n`,
		);

		const result = readCodex();
		expect(result.records).toHaveLength(2);
		expect(result.records.reduce((sum, r) => sum + r.outputTokens, 0)).toBe(
			400,
		);
	});

	test("prefers higher DSH generation and .zstd compressed logs over stale plain session.jsonl", () => {
		const dshHome = temporaryDirectory();
		process.env.DSH_HOME = dshHome;

		const dirA = path.join(dshHome, "sessions", "sess-a");
		mkdirSync(dirA, { recursive: true });
		const stalePlain = [
			JSON.stringify({ type: "session", id: "sess-a", cwd: "/repo" }),
			JSON.stringify({
				type: "assistant/message",
				id: "msg-a",
				time: "2026-11-15T03:00:00Z",
				data: {
					message: { source: { provider: "google", model: "gemini-3" } },
					usage: { inputTokens: 100, outputTokens: 10 },
				},
			}),
		].join("\n");
		const freshZstd = [
			JSON.stringify({ type: "session", id: "sess-a", cwd: "/repo" }),
			JSON.stringify({
				type: "assistant/message",
				id: "msg-a",
				time: "2026-11-15T03:00:00Z",
				data: {
					message: { source: { provider: "google", model: "gemini-3" } },
					usage: { inputTokens: 500, outputTokens: 50 },
				},
			}),
		].join("\n");
		writeFileSync(path.join(dirA, "session.jsonl"), `${stalePlain}\n`);
		writeFileSync(
			path.join(dirA, "session.v2.jsonl.zstd"),
			zstdCompressSync(Buffer.from(`${freshZstd}\n`)),
		);

		const dirB = path.join(dshHome, "sessions", "sess-b");
		mkdirSync(dirB, { recursive: true });
		writeFileSync(
			path.join(dirB, "session.jsonl"),
			`${JSON.stringify({ type: "session", id: "sess-b", cwd: "/repo" })}\n${JSON.stringify(
				{
					type: "assistant/message",
					id: "msg-b",
					time: "2026-11-15T03:05:00Z",
					data: {
						message: { source: { provider: "google", model: "gemini-3" } },
						usage: { inputTokens: 10, outputTokens: 1 },
					},
				},
			)}\n`,
		);
		writeFileSync(
			path.join(dirB, "session.jsonl.zstd"),
			zstdCompressSync(
				Buffer.from(
					`${JSON.stringify({ type: "session", id: "sess-b", cwd: "/repo" })}\n${JSON.stringify(
						{
							type: "assistant/message",
							id: "msg-b",
							time: "2026-11-15T03:05:00Z",
							data: {
								message: { source: { provider: "google", model: "gemini-3" } },
								usage: { inputTokens: 200, outputTokens: 20 },
							},
						},
					)}\n`,
				),
			),
		);

		const result = readDsh();
		expect(result.records).toHaveLength(2);
		const bySession = new Map(
			result.records.map((record) => [record.sessionId, record]),
		);
		expect(bySession.get("sess-a")?.inputTokens).toBe(500);
		expect(bySession.get("sess-b")?.inputTokens).toBe(200);
	});
});
