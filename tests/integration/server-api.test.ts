import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApi } from "../../server/api";
import { renderBatchSessionEntries } from "../../server/data/session-export";
import { DataStore, store } from "../../server/data/store";
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
		const envKeys = [
			"HOME",
			"CODEX_HOME",
			"DSH_HOME",
			"OPENCODE_DATA_DIR",
			"OPENCODE_DB",
			"COMMANDCODE_HOME",
			"ANTIGRAVITY_HOME",
			"T3_USER_DATA_DIR",
			"CLAUDE_CONFIG_DIR",
			"AIDER_HOME",
			"GOOSE_PATH_ROOT",
			"OPENHANDS_DIR",
			"OPENHANDS_CONVERSATIONS_DIR",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"XDG_CACHE_HOME",
		] as const;
		originalEnv = {};
		for (const key of envKeys) {
			originalEnv[key] = process.env[key];
		}

		const mockHome = path.join(suiteTmp, "home");
		mkdirSync(suiteTmp, { recursive: true });
		mkdirSync(mockHome, { recursive: true });
		mkdirSync(codexHome, { recursive: true });
		mkdirSync(dshHome, { recursive: true });
		mkdirSync(exportTargetDir, { recursive: true });

		process.env.HOME = mockHome;
		process.env.CODEX_HOME = codexHome;
		process.env.DSH_HOME = dshHome;
		process.env.OPENCODE_DATA_DIR = path.join(suiteTmp, "opencode");
		process.env.OPENCODE_DB = path.join(suiteTmp, "opencode.db");
		process.env.COMMANDCODE_HOME = path.join(suiteTmp, "commandcode");
		process.env.ANTIGRAVITY_HOME = path.join(suiteTmp, "antigravity");
		process.env.T3_USER_DATA_DIR = path.join(suiteTmp, "t3");
		process.env.CLAUDE_CONFIG_DIR = path.join(suiteTmp, "claude");
		process.env.AIDER_HOME = path.join(suiteTmp, "aider");
		process.env.GOOSE_PATH_ROOT = path.join(suiteTmp, "goose");
		process.env.OPENHANDS_DIR = path.join(suiteTmp, "openhands");
		process.env.OPENHANDS_CONVERSATIONS_DIR = path.join(
			suiteTmp,
			"openhands",
			"conversations",
		);
		process.env.XDG_CONFIG_HOME = path.join(suiteTmp, "xdg-config");
		process.env.XDG_DATA_HOME = path.join(suiteTmp, "xdg-data");
		process.env.XDG_CACHE_HOME = path.join(suiteTmp, "xdg-cache");

		for (const key of envKeys) {
			if (key !== "OPENCODE_DB") {
				const dir = process.env[key];
				if (dir) mkdirSync(dir, { recursive: true });
			}
		}

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
		store.close();
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
				body: {
					locale: "ja",
					theme: "dark",
					batchExportDetailLevel: "chat_tools",
					batchExportOrganization: "custom",
					batchExportPathTemplate: "{harness}/{date}/{title}.md",
					batchExportIncludeTimestamps: false,
					batchExportIncludeTokenStats: false,
					batchExportAsZip: true,
				},
			});
			expect(putRes.status).toBe(200);
			const updated = await putRes.json();
			expect(updated.locale).toBe("ja");
			expect(updated.theme).toBe("dark");
			expect(updated.batchExportDetailLevel).toBe("chat_tools");
			expect(updated.batchExportOrganization).toBe("custom");
			expect(updated.batchExportPathTemplate).toBe(
				"{harness}/{date}/{title}.md",
			);
			expect(updated.batchExportIncludeTimestamps).toBe(false);
			expect(updated.batchExportIncludeTokenStats).toBe(false);
			expect(updated.batchExportAsZip).toBe(true);

			const getRes = await dispatchApi("/api/settings");
			const fetched = await getRes.json();
			expect(fetched.locale).toBe("ja");
			expect(fetched.theme).toBe("dark");
			expect(fetched.batchExportDetailLevel).toBe("chat_tools");
			expect(fetched.batchExportOrganization).toBe("custom");
			expect(fetched.batchExportPathTemplate).toBe(
				"{harness}/{date}/{title}.md",
			);
			expect(fetched.batchExportIncludeTimestamps).toBe(false);
			expect(fetched.batchExportIncludeTokenStats).toBe(false);
			expect(fetched.batchExportAsZip).toBe(true);
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

		test("API-T1-15: POST /api/sessions/export batch exports matching sessions and _index.md", async () => {
			const batchDir = path.join(suiteTmp, "batch-exports");
			const folderRes = await dispatchApi("/api/sessions/export", {
				method: "POST",
				body: {
					keys: ["codex:codex-sess-1"],
					level: "chat",
					includeTimestamps: true,
					includeTokenStats: true,
					directory: batchDir,
				},
			});
			expect(folderRes.status).toBe(200);
			const folderData = await folderRes.json();
			expect(folderData.filesWritten).toBe(1);
			expect(folderData.skippedCount).toBe(0);
			expect(existsSync(folderData.outputPath)).toBe(true);

			const res = await dispatchApi("/api/sessions/export", {
				method: "POST",
				body: {
					keys: ["codex:codex-sess-1"],
					level: "chat",
					includeTimestamps: true,
					includeTokenStats: true,
					directory: batchDir,
					asZip: true,
				},
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.directory).toBe(batchDir);
			expect(data.filesWritten).toBe(1);
			expect(data.skippedCount).toBe(0);
			expect(data.filename.endsWith(".zip")).toBe(true);
			expect(existsSync(data.zipPath)).toBe(true);
			const zipBytes = readFileSync(data.zipPath);
			expect(zipBytes[0]).toBe(0x50); // 'P'
			expect(zipBytes[1]).toBe(0x4b); // 'K'
		});
	});

	// =========================================================================
	// Tier 2: Boundary, Corruption & Error Handling (6 tests)
	// =========================================================================
	describe("Tier 2: Boundary & Error Handling", () => {
		test("API-T2-00: POST /api/sessions/export with empty keys returns 400", async () => {
			const res = await dispatchApi("/api/sessions/export", {
				method: "POST",
				body: { keys: [], level: "chat" },
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("At least one session key is required");
		});
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
			// Session does not exist in transcript sources; decodes safely and returns 404 rather than 500
			expect(res.status).toBe(404);
			const data = await res.json();
			expect(data.error).toBe("Session not found");
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

		test("DataStore recovers unchanged harnesses missing from partial session_catalog", async () => {
			const partialDbPath = path.join(suiteTmp, "partial-catalog.db");
			const sourceDb = new Database(dbPath, { readonly: true });
			try {
				sourceDb.exec(`VACUUM INTO '${partialDbPath.replace(/'/g, "''")}'`);
			} finally {
				sourceDb.close();
			}
			const rawDb = new Database(partialDbPath);
			try {
				rawDb.exec("DELETE FROM session_catalog WHERE harness = 'codex'");
				rawDb.exec(`
					INSERT OR REPLACE INTO usage_records (
						harness, session_id, message_id, turn_id, is_subagent, cwd, model,
						timestamp, input_tokens, output_tokens, cache_read_tokens,
						cache_write_tokens, reasoning_tokens, cost_usd, cost_estimated
					) VALUES (
						'dsh', 'dsh-existing', 'm-dsh-1', NULL, 0, '/workspace/sample-project',
						'claude-3-5-sonnet', 1773568800000, 100, 50, 0, 0, 0, 0.01, 0
					);
					INSERT OR REPLACE INTO session_catalog (
						harness, session_id, title, cwd, started_at, is_subagent,
						is_review, has_transcript, source_kind, source_path
					) VALUES (
						'dsh', 'dsh-existing', 'Existing DSH Session', '/workspace/sample-project',
						1773568800000, 0, 0, 0, NULL, NULL
					);
				`);
			} finally {
				rawDb.close();
			}

			const partialStore = new DataStore();
			try {
				partialStore.configure({ dbPath: partialDbPath });
				await partialStore.start();

				const summaries = partialStore.sessionSummaries({
					from: null,
					until: null,
				});
				const harnesses = new Set(summaries.map((item) => item.harness));
				expect(harnesses.has("codex")).toBe(true);
				expect(partialStore.catalogEntries().has("codex:codex-sess-1")).toBe(
					true,
				);

				const persistedDb = new Database(partialDbPath, { readonly: true });
				try {
					const codexRows = persistedDb
						.query(
							"SELECT COUNT(*) as cnt FROM session_catalog WHERE harness = 'codex'",
						)
						.get() as { cnt: number };
					expect(codexRows.cnt).toBeGreaterThan(0);
				} finally {
					persistedDb.close();
				}
			} finally {
				partialStore.close();
			}
		});

		test("Batch export aborts immediately when signal cancels isolated worker", async () => {
			const controller = new AbortController();
			const promise = renderBatchSessionEntries({
				keys: ["codex:codex-sess-1"],
				detail: "chat",
				signal: controller.signal,
			});
			controller.abort();
			await expect(promise).rejects.toThrow();
		});

		test("Pricing API: GET/PUT settings, live custom rule repricing, lossless delete, and invalid URL rejection", async () => {
			// 1. Inspect initial pricing payload
			const initialRes = await dispatchApi("/api/pricing");
			expect(initialRes.status).toBe(200);
			const initialPricing = await initialRes.json();
			expect(initialPricing).toHaveProperty("status");
			expect(initialPricing).toHaveProperty("settings");
			expect(initialPricing.settings.endpoint).toBe(
				"https://models.dev/api.json",
			);

			// 2. Reject invalid URL
			const invalidRes = await dispatchApi("/api/pricing/settings", {
				method: "PUT",
				body: { endpoint: "ftp://invalid.example/prices.json" },
			});
			expect(invalidRes.status).toBe(400);

			// 3. Valid settings update (offline mode)
			const settingsRes = await dispatchApi("/api/pricing/settings", {
				method: "PUT",
				body: { autoFetch: false, cacheTtlHours: 12 },
			});
			expect(settingsRes.status).toBe(200);
			const updatedSettings = await settingsRes.json();
			expect(updatedSettings.settings.autoFetch).toBe(false);
			expect(updatedSettings.settings.cacheTtlHours).toBe(12);

			// 4. Inspect model report before custom rule
			const modelsBeforeRes = await dispatchApi("/api/models");
			expect(modelsBeforeRes.status).toBe(200);
			const modelsBefore = await modelsBeforeRes.json();
			expect(modelsBefore.rows.length).toBeGreaterThan(0);
			const targetModel = modelsBefore.rows[0].model as string;
			expect(modelsBefore.rows[0]).toHaveProperty("pricing");
			const originalCost = modelsBefore.rows[0].totals.costUsd as number;

			// 5. Upsert custom rule with overrideRecorded: true
			const ruleRes = await dispatchApi("/api/pricing/rules", {
				method: "PUT",
				body: {
					rule: {
						model: targetModel,
						mode: "rates",
						rates: {
							input: 1000,
							output: 2000,
							cacheRead: 500,
							cacheWrite: 1000,
							reasoning: 2000,
						},
						overrideRecorded: true,
					},
				},
			});
			expect(ruleRes.status).toBe(200);
			const rulePayload = await ruleRes.json();
			expect(rulePayload.status.summary.customModels).toBeGreaterThanOrEqual(1);

			// 6. Verify /api/models reflects custom rates immediately
			const modelsAfterRes = await dispatchApi("/api/models");
			const modelsAfter = await modelsAfterRes.json();
			const updatedRow = modelsAfter.rows.find(
				(r: { model: string }) => r.model === targetModel,
			);
			expect(updatedRow).toBeDefined();
			expect(updatedRow.pricing.source).toBe("custom");
			expect(updatedRow.totals.costUsd).not.toBe(originalCost);
			expect(updatedRow.totals.costUsd).toBeGreaterThan(0);

			// 7. Delete custom rule and confirm original cost is losslessly restored
			const delRes = await dispatchApi(
				`/api/pricing/rules/${encodeURIComponent(targetModel)}`,
				{ method: "DELETE" },
			);
			expect(delRes.status).toBe(200);
			const modelsRestoredRes = await dispatchApi("/api/models");
			const modelsRestored = await modelsRestoredRes.json();
			const restoredRow = modelsRestored.rows.find(
				(r: { model: string }) => r.model === targetModel,
			);
			expect(restoredRow.totals.costUsd).toBeCloseTo(originalCost, 6);

			// 8. Catalog search endpoint works cleanly
			const catalogRes = await dispatchApi("/api/pricing/catalog?q=&limit=10");
			expect(catalogRes.status).toBe(200);
			const catalogBody = await catalogRes.json();
			expect(Array.isArray(catalogBody.items)).toBe(true);
		});

		test("Cache-first cold hydrate and isolated index-worker sync cleanly", async () => {
			const workerDbPath = path.join(suiteTmp, "worker-hydrate.db");
			copyFileSync(dbPath, workerDbPath);

			const coldStore = new DataStore();
			try {
				coldStore.configure({ dbPath: workerDbPath, useIndexWorker: true });
				await coldStore.start();

				expect(coldStore.isReady).toBe(true);
				expect(coldStore.allRecords().length).toBeGreaterThan(0);
				expect(
					coldStore.sessionSummaries({ from: null, until: null }).length,
				).toBeGreaterThan(0);
			} finally {
				coldStore.close();
			}
		});
	});
});
