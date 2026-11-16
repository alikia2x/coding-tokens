import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	matchesSessionQuery,
	matchesTextQuery,
	parseSearchQuery,
	type SearchableSession,
	scoreSessionQuery,
} from "../../shared/search";
import type { SearchPayload, SessionsSearchPayload } from "../../shared/types";
import { handleApi } from "../api";
import { extractSnippet, searchPayload, sessionSearchMatches } from "./search";
import { store } from "./store";

const SESSION_A = "00000000-0000-4000-8000-000000000101";
const SESSION_B = "00000000-0000-4000-8000-000000000102";

const sampleSession: SearchableSession = {
	title: "Build dashboard filtering",
	projectName: "dashboard",
	cwd: "/Users/alikia/Code/dashboard",
	harness: "codex Codex",
	models: ["GPT-6.1 Sol"],
	sessionId: "01a14a84-35a7-7bd3-bcb0-924a1bf92fb1",
	isSubagent: false,
	hasTranscript: true,
	costUsd: 1.2,
	body: "Investigated cache invalidation and added a sidebar filter.",
};

function writeCodexRollout(
	codexHome: string,
	name: string,
	options: {
		sessionId: string;
		cwd: string;
		model: string;
		timestamp: string;
		userText: string;
		assistantText: string;
	},
): void {
	const filePath = path.join(codexHome, "sessions", "2026", "05", "01", name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	const events = [
		{
			timestamp: options.timestamp,
			type: "session_meta",
			payload: {
				id: options.sessionId,
				session_id: options.sessionId,
				timestamp: options.timestamp,
				cwd: options.cwd,
			},
		},
		{
			timestamp: options.timestamp,
			type: "turn_context",
			payload: {
				model: options.model,
				cwd: options.cwd,
			},
		},
		{
			timestamp: options.timestamp,
			type: "response_item",
			payload: {
				type: "message",
				id: `${options.sessionId}-user`,
				role: "user",
				content: [{ type: "input_text", text: options.userText }],
			},
		},
		{
			timestamp: options.timestamp,
			type: "response_item",
			payload: {
				type: "message",
				id: `${options.sessionId}-assistant`,
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: options.assistantText }],
			},
		},
		{
			timestamp: options.timestamp,
			type: "token_usage_record",
			payload: {
				response_id: `${options.sessionId}-resp`,
				turn_id: "turn-1",
				usage: { input_tokens: 120, output_tokens: 45 },
			},
		},
	];
	writeFileSync(
		filePath,
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		"utf8",
	);
}

async function withIsolatedStore(
	setup: (dirs: { codexHome: string; emptyDir: string }) => void,
	run: () => Promise<void> | void,
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "coding-tokens-search-"));
	const codexHome = path.join(root, "codex");
	const emptyDir = path.join(root, "empty");
	const dbPath = path.join(root, "index.sqlite");
	mkdirSync(codexHome, { recursive: true });
	mkdirSync(emptyDir, { recursive: true });

	const envKeys = [
		"CODEX_HOME",
		"DSH_HOME",
		"OPENCODE_DATA_DIR",
		"OPENCODE_DB",
		"COMMANDCODE_HOME",
		"T3_USER_DATA_DIR",
		"ANTIGRAVITY_HOME",
	] as const;
	const savedEnv = new Map<string, string | undefined>();
	for (const key of envKeys) savedEnv.set(key, process.env[key]);
	const savedDbPath = store.databasePath();

	try {
		process.env.CODEX_HOME = codexHome;
		process.env.DSH_HOME = emptyDir;
		process.env.OPENCODE_DATA_DIR = emptyDir;
		delete process.env.OPENCODE_DB;
		process.env.COMMANDCODE_HOME = emptyDir;
		process.env.T3_USER_DATA_DIR = emptyDir;
		process.env.ANTIGRAVITY_HOME = emptyDir;

		setup({ codexHome, emptyDir });
		store.configure({ dbPath });
		await store.refresh();
		await run();
	} finally {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		store.configure({ dbPath: savedDbPath });
		rmSync(root, { recursive: true, force: true });
	}
}

describe("matchesTextQuery (models, projects, tools)", () => {
	test("matches positive terms without requiring negative terms", () => {
		const values = [
			"Gemini 4 Hydrogen",
			"Google",
			"antigravity",
			"Antigravity",
		];
		expect(matchesTextQuery(parseSearchQuery("Gemini"), values)).toBe(true);
		expect(matchesTextQuery(parseSearchQuery("gemini 4"), values)).toBe(true);
		expect(matchesTextQuery(parseSearchQuery("Claude"), values)).toBe(false);
		expect(matchesTextQuery(parseSearchQuery("   "), values)).toBe(true);
	});

	test("excludes items matching any negative term", () => {
		const values = ["Gemini 3.8 Flash", "Google", "opencode", "OpenCode"];
		expect(matchesTextQuery(parseSearchQuery("gemini -flash"), values)).toBe(
			false,
		);
		expect(
			matchesTextQuery(parseSearchQuery("gemini -claude -flash"), values),
		).toBe(false);
		expect(
			matchesTextQuery(parseSearchQuery("gemini -claude -sonnet"), values),
		).toBe(true);
	});

	test("filters by qualifiers against supplied facets", () => {
		const values = [
			"Gemini 4 Hydrogen",
			"Google",
			"antigravity",
			"Antigravity",
		];
		const facets = {
			model: ["Gemini 4 Hydrogen"],
			harness: ["antigravity", "Antigravity"],
		};
		expect(
			matchesTextQuery(parseSearchQuery("harness:antigravity"), values, facets),
		).toBe(true);
		expect(
			matchesTextQuery(parseSearchQuery("harness:codex"), values, facets),
		).toBe(false);
		expect(
			matchesTextQuery(
				parseSearchQuery("model:gemini -harness:codex"),
				values,
				facets,
			),
		).toBe(true);
		expect(
			matchesTextQuery(
				parseSearchQuery("model:gemini -harness:antigravity"),
				values,
				facets,
			),
		).toBe(false);
	});
});

describe("session query & snippet extraction", () => {
	test("matches session body text and excludes any negative term", () => {
		expect(
			matchesSessionQuery(
				sampleSession,
				parseSearchQuery("cache invalidation"),
			),
		).toBe(true);
		expect(
			matchesSessionQuery(
				sampleSession,
				parseSearchQuery("cache -nonexistent -invalidation"),
			),
		).toBe(false);
	});

	test("ranks title matches ahead of body-only matches", () => {
		const titleMatch = scoreSessionQuery(
			sampleSession,
			parseSearchQuery("filtering"),
		);
		const bodyMatch = scoreSessionQuery(
			sampleSession,
			parseSearchQuery("invalidation"),
		);
		expect(titleMatch).toBeGreaterThan(bodyMatch);
		expect(bodyMatch).toBeGreaterThan(0);
	});

	test("extracts a centered snippet around the first matching term", () => {
		const prefix = "a".repeat(80);
		const body = `${prefix} discovered subtle websocket reconnect bug here ${"b".repeat(80)}`;
		const snippet = extractSnippet(body, ["websocket"], 70);
		expect(snippet).not.toBeNull();
		expect(snippet).toContain("websocket");
		expect(snippet?.startsWith("…")).toBe(true);
		expect(snippet?.endsWith("…")).toBe(true);
	});
});

describe("indexed full-text & entity search integration", () => {
	test("searches models, harnesses, projects, and transcript bodies end-to-end", async () => {
		await withIsolatedStore(
			({ codexHome }) => {
				writeCodexRollout(
					codexHome,
					`rollout-2026-05-01T10-00-00-${SESSION_A}.jsonl`,
					{
						sessionId: SESSION_A,
						cwd: "/tmp/workspace/alpha-portal",
						model: "gemini-2.5-pro",
						timestamp: "2026-05-01T10:00:00.000Z",
						userText: "Fix pagination alignment in the header bar",
						assistantText:
							"Updated layout spacing and verified the quantum_flux_capacitor handler passes.",
					},
				);
				writeCodexRollout(
					codexHome,
					`rollout-2026-05-01T11-00-00-${SESSION_B}.jsonl`,
					{
						sessionId: SESSION_B,
						cwd: "/tmp/workspace/beta-billing",
						model: "gpt-5.4",
						timestamp: "2026-05-01T11:00:00.000Z",
						userText: "Audit invoice rounding rules",
						assistantText: "Checked tax calculation across currencies.",
					},
				);
			},
			async () => {
				// Global search finds models & harnesses & projects (previously broken)
				const gemini = searchPayload("Gemini");
				expect(gemini.models.some((m) => m.model.includes("Gemini"))).toBe(
					true,
				);
				expect(gemini.sessions.map((s) => s.sessionId)).toEqual([SESSION_A]);

				const codex = searchPayload("Codex");
				expect(codex.harnesses.map((h) => h.harness)).toContain("codex");
				expect(codex.sessions).toHaveLength(2);

				const project = searchPayload("alpha-portal");
				expect(project.projects.map((p) => p.name)).toContain("alpha-portal");

				// Body-only search matches transcript content and builds snippet
				const bodyGlobal = searchPayload("quantum_flux_capacitor");
				expect(bodyGlobal.sessions).toHaveLength(1);
				expect(bodyGlobal.sessions[0]?.sessionId).toBe(SESSION_A);
				expect(bodyGlobal.sessions[0]?.snippet).toContain(
					"quantum_flux_capacitor",
				);

				// Sessions search helper respects qualifiers and exclusions
				const bodyList = sessionSearchMatches("quantum_flux_capacitor");
				expect(bodyList.keys).toEqual([`codex:${SESSION_A}`]);
				expect(bodyList.snippets[`codex:${SESSION_A}`]).toContain(
					"quantum_flux_capacitor",
				);
				expect(
					sessionSearchMatches("quantum_flux_capacitor -pagination").keys,
				).toEqual([]);
				expect(sessionSearchMatches("harness:codex invoice").keys).toEqual([
					`codex:${SESSION_B}`,
				]);

				// HTTP API route /api/sessions/search is not shadowed by /api/sessions/:harness/:id
				const sessionsUrl = new URL(
					"http://localhost/api/sessions/search?q=quantum_flux_capacitor",
				);
				const sessionsRes = await handleApi(
					new Request(sessionsUrl),
					sessionsUrl,
				);
				expect(sessionsRes.status).toBe(200);
				const sessionsBody =
					(await sessionsRes.json()) as SessionsSearchPayload;
				expect(sessionsBody.keys).toEqual([`codex:${SESSION_A}`]);
				expect(sessionsBody.snippets[`codex:${SESSION_A}`]).toContain(
					"quantum_flux_capacitor",
				);

				const globalUrl = new URL("http://localhost/api/search?q=Gemini");
				const globalRes = await handleApi(new Request(globalUrl), globalUrl);
				expect(globalRes.status).toBe(200);
				const globalBody = (await globalRes.json()) as SearchPayload;
				expect(globalBody.models.length).toBeGreaterThan(0);
			},
		);
	});
});
