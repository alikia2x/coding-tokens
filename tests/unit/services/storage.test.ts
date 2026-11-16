import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
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
