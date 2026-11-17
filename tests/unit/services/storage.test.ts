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
import type { UsageRecord } from "@shared/types";
import {
	openStoreDatabase,
	readHarnessRecords,
	readSessionMessages,
	readSessionTexts,
	readSetting,
	readSettingRows,
	readSourceState,
	replaceHarnessMessages,
	replaceHarnessRecords,
	replaceHarnessTexts,
	type SourceStateRow,
	writeSetting,
} from "../../../server/data/database";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import {
	createStorageService,
	DefaultStorageService,
	resolveDatabasePath,
	sanitizeFts5Query,
} from "../../../src/services/storage";

describe("Services: StorageService & SQLite Persistence (Feature 7)", () => {
	const tmpDir = path.join(
		os.tmpdir(),
		`ct-unit-storage-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	function makeTempDbPath(name: string): string {
		return path.join(tmpDir, `${name}.db`);
	}

	const sampleState: SourceStateRow = {
		fingerprint: "fp-123456",
		indexedAt: 1700000000000,
		available: 1,
		warnings: JSON.stringify(["Warning sample"]),
	};

	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F7-T1-01: Database schema initialization with WAL mode and expected tables", () => {
		const dbPath = makeTempDbPath("init-schema");
		const db = openStoreDatabase(dbPath);

		// Verify PRAGMA journal_mode = WAL
		const pragmaMode = db
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode;")
			.get();
		expect(pragmaMode?.journal_mode.toLowerCase()).toBe("wal");

		// Verify tables in sqlite_master
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC;",
			)
			.all()
			.map((t) => t.name);

		expect(tables).toContain("usage_records");
		expect(tables).toContain("session_messages");
		expect(tables).toContain("session_texts");
		expect(tables).toContain("source_state");
		expect(tables).toContain("settings");

		db.close();
	});

	test("F7-T1-02: Batch insert and retrieval of UsageRecord entities", () => {
		const dbPath = makeTempDbPath("batch-insert");
		const db = openStoreDatabase(dbPath);

		const records: UsageRecord[] = [
			{
				harness: "codex",
				sessionId: "sess-1",
				messageId: "msg-1",
				turnId: "turn-1",
				isSubagent: false,
				cwd: "/projects/repo-1",
				model: "GPT-4o",
				timestamp: 1700000001000,
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheWriteTokens: 100,
				reasoningTokens: 50,
				costUsd: 0.025,
				costEstimated: false,
			},
			{
				harness: "codex",
				sessionId: "sess-1",
				messageId: "msg-2",
				turnId: "turn-2",
				isSubagent: true,
				cwd: "/projects/repo-1",
				model: "GPT-4o",
				timestamp: 1700000002000,
				inputTokens: 2000,
				outputTokens: 800,
				cacheReadTokens: 400,
				cacheWriteTokens: 200,
				reasoningTokens: 100,
				costUsd: 0.05,
				costEstimated: true,
			},
		];

		replaceHarnessRecords(db, "codex", records, sampleState);

		const loaded = readHarnessRecords(db, "codex");
		expect(loaded.length).toBe(2);

		expect(loaded[0]?.sessionId).toBe("sess-1");
		expect(loaded[0]?.messageId).toBe("msg-1");
		expect(loaded[0]?.turnId).toBe("turn-1");
		expect(loaded[0]?.isSubagent).toBeUndefined(); // false is mapped to undefined
		expect(loaded[0]?.inputTokens).toBe(1000);
		expect(loaded[0]?.costUsd).toBe(0.025);

		expect(loaded[1]?.messageId).toBe("msg-2");
		expect(loaded[1]?.isSubagent).toBe(true);
		expect(loaded[1]?.costEstimated).toBe(true);

		db.close();
	});

	test("F7-T1-03: Atomic persistence of SourceState metadata", () => {
		const dbPath = makeTempDbPath("source-state");
		const db = openStoreDatabase(dbPath);

		replaceHarnessRecords(db, "dsh", [], sampleState);

		const state = readSourceState(db, "dsh");
		expect(state).toBeDefined();
		expect(state?.fingerprint).toBe("fp-123456");
		expect((state as unknown as { indexed_at: number })?.indexed_at).toBe(
			1700000000000,
		);
		expect(state?.available).toBe(1);
		expect(JSON.parse(state?.warnings ?? "[]")).toEqual(["Warning sample"]);

		// Non-existent harness returns null
		expect(readSourceState(db, "opencode")).toBeNull();

		db.close();
	});

	test("F7-T1-04: Session message counts and full text body storage", () => {
		const dbPath = makeTempDbPath("messages-texts");
		const db = openStoreDatabase(dbPath);

		const messages = new Map<string, number>([
			["sess-a", 15],
			["sess-b", 42],
		]);
		replaceHarnessMessages(db, "opencode", messages);

		const readMessages = readSessionMessages(db);
		expect(readMessages.get("opencode:sess-a")).toBe(15);
		expect(readMessages.get("opencode:sess-b")).toBe(42);

		const texts = new Map<string, string>([
			["sess-a", "Full conversation transcript for session A"],
			["sess-b", "Transcript content for session B"],
		]);
		replaceHarnessTexts(db, "opencode", texts);

		const readTexts = readSessionTexts(db);
		expect(readTexts.get("opencode:sess-a")).toBe(
			"Full conversation transcript for session A",
		);
		expect(readTexts.get("opencode:sess-b")).toBe(
			"Transcript content for session B",
		);

		db.close();
	});

	test("F7-T1-05: Settings key-value storage and JSON roundtrip", () => {
		const dbPath = makeTempDbPath("settings");
		const db = openStoreDatabase(dbPath);

		const settingsData = {
			theme: "dark",
			currency: "USD",
			refreshIntervalMs: 5000,
		};
		writeSetting(db, "app_config", JSON.stringify(settingsData));
		writeSetting(db, "active_profile", "dev");

		expect(readSetting(db, "active_profile")).toBe("dev");
		expect(readSetting(db, "missing_key")).toBeNull();

		const loadedJson = readSetting(db, "app_config");
		expect(loadedJson).toBeDefined();
		expect(JSON.parse(loadedJson as string)).toEqual(settingsData);

		const allSettings = readSettingRows(db);
		expect(allSettings.active_profile).toBe("dev");
		expect(allSettings.app_config).toBe(JSON.stringify(settingsData));

		db.close();
	});

	// =========================================================================
	// Tier 2: Boundary & Robustness Cases
	// =========================================================================

	test("F7-T2-01: Atomic transaction rollback on mid-batch failure", () => {
		const dbPath = makeTempDbPath("rollback");
		const db = openStoreDatabase(dbPath);

		// Seed initial record
		const initialRecord: UsageRecord = {
			harness: "codex",
			sessionId: "initial",
			messageId: "msg-init",
			cwd: null,
			model: "GPT-4o",
			timestamp: 1000,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.001,
			costEstimated: false,
		};
		replaceHarnessRecords(db, "codex", [initialRecord], sampleState);
		expect(readHarnessRecords(db, "codex").length).toBe(1);

		// Execute failing transaction
		expect(() => {
			db.transaction(() => {
				db.prepare("DELETE FROM usage_records WHERE harness = ?").run("codex");
				// Force a syntax error / invalid table
				db.run("INSERT INTO non_existent_table VALUES (123);");
			})();
		}).toThrow();

		// Previous data should remain intact due to atomic rollback
		const recordsAfterFail = readHarnessRecords(db, "codex");
		expect(recordsAfterFail.length).toBe(1);
		expect(recordsAfterFail[0]?.sessionId).toBe("initial");

		db.close();
	});

	test("F7-T2-02: High-volume batch insert (5,000+ records) integrity", () => {
		const dbPath = makeTempDbPath("high-volume");
		const db = openStoreDatabase(dbPath);

		const count = 5000;
		const largeBatch: UsageRecord[] = [];
		for (let i = 0; i < count; i++) {
			largeBatch.push({
				harness: "opencode",
				sessionId: `session-${Math.floor(i / 10)}`,
				messageId: `msg-${i}`,
				cwd: null,
				model: "Claude 3.5 Sonnet",
				timestamp: 1700000000000 + i * 1000,
				inputTokens: 1000 + (i % 500),
				outputTokens: 200 + (i % 100),
				cacheReadTokens: 100,
				cacheWriteTokens: 50,
				reasoningTokens: 0,
				costUsd: 0.005,
				costEstimated: false,
			});
		}

		const startTime = performance.now();
		replaceHarnessRecords(db, "opencode", largeBatch, sampleState);
		const duration = performance.now() - startTime;

		// Verify high performance WAL transaction
		expect(duration).toBeLessThan(1000); // Well under 1s for 5,000 rows

		const loaded = readHarnessRecords(db, "opencode");
		expect(loaded.length).toBe(count);

		db.close();
	});

	test("F7-T2-03: Primary key conflict resolution updates existing row", () => {
		const dbPath = makeTempDbPath("pk-conflict");
		const db = openStoreDatabase(dbPath);

		const recordA: UsageRecord = {
			harness: "dsh",
			sessionId: "sess-shared",
			messageId: "msg-shared",
			cwd: null,
			model: "initial-model",
			timestamp: 1000,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.001,
			costEstimated: false,
		};

		const recordB: UsageRecord = {
			...recordA,
			model: "updated-model",
			inputTokens: 9999,
		};

		// Inserting two records with same PK in same batch
		replaceHarnessRecords(db, "dsh", [recordA, recordB], sampleState);

		const rows = readHarnessRecords(db, "dsh");
		expect(rows.length).toBe(1);
		expect(rows[0]?.model).toBe("updated-model");
		expect(rows[0]?.inputTokens).toBe(9999);

		db.close();
	});

	test("F7-T2-04: Nullable and optional field permutations", () => {
		const dbPath = makeTempDbPath("nullables");
		const db = openStoreDatabase(dbPath);

		const sparseRecord: UsageRecord = {
			harness: "commandcode",
			sessionId: "sess-sparse",
			messageId: "msg-sparse",
			turnId: undefined,
			cwd: null,
			model: "Gemini 1.5 Pro",
			timestamp: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: null,
			costEstimated: false,
		};

		replaceHarnessRecords(db, "commandcode", [sparseRecord], sampleState);

		const loaded = readHarnessRecords(db, "commandcode");
		expect(loaded.length).toBe(1);
		const row = loaded[0];
		expect(row?.turnId).toBeUndefined();
		expect(row?.cwd).toBeNull();
		expect(row?.timestamp).toBeNull();
		expect(row?.costUsd).toBeNull();

		db.close();
	});

	test("F7-T2-05: Checkpoint, database close, and re-opening integrity", () => {
		const dbPath = makeTempDbPath("checkpoint-reopen");
		let db = openStoreDatabase(dbPath);

		writeSetting(db, "persistence_test", "verified");
		db.close();

		// Re-open
		db = openStoreDatabase(dbPath);
		expect(readSetting(db, "persistence_test")).toBe("verified");
		db.close();
	});

	afterAll(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});
});

describe("Services: DefaultStorageService (Feature 7)", () => {
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

	test("F7-T1-09: Upgrades legacy user_version=1 database missing session_texts", async () => {
		const { Database } = await import("bun:sqlite");
		const dbDir = path.join(tmpRoot, "legacy-v1-upgrade");
		mkdirSync(dbDir, { recursive: true });
		const dbPath = path.join(dbDir, "legacy.sqlite");

		const legacyDb = new Database(dbPath, { create: true });
		legacyDb.exec(`
			CREATE TABLE usage_records (
				harness TEXT NOT NULL,
				session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				turn_id TEXT,
				is_subagent INTEGER NOT NULL DEFAULT 0,
				cwd TEXT,
				model TEXT NOT NULL,
				timestamp INTEGER,
				input_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				reasoning_tokens INTEGER NOT NULL DEFAULT 0,
				cost_usd REAL,
				cost_estimated INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (harness, session_id, message_id)
			);
			CREATE TABLE session_messages (
				harness TEXT NOT NULL,
				session_id TEXT NOT NULL,
				messages INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (harness, session_id)
			);
			CREATE TABLE source_state (
				harness TEXT PRIMARY KEY,
				fingerprint TEXT NOT NULL,
				indexed_at INTEGER NOT NULL,
				available INTEGER NOT NULL,
				warnings TEXT NOT NULL DEFAULT '[]'
			);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			PRAGMA user_version = 1;
		`);
		legacyDb.close();

		const upgraded = openStoreDatabase(dbPath);
		try {
			const texts = readSessionTexts(upgraded);
			expect(texts.size).toBe(0);
			const version = upgraded
				.query<{ user_version: number }, []>("PRAGMA user_version")
				.get()?.user_version;
			expect(version).toBe(3);
		} finally {
			upgraded.close();
		}
	});
});
