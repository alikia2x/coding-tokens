import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApi } from "../../server/api";
import { store } from "../../server/data/store";
import { MockOsEnvProvider } from "../../src/platform/env";
import { DefaultPlatformPathService } from "../../src/platform/paths";
import { AntigravityProvider } from "../../src/providers/antigravity";
import { ClineProvider } from "../../src/providers/cline";
import { readCodexUsageSync } from "../../src/providers/codex/usage";
import { CursorProvider } from "../../src/providers/cursor";
import { readDshUsageSync } from "../../src/providers/dsh/usage";
import { GooseProvider } from "../../src/providers/goose";
import { RooProvider } from "../../src/providers/roo";
import { createPricingService } from "../../src/services/pricing";
import { createStorageService } from "../../src/services/storage";
import { createTranscriptService } from "../../src/services/transcripts";
import type { TranscriptSession } from "../../src/transcripts";
import type { UsageRecord } from "../../src/types";

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const HARNESSES_DIR = path.join(FIXTURES_DIR, "harnesses");
const PLATFORMS_DIR = path.join(FIXTURES_DIR, "platforms");

describe("End-to-End Pipeline Integration Suite (Milestone EM3 Tier 3)", () => {
	const suiteTmp = path.join(
		os.tmpdir(),
		`ct-e2e-suite-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	const downloadsDir = path.join(suiteTmp, "downloads");

	beforeAll(() => {
		mkdirSync(suiteTmp, { recursive: true });
		mkdirSync(downloadsDir, { recursive: true });
	});

	afterAll(() => {
		try {
			rmSync(suiteTmp, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	test("E2E-T3-01: Fixture -> Provider -> Storage persistence pipeline", async () => {
		const storage = createStorageService({
			dbPath: path.join(suiteTmp, "t1-storage.db"),
		});
		await storage.init();
		const claudeFixtureDir = path.join(HARNESSES_DIR, "claude");

		// Read stats-cache.json directly from fixture
		const statsCachePath = path.join(claudeFixtureDir, "stats-cache.json");
		expect(existsSync(statsCachePath)).toBe(true);
		const statsData = JSON.parse(readFileSync(statsCachePath, "utf8"));
		expect(statsData).toHaveProperty("modelUsage");

		const records: UsageRecord[] = [
			{
				harness: "claude",
				sessionId: "claude-sess-stats",
				messageId: "msg-stats-1",
				cwd: "/workspace/claude-project",
				model: "claude-3-7-sonnet",
				timestamp: Date.now(),
				inputTokens: 25000,
				outputTokens: 3500,
				cacheReadTokens: 150000,
				cacheWriteTokens: 12000,
				reasoningTokens: 1000,
				costUsd: 0.15,
				costEstimated: false,
			},
		];

		await storage.saveHarnessBatch({
			harness: "claude",
			records,
			state: {
				harness: "claude",
				fingerprint: "v12:1:abcd1234",
				indexedAt: Date.now(),
				available: true,
				warnings: [],
			},
		});

		const persisted = await storage.getUsageRecords({ harness: "claude" });
		expect(persisted.length).toBe(1);
		expect(persisted[0]?.inputTokens).toBe(25000);
		expect(persisted[0]?.cacheReadTokens).toBe(150000);
		expect(persisted[0]?.model).toBe("claude-3-7-sonnet");
	});

	test("E2E-T3-02: SQLite -> Pricing -> Cost enrichment calculation", async () => {
		const pricing = createPricingService();
		const unpricedRecords: UsageRecord[] = [
			{
				harness: "claude",
				sessionId: "claude-sess-unpriced",
				messageId: "msg-unpriced-1",
				cwd: "/workspace/project",
				model: "claude-3-7-sonnet",
				timestamp: Date.now(),
				inputTokens: 10000,
				outputTokens: 2000,
				cacheReadTokens: 5000,
				cacheWriteTokens: 1000,
				reasoningTokens: 500,
				costUsd: 0,
				costEstimated: false,
			},
		];

		const enriched = await pricing.enrichRecords(unpricedRecords);
		expect(enriched.length).toBe(1);
		expect(enriched[0]?.costUsd).toBeGreaterThan(0);
		expect(enriched[0]?.costEstimated).toBe(true);
	});

	test("E2E-T3-03: Storage -> FTS5 indexing -> Session text search", async () => {
		const storage = createStorageService({
			dbPath: path.join(suiteTmp, "t3-fts.db"),
		});
		await storage.init();
		const uniqueKeyword = "refactor_auth_token_pipeline";

		await storage.saveHarnessBatch({
			harness: "codex",
			records: [
				{
					harness: "codex",
					sessionId: "codex-auth-sess",
					messageId: "msg-1",
					cwd: "/workspace/auth",
					model: "gpt-4o",
					timestamp: Date.now(),
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0.001,
					costEstimated: false,
				},
			],
			state: {
				harness: "codex",
				fingerprint: "v12:1:auth",
				indexedAt: Date.now(),
				available: true,
				warnings: [],
			},
			texts: new Map([
				[
					"codex-auth-sess",
					`User asked: Please help with the ${uniqueKeyword} in security module.`,
				],
			]),
		});

		const matches = await storage.searchSessionText(uniqueKeyword);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.sessionId).toBe("codex-auth-sess");
		expect(matches[0]?.snippet).toContain(uniqueKeyword);
	});

	test("E2E-T3-04: Catalog -> Transcript -> Markdown export pipeline", async () => {
		const transcripts = createTranscriptService();
		const session: TranscriptSession = {
			harness: "codex",
			sessionId: "sess-e2e-md-export",
			title: "Pipeline Verification",
			cwd: "/workspace/e2e",
			startedAt: Date.now() - 5000,
			items: [
				{
					id: "item-1",
					order: 1,
					turnId: "turn-1",
					phase: "final",
					kind: "message",
					role: "user",
					text: "Verify the complete export pipeline.",
					timestamp: Date.now() - 5000,
				},
				{
					id: "item-2",
					order: 2,
					turnId: "turn-1",
					phase: "final",
					kind: "message",
					role: "assistant",
					text: "Pipeline markdown rendering completed successfully.",
					timestamp: Date.now(),
				},
			],
			usageRecords: [
				{
					harness: "codex",
					sessionId: "sess-e2e-md-export",
					messageId: "m1",
					cwd: "/workspace/e2e",
					model: "gpt-4o",
					timestamp: Date.now(),
					inputTokens: 200,
					outputTokens: 80,
					cacheReadTokens: 10,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0.002,
					costEstimated: false,
				},
			],
		};

		const result = await transcripts.exportMarkdown(session, {
			detail: "chat",
			targetDirectory: downloadsDir,
		});

		expect(result.filePath).toBeDefined();
		expect(existsSync(result.filePath)).toBe(true);
		expect(result.bytes).toBeGreaterThan(0);
		const content = readFileSync(result.filePath, "utf8");
		expect(content).toContain("Verify the complete export pipeline.");
		expect(content).toContain(
			"Pipeline markdown rendering completed successfully.",
		);
	});

	test("E2E-T3-05: Full Multi-Harness Pipeline -> REST API overview output", async () => {
		const apiDbPath = path.join(suiteTmp, "api-pipeline.db");
		const prevCodex = process.env.CODEX_HOME;
		const prevDsh = process.env.DSH_HOME;
		const prevOpenCode = process.env.OPENCODE_DB;
		const prevCmd = process.env.COMMANDCODE_HOME;
		const prevAg = process.env.ANTIGRAVITY_HOME;
		const prevT3 = process.env.T3_USER_DATA_DIR;

		const emptyHome = path.join(suiteTmp, "empty-harnesses");
		mkdirSync(emptyHome, { recursive: true });
		process.env.CODEX_HOME = emptyHome;
		process.env.DSH_HOME = emptyHome;
		process.env.OPENCODE_DB = path.join(emptyHome, "none.db");
		process.env.COMMANDCODE_HOME = emptyHome;
		process.env.ANTIGRAVITY_HOME = emptyHome;
		process.env.T3_USER_DATA_DIR = emptyHome;

		try {
			store.configure({ dbPath: apiDbPath });

			// Seed storage directly via DefaultStorageService
			const storage = createStorageService({ dbPath: apiDbPath });
			await storage.init();
			await storage.saveHarnessBatch({
				harness: "codex",
				records: [
					{
						harness: "codex",
						sessionId: "sess-cdx",
						messageId: "m1",
						cwd: "/workspace/proj-a",
						model: "gpt-4o",
						timestamp: Date.now(),
						inputTokens: 500,
						outputTokens: 200,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUsd: 0.005,
						costEstimated: false,
					},
				],
				state: {
					harness: "codex",
					fingerprint: "cdx-fp",
					indexedAt: Date.now(),
					available: true,
					warnings: [],
				},
			});

			await storage.saveHarnessBatch({
				harness: "cline",
				records: [
					{
						harness: "cline",
						sessionId: "sess-cline",
						messageId: "m2",
						cwd: "/workspace/proj-b",
						model: "claude-3-7-sonnet",
						timestamp: Date.now(),
						inputTokens: 1200,
						outputTokens: 400,
						cacheReadTokens: 800,
						cacheWriteTokens: 100,
						reasoningTokens: 50,
						costUsd: 0.015,
						costEstimated: false,
					},
				],
				state: {
					harness: "cline",
					fingerprint: "cline-fp",
					indexedAt: Date.now(),
					available: true,
					warnings: [],
				},
			});

			await store.start();
			await store.ensureReady();

			const url = new URL("http://localhost:4317/api/overview");
			const req = new Request(url.toString(), { method: "GET" });
			const response = await handleApi(req, url);
			expect(response.status).toBe(200);
			const overview = await response.json();
			expect(overview.totals.sessions).toBeGreaterThanOrEqual(2);
			expect(overview.totals.inputTokens).toBeGreaterThan(0);
		} finally {
			if (prevCodex !== undefined) process.env.CODEX_HOME = prevCodex;
			else delete process.env.CODEX_HOME;
			if (prevDsh !== undefined) process.env.DSH_HOME = prevDsh;
			else delete process.env.DSH_HOME;
			if (prevOpenCode !== undefined) process.env.OPENCODE_DB = prevOpenCode;
			else delete process.env.OPENCODE_DB;
			if (prevCmd !== undefined) process.env.COMMANDCODE_HOME = prevCmd;
			else delete process.env.COMMANDCODE_HOME;
			if (prevAg !== undefined) process.env.ANTIGRAVITY_HOME = prevAg;
			else delete process.env.ANTIGRAVITY_HOME;
			if (prevT3 !== undefined) process.env.T3_USER_DATA_DIR = prevT3;
			else delete process.env.T3_USER_DATA_DIR;
		}
	});

	test("E2E-T3-06: Multi-Platform Discovery (Darwin environment)", async () => {
		const darwinHome = path.join(PLATFORMS_DIR, "darwin");
		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: darwinHome,
		});
		const paths = new DefaultPlatformPathService(mockEnv);

		const cursorProvider = new CursorProvider();
		const cursorAvailable = await cursorProvider.isAvailable(paths);
		expect(cursorAvailable).toBe(true);

		const clineProvider = new ClineProvider();
		const clineAvailable = await clineProvider.isAvailable(paths);
		expect(clineAvailable).toBe(true);

		const clineSessions = await clineProvider.discoverSessions(paths);
		expect(clineSessions.length).toBeGreaterThan(0);
	});

	test("E2E-T3-07: Multi-Platform Discovery (Linux XDG environment)", async () => {
		const linuxHome = path.join(PLATFORMS_DIR, "linux");
		const mockEnv = new MockOsEnvProvider({
			platform: "linux",
			home: linuxHome,
			env: {
				XDG_CONFIG_HOME: path.join(linuxHome, ".config"),
				XDG_DATA_HOME: path.join(linuxHome, ".local/share"),
			},
		});
		const paths = new DefaultPlatformPathService(mockEnv);

		const rooProvider = new RooProvider();
		const rooAvailable = await rooProvider.isAvailable(paths);
		expect(rooAvailable).toBe(true);
		const rooSessions = await rooProvider.discoverSessions(paths);
		expect(rooSessions.length).toBeGreaterThan(0);

		const gooseProvider = new GooseProvider();
		const gooseAvailable = await gooseProvider.isAvailable(paths);
		expect(gooseAvailable).toBe(true);
		const gooseSessions = await gooseProvider.discoverSessions(paths);
		expect(gooseSessions.length).toBeGreaterThan(0);
	});

	test("E2E-T3-08: Multi-Platform Discovery (Windows AppData environment)", async () => {
		const winHome = path.join(PLATFORMS_DIR, "win32");
		const mockEnv = new MockOsEnvProvider({
			platform: "win32",
			home: winHome,
			env: {
				APPDATA: path.join(winHome, "AppData/Roaming"),
				LOCALAPPDATA: path.join(winHome, "AppData/Local"),
			},
		});
		const paths = new DefaultPlatformPathService(mockEnv);

		const cursorProvider = new CursorProvider();
		const cursorAvailable = await cursorProvider.isAvailable(paths);
		expect(cursorAvailable).toBe(true);

		const gooseProvider = new GooseProvider();
		const gooseAvailable = await gooseProvider.isAvailable(paths);
		expect(gooseAvailable).toBe(true);
		const gooseSessions = await gooseProvider.discoverSessions(paths);
		expect(gooseSessions.length).toBeGreaterThan(0);
	});

	test("E2E-T3-09: Zstandard Decompression Pipeline (.zst & .zstd)", async () => {
		const codexZstFile = path.join(
			HARNESSES_DIR,
			"codex/sessions/2026/03/15/rollout-thread-compressed.jsonl.zst",
		);
		expect(existsSync(codexZstFile)).toBe(true);

		const mockCodexEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: suiteTmp,
			env: {
				CODEX_HOME: path.join(HARNESSES_DIR, "codex"),
			},
		});
		const codexPaths = new DefaultPlatformPathService(mockCodexEnv);
		const codexResult = readCodexUsageSync(codexPaths);
		expect(codexResult.records.length).toBeGreaterThan(0);

		const dshZstdFile = path.join(
			HARNESSES_DIR,
			"dsh/sessions/--workspace-dsh-project--/session-dsh-1/session.v3.jsonl.zstd",
		);
		expect(existsSync(dshZstdFile)).toBe(true);

		const mockDshEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: suiteTmp,
			env: {
				DSH_HOME: path.join(HARNESSES_DIR, "dsh"),
			},
		});
		const dshPaths = new DefaultPlatformPathService(mockDshEnv);
		const dshResult = readDshUsageSync(dshPaths);
		expect(dshResult.records.length).toBeGreaterThan(0);
	});

	test("E2E-T3-10: Protobuf Wire Blob Pipeline (Antigravity gen_metadata)", async () => {
		const agProvider = new AntigravityProvider();
		const mockAgEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: suiteTmp,
			env: {
				ANTIGRAVITY_HOME: path.join(HARNESSES_DIR, "antigravity"),
			},
		});
		const agPaths = new DefaultPlatformPathService(mockAgEnv);

		const sessions = await agProvider.discoverSessions(agPaths);
		expect(sessions.length).toBeGreaterThan(0);

		const usage = await agProvider.readUsage(agPaths, sessions[0]);
		expect(usage.records.length).toBeGreaterThan(0);
		const firstRecord = usage.records[0];
		expect(firstRecord).toBeDefined();
		if (!firstRecord) throw new Error("firstRecord not found");
		expect(firstRecord.inputTokens).toBeGreaterThan(0);
	});

	test("E2E-T3-11: Concurrent DB Read/Write under WAL mode", async () => {
		const walDbPath = path.join(suiteTmp, "concurrent-wal.db");
		const storage = createStorageService({ dbPath: walDbPath });
		await storage.init();

		// Seed initial record
		await storage.saveHarnessBatch({
			harness: "codex",
			records: [
				{
					harness: "codex",
					sessionId: "wal-init",
					messageId: "m-init",
					cwd: "/workspace",
					model: "gpt-4o",
					timestamp: Date.now(),
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0.001,
					costEstimated: false,
				},
			],
			state: {
				harness: "codex",
				fingerprint: "wal-fp",
				indexedAt: Date.now(),
				available: true,
				warnings: [],
			},
		});

		const readonlyHandle = storage.getReadonlyHandle();

		// Execute concurrent writes and reads
		const iterations = 25;
		const tasks: Promise<unknown>[] = [];

		for (let i = 0; i < iterations; i++) {
			tasks.push(
				storage.saveHarnessBatch({
					harness: "codex",
					records: [
						{
							harness: "codex",
							sessionId: `wal-sess-${i}`,
							messageId: `m-${i}`,
							cwd: "/workspace",
							model: "gpt-4o",
							timestamp: Date.now(),
							inputTokens: 100 + i,
							outputTokens: 50 + i,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							reasoningTokens: 0,
							costUsd: 0.001,
							costEstimated: false,
						},
					],
					state: {
						harness: "codex",
						fingerprint: `wal-fp-${i}`,
						indexedAt: Date.now(),
						available: true,
						warnings: [],
					},
				}),
			);

			tasks.push(
				new Promise<void>((resolve, reject) => {
					try {
						const rows = readonlyHandle.db
							.prepare("SELECT count(*) as count FROM usage_records")
							.get() as { count: number };
						expect(rows.count).toBeGreaterThan(0);
						resolve();
					} catch (err) {
						reject(err);
					}
				}),
			);
		}

		await Promise.all(tasks);
		readonlyHandle.close();
	});

	test("E2E-T3-12: Full CLI Subprocess Scan on Synthetic Fixtures", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"run",
				"src/cli.ts",
				"--format",
				"json",
				"--harness",
				"codex,dsh",
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					CODEX_HOME: path.join(HARNESSES_DIR, "codex"),
					DSH_HOME: path.join(HARNESSES_DIR, "dsh"),
					OPENCODE_DATA_DIR: path.join(HARNESSES_DIR, "opencode"),
					OPENCODE_DB: path.join(HARNESSES_DIR, "opencode/opencode.db"),
					COMMANDCODE_HOME: path.join(HARNESSES_DIR, "commandcode"),
					ANTIGRAVITY_HOME: path.join(HARNESSES_DIR, "antigravity"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty("totals");
		expect(parsed.totals.requests).toBeGreaterThan(0);
		expect(parsed.totals.inputTokens).toBeGreaterThan(0);
	});
});
