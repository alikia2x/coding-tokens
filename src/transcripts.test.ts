import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCodex } from "./sources/codex";
import {
	cleanUserMessage,
	codexSessionFiles,
	isInjectedUserMessage,
	readTranscriptSources,
} from "./transcripts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const FORK_ID = "00000000-0000-4000-8000-000000000003";
const SUBAGENT_ID = "00000000-0000-4000-8000-000000000004";

function jsonl(events: unknown[]): string {
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function writeRollout(
	codexHome: string,
	name: string,
	events: unknown[],
): string {
	const filePath = path.join(codexHome, "sessions", "2026", "01", "01", name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, jsonl(events), "utf8");
	return filePath;
}

function rollout(
	codexHome: string,
	name: string,
	startedAt: string,
	turnId: string | null,
	text: string,
): void {
	const timestamp = new Date(startedAt).toISOString();
	const turn = turnId ? { turn_id: turnId } : {};
	writeRollout(codexHome, name, [
		{
			timestamp,
			type: "session_meta",
			payload: {
				id: SESSION_ID,
				session_id: SESSION_ID,
				timestamp,
				cwd: "/tmp/project",
			},
		},
		{
			timestamp,
			type: "event_msg",
			payload: { type: "task_started", ...turn },
		},
		{
			timestamp,
			type: "response_item",
			payload: {
				type: "message",
				id: `${name}-user`,
				role: "user",
				content: [{ type: "input_text", text }],
			},
		},
		{
			timestamp,
			type: "response_item",
			payload: {
				type: "message",
				id: `${name}-assistant`,
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: `re: ${text}` }],
			},
		},
		{
			timestamp,
			type: "token_usage_record",
			payload: {
				response_id: `${name}-response`,
				...(turnId ? { turn_id: turnId } : {}),
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		},
	]);
}

function withCodexHome(run: (codexHome: string) => void): void {
	const previous = process.env.CODEX_HOME;
	const codexHome = mkdtempSync(path.join(tmpdir(), "coding-tokens-codex-"));
	try {
		process.env.CODEX_HOME = codexHome;
		run(codexHome);
	} finally {
		if (previous === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previous;
		rmSync(codexHome, { recursive: true, force: true });
	}
}

describe("Codex rollout segments", () => {
	test("merges every segment of one thread into a single transcript", () => {
		withCodexHome((codexHome) => {
			rollout(
				codexHome,
				`rollout-2026-01-01T10-00-00-${SESSION_ID}.jsonl`,
				"2026-01-01T10:00:00.000Z",
				"turn-a",
				"first request",
			);
			rollout(
				codexHome,
				`rollout-2026-01-02T10-00-00-${SESSION_ID}_00000000-0000-4000-8000-000000000002.jsonl`,
				"2026-01-02T10:00:00.000Z",
				"turn-b",
				"second request",
			);

			expect(codexSessionFiles(SESSION_ID)).toHaveLength(2);
			const result = readTranscriptSources(["codex"])[0];
			const session = result?.sessions.find(
				(candidate) => candidate.sessionId === SESSION_ID,
			);
			expect(result?.sessions).toHaveLength(1);
			expect(
				session?.items.filter((item) => item.role === "user"),
			).toHaveLength(2);
			expect(new Set(session?.items.map((item) => item.turnId))).toEqual(
				new Set(["turn-a", "turn-b"]),
			);
			expect(session?.startedAt).toBe(Date.parse("2026-01-01T10:00:00.000Z"));

			const usage = readCodex();
			expect(usage.records).toHaveLength(2);
			expect(usage.messages.get(SESSION_ID)).toBe(2);
		});
	});

	test("keeps synthesized turn ids distinct across segments", () => {
		withCodexHome((codexHome) => {
			rollout(
				codexHome,
				`rollout-2026-01-01T10-00-00-${SESSION_ID}.jsonl`,
				"2026-01-01T10:00:00.000Z",
				null,
				"first request",
			);
			rollout(
				codexHome,
				`rollout-2026-01-02T10-00-00-${SESSION_ID}_00000000-0000-4000-8000-000000000002.jsonl`,
				"2026-01-02T10:00:00.000Z",
				null,
				"second request",
			);

			const result = readTranscriptSources(["codex"])[0];
			const session = result?.sessions.find(
				(candidate) => candidate.sessionId === SESSION_ID,
			);
			const turnIds = new Set(session?.items.map((item) => item.turnId));
			expect(turnIds.size).toBe(2);
			expect(turnIds.has("1")).toBe(false);
		});
	});

	test("keeps a forked chat separate from its spawned subagents", () => {
		withCodexHome((codexHome) => {
			const forkPath = writeRollout(
				codexHome,
				`rollout-2026-01-03T10-00-00-${FORK_ID}.jsonl`,
				[
					{
						timestamp: "2026-01-03T10:00:00.000Z",
						type: "session_meta",
						payload: {
							id: FORK_ID,
							session_id: FORK_ID,
							forked_from_id: SESSION_ID,
							thread_source: "user",
							source: "vscode",
							timestamp: "2026-01-03T10:00:00.000Z",
							cwd: "/tmp/project",
						},
					},
					{
						timestamp: "2026-01-03T10:00:00.000Z",
						type: "event_msg",
						payload: { type: "task_started", turn_id: "fork-turn" },
					},
					{
						timestamp: "2026-01-03T10:00:00.000Z",
						type: "response_item",
						payload: {
							type: "message",
							id: "fork-user",
							role: "user",
							content: [{ type: "input_text", text: "fork request" }],
						},
					},
					{
						timestamp: "2026-01-03T10:00:00.000Z",
						type: "token_usage_record",
						payload: {
							response_id: "fork-response",
							turn_id: "fork-turn",
							usage: { input_tokens: 10, output_tokens: 5 },
						},
					},
				],
			);
			const subTimestamp = "2026-01-03T11:00:00.000Z";
			const subPath = writeRollout(
				codexHome,
				`rollout-2026-01-03T11-00-00-${SUBAGENT_ID}.jsonl`,
				[
					{
						timestamp: subTimestamp,
						type: "session_meta",
						payload: {
							id: SUBAGENT_ID,
							session_id: FORK_ID,
							thread_source: "subagent",
							source: {
								subagent: {
									thread_spawn: {
										parent_thread_id: FORK_ID,
										depth: 1,
									},
								},
							},
							timestamp: subTimestamp,
							cwd: "/tmp/project",
						},
					},
					// Codex replays the parent's session_meta inside a spawn rollout.
					{
						timestamp: subTimestamp,
						type: "session_meta",
						payload: {
							id: FORK_ID,
							session_id: FORK_ID,
							thread_source: "user",
							source: "vscode",
							timestamp: "2026-01-03T10:00:00.000Z",
							cwd: "/tmp/project",
						},
					},
					{
						timestamp: subTimestamp,
						type: "event_msg",
						payload: { type: "task_started", turn_id: "sub-turn" },
					},
					{
						timestamp: subTimestamp,
						type: "response_item",
						payload: {
							type: "message",
							id: "sub-user",
							role: "user",
							content: [{ type: "input_text", text: "sub request" }],
						},
					},
					{
						timestamp: subTimestamp,
						type: "token_usage_record",
						payload: {
							response_id: "sub-response",
							turn_id: "sub-turn",
							usage: { input_tokens: 7, output_tokens: 3 },
						},
					},
				],
			);

			const usage = readCodex();
			const forkRecords = usage.records.filter(
				(record) => record.sessionId === FORK_ID,
			);
			const subRecords = usage.records.filter(
				(record) => record.sessionId === SUBAGENT_ID,
			);
			expect(forkRecords).toHaveLength(1);
			expect(forkRecords.every((record) => !record.isSubagent)).toBe(true);
			expect(subRecords).toHaveLength(1);
			expect(subRecords.every((record) => record.isSubagent)).toBe(true);
			expect(usage.messages.get(FORK_ID)).toBe(1);

			const result = readTranscriptSources(["codex"], {
				codex: new Set([forkPath, subPath]),
			})[0];
			const fork = result?.sessions.find(
				(candidate) => candidate.sessionId === FORK_ID,
			);
			const subagent = result?.sessions.find(
				(candidate) => candidate.sessionId === SUBAGENT_ID,
			);
			expect(result?.sessions).toHaveLength(2);
			expect(fork?.items.map((item) => item.text)).toEqual(["fork request"]);
			expect(subagent?.items.map((item) => item.text)).toEqual(["sub request"]);
			expect(fork?.startedAt).toBe(Date.parse("2026-01-03T10:00:00.000Z"));
		});
	});
});

describe("Codex user message cleaning", () => {
	test("hides AGENTS.md and recommended-plugin context", () => {
		expect(
			cleanUserMessage(
				"codex",
				"# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>do things</INSTRUCTIONS>",
			),
		).toBe("");
		expect(
			cleanUserMessage(
				"codex",
				"<recommended_plugins>\nplugins\n</recommended_plugins>\n\n# AGENTS.md instructions\n\n<INSTRUCTIONS>do things</INSTRUCTIONS>",
			),
		).toBe("");
	});

	test("hides guardian history and internal continuation context", () => {
		expect(
			cleanUserMessage(
				"codex",
				"The following is the Codex agent history whose request action you are assessing. ...",
			),
		).toBe("");
		expect(
			cleanUserMessage(
				"codex",
				'<codex_internal_context source="goal">\ncontinue\n</codex_internal_context>',
			),
		).toBe("");
		expect(
			isInjectedUserMessage(
				"codex",
				"<turn_aborted>\nstopped\n</turn_aborted>",
			),
		).toBe(true);
	});

	test("formats response annotations instead of dumping instructions and JSON", () => {
		const value =
			'\n# Response annotations:\nLong instructions.\n<response-annotations>\n[{"text":"单旋律约束与 8 秒片段上限","annotation":"谁让你这么做了？？？？"}]\n</response-annotations>\n\n## My request:\n\n';
		expect(cleanUserMessage("codex", value)).toBe(
			"> 单旋律约束与 8 秒片段上限\n\n谁让你这么做了？？？？",
		);
	});

	test("extracts the real request after file and reference wrappers", () => {
		expect(
			cleanUserMessage(
				"codex",
				"# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request:\n把表格列删掉",
			),
		).toBe("把表格列删掉");
		expect(
			cleanUserMessage(
				"codex",
				'## Referenced chats with Codex:\n[{"threadId":"x"}]\n## My request:\n[@另一个对话](thread://x) 继续修',
			),
		).toBe("[@另一个对话](thread://x) 继续修");
	});

	test("removes environment context and keeps normal messages", () => {
		expect(
			cleanUserMessage(
				"codex",
				"<environment_context>\n<current_date>2026-10-01</current_date>\n</environment_context>",
			),
		).toBe("");
		expect(cleanUserMessage("codex", "修一下这个 bug")).toBe("修一下这个 bug");
	});
});
