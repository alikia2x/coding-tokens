import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApi } from "../../server/api";
import { store } from "../../server/data/store";
import { startServer } from "../../server/start";

describe("Server REST API Integration Suite", () => {
	const suiteTmp = path.join(
		os.tmpdir(),
		`ct-api-suite-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	const dbPath = path.join(suiteTmp, "api-store.db");
	const codexHome = path.join(suiteTmp, "codex");
	const dshHome = path.join(suiteTmp, "dsh");
	const exportTargetDir = path.join(suiteTmp, "api-exports");

	let originalEnv: Record<string, string | undefined>;
	let serverInstance: ReturnType<typeof startServer> | null = null;
	let baseUrl = "";

	beforeAll(async () => {
		originalEnv = {
			CODEX_HOME: process.env.CODEX_HOME,
			DSH_HOME: process.env.DSH_HOME,
			OPENCODE_DATA_DIR: process.env.OPENCODE_DATA_DIR,
			OPENCODE_DB: process.env.OPENCODE_DB,
			COMMANDCODE_HOME: process.env.COMMANDCODE_HOME,
			ANTIGRAVITY_HOME: process.env.ANTIGRAVITY_HOME,
			T3_USER_DATA_DIR: process.env.T3_USER_DATA_DIR,
		};

		mkdirSync(suiteTmp, { recursive: true });
		mkdirSync(codexHome, { recursive: true });
		mkdirSync(dshHome, { recursive: true });
		mkdirSync(exportTargetDir, { recursive: true });

		process.env.CODEX_HOME = codexHome;
		process.env.DSH_HOME = dshHome;
		process.env.OPENCODE_DATA_DIR = path.join(suiteTmp, "opencode");
		process.env.OPENCODE_DB = path.join(suiteTmp, "opencode.db");
		process.env.COMMANDCODE_HOME = path.join(suiteTmp, "commandcode");
		process.env.ANTIGRAVITY_HOME = path.join(suiteTmp, "antigravity");
		process.env.T3_USER_DATA_DIR = path.join(suiteTmp, "t3");

		mkdirSync(process.env.OPENCODE_DATA_DIR, { recursive: true });
		mkdirSync(process.env.COMMANDCODE_HOME, { recursive: true });
		mkdirSync(process.env.ANTIGRAVITY_HOME, { recursive: true });
		mkdirSync(process.env.T3_USER_DATA_DIR, { recursive: true });

		// Seed a valid Codex session so that sessions and exports succeed
		const codexSessionsDir = path.join(codexHome, "sessions");
		mkdirSync(codexSessionsDir, { recursive: true });
		const sampleSessionFile = path.join(
			codexSessionsDir,
			"rollout-2026-03-15T10-00-00-codex-sess-1.jsonl",
		);
		const lines = [
			JSON.stringify({
				type: "session_meta",
				timestamp: "2026-03-15T10:00:00.000Z",
				payload: {
					id: "codex-sess-1",
					timestamp: "2026-03-15T10:00:00.000Z",
					cwd: "/workspace/sample-project",
				},
			}),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-03-15T10:00:01.000Z",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "text", text: "Implement REST API tests." }],
				},
			}),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-03-15T10:00:02.000Z",
				payload: {
					type: "message",
					role: "assistant",
					content: [
						{ type: "text", text: "Writing integration test suite now." },
					],
				},
			}),
			JSON.stringify({
				type: "token_usage_record",
				timestamp: "2026-03-15T10:00:03.000Z",
				payload: {
					usage: {
						input_tokens: 350,
						output_tokens: 120,
						cached_input_tokens: 50,
						reasoning_output_tokens: 15,
					},
				},
			}),
		];
		writeFileSync(sampleSessionFile, lines.join("\n"), "utf8");

		// Configure store and refresh data
		store.configure({ dbPath });
		await store.start();
		await store.ensureReady();

		// Start ephemeral server for real socket testing
		serverInstance = startServer({
			port: 0,
			hostname: "127.0.0.1",
			dbPath,
		});
		baseUrl = `http://127.0.0.1:${serverInstance.port}`;
	});

	afterAll(() => {
		if (serverInstance?.server) {
			serverInstance.server.stop();
		}
		for (const [key, val] of Object.entries(originalEnv)) {
			if (val === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = val;
			}
		}
		try {
			rmSync(suiteTmp, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	async function dispatchApi(
		pathAndQuery: string,
		options: {
			method?: string;
			body?: unknown;
			headers?: Record<string, string>;
		} = {},
	) {
		const url = new URL(`http://localhost:4317${pathAndQuery}`);
		const reqInit: RequestInit = {
			method: options.method ?? "GET",
			headers: {
				"Content-Type": "application/json",
				...(options.headers ?? {}),
			},
		};
		if (options.body !== undefined) {
			reqInit.body = JSON.stringify(options.body);
		}
		const request = new Request(url.toString(), reqInit);
		return await handleApi(request, url);
	}

	// =========================================================================
	// Tier 1: Happy-Path Endpoints (14 tests)
	// =========================================================================
	describe("Tier 1: Happy-Path REST API Endpoints", () => {
		test("API-T1-01: GET /api/overview returns totals, sparkline, and top rankings", async () => {
			const res = await dispatchApi("/api/overview");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("totals");
			expect(data.totals).toHaveProperty("sessions");
			expect(data.totals).toHaveProperty("inputTokens");
			expect(data.totals).toHaveProperty("outputTokens");
			expect(data.totals).toHaveProperty("costUsd");
			expect(data).toHaveProperty("buckets");
			expect(data).toHaveProperty("harnesses");
			expect(data).toHaveProperty("models");
			expect(data).toHaveProperty("projects");
			expect(data).toHaveProperty("recentSessions");
		});

		test("API-T1-02: GET /api/sessions returns session summaries and warnings", async () => {
			const res = await dispatchApi("/api/sessions");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("sessions");
			expect(Array.isArray(data.sessions)).toBe(true);
			expect(data).toHaveProperty("indexedAt");
			expect(data).toHaveProperty("warnings");
		});

		test("API-T1-03: GET /api/harnesses returns harness report entries", async () => {
			const res = await dispatchApi("/api/harnesses");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("rows");
			expect(Array.isArray(data.rows)).toBe(true);
			expect(data).toHaveProperty("totals");
			for (const h of data.rows) {
				expect(h).toHaveProperty("harness");
				expect(h).toHaveProperty("label");
				expect(h).toHaveProperty("available");
			}
		});

		test("API-T1-04: GET /api/models returns model report entries", async () => {
			const res = await dispatchApi("/api/models");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("rows");
			expect(Array.isArray(data.rows)).toBe(true);
			expect(data).toHaveProperty("totals");
		});

		test("API-T1-05: GET /api/projects returns project report entries", async () => {
			const res = await dispatchApi("/api/projects");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("rows");
			expect(Array.isArray(data.rows)).toBe(true);
			expect(data).toHaveProperty("totals");
		});

		test("API-T1-06: GET /api/settings conforms to AppSettings schema", async () => {
			const res = await dispatchApi("/api/settings");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("theme");
			expect(data).toHaveProperty("locale");
			expect(data).toHaveProperty("defaultDetailLevel");
		});

		test("API-T1-07: PUT /api/settings updates settings and persists changes", async () => {
			const putRes = await dispatchApi("/api/settings", {
				method: "PUT",
				body: { locale: "ja", theme: "dark" },
			});
			expect(putRes.status).toBe(200);
			const updated = await putRes.json();
			expect(updated.locale).toBe("ja");
			expect(updated.theme).toBe("dark");

			const getRes = await dispatchApi("/api/settings");
			const fetched = await getRes.json();
			expect(fetched.locale).toBe("ja");
			expect(fetched.theme).toBe("dark");
		});

		test("API-T1-08: GET /api/status returns indexing status payload", async () => {
			const res = await dispatchApi("/api/status");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("ready");
			expect(data.ready).toBe(true);
			expect(data).toHaveProperty("indexing");
			expect(data).toHaveProperty("phase");
			expect(data).toHaveProperty("progress");
			expect(data.progress).toHaveProperty("completed");
			expect(data.progress).toHaveProperty("total");
		});

		test("API-T1-09: POST /api/refresh triggers refresh and responds 202 Accepted", async () => {
			const res = await dispatchApi("/api/refresh", { method: "POST" });
			expect(res.status).toBe(202);
			const data = await res.json();
			expect(data).toHaveProperty("started");
			expect(data.started).toBe(true);
			expect(data).toHaveProperty("status");
		});

		test("API-T1-10: GET /api/search returns multi-entity search results", async () => {
			const res = await dispatchApi("/api/search?q=REST");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("query");
			expect(data.query).toBe("REST");
			expect(data).toHaveProperty("models");
			expect(data).toHaveProperty("harnesses");
			expect(data).toHaveProperty("projects");
			expect(data).toHaveProperty("sessions");
		});

		test("API-T1-11: GET /api/explore returns multi-dimensional series data", async () => {
			const res = await dispatchApi(
				"/api/explore?mode=time&metric=cost&bucket=day&dimension=model",
			);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("mode");
			expect(data).toHaveProperty("metric");
			expect(data).toHaveProperty("series");
		});

		test("API-T1-12: GET /api/heatmap returns 53-week activity heatmap", async () => {
			const res = await dispatchApi("/api/heatmap?weeks=53");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("from");
			expect(data).toHaveProperty("until");
			expect(data).toHaveProperty("days");
			expect(Array.isArray(data.days)).toBe(true);
			expect(data).toHaveProperty("totals");
			expect(data).toHaveProperty("maxTokens");
		});

		test("API-T1-13: GET /api/sessions/:harness/:sessionId returns detail transcript", async () => {
			const res = await dispatchApi(
				"/api/sessions/codex/codex-sess-1?level=chat",
			);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("summary");
			expect(data).toHaveProperty("level");
			expect(data.level).toBe("chat");
			expect(data).toHaveProperty("items");
			expect(data).toHaveProperty("turns");
			expect(data).toHaveProperty("totalItems");
		});

		test("API-T1-14: POST /api/sessions/:harness/:sessionId/export writes markdown", async () => {
			const res = await dispatchApi("/api/sessions/codex/codex-sess-1/export", {
				method: "POST",
				body: {
					level: "chat",
					directory: exportTargetDir,
				},
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("path");
			expect(data).toHaveProperty("filename");
			expect(data).toHaveProperty("bytes");
			expect(data.bytes).toBeGreaterThan(0);
		});
	});

	// =========================================================================
	// Tier 2: Boundary, Corruption & Error Handling (6 tests)
	// =========================================================================
	describe("Tier 2: Boundary & Error Handling", () => {
		test("API-T2-01: Non-existent route returns 404 with error payload", async () => {
			const res = await dispatchApi("/api/unknown_resource");
			expect(res.status).toBe(404);
			const data = await res.json();
			expect(data).toEqual({ error: "Not found" });
		});

		test("API-T2-02: Inverted date range (from >= until) returns 400", async () => {
			const res = await dispatchApi("/api/overview?from=2000000&until=1000000");
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("from must be earlier than until");
		});

		test("API-T2-03: Unknown harness query param returns 400", async () => {
			const res = await dispatchApi(
				"/api/overview?harness=invalid_harness_xyz",
			);
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("Unknown harness: invalid_harness_xyz");
		});

		test("API-T2-04: Invalid detail level returns 400", async () => {
			const res = await dispatchApi(
				"/api/sessions/codex/codex-sess-1?level=bogus_level",
			);
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("Unknown detail level: bogus_level");
		});

		test("API-T2-05: Non-numeric parameter returns 400", async () => {
			const res = await dispatchApi("/api/overview?from=not_a_number");
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("from must be a number");
		});

		test("API-T2-06: URL-encoded session ID is safely decoded without 500", async () => {
			const encodedId = encodeURIComponent("/workspace/sub/sess-1");
			const res = await dispatchApi(`/api/sessions/codex/${encodedId}`);
			// Session may not exist in transcript sources, but it decodes safely and returns 200 payload
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("summary");
			expect(data.summary.sessionId).toBe("/workspace/sub/sess-1");
		});
	});

	// =========================================================================
	// Real Ephemeral HTTP Server Socket Verification
	// =========================================================================
	describe("Real Socket HTTP Requests via startServer", () => {
		test("HTTP GET /api/overview over live TCP socket", async () => {
			const res = await fetch(`${baseUrl}/api/overview`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data).toHaveProperty("totals");
		});

		test("HTTP GET /api/status over live TCP socket", async () => {
			const res = await fetch(`${baseUrl}/api/status`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.ready).toBe(true);
		});
	});
});
