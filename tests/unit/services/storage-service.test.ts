import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageRecord } from "../../../shared/types";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import {
	createStorageService,
	DefaultStorageService,
	resolveDatabasePath,
	sanitizeFts5Query,
} from "../../../src/services/storage";

describe("Services: StorageService & SQLite Persistence (Feature 7)", () => {
	const tmpRoot = path.join(
		os.tmpdir(),
		`ct-storage-service-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	afterAll(() => {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	});

	function makeTempService(name: string) {
		const dbDir = path.join(tmpRoot, name);
		mkdirSync(dbDir, { recursive: true });
		const dbPath = path.join(dbDir, "test.sqlite");
		const service = new DefaultStorageService({ dbPath });
		return { service, dbPath, dbDir };
	}

	test("F7-T1-01: Path resolution precedence and fallback", () => {
		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: path.join(tmpRoot, "home"),
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);

		// 1. Explicit options.dbPath
		const explicit = resolveDatabasePath(
			{ dbPath: "/custom/my.db" },
			mockPaths,
		);
		expect(explicit).toBe("/custom/my.db");

		// 2. CODING_TOKENS_DB_PATH env
		const origDbPath = process.env.CODING_TOKENS_DB_PATH;
		const origDb = process.env.CODING_TOKENS_DB;
		try {
			process.env.CODING_TOKENS_DB_PATH = "/env/path/my.db";
			const fromEnv = resolveDatabasePath({}, mockPaths);
			expect(fromEnv).toBe("/env/path/my.db");

			delete process.env.CODING_TOKENS_DB_PATH;
			process.env.CODING_TOKENS_DB = "/env/short/my.db";
			const fromShort = resolveDatabasePath({}, mockPaths);
			expect(fromShort).toBe("/env/short/my.db");
		} finally {
			if (origDbPath !== undefined)
				process.env.CODING_TOKENS_DB_PATH = origDbPath;
			else delete process.env.CODING_TOKENS_DB_PATH;
			if (origDb !== undefined) process.env.CODING_TOKENS_DB = origDb;
			else delete process.env.CODING_TOKENS_DB;
		}

		// 3. Platform default standard location
		const standard = resolveDatabasePath({}, mockPaths);
		expect(standard).toContain("coding-tokens.sqlite");
	});

	test("F7-T1-02: Legacy database migration from ~/.cache/coding-tokens", () => {
		const mockHome = path.join(tmpRoot, "mock-home-legacy");
		const legacyDir = path.join(mockHome, ".cache", "coding-tokens");
		mkdirSync(legacyDir, { recursive: true });

		const legacyDb = path.join(legacyDir, "coding-tokens.sqlite");
		const legacyWal = path.join(legacyDir, "coding-tokens.sqlite-wal");
		writeFileSync(legacyDb, "dummy-sqlite-content");
		writeFileSync(legacyWal, "dummy-wal-content");

		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: mockHome,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);

		const resolved = resolveDatabasePath({}, mockPaths);
		// Should have migrated into standard directory
		expect(existsSync(resolved)).toBe(true);
		expect(readFileSync(resolved, "utf-8")).toBe("dummy-sqlite-content");
		expect(existsSync(`${resolved}-wal`)).toBe(true);
		expect(readFileSync(`${resolved}-wal`, "utf-8")).toBe("dummy-wal-content");
	});

	test("F7-T1-03: FTS5 Query Sanitization handles edge cases and operators safely", () => {
		expect(sanitizeFts5Query("hello world")).toBe('"hello"* "world"*');
		expect(sanitizeFts5Query("")).toBe("");
		expect(sanitizeFts5Query("   ")).toBe("");
		expect(sanitizeFts5Query('model:gpt-4 "quoted string"')).toBe(
			'"model:gpt-4"* """quoted"* "string"""*',
		);
		expect(sanitizeFts5Query("foo* OR NOT bar")).toBe(
			'"foo*"* "OR"* "NOT"* "bar"*',
		);
		expect(sanitizeFts5Query('quotes""nested"""')).toBe(
			'"quotes""""nested"""""""*',
		);
	});

	test("F7-T1-04: Database initialization applies WAL mode, busy_timeout, and runs migrations", async () => {
		const { service } = makeTempService("init-test");
		await service.init();

		const db = service.getDatabase();
		const journal = db
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode;")
			.get();
		expect(journal?.journal_mode.toLowerCase()).toBe("wal");

		const busyTimeout = db
			.query<{ timeout: number }, []>("PRAGMA busy_timeout;")
			.get();
		expect(busyTimeout?.timeout).toBe(5000);

		const userVer = db
			.query<{ user_version: number }, []>("PRAGMA user_version;")
			.get();
		expect(userVer?.user_version).toBeGreaterThanOrEqual(2);

		await service.close();
	});

	test("F7-T1-05: saveHarnessBatch writes records, messages, texts, and source_state atomically", async () => {
		const { service } = makeTempService("batch-atomic");
		await service.init();

		const record1: UsageRecord = {
			harness: "codex",
			sessionId: "sess-batch-1",
			messageId: "msg-1",
			turnId: "turn-1",
			isSubagent: false,
			cwd: "/workspace/proj",
			model: "gpt-4o",
			timestamp: 1700000000000,
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200,
			cacheWriteTokens: 100,
			reasoningTokens: 50,
			costUsd: 0.05,
			costEstimated: false,
		};

		const record2: UsageRecord = {
			harness: "codex",
			sessionId: "sess-batch-2",
			messageId: "msg-2",
			turnId: "turn-2",
			isSubagent: true,
			cwd: "/workspace/proj",
			model: "claude-3-5-sonnet",
			timestamp: 1700000005000,
			inputTokens: 2000,
			outputTokens: 800,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.08,
			costEstimated: true,
		};

		await service.saveHarnessBatch({
			harness: "codex",
			records: [record1, record2],
			state: {
				harness: "codex",
				fingerprint: "v12:2:abcde",
				indexedAt: 1700000010000,
				available: true,
				warnings: ["Test warning"],
			},
			messages: {
				"sess-batch-1": 15,
				"sess-batch-2": 22,
			},
			texts: {
				"sess-batch-1":
					"Full text of session 1 talking about TypeScript and SQLite",
				"sess-batch-2":
					"Full text of session 2 discussing Python and Machine Learning",
			},
		});

		// Verify records stored
		const allRecords = await service.getUsageRecords();
		expect(allRecords).toHaveLength(2);

		// Verify state stored
		const state = await service.getSourceState("codex");
		expect(state?.fingerprint).toBe("v12:2:abcde");
		expect(state?.available).toBe(true);
		expect(state?.warnings).toEqual(["Test warning"]);

		// Verify text stored
		const text1 = await service.getSessionText("codex", "sess-batch-1");
		expect(text1).toContain("TypeScript and SQLite");

		// Verify FTS5 search
		const ftsHits = (await service.searchSessionText("TypeScript")).map(
			(r) => r.sessionId,
		);
		expect(ftsHits).toContain("sess-batch-1");
		expect(ftsHits).not.toContain("sess-batch-2");

		const ftsPythonHits = (await service.searchSessionText("Python")).map(
			(r) => r.sessionId,
		);
		expect(ftsPythonHits).toContain("sess-batch-2");

		await service.close();
	});

	test("F7-T1-06: getUsageRecords filter predicates work correctly", async () => {
		const { service } = makeTempService("filters-test");
		await service.init();

		const records: UsageRecord[] = [
			{
				harness: "codex",
				sessionId: "sess-1",
				messageId: "m1",
				turnId: undefined,
				isSubagent: false,
				cwd: "/home/app",
				model: "gpt-4o",
				timestamp: 1000,
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.01,
				costEstimated: false,
			},
			{
				harness: "dsh",
				sessionId: "sess-2",
				messageId: "m2",
				turnId: undefined,
				isSubagent: false,
				cwd: "/home/web",
				model: "claude-3-5-sonnet",
				timestamp: 2000,
				inputTokens: 20,
				outputTokens: 20,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.02,
				costEstimated: false,
			},
		];

		await service.saveUsageRecords(records);

		// Filter by harness
		const codexOnly = await service.getUsageRecords({ harness: "codex" });
		expect(codexOnly).toHaveLength(1);
		expect(codexOnly[0]?.sessionId).toBe("sess-1");

		// Filter by sessionId
		const sess2Only = await service.getUsageRecords({ sessionId: "sess-2" });
		expect(sess2Only).toHaveLength(1);
		expect(sess2Only[0]?.harness).toBe("dsh");

		// Filter by time range
		const range = await service.getUsageRecords({ from: 1500, until: 2500 });
		expect(range).toHaveLength(1);
		expect(range[0]?.sessionId).toBe("sess-2");

		// Filter by model
		const gptOnly = await service.getUsageRecords({ model: "gpt-4o" });
		expect(gptOnly).toHaveLength(1);
		expect(gptOnly[0]?.model).toBe("gpt-4o");

		await service.close();
	});

	test("F7-T1-07: Settings key-value JSON storage roundtrip", async () => {
		const { service } = makeTempService("settings-test");
		await service.init();

		expect(await service.getSetting("user_theme")).toBeNull();

		await service.setSetting("user_theme", { theme: "dark", fontSize: 14 });
		const themeSetting = await service.getSetting<{
			theme: string;
			fontSize: number;
		}>("user_theme");
		expect(themeSetting).toEqual({ theme: "dark", fontSize: 14 });

		await service.setSetting("user_theme", "light");
		const lightSetting = await service.getSetting<string>("user_theme");
		expect(lightSetting).toBe("light");

		await service.close();
	});

	test("F7-T1-08: Factory createStorageService and re-open integrity", async () => {
		const dbDir = path.join(tmpRoot, "reopen-test");
		mkdirSync(dbDir, { recursive: true });
		const dbPath = path.join(dbDir, "reopen.sqlite");

		const service1 = createStorageService({ dbPath });
		await service1.init();
		await service1.setSetting("persist_key", "persisted_value");
		await service1.close();

		const service2 = createStorageService({ dbPath });
		await service2.init();
		const val = await service2.getSetting<string>("persist_key");
		expect(val).toBe("persisted_value");
		await service2.close();
	});
});
