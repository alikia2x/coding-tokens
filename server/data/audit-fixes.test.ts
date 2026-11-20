import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageRecord } from "@shared/types";
import { handleApi } from "../api";
import { startServer } from "../start";
import {
	openStoreDatabase,
	readHarnessRecords,
	readSessionFileStamps,
	readSourceState,
	replaceHarnessAll,
	replaceHarnessRecords,
} from "./database";
import { DataStore, store } from "./store";
import { bucketize, projectName } from "./totals";
import { resolveWorkerCommand } from "./worker-command";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ct-audit-fixes-"));

afterAll(() => {
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {}
});

describe("Database persistence & atomicity fixes", () => {
	test("readSourceState returns indexedAt and preserves isReview & pricingModel", () => {
		const dbPath = path.join(tmpRoot, "state-and-fields.sqlite");
		const db = openStoreDatabase(dbPath);
		try {
			const records: UsageRecord[] = [
				{
					harness: "codex",
					sessionId: "s-review",
					messageId: "m-1",
					isSubagent: false,
					isReview: true,
					cwd: "/repo",
					model: "GPT-5",
					rawModel: "gpt-5-2026",
					pricingModel: "openai/gpt-5",
					timestamp: 1_700_000_000_000,
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0.01,
					costEstimated: false,
				},
			];
			replaceHarnessRecords(db, "codex", records, {
				fingerprint: "fp-1",
				indexedAt: 1_700_000_123_456,
				available: 1,
				warnings: "[]",
			});
			const state = readSourceState(db, "codex");
			expect(state).toEqual({
				fingerprint: "fp-1",
				indexedAt: 1_700_000_123_456,
				available: 1,
				warnings: "[]",
			});

			const loaded = readHarnessRecords(db, "codex");
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.isReview).toBe(true);
			expect(loaded[0]?.pricingModel).toBe("openai/gpt-5");
		} finally {
			db.close();
		}
	});

	test("replaceHarnessAll clears stamps when discoveredItems becomes empty", () => {
		const dbPath = path.join(tmpRoot, "stamps-clear.sqlite");
		const db = openStoreDatabase(dbPath);
		try {
			replaceHarnessAll(db, "codex", {
				records: [],
				messages: new Map(),
				texts: new Map(),
				discoveredItems: [
					{
						harness: "codex",
						sessionId: "s1",
						filePath: "/tmp/s1.jsonl",
						mtimeMs: 100,
						sizeBytes: 50,
						cwd: "/repo",
					},
				],
				catalogEntries: new Map(),
				state: {
					fingerprint: "fp-a",
					indexedAt: 1000,
					available: 1,
					warnings: "[]",
				},
			});
			expect(readSessionFileStamps(db, "codex")).toHaveLength(1);

			replaceHarnessAll(db, "codex", {
				records: [],
				messages: new Map(),
				texts: new Map(),
				discoveredItems: [],
				catalogEntries: new Map(),
				state: {
					fingerprint: "fp-b",
					indexedAt: 2000,
					available: 0,
					warnings: "[]",
				},
			});
			expect(readSessionFileStamps(db, "codex")).toHaveLength(0);
			expect(readSourceState(db, "codex")?.fingerprint).toBe("fp-b");
		} finally {
			db.close();
		}
	});
});

describe("Totals, Windows paths & DataStore fixes", () => {
	test("DataStore.totalsFor honors :cumulative-total deduplication", () => {
		const localStore = new DataStore();
		const totals = localStore.totalsFor([
			{
				harness: "antigravity",
				sessionId: "s1",
				messageId: "m1",
				cwd: null,
				model: "gemini-2.5-pro",
				timestamp: 1000,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.01,
				costEstimated: false,
			},
			{
				harness: "antigravity",
				sessionId: "s1",
				messageId: "m1:cumulative-total",
				cwd: null,
				model: "gemini-2.5-pro",
				timestamp: 2000,
				inputTokens: 400,
				outputTokens: 200,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.04,
				costEstimated: false,
			},
		]);
		expect(totals.inputTokens).toBe(400);
		expect(totals.outputTokens).toBe(200);
		expect(totals.costUsd).toBe(0.04);
		expect(totals.requests).toBe(1);
	});

	test("projectName normalizes Windows backslashes across platforms", () => {
		expect(projectName("C:\\Users\\dev\\workspace\\win-app\\")).toBe("win-app");
		expect(projectName("\\\\server\\share\\proj\\")).toBe("proj");
	});

	test("bucketize with unit=hour over >2000 hours clamps from latest window backwards", () => {
		const end = new Date(2026, 10, 20, 12, 0, 0, 0).getTime();
		const start = end - 3000 * 3_600_000;
		const recentTs = end - 2 * 3_600_000;
		const buckets = bucketize(
			[
				{
					harness: "codex",
					sessionId: "s-recent",
					messageId: "m-recent",
					cwd: "/repo",
					model: "gpt-5",
					timestamp: recentTs,
					inputTokens: 500,
					outputTokens: 100,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0.5,
					costEstimated: false,
				},
			],
			start,
			end,
			"hour",
		);
		expect(buckets.length).toBeLessThanOrEqual(2000);
		const totalCost = buckets.reduce((sum, b) => sum + b.totals.costUsd, 0);
		expect(totalCost).toBeCloseTo(0.5, 6);
	});
});

describe("API security, validation & static serving fixes", () => {
	test("API enforces localhost Origin/Host, Content-Type, and field validation", async () => {
		const savedDbPath = store.databasePath();
		const dbPath = path.join(tmpRoot, "api-validation.sqlite");
		const staticDir = path.join(tmpRoot, "static");
		mkdirSync(path.join(staticDir, "assets"), { recursive: true });
		writeFileSync(path.join(staticDir, "index.html"), "<html>ok</html>");
		const existingFile = path.join(tmpRoot, "existing.txt");
		writeFileSync(existingFile, "hello");

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
		for (const k of envKeys) savedEnv.set(k, process.env[k]);
		const emptyDir = path.join(tmpRoot, "empty-harnesses");
		mkdirSync(emptyDir, { recursive: true });
		for (const k of envKeys) {
			if (k === "OPENCODE_DB") delete process.env[k];
			else process.env[k] = emptyDir;
		}

		store.configure({ dbPath });
		await store.start();
		const started = startServer({
			port: 0,
			hostname: "127.0.0.1",
			staticDir,
			dbPath,
		});

		try {
			// Cross-origin mutating request rejected with 403
			const csrfRes = await handleApi(
				new Request("http://127.0.0.1:4317/api/settings", {
					method: "PUT",
					headers: {
						Origin: "https://evil.example",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ theme: "dark" }),
				}),
				new URL("http://127.0.0.1:4317/api/settings"),
			);
			expect(csrfRes.status).toBe(403);

			// Wrong Content-Type rejected with 415
			const ctRes = await handleApi(
				new Request("http://127.0.0.1:4317/api/settings", {
					method: "PUT",
					headers: { "Content-Type": "text/plain" },
					body: '{"theme":"dark"}',
				}),
				new URL("http://127.0.0.1:4317/api/settings"),
			);
			expect(ctRes.status).toBe(415);

			// Invalid settings rejected with 400
			const badSettings = await handleApi(
				new Request("http://127.0.0.1:4317/api/settings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ theme: "neon-pink" }),
				}),
				new URL("http://127.0.0.1:4317/api/settings"),
			);
			expect(badSettings.status).toBe(400);

			// Bounded heatmap weeks
			const badHeatmap = await handleApi(
				new Request("http://127.0.0.1:4317/api/heatmap?weeks=999"),
				new URL("http://127.0.0.1:4317/api/heatmap?weeks=999"),
			);
			expect(badHeatmap.status).toBe(400);

			// rangeFrom validates from < until
			const badSearchRange = await handleApi(
				new Request(
					"http://127.0.0.1:4317/api/sessions/search?from=2000&until=1000",
				),
				new URL(
					"http://127.0.0.1:4317/api/sessions/search?from=2000&until=1000",
				),
			);
			expect(badSearchRange.status).toBe(400);

			// Invalid limit returns 400
			const badLimit = await handleApi(
				new Request("http://127.0.0.1:4317/api/search?limit=0"),
				new URL("http://127.0.0.1:4317/api/search?limit=0"),
			);
			expect(badLimit.status).toBe(400);

			// Missing session returns 404; malformed encoding returns 400
			const notFoundSession = await handleApi(
				new Request("http://127.0.0.1:4317/api/sessions/codex/missing-id"),
				new URL("http://127.0.0.1:4317/api/sessions/codex/missing-id"),
			);
			expect(notFoundSession.status).toBe(404);

			const badEncoding = await handleApi(
				new Request("http://127.0.0.1:4317/api/sessions/codex/%E0%A4%A"),
				new URL("http://127.0.0.1:4317/api/sessions/codex/%E0%A4%A"),
			);
			expect(badEncoding.status).toBe(400);

			// reveal rejects URLs & missing files
			const revealUrl = await handleApi(
				new Request("http://127.0.0.1:4317/api/dialog/reveal", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: "https://evil.example" }),
				}),
				new URL("http://127.0.0.1:4317/api/dialog/reveal"),
			);
			expect(revealUrl.status).toBe(400);

			// export rejects relative directory and file-as-directory
			const relExport = await handleApi(
				new Request("http://127.0.0.1:4317/api/sessions/export", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ keys: ["codex:1"], directory: "rel/dir" }),
				}),
				new URL("http://127.0.0.1:4317/api/sessions/export"),
			);
			expect(relExport.status).toBe(400);

			const fileDirExport = await handleApi(
				new Request("http://127.0.0.1:4317/api/sessions/export", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ keys: ["codex:1"], directory: existingFile }),
				}),
				new URL("http://127.0.0.1:4317/api/sessions/export"),
			);
			expect(fileDirExport.status).toBe(400);

			// Static serving handles null bytes (400) and directory paths (404, not 500)
			const baseUrl = `http://127.0.0.1:${started.port}`;
			const nullByteRes = await fetch(`${baseUrl}/assets/%00bad.js`);
			expect(nullByteRes.status).toBe(400);

			const dirRes = await fetch(`${baseUrl}/assets`);
			expect(dirRes.status).toBe(404);
		} finally {
			started.server.stop();
			for (const [k, v] of savedEnv) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			store.configure({ dbPath: savedDbPath });
		}
	});

	test("resolveWorkerCommand throws instead of returning bare process.execPath", () => {
		expect(() => resolveWorkerCommand("non-existent-worker.ts")).toThrow();
	});
});
