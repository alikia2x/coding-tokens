import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	openSafeReadonlyDatabase,
	openSafeReadonlyDatabaseAsync,
} from "../../../src/platform/sqlite";
import {
	closeDatabase,
	createDatabase,
} from "../../fixtures/helpers/sqlite-fixtures";

describe("Platform: Safe SQLite Opener & Snapshots (Features 2 & 7)", () => {
	const tmpDir = path.join(
		os.tmpdir(),
		`ct-unit-sqlite-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F2-T1-01: Opens real SQLite database in readonly mode with busy_timeout", () => {
		mkdirSync(tmpDir, { recursive: true });
		const dbPath = path.join(tmpDir, "sample.db");

		const initDb = createDatabase(dbPath, { wal: false });
		initDb.run(
			"CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
		);
		initDb.run("INSERT INTO items (name) VALUES ('item-1'), ('item-2');");
		closeDatabase(initDb);

		const handle = openSafeReadonlyDatabase(dbPath);
		expect(handle.isSnapshotCopy).toBe(false);

		const rows = handle.db
			.query<{ name: string }, []>("SELECT name FROM items ORDER BY id ASC;")
			.all();
		expect(rows).toEqual([{ name: "item-1" }, { name: "item-2" }]);

		// Verify read-only enforcement
		expect(() => {
			handle.db.run("INSERT INTO items (name) VALUES ('item-3');");
		}).toThrow();

		handle.close();
	});

	test("F2-T1-02: Handles databases with active WAL sidecars seamlessly", () => {
		const dbPath = path.join(tmpDir, "wal-sample.db");
		const initDb = createDatabase(dbPath, { wal: true });
		initDb.run("CREATE TABLE logs (msg TEXT);");
		initDb.run("INSERT INTO logs VALUES ('wal log 1');");
		initDb.close();

		// Add dummy non-empty WAL sidecar file
		writeFileSync(`${dbPath}-wal`, "fake wal content");

		const handle = openSafeReadonlyDatabase(dbPath);
		expect(handle.db).toBeDefined();
		const rows = handle.db
			.query<{ msg: string }, []>("SELECT msg FROM logs;")
			.all();
		expect(rows).toEqual([{ msg: "wal log 1" }]);
		handle.close();
	});

	test("F2-T1-03: openSafeReadonlyDatabaseAsync resolves asynchronously", async () => {
		const dbPath = path.join(tmpDir, "async-sample.db");
		const initDb = createDatabase(dbPath, { wal: false });
		initDb.run("CREATE TABLE kv (k TEXT, v TEXT);");
		initDb.run("INSERT INTO kv VALUES ('greeting', 'hello');");
		closeDatabase(initDb);

		const handle = await openSafeReadonlyDatabaseAsync(dbPath);
		const rows = handle.db
			.query<{ k: string; v: string }, []>("SELECT k, v FROM kv;")
			.all();
		expect(rows).toEqual([{ k: "greeting", v: "hello" }]);
		handle.close();
	});

	// =========================================================================
	// Tier 2: Boundary, Lock & Failure Cases
	// =========================================================================

	test("F2-T2-01: Fallback snapshot copy works under active BEGIN EXCLUSIVE write lock", () => {
		const dbPath = path.join(tmpDir, "snapshot-test.db");
		const writer = new Database(dbPath);
		writer.run("PRAGMA journal_mode = DELETE;");
		writer.run("CREATE TABLE stats (count INT);");
		writer.run("INSERT INTO stats VALUES (42);");
		writer.run("BEGIN EXCLUSIVE;");
		writer.run("INSERT INTO stats VALUES (99);");

		try {
			const handle = openSafeReadonlyDatabase(dbPath, {
				allowSnapshotCopy: true,
				maxRetries: 1,
				busyTimeoutMs: 50,
				initialDelayMs: 10,
				maxDelayMs: 30,
			});

			expect(handle.isSnapshotCopy).toBe(true);
			expect(handle.db).toBeDefined();
			const rows = handle.db
				.query<{ count: number }, []>(
					"SELECT count FROM stats WHERE count = 42;",
				)
				.all();
			expect(rows).toEqual([{ count: 42 }]);
			handle.close();
		} finally {
			writer.run("ROLLBACK;");
			writer.close();
		}
	});

	test("F2-T2-02: Async fallback snapshot copy works under active BEGIN EXCLUSIVE write lock", async () => {
		const dbPath = path.join(tmpDir, "async-snapshot-test.db");
		const writer = new Database(dbPath);
		writer.run("PRAGMA journal_mode = DELETE;");
		writer.run("CREATE TABLE items (val TEXT);");
		writer.run("INSERT INTO items VALUES ('persisted');");
		writer.run("BEGIN EXCLUSIVE;");
		writer.run("INSERT INTO items VALUES ('uncommitted');");

		try {
			const handle = await openSafeReadonlyDatabaseAsync(dbPath, {
				allowSnapshotCopy: true,
				maxRetries: 1,
				busyTimeoutMs: 50,
				initialDelayMs: 10,
				maxDelayMs: 30,
			});

			expect(handle.isSnapshotCopy).toBe(true);
			expect(handle.db).toBeDefined();
			const rows = handle.db
				.query<{ val: string }, []>(
					"SELECT val FROM items WHERE val = 'persisted';",
				)
				.all();
			expect(rows).toEqual([{ val: "persisted" }]);
			handle.close();
		} finally {
			writer.run("ROLLBACK;");
			writer.close();
		}
	});

	test("F2-T2-03: Cleans up temp directory if snapshot copy fails without leaking", () => {
		const unreadableDb = path.join(tmpDir, "unreadable.db");
		const initDb = createDatabase(unreadableDb, { wal: false });
		initDb.run("CREATE TABLE dummy (x INT);");
		closeDatabase(initDb);

		chmodSync(unreadableDb, 0o000);

		const before = readdirSync(os.tmpdir()).filter((f) =>
			f.startsWith("ct-sqlite-"),
		);

		try {
			openSafeReadonlyDatabase(unreadableDb, {
				maxRetries: 0,
				allowSnapshotCopy: true,
			});
		} catch {
			// Expected failure
		} finally {
			chmodSync(unreadableDb, 0o644);
		}

		const after = readdirSync(os.tmpdir()).filter((f) =>
			f.startsWith("ct-sqlite-"),
		);
		const leaked = after.filter((d) => !before.includes(d));
		expect(leaked).toEqual([]);
	});

	test("F2-T2-04: Throws error when database file does not exist", () => {
		const nonexistent = path.join(tmpDir, "does-not-exist.db");
		expect(() => {
			openSafeReadonlyDatabase(nonexistent, { allowSnapshotCopy: false });
		}).toThrow();
	});

	test("F2-T2-05: Corrupted non-database files are rejected without snapshot copy", async () => {
		const corruptFile = path.join(tmpDir, "corrupted-file.db");
		writeFileSync(corruptFile, "invalid sqlite header content payload");

		const beforeSync = readdirSync(os.tmpdir()).filter((f) =>
			f.startsWith("ct-sqlite-"),
		);

		// Synchronous invocation must reject with not-a-database error
		expect(() => {
			openSafeReadonlyDatabase(corruptFile, { allowSnapshotCopy: true });
		}).toThrow(/not a database/i);

		const afterSync = readdirSync(os.tmpdir()).filter((f) =>
			f.startsWith("ct-sqlite-"),
		);
		// Verify zero temp directories created
		expect(afterSync.filter((d) => !beforeSync.includes(d))).toEqual([]);

		// Asynchronous invocation must reject with not-a-database error
		await expect(
			openSafeReadonlyDatabaseAsync(corruptFile, { allowSnapshotCopy: true }),
		).rejects.toThrow(/not a database/i);

		const afterAsync = readdirSync(os.tmpdir()).filter((f) =>
			f.startsWith("ct-sqlite-"),
		);
		expect(afterAsync.filter((d) => !beforeSync.includes(d))).toEqual([]);
	});

	test("F2-T2-06: Locked database with allowSnapshotCopy: false throws lock error without bypassing via immutable=1", async () => {
		const lockDbPath = path.join(tmpDir, "locked-exclusive.db");
		const writer = new Database(lockDbPath);
		writer.run("PRAGMA journal_mode = DELETE;");
		writer.run("CREATE TABLE state (id INT, val TEXT);");
		writer.run("INSERT INTO state VALUES (1, 'initial');");
		writer.run("BEGIN EXCLUSIVE;");
		writer.run("UPDATE state SET val = 'modified';");

		try {
			// Synchronous check: should throw lock error immediately, NOT return immutable handle
			expect(() => {
				openSafeReadonlyDatabase(lockDbPath, {
					allowSnapshotCopy: false,
					maxRetries: 0,
					busyTimeoutMs: 20,
				});
			}).toThrow(/(busy|locked)/i);

			// Asynchronous check: should reject with lock error immediately
			await expect(
				openSafeReadonlyDatabaseAsync(lockDbPath, {
					allowSnapshotCopy: false,
					maxRetries: 0,
					busyTimeoutMs: 20,
				}),
			).rejects.toThrow(/(busy|locked)/i);
		} finally {
			writer.run("ROLLBACK;");
			writer.close();
		}
	});

	afterAll(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});
});
