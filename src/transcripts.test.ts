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

function protoVarint(field: number, value: number): Uint8Array {
	const bytes: number[] = [];
	let tag = (field << 3) | 0;
	while (tag >= 128) {
		bytes.push((tag & 127) | 128);
		tag >>>= 7;
	}
	bytes.push(tag);
	let v = BigInt(value);
	while (v >= 128n) {
		bytes.push(Number(v & 127n) | 128);
		v >>= 7n;
	}
	bytes.push(Number(v));
	return new Uint8Array(bytes);
}

function protoBytes(field: number, content: Uint8Array | string): Uint8Array {
	const payload =
		typeof content === "string" ? new TextEncoder().encode(content) : content;
	const header: number[] = [];
	let tag = (field << 3) | 2;
	while (tag >= 128) {
		header.push((tag & 127) | 128);
		tag >>>= 7;
	}
	header.push(tag);
	let len = payload.length;
	while (len >= 128) {
		header.push((len & 127) | 128);
		len >>>= 7;
	}
	header.push(len);
	const out = new Uint8Array(header.length + payload.length);
	out.set(header, 0);
	out.set(payload, header.length);
	return out;
}

function protoConcat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

describe("Antigravity T3 ACP, subagents, and token parsing", () => {
	test("strips T3 wrapper XML tags from Antigravity user messages", () => {
		const wrapped = [
			"<t3_code_instructions>rules</t3_code_instructions>",
			"<user_request>",
			"Fix the billing bug",
			'<t3_context version="1">ctx</t3_context>',
			"</user_request>",
			"<runtime_info>info</runtime_info>",
			"<pull_request_linking>pr</pull_request_linking>",
		].join("\n");
		expect(cleanUserMessage("antigravity", wrapped)).toBe(
			"Fix the billing bug",
		);
	});

	test("discovers T3 antigravity-acp sessions, detects subagents, and extracts reasoning without bogus cacheWrite", async () => {
		const { Database } = await import("bun:sqlite");
		const { readAntigravity } = await import("./sources/antigravity");
		const { buildSessionCatalog } = await import("../server/data/catalog");

		const prevAgHome = process.env.ANTIGRAVITY_HOME;
		const prevT3Dir = process.env.T3_USER_DATA_DIR;
		const prevHome = process.env.HOME;
		const rootTmp = mkdtempSync(path.join(tmpdir(), "ct-ag-test-"));
		const fakeHome = path.join(rootTmp, "home");
		const agHome = path.join(fakeHome, ".gemini/antigravity");
		const t3Dir = path.join(rootTmp, "t3data");
		const acpConv = path.join(
			t3Dir,
			"providers/antigravity/hash1/antigravity-acp/conversations",
		);
		const nativeConv = path.join(agHome, "conversations");
		mkdirSync(acpConv, { recursive: true });
		mkdirSync(nativeConv, { recursive: true });

		try {
			delete process.env.ANTIGRAVITY_HOME;
			process.env.T3_USER_DATA_DIR = t3Dir;
			process.env.HOME = fakeHome;

			// Write T3 statev2.sqlite with thread title
			const t3Db = new Database(path.join(t3Dir, "statev2.sqlite"));
			t3Db.run(
				"CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT)",
			);
			t3Db.run(
				"CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, driver TEXT, payload_json TEXT)",
			);
			t3Db.run(
				"INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'T3 ACP Session Title')",
			);
			t3Db.run(
				"INSERT INTO orchestration_v2_projection_provider_threads VALUES ('t1', 'antigravity', ?)",
				[JSON.stringify({ nativeThreadRef: { nativeId: "acp-root-1" } })],
			);
			t3Db.close();

			// Write ACP conversation DB (no trajectory timestamp, no f4.11 request_id, f4.6 = 24 enum, f4.9 = 40 reasoning)
			writeFileSync(
				path.join(acpConv, "acp-root-1.meta"),
				JSON.stringify({ cwd: "/tmp/t3-project" }),
			);
			const acpDb = new Database(path.join(acpConv, "acp-root-1.db"));
			acpDb.run("CREATE TABLE trajectory_metadata_blob (data BLOB)");
			acpDb.run(
				"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)",
			);
			acpDb.run("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
			acpDb.run("INSERT INTO trajectory_metadata_blob VALUES (?)", [
				protoBytes(6, "acp-root-1"),
			]);
			const tsMeta = protoBytes(
				1,
				protoConcat(protoVarint(1, 1_780_000_000), protoVarint(2, 0)),
			);
			const userStepPayload = protoBytes(
				19,
				protoBytes(
					2,
					"<t3_code_instructions>x</t3_code_instructions><user_request>Hello ACP</user_request>",
				),
			);
			acpDb.run("INSERT INTO steps VALUES (0, 14, 1, ?, ?)", [
				tsMeta,
				userStepPayload,
			]);
			const kvPair = (k: string, v: string) =>
				protoBytes(20, protoConcat(protoBytes(1, k), protoBytes(2, v)));
			const f4 = protoConcat(
				protoVarint(2, 100),
				protoVarint(3, 60),
				protoVarint(5, 500),
				protoVarint(6, 24),
				protoVarint(9, 40),
				protoVarint(10, 20),
			);
			const f1 = protoConcat(
				protoBytes(4, f4),
				protoBytes(19, "gemini-3.8-flash-n"),
				kvPair("request_id", "req-acp-1"),
				kvPair("last_step_index", "0"),
			);
			acpDb.run("INSERT INTO gen_metadata VALUES (0, ?)", [protoBytes(1, f1)]);
			acpDb.close();

			// Write native Antigravity subagent DB
			const subDb = new Database(path.join(nativeConv, "sub-1.db"));
			subDb.run("CREATE TABLE trajectory_metadata_blob (data BLOB)");
			subDb.run(
				"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)",
			);
			subDb.run("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
			subDb.run("INSERT INTO trajectory_metadata_blob VALUES (?)", [
				protoConcat(
					protoBytes(5, "parent-1"),
					protoBytes(6, "parent-1"),
					protoBytes(7, "file:///tmp/t3-project"),
					protoBytes(
						8,
						protoConcat(protoBytes(1, "worker"), protoBytes(2, "Swarm Worker")),
					),
					protoVarint(17, 1),
				),
			]);
			subDb.run("INSERT INTO steps VALUES (0, 14, 1, ?, ?)", [
				tsMeta,
				protoBytes(19, protoBytes(2, "Internal worker prompt")),
			]);
			subDb.run("INSERT INTO gen_metadata VALUES (0, ?)", [
				protoBytes(
					1,
					protoConcat(
						protoBytes(4, protoConcat(protoVarint(2, 50), protoVarint(6, 26))),
						protoBytes(19, "claude-sonnet-5-5-high"),
						protoBytes(11, "req-sub-1"),
					),
				),
			]);
			subDb.close();

			// Also verify readAntigravity uses fakeHome fallback only if ANTIGRAVITY_HOME isn't overriding;
			// note homeDir in util.ts is evaluated at module load time, so explicitly point to acpConv's parent via T3_USER_DATA_DIR and check ACP + subagent via direct ANTIGRAVITY_HOME for nativeConv.
			const acpUsage = readAntigravity();
			const acpRecords = acpUsage.records.filter(
				(r) => r.sessionId === "acp-root-1",
			);
			expect(acpRecords).toHaveLength(1);
			expect(acpRecords[0]?.messageId).toBe("req-acp-1");
			expect(acpRecords[0]?.cwd).toBe("/tmp/t3-project");
			expect(acpRecords[0]?.cacheWriteTokens).toBe(0);
			expect(acpRecords[0]?.reasoningTokens).toBe(40);
			expect(acpRecords[0]?.timestamp).toBe(1_780_000_000_000);
			expect(acpRecords[0]?.isSubagent).toBeUndefined();

			const catalog = buildSessionCatalog(acpUsage.records);
			expect(catalog.entries.get("antigravity:acp-root-1")?.title).toBe(
				"T3 ACP Session Title",
			);

			const transcripts = readTranscriptSources(["antigravity"]);
			const agTranscript = transcripts
				.find((t) => t.harness === "antigravity")
				?.sessions.find((s) => s.sessionId === "acp-root-1");
			expect(agTranscript?.startedAt).toBe(1_780_000_000_000);
			expect(agTranscript?.items[0]?.text).toBe("Hello ACP");

			// Test native subagent isolation with ANTIGRAVITY_HOME
			process.env.ANTIGRAVITY_HOME = agHome;
			const subUsage = readAntigravity();
			expect(subUsage.records).toHaveLength(1);
			expect(subUsage.records[0]?.isSubagent).toBe(true);
			expect(subUsage.records[0]?.cacheWriteTokens).toBe(0);
			expect(subUsage.messages.get("sub-1")).toBeUndefined();

			const subCatalog = buildSessionCatalog(subUsage.records);
			expect(subCatalog.entries.get("antigravity:sub-1")?.isSubagent).toBe(
				true,
			);
			expect(subCatalog.entries.get("antigravity:sub-1")?.title).toBe(
				"Subagent: Swarm Worker",
			);
			const bulkSubTranscripts = readTranscriptSources(["antigravity"]);
			expect(
				bulkSubTranscripts.find((t) => t.harness === "antigravity")?.sessions,
			).toHaveLength(0);
		} finally {
			if (prevAgHome === undefined) delete process.env.ANTIGRAVITY_HOME;
			else process.env.ANTIGRAVITY_HOME = prevAgHome;
			if (prevT3Dir === undefined) delete process.env.T3_USER_DATA_DIR;
			else process.env.T3_USER_DATA_DIR = prevT3Dir;
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(rootTmp, { recursive: true, force: true });
		}
	});
});

describe("custom date range formatting", () => {
	test("omits current year and formats zh-CN and en ranges naturally", async () => {
		const { formatRangeDates } = await import("../app/lib/date-locale");
		const { formatRangeLabel, setFormatLocale } = await import(
			"../app/lib/format"
		);
		const now2026 = new Date(2026, 10, 15);
		const from = new Date(2026, 8, 2).getTime();
		const until = new Date(2026, 10, 16).getTime();

		expect(formatRangeDates(from, until, "zh-CN", now2026)).toBe(
			"9月2日 – 11月15日",
		);
		setFormatLocale("zh-CN");
		expect(formatRangeLabel(from, until)).toBe("9月2日 – 11月15日");

		const singleDayFrom = new Date(2026, 10, 15).getTime();
		expect(formatRangeDates(singleDayFrom, until, "zh-CN", now2026)).toBe(
			"11月15日",
		);

		const pastFrom = new Date(2025, 8, 2).getTime();
		const pastUntil = new Date(2025, 10, 16).getTime();
		expect(formatRangeDates(pastFrom, pastUntil, "zh-CN", now2026)).toBe(
			"2025年9月2日 – 11月15日",
		);

		const crossYearFrom = new Date(2025, 11, 20).getTime();
		expect(formatRangeDates(crossYearFrom, until, "zh-CN", now2026)).toBe(
			"2025年12月20日 – 2026年11月15日",
		);

		expect(formatRangeDates(from, until, "en", now2026)).toBe("Sep 2 – Nov 15");
		setFormatLocale("en");
		expect(formatRangeLabel(from, until)).toBe("Sep 2 – Nov 15");
		expect(formatRangeDates(singleDayFrom, until, "en", now2026)).toBe(
			"Nov 15",
		);
		expect(formatRangeDates(pastFrom, pastUntil, "en", now2026)).toBe(
			"Sep 2 – Nov 15, 2025",
		);
		expect(formatRangeDates(crossYearFrom, until, "en", now2026)).toBe(
			"Dec 20, 2025 – Nov 15, 2026",
		);
	});
});

describe("cross-harness transcript tool parsing", () => {
	test("parses Codex web_search_call, local_shell_call, mcp_call, and input_text tool outputs", () => {
		withCodexHome((codexHome) => {
			writeRollout(
				codexHome,
				`rollout-2026-01-04T10-00-00-${SESSION_ID}.jsonl`,
				[
					{
						timestamp: "2026-01-04T10:00:00.000Z",
						type: "session_meta",
						payload: {
							id: SESSION_ID,
							cwd: "/tmp/project",
							timestamp: "2026-01-04T10:00:00.000Z",
						},
					},
					{
						timestamp: "2026-01-04T10:00:01.000Z",
						type: "response_item",
						payload: {
							type: "web_search_call",
							id: "ws-1",
							status: "completed",
							action: { type: "search", query: "bun sqlite readonly" },
						},
					},
					{
						timestamp: "2026-01-04T10:00:02.000Z",
						type: "response_item",
						payload: {
							type: "local_shell_call",
							call_id: "sh-1",
							status: "completed",
							action: { type: "exec", command: ["ls", "-la"] },
						},
					},
					{
						timestamp: "2026-01-04T10:00:03.000Z",
						type: "response_item",
						payload: {
							type: "mcp_call",
							id: "mcp-1",
							server_label: "t3-code",
							name: "preview_open",
							arguments: '{"url":"http://localhost:3000"}',
							status: "completed",
						},
					},
					{
						timestamp: "2026-01-04T10:00:04.000Z",
						type: "response_item",
						payload: {
							type: "custom_tool_call_output",
							call_id: "sh-1",
							output: [{ type: "input_text", text: "total 8" }],
						},
					},
				],
			);

			const result = readTranscriptSources(["codex"])[0];
			const session = result?.sessions[0];
			const calls =
				session?.items.filter((item) => item.kind === "tool_call") ?? [];
			const results =
				session?.items.filter((item) => item.kind === "tool_result") ?? [];
			expect(calls.map((c) => c.name)).toEqual([
				"web_search_call",
				"local_shell_call",
				"mcp__t3-code__preview_open",
			]);
			expect(results[0]?.text).toBe("total 8");
		});
	});

	test("unwraps DSH nested tool-result blocks and flags isError / data.error", () => {
		const prevDsh = process.env.DSH_HOME;
		const rootTmp = mkdtempSync(path.join(tmpdir(), "ct-dsh-test-"));
		try {
			process.env.DSH_HOME = rootTmp;
			const sessionDir = path.join(
				rootTmp,
				"sessions",
				"--tmp-proj--",
				"dsh-1",
			);
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(
				path.join(sessionDir, "session.v4.jsonl"),
				jsonl([
					{
						type: "session",
						version: 4,
						id: "dsh-1",
						createdAt: 1_780_000_000_000,
						isSeeded: false,
						delegationDepth: 0,
						cwd: "/tmp/proj",
					},
					{
						type: "user/message",
						seq: 0,
						time: 1_780_000_001_000,
						data: { turn: 1, content: [{ type: "text", text: "Check files" }] },
					},
					{
						type: "tool/call",
						seq: 1,
						time: 1_780_000_002_000,
						data: {
							turn: 1,
							step: 0,
							callId: "c-1",
							name: "read",
							arguments: { file_path: "/tmp/proj/missing.ts" },
						},
					},
					{
						type: "tool/result",
						seq: 2,
						time: 1_780_000_003_000,
						data: {
							turn: 1,
							step: 0,
							callId: "c-1",
							message: {
								id: "m-1",
								role: "tool",
								toolCallId: "c-1",
								content: [
									{
										type: "tool-result",
										toolCallId: "c-1",
										isError: true,
										content: [{ type: "text", text: "ENOENT: missing.ts" }],
									},
								],
							},
						},
					},
				]),
				"utf8",
			);

			const res = readTranscriptSources(["dsh"])[0];
			const session = res?.sessions[0];
			const toolRes = session?.items.find(
				(item) => item.kind === "tool_result",
			);
			expect(toolRes?.text).toBe("ENOENT: missing.ts");
			expect(toolRes?.status).toBe("error");
		} finally {
			if (prevDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = prevDsh;
			rmSync(rootTmp, { recursive: true, force: true });
		}
	});

	test("reads OpenCode V2 session_part rows, state.content, SessionError, and non-zero bash exit", async () => {
		const { Database } = await import("bun:sqlite");
		const prevDb = process.env.OPENCODE_DB;
		const rootTmp = mkdtempSync(path.join(tmpdir(), "ct-oc-test-"));
		const dbPath = path.join(rootTmp, "opencode.db");
		try {
			process.env.OPENCODE_DB = dbPath;
			const db = new Database(dbPath);
			db.run(
				"CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)",
			);
			db.run(
				"CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)",
			);
			db.run(
				"CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
			);
			db.run(
				"INSERT INTO session_v2 VALUES ('oc-1', '/tmp/proj', 'OC V2', 1000)",
			);
			db.run(
				"INSERT INTO session_message VALUES ('u-1', 'oc-1', 'user', 1, 1001, ?)",
				[JSON.stringify({ text: "Run tests" })],
			);
			db.run(
				"INSERT INTO session_message VALUES ('a-1', 'oc-1', 'assistant', 2, 1002, ?)",
				[JSON.stringify({ finish: "stop" })],
			);
			db.run(
				"INSERT INTO session_part VALUES ('a-1', 'oc-1', 0, 'tool', 'call-bash', 1003, 1004, ?)",
				[
					JSON.stringify({
						type: "tool",
						id: "call-bash",
						name: "bash",
						state: {
							status: "completed",
							input: { command: "bun test" },
							content: [{ type: "text", text: "FAIL 1 test" }],
							metadata: { exit: 1 },
						},
					}),
				],
			);
			db.run(
				"INSERT INTO session_part VALUES ('a-1', 'oc-1', 1, 'tool', 'call-read', 1005, 1006, ?)",
				[
					JSON.stringify({
						type: "tool",
						id: "call-read",
						name: "read",
						state: {
							status: "error",
							input: { path: "/tmp/no.ts" },
							error: { type: "FileNotFound", message: "No such file" },
						},
					}),
				],
			);
			db.close();

			const res = readTranscriptSources(["opencode"])[0];
			const session = res?.sessions[0];
			const calls =
				session?.items.filter((item) => item.kind === "tool_call") ?? [];
			const results =
				session?.items.filter((item) => item.kind === "tool_result") ?? [];
			expect(calls.map((c) => [c.name, c.status])).toEqual([
				["bash", "error"],
				["read", "error"],
			]);
			expect(results[0]?.text).toBe("FAIL 1 test");
			expect(results[1]?.text).toBe("No such file");
		} finally {
			if (prevDb === undefined) delete process.env.OPENCODE_DB;
			else process.env.OPENCODE_DB = prevDb;
			rmSync(rootTmp, { recursive: true, force: true });
		}
	});

	test("captures Antigravity error (status 7) and cancelled (status 6) tool outcomes", async () => {
		const { Database } = await import("bun:sqlite");
		const prevAg = process.env.ANTIGRAVITY_HOME;
		const rootTmp = mkdtempSync(path.join(tmpdir(), "ct-ag-err-"));
		const convDir = path.join(rootTmp, "conversations");
		mkdirSync(convDir, { recursive: true });
		try {
			process.env.ANTIGRAVITY_HOME = rootTmp;
			const db = new Database(path.join(convDir, "ag-err-1.db"));
			db.run("CREATE TABLE trajectory_metadata_blob (data BLOB)");
			db.run(
				"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)",
			);
			const f5Call = (id: string, name: string, inputJson: string) =>
				protoBytes(
					5,
					protoBytes(
						4,
						protoConcat(
							protoBytes(1, id),
							protoBytes(2, name),
							protoBytes(3, inputJson),
						),
					),
				);
			// Step 0: error status 7 with f31.f2 message
			db.run("INSERT INTO steps VALUES (0, 21, 7, NULL, ?)", [
				protoConcat(
					f5Call("c1", "run_command", '{"CommandLine":"bad"}'),
					protoBytes(31, protoBytes(2, "permission denied")),
				),
			]);
			// Step 1: cancelled status 6 with f148.f3 output
			db.run("INSERT INTO steps VALUES (1, 21, 6, NULL, ?)", [
				protoConcat(
					f5Call("c2", "run_command", '{"CommandLine":"sleep 9"}'),
					protoBytes(148, protoBytes(3, "terminated by user")),
				),
			]);
			db.close();

			const res = readTranscriptSources(["antigravity"])[0];
			const session = res?.sessions[0];
			const results =
				session?.items.filter((item) => item.kind === "tool_result") ?? [];
			expect(results.map((r) => [r.status, r.text])).toEqual([
				["error", "permission denied"],
				["cancelled", "terminated by user"],
			]);
		} finally {
			if (prevAg === undefined) delete process.env.ANTIGRAVITY_HOME;
			else process.env.ANTIGRAVITY_HOME = prevAg;
			rmSync(rootTmp, { recursive: true, force: true });
		}
	});
});
