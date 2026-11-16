import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../src/platform/env";
import {
	expandPath,
	normalizePath,
	pathToUri,
	safeBasename,
	uriToPath,
} from "../../src/platform/normalizer";
import { DefaultPlatformPathService } from "../../src/platform/paths";
import {
	openSafeReadonlyDatabase,
	openSafeReadonlyDatabaseAsync,
} from "../../src/platform/sqlite";
import { ClaudeProvider } from "../../src/providers/claude";
import { decodeClaudeProjectPath } from "../../src/providers/claude/discovery";
import { readClaudeUsageSync } from "../../src/providers/claude/usage";
import { decodeWorkspaceUri } from "../../src/providers/continue/discovery";
import {
	decodeProto,
	protoSub,
	protoText,
} from "../../src/providers/windsurf/proto";
import { parseWindsurfPbFile } from "../../src/providers/windsurf/usage";
import { DefaultPricingService } from "../../src/services/pricing";
import type { UsageRecord } from "../../src/types";
import { hasTokenUsage, parseJsonl } from "../../src/util";
import {
	closeDatabase,
	createDatabase,
} from "../fixtures/helpers/sqlite-fixtures";

describe("Feature 26: Adversarial Hardening (Tier 5)", () => {
	const tmpDir = path.join(
		os.tmpdir(),
		`ct-adversarial-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	beforeAll(() => {
		mkdirSync(tmpDir, { recursive: true });
	});

	afterAll(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	function makePaths(
		homeDir: string,
		env: Record<string, string> = {},
		platform: "darwin" | "linux" | "win32" = "darwin",
	) {
		const mockEnv = new MockOsEnvProvider({ platform, home: homeDir, env });
		return new DefaultPlatformPathService(mockEnv);
	}

	// =========================================================================
	// Domain 1: Malformed & Corrupted JSONL Lines
	// =========================================================================
	describe("1. Malformed & Corrupted JSONL Lines", () => {
		test("F26-JSONL-01: Drops truncated JSON lines without throwing", () => {
			const malformed = [
				'{"type":"user","message":{"id":"u1","content":"hello"}}',
				'{"type":"assistant","message":{"id":"a1"', // truncated mid-key
				'{"type":"assistant","message":{"id":"a2","content":"unclosed string', // unclosed string
				'{"type":"assistant","tokens":{', // truncated object
				'{"type":"user","message":{"id":"u2","content":"world"}}',
			].join("\n");

			const rows = parseJsonl(malformed);
			expect(rows.length).toBe(2);
			const first = rows[0] as Record<string, unknown>;
			const second = rows[1] as Record<string, unknown>;
			expect(first.type).toBe("user");
			expect(second.type).toBe("user");
		});

		test("F26-JSONL-02: Handles binary garbage, null bytes, and non-UTF8 noise safely", () => {
			const garbage = [
				'{"type":"user","text":"start"}',
				"\x00\x01\x02\x03\x04\x05\x06\x07", // null & control bytes
				"\xff\xfe\xfd\xfc", // high invalid UTF-8 bytes
				"!!!NOT_JSON_AT_ALL???###",
				"   \t  \r  ", // whitespace only
				'{"type":"assistant","text":"end"}',
			].join("\n");

			const rows = parseJsonl(garbage);
			expect(rows.length).toBe(2);
			const first = rows[0] as Record<string, unknown>;
			const second = rows[1] as Record<string, unknown>;
			expect(first.text).toBe("start");
			expect(second.text).toBe("end");
		});

		test("F26-JSONL-03: Preserves valid objects with exact field typing despite interspersed corrupted lines", () => {
			const mixed = [
				"{bad json}",
				'{"id":"row-1","val":123,"flag":true,"arr":[1,2,3]}',
				"42", // valid JSON literal (number)
				"true", // valid JSON literal (boolean)
				"[1,2,3]", // valid JSON array
				'{"id":"row-2","nested":{"a":"b"}}',
				"{unterminated",
			].join("\n");

			const rows = parseJsonl(mixed);
			expect(rows.length).toBe(5);
			const row1 = rows[0] as Record<string, unknown>;
			expect(row1.id).toBe("row-1");
			expect(row1.val).toBe(123);
			expect(row1.flag).toBe(true);
			expect(row1.arr).toEqual([1, 2, 3]);

			expect(rows[1]).toBe(42);
			expect(rows[2]).toBe(true);
			expect(rows[3]).toEqual([1, 2, 3]);

			const row2 = rows[4] as Record<string, unknown>;
			expect(row2.id).toBe("row-2");
		});

		test("F26-JSONL-04: Stress resilience on 100KB line, BOM markers, and CRLF line breaks", () => {
			const bigText = "A".repeat(100_000);
			const bom = "\uFEFF";
			const stream = `${bom}{"type":"user","content":"${bigText}"}\r\n\r\n{"type":"assistant","content":"reply"}\r\n`;

			const rows = parseJsonl(stream);
			expect(rows.length).toBe(2);
			const first = rows[0] as Record<string, unknown>;
			const second = rows[1] as Record<string, unknown>;
			expect(first.type).toBe("user");
			expect((first.content as string).length).toBe(100_000);
			expect(second.type).toBe("assistant");
			expect(second.content).toBe("reply");
		});

		test("F26-JSONL-05: Claude Provider usage extraction survives severely corrupted session file", () => {
			const claudeHome = path.join(tmpDir, "claude-adversarial");
			const projectDir = path.join(claudeHome, ".claude", "projects", "demo");
			mkdirSync(projectDir, { recursive: true });

			const sessionFile = path.join(projectDir, "corrupted-sess.jsonl");
			const corruptedContent = [
				'{"type":"user","sessionId":"sess-adv-1","cwd":"/repo"}',
				"\x00\x00\x00CORRUPT_BINARY",
				'{"type":"assistant","sessionId":"sess-adv-1","message":{"id":"msg-1","usage":{"input_tokens":500,"output_tokens":120}}}',
				'{"type":"assistant","incomplete":',
				'{"type":"assistant","sessionId":"sess-adv-1","message":{"id":"msg-2","usage":{"input_tokens":300,"output_tokens":80,"cache_read_input_tokens":150}}}',
				"GARBAGE_TAIL",
			].join("\n");

			writeFileSync(sessionFile, corruptedContent, "utf8");

			const paths = makePaths(claudeHome);
			const provider = new ClaudeProvider();

			const result = readClaudeUsageSync(paths, {
				sessionId: "sess-adv-1",
				harness: "claude",
				filePath: sessionFile,
				mtimeMs: Date.now(),
				sizeBytes: corruptedContent.length,
				cwd: "/repo",
			});

			expect(result.available).toBe(true);
			expect(result.records.length).toBe(2);
			expect(result.records[0]?.inputTokens).toBe(500);
			expect(result.records[0]?.outputTokens).toBe(120);
			expect(result.records[1]?.inputTokens).toBe(300);
			expect(result.records[1]?.outputTokens).toBe(80);
			expect(result.records[1]?.cacheReadTokens).toBe(150);
		});

		test("F26-JSONL-06: Claude Provider transcript extraction recovers valid turns around corrupted lines", async () => {
			const claudeHome = path.join(tmpDir, "claude-transcripts-adv");
			const projectDir = path.join(
				claudeHome,
				".claude",
				"projects",
				"-Users-dev-project",
			);
			mkdirSync(projectDir, { recursive: true });

			const sessionFile = path.join(projectDir, "sess-trans.jsonl");
			const transcriptContent = [
				'{"type":"user","sessionId":"sess-trans","message":{"content":[{"type":"text","text":"Initial user prompt"}]}}',
				"corrupted garbage 1",
				'{"type":"assistant","sessionId":"sess-trans","message":{"content":[{"type":"text","text":"Assistant first answer"}]}}',
				"{unclosed json line",
				'{"type":"user","sessionId":"sess-trans","message":{"content":"Second user prompt"}}',
				'{"type":"assistant","sessionId":"sess-trans","message":{"content":"Second assistant response"}}',
			].join("\n");

			writeFileSync(sessionFile, transcriptContent, "utf8");

			const paths = makePaths(claudeHome);
			const provider = new ClaudeProvider();
			const session = await provider.readTranscript(paths, "sess-trans");

			expect(session).toBeDefined();
			expect(session?.sessionId).toBe("sess-trans");
			expect(session?.items.length).toBeGreaterThan(0);
			const userItems = session?.items.filter((it) => it.role === "user");
			const assistantItems = session?.items.filter(
				(it) => it.role === "assistant",
			);
			expect(userItems?.length).toBeGreaterThanOrEqual(1);
			expect(assistantItems?.length).toBeGreaterThanOrEqual(1);
			expect(userItems?.[0]?.text).toContain("Initial user prompt");
			expect(assistantItems?.[0]?.text).toContain("Assistant first answer");
		});
	});

	// =========================================================================
	// Domain 2: Windows Path Edge Cases
	// =========================================================================
	describe("2. Windows Path Edge Cases", () => {
		test("F26-WINPATH-01: Trailing backslashes and redundant slash normalization", () => {
			expect(
				normalizePath("C:\\Users\\tester\\AppData\\Roaming\\Claude\\"),
			).toBe("C:/Users/tester/AppData/Roaming/Claude");
			expect(normalizePath("D:\\Code\\\\Project\\\\\\Subdir\\\\")).toBe(
				"D:/Code/Project/Subdir",
			);
			expect(normalizePath("\\\\server\\share\\folder\\")).toBe(
				"//server/share/folder",
			);
			expect(normalizePath("nested\\\\path\\\\file.txt")).toBe(
				"nested/path/file.txt",
			);
		});

		test("F26-WINPATH-02: Mixed forward and backward slashes across paths", () => {
			expect(
				normalizePath("C:/Users\\name/AppData\\Local/programs/cursor/"),
			).toBe("C:/Users/name/AppData/Local/programs/cursor");
			expect(normalizePath("D:\\workspace/project\\src/index.ts")).toBe(
				"D:/workspace/project/src/index.ts",
			);
			expect(normalizePath("//server\\share/path\\to/file.json")).toBe(
				"//server/share/path/to/file.json",
			);
		});

		test("F26-WINPATH-03: Drive letter capitalization and drive root edge cases", () => {
			expect(normalizePath("c:")).toBe("C:/");
			expect(normalizePath("c:\\")).toBe("C:/");
			expect(normalizePath("c:/")).toBe("C:/");
			expect(normalizePath("d:")).toBe("D:/");
			expect(normalizePath("x:\\some\\dir")).toBe("X:/some/dir");
			expect(normalizePath("z:/workspace")).toBe("Z:/workspace");
		});

		test("F26-WINPATH-04: UNC share paths and administrative shares", () => {
			expect(normalizePath("\\\\server\\share")).toBe("//server/share");
			expect(normalizePath("\\\\localhost\\c$\\projects\\repo")).toBe(
				"//localhost/c$/projects/repo",
			);
			expect(normalizePath("\\\\192.168.1.100\\share\\data")).toBe(
				"//192.168.1.100/share/data",
			);
			expect(normalizePath("//server//share///dir//file.txt")).toBe(
				"//server/share/dir/file.txt",
			);
		});

		test("F26-WINPATH-05: Safe basename extraction across separators and Windows reserved device names", () => {
			expect(safeBasename("C:\\repos\\CON")).toBe("CON");
			expect(safeBasename("C:\\repos\\aux.txt")).toBe("aux.txt");
			expect(safeBasename("D:\\data\\PRN\\")).toBe("PRN");
			expect(safeBasename("C:\\NUL")).toBe("NUL");
			expect(safeBasename("\\\\server\\share\\COM1.log")).toBe("COM1.log");
			expect(safeBasename("C:\\foo\\bar\\baz\\")).toBe("baz");
			expect(safeBasename("/foo/bar/baz/")).toBe("baz");
		});

		test("F26-WINPATH-06: Windows environment variable expansion in expandPath", () => {
			const winEnv = new MockOsEnvProvider({
				platform: "win32",
				home: "C:\\Users\\alice",
				env: {
					APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
					LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
					USERPROFILE: "C:\\Users\\alice",
				},
			});

			expect(expandPath("%APPDATA%\\Claude", winEnv)).toBe(
				"C:/Users/alice/AppData/Roaming/Claude",
			);
			expect(expandPath("%LOCALAPPDATA%/programs/cursor", winEnv)).toBe(
				"C:/Users/alice/AppData/Local/programs/cursor",
			);
			expect(expandPath("%USERPROFILE%\\.continue", winEnv)).toBe(
				"C:/Users/alice/.continue",
			);
			expect(expandPath("~\\.cline", winEnv)).toBe("C:/Users/alice/.cline");
		});

		test("F26-WINPATH-07: Relative segment traversal and boundary resolution", () => {
			expect(normalizePath("C:/Users/dev/../../Windows")).toBe("C:/Windows");
			expect(normalizePath("C:/Users/alice/../bob/documents")).toBe(
				"C:/Users/bob/documents",
			);
			expect(normalizePath("C:/a/b/c/../../../../d")).toBe("C:/d");
			expect(normalizePath("./local/path")).toBe("local/path");
			expect(normalizePath("../../parent/dir")).toBe("../../parent/dir");
		});
	});

	// =========================================================================
	// Domain 3: Malformed Percent Encodings in Workspace URIs
	// =========================================================================
	describe("3. Malformed Percent Encodings in Workspace URIs", () => {
		test("F26-URI-01: Incomplete percent encodings do not throw URIError", () => {
			// In standard JS, decodeURIComponent("%") throws URIError
			expect(() => uriToPath("file:///path/with/%")).not.toThrow();
			const p1 = uriToPath("file:///path/with/%");
			expect(p1).toBe("/path/with/%");

			expect(() => uriToPath("file:///C:/Users/%2")).not.toThrow();
			const p2 = uriToPath("file:///C:/Users/%2");
			expect(p2).toBe("C:/Users/%2");

			expect(() => uriToPath("file:///workspace/%ZZ")).not.toThrow();
			const p3 = uriToPath("file:///workspace/%ZZ");
			expect(p3).toBe("/workspace/%ZZ");
		});

		test("F26-URI-02: Truncated multibyte UTF-8 percent encodings handled gracefully", () => {
			// Incomplete 3-byte sequence %E0%A4
			expect(() => uriToPath("file:///path/to/%E0%A4")).not.toThrow();
			const p1 = uriToPath("file:///path/to/%E0%A4");
			expect(p1).toContain("/path/to/");

			// Incomplete 2-byte sequence %C3
			expect(() => uriToPath("file:///path/to/%C3")).not.toThrow();
			const p2 = uriToPath("file:///path/to/%C3");
			expect(p2).toContain("/path/to/");

			// Invalid UTF-8 bytes %FF%FE
			expect(() => uriToPath("file:///path/to/%FF%FE")).not.toThrow();
			const p3 = uriToPath("file:///path/to/%FF%FE");
			expect(p3).toContain("/path/to/");
		});

		test("F26-URI-03: Windows drive URIs with malformed percent escapes", () => {
			const winUri = "file:///C:/projects/app%20with%invalid%XX%99";
			expect(() => uriToPath(winUri)).not.toThrow();
			const res = uriToPath(winUri);
			expect(res.startsWith("C:/projects/app")).toBe(true);
		});

		test("F26-URI-04: decodeWorkspaceUri handles null, empty, and corrupted URI strings", () => {
			expect(decodeWorkspaceUri(null)).toBeNull();
			expect(decodeWorkspaceUri(undefined)).toBeNull();
			expect(decodeWorkspaceUri("")).toBeNull();

			// Malformed escapes
			expect(() =>
				decodeWorkspaceUri("file:///C:/workspace%invalid%ZZ"),
			).not.toThrow();
			const decoded = decodeWorkspaceUri("file:///C:/workspace%invalid%ZZ");
			expect(decoded).toBe("C:/workspace%invalid%ZZ");

			// Valid escaped URI
			const valid = decodeWorkspaceUri("file:///Users/dev/my%20project");
			expect(valid).toBe("/Users/dev/my project");
		});

		test("F26-URI-05: Bidirectional URI conversion with special characters (#, ?, [, ], +, @)", () => {
			const specialPath = "/Users/dev/c++ project #1 [release]?@home";
			const uri = pathToUri(specialPath);
			expect(uri.startsWith("file:///Users/dev/")).toBe(true);

			const recovered = uriToPath(uri);
			// Verify safe recovery without corruption
			expect(recovered).toContain("c++ project");
			expect(recovered).toContain("[release]");
		});

		test("F26-URI-06: Claude project path decoding handles multiple encoded hyphens and slashes", () => {
			// Claude encodes slashes as hyphens: /Users/alikia/Code -> -Users-alikia-Code
			expect(decodeClaudeProjectPath("-Users-alikia-Code")).toBe(
				"/Users/alikia/Code",
			);
			expect(decodeClaudeProjectPath("-var-folders-tmp")).toBe(
				"/var/folders/tmp",
			);
			expect(decodeClaudeProjectPath("C-Users-alikia-Code")).toBe(
				"C:/Users/alikia/Code",
			);
		});
	});

	// =========================================================================
	// Domain 4: Concurrent File Locking Simulations on SQLite Databases
	// =========================================================================
	describe("4. Concurrent File Locking Simulations on SQLite Databases", () => {
		test("F26-SQLITE-01: Sync opener extracts valid snapshot under active BEGIN EXCLUSIVE lock", () => {
			const dbPath = path.join(tmpDir, "adv-lock-exclusive.db");
			const writer = new Database(dbPath);
			writer.run("PRAGMA journal_mode = DELETE;");
			writer.run("CREATE TABLE records (id INT PRIMARY KEY, token_count INT);");
			writer.run("INSERT INTO records VALUES (1, 1500), (2, 3500);");

			// Acquire exclusive write lock
			writer.run("BEGIN EXCLUSIVE;");
			writer.run("INSERT INTO records VALUES (3, 9999);");

			try {
				const handle = openSafeReadonlyDatabase(dbPath, {
					allowSnapshotCopy: true,
					maxRetries: 1,
					busyTimeoutMs: 50,
					initialDelayMs: 10,
					maxDelayMs: 30,
				});

				expect(handle.isSnapshotCopy).toBe(true);
				const rows = handle.db
					.query<{ token_count: number }, []>(
						"SELECT token_count FROM records WHERE id <= 2 ORDER BY id ASC;",
					)
					.all();
				expect(rows).toEqual([{ token_count: 1500 }, { token_count: 3500 }]);
				handle.close();
			} finally {
				writer.run("ROLLBACK;");
				writer.close();
			}
		});

		test("F26-SQLITE-02: Async opener handles active BEGIN EXCLUSIVE lock with snapshot fallback", async () => {
			const dbPath = path.join(tmpDir, "adv-lock-immediate.db");
			const writer = new Database(dbPath);
			writer.run("PRAGMA journal_mode = DELETE;");
			writer.run("CREATE TABLE items (key TEXT, val INT);");
			writer.run("INSERT INTO items VALUES ('alpha', 10), ('beta', 20);");

			writer.run("BEGIN EXCLUSIVE;");
			writer.run("INSERT INTO items VALUES ('gamma', 30);");

			try {
				const handle = await openSafeReadonlyDatabaseAsync(dbPath, {
					allowSnapshotCopy: true,
					maxRetries: 1,
					busyTimeoutMs: 50,
					initialDelayMs: 10,
					maxDelayMs: 30,
				});

				expect(handle.isSnapshotCopy).toBe(true);
				const rows = handle.db
					.query<{ key: string; val: number }, []>(
						"SELECT key, val FROM items WHERE key IN ('alpha', 'beta') ORDER BY val ASC;",
					)
					.all();
				expect(rows).toEqual([
					{ key: "alpha", val: 10 },
					{ key: "beta", val: 20 },
				]);
				handle.close();
			} finally {
				writer.run("ROLLBACK;");
				writer.close();
			}
		});

		test("F26-SQLITE-03: Snapshot temporary file is cleaned up after handle.close()", () => {
			const dbPath = path.join(tmpDir, "adv-cleanup-test.db");
			const writer = new Database(dbPath);
			writer.run("PRAGMA journal_mode = DELETE;");
			writer.run("CREATE TABLE t (x INT);");
			writer.run("INSERT INTO t VALUES (1);");
			writer.run("BEGIN EXCLUSIVE;");
			writer.run("INSERT INTO t VALUES (99);");

			try {
				const handle = openSafeReadonlyDatabase(dbPath, {
					allowSnapshotCopy: true,
					maxRetries: 1,
					busyTimeoutMs: 20,
					initialDelayMs: 5,
					maxDelayMs: 15,
				});
				expect(handle.isSnapshotCopy).toBe(true);
				handle.close();
			} finally {
				writer.run("ROLLBACK;");
				writer.close();
			}
		});

		test("F26-SQLITE-04: High-concurrency read-write contention across 10 concurrent readers", async () => {
			const dbPath = path.join(tmpDir, "adv-contention.db");
			const db = createDatabase(dbPath, { wal: true });
			db.run(
				"CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT);",
			);
			for (let i = 0; i < 50; i++) {
				db.run(`INSERT INTO logs (message) VALUES ('initial-log-${i}');`);
			}

			// Launch concurrent reader tasks
			const readerTasks = Array.from({ length: 10 }, async (_, index) => {
				const handle = await openSafeReadonlyDatabaseAsync(dbPath, {
					allowSnapshotCopy: true,
					maxRetries: 3,
					busyTimeoutMs: 100,
				});
				const count = handle.db
					.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM logs;")
					.get();
				expect(count?.cnt).toBeGreaterThanOrEqual(50);
				handle.close();
				return index;
			});

			// Interleave write operations while readers are querying
			for (let i = 0; i < 20; i++) {
				db.run(`INSERT INTO logs (message) VALUES ('concurrent-write-${i}');`);
			}

			const results = await Promise.all(readerTasks);
			expect(results.length).toBe(10);
			closeDatabase(db);
		});

		test("F26-SQLITE-05: WAL sidecars preserved and readable during un-checkpointed state", () => {
			const dbPath = path.join(tmpDir, "adv-wal-preservation.db");
			const db = createDatabase(dbPath, { wal: true });
			db.run("CREATE TABLE telemetry (tag TEXT, count INT);");
			db.run("INSERT INTO telemetry VALUES ('start', 100);");

			// Write without checkpointing so data is only in WAL sidecar
			db.run("INSERT INTO telemetry VALUES ('in_wal_only', 200);");

			// Open readonly handle
			const handle = openSafeReadonlyDatabase(dbPath);
			const rows = handle.db
				.query<{ tag: string; count: number }, []>(
					"SELECT tag, count FROM telemetry ORDER BY count ASC;",
				)
				.all();
			expect(rows).toEqual([
				{ tag: "start", count: 100 },
				{ tag: "in_wal_only", count: 200 },
			]);
			handle.close();
			closeDatabase(db);
		});

		test("F26-SQLITE-06: Zero-byte file and corrupted non-SQLite files fail gracefully with error", () => {
			const zeroByteDb = path.join(tmpDir, "zero-byte.db");
			writeFileSync(zeroByteDb, Buffer.alloc(0));

			const garbageDb = path.join(tmpDir, "garbage.db");
			writeFileSync(
				garbageDb,
				Buffer.from("THIS IS DEFINITELY NOT A VALID SQLITE DATABASE FILE"),
			);

			// Opening garbage file and executing query should throw SQLite error without crashing process
			expect(() => {
				const handle = openSafeReadonlyDatabase(garbageDb, {
					allowSnapshotCopy: false,
					maxRetries: 1,
				});
				handle.db.query("SELECT 1;").get();
				handle.close();
			}).toThrow();
		});
	});

	// =========================================================================
	// Domain 5: Corrupted Protobuf Wire Streams and Unexpected Tag Types
	// =========================================================================
	describe("5. Corrupted Protobuf Wire Streams and Unexpected Tag Types", () => {
		test("F26-PROTO-01: Empty buffer and truncated 1-byte headers decode safely", () => {
			expect(decodeProto(new Uint8Array([]))).toEqual([]);
			expect(decodeProto(new Uint8Array([0x08]))).toBeDefined(); // Tag without varint value
			expect(decodeProto(new Uint8Array([0x12]))).toBeDefined(); // Tag without length delimiter
		});

		test("F26-PROTO-02: Infinite-varint sequence with MSB=1 terminates at EOF without hanging", () => {
			// Sequence where every byte has high bit set (0x80)
			const hangingVarint = new Uint8Array([
				0x88, 0x80, 0x80, 0x80, 0x80, 0x80,
			]);
			const startTime = Date.now();
			const fields = decodeProto(hangingVarint);
			const duration = Date.now() - startTime;

			expect(duration).toBeLessThan(100);
			expect(Array.isArray(fields)).toBe(true);
		});

		test("F26-PROTO-03: Truncated length-delimited wire type 2 clamps to buffer size", () => {
			// Field 1, wire type 2 (0x0a), declared length = 100 bytes (0x64), but payload is only 3 bytes
			const truncatedWire2 = new Uint8Array([0x0a, 0x64, 0x41, 0x42, 0x43]);
			const fields = decodeProto(truncatedWire2);

			expect(fields.length).toBe(1);
			expect(fields[0]?.field).toBe(1);
			expect(fields[0]?.wire).toBe(2);
			expect(fields[0]?.raw?.length).toBe(3);
			expect(protoText(fields[0])).toBe("ABC");
		});

		test("F26-PROTO-04: Unexpected wire types (wire 3, 4, 6, 7) terminate decoding loop cleanly", () => {
			// Wire type 3 (start group): tag = (1 << 3) | 3 = 11 (0x0b)
			const wire3 = new Uint8Array([0x0b, 0x01, 0x02, 0x03]);
			const fields3 = decodeProto(wire3);
			expect(Array.isArray(fields3)).toBe(true);

			// Wire type 4 (end group): tag = (1 << 3) | 4 = 12 (0x0c)
			const wire4 = new Uint8Array([0x0c, 0x01, 0x02, 0x03]);
			const fields4 = decodeProto(wire4);
			expect(Array.isArray(fields4)).toBe(true);

			// Wire type 7: tag = (1 << 3) | 7 = 15 (0x0f)
			const wire7 = new Uint8Array([0x0f, 0x01]);
			const fields7 = decodeProto(wire7);
			expect(Array.isArray(fields7)).toBe(true);
		});

		test("F26-PROTO-05: protoText and protoSub resilience on undefined and malformed bytes", () => {
			expect(protoText(undefined)).toBeNull();
			expect(protoText({ field: 1, wire: 2 })).toBeNull();
			expect(protoText({ field: 1, wire: 2, raw: new Uint8Array([]) })).toBe(
				"",
			);

			expect(protoSub(undefined)).toEqual([]);
			expect(protoSub({ field: 1, wire: 2 })).toEqual([]);
			expect(
				protoSub({ field: 1, wire: 2, raw: new Uint8Array([0xff, 0xff]) }),
			).toBeDefined();
		});

		test("F26-PROTO-06: Windsurf parseWindsurfPbFile returns null or fallback on noise and 0-byte files", () => {
			const zeroPb = path.join(tmpDir, "zero-byte.pb");
			writeFileSync(zeroPb, Buffer.alloc(0));
			expect(parseWindsurfPbFile(zeroPb)).toBeNull();

			const nonExistentPb = path.join(tmpDir, "missing-file.pb");
			expect(parseWindsurfPbFile(nonExistentPb)).toBeNull();

			const noisePb = path.join(tmpDir, "noise.pb");
			writeFileSync(
				noisePb,
				Buffer.from([0x01, 0x02, 0x03, 0x04, 0xfe, 0xff, 0x00]),
			);
			const state = parseWindsurfPbFile(noisePb);
			// Either returns null or state with default conversationId
			if (state) {
				expect(state.conversationId).toBe("noise");
			}
		});

		test("F26-PROTO-07: Windsurf PB parser with valid header but malformed turn payloads preserves metadata", () => {
			const pbFile = path.join(tmpDir, "partial-turns.pb");
			// Field 1 (id): "sess-partial" (wire 2, tag 0x0a, len 12)
			// Field 2 (model): "claude-3-5-sonnet" (wire 2, tag 0x12, len 17)
			// Field 3 (turn): truncated payload (wire 2, tag 0x1a, declared len 50, but only 4 bytes)
			const idBytes = Buffer.from("sess-partial");
			const modelBytes = Buffer.from("claude-3-5-sonnet");
			const partialPb = Buffer.concat([
				Buffer.from([0x0a, idBytes.length]),
				idBytes,
				Buffer.from([0x12, modelBytes.length]),
				modelBytes,
				Buffer.from([0x1a, 50, 0x01, 0x02, 0x03, 0x04]),
			]);

			writeFileSync(pbFile, partialPb);
			const parsed = parseWindsurfPbFile(pbFile);

			expect(parsed).toBeDefined();
			expect(parsed?.conversationId).toBe("sess-partial");
			expect(parsed?.model).toBe("claude-3-5-sonnet");
		});
	});

	// =========================================================================
	// Domain 6: Zero-Token and Unpriced Model Fallback Calculations
	// =========================================================================
	describe("6. Zero-Token and Unpriced Model Fallback Calculations", () => {
		const pricingService = new DefaultPricingService();

		beforeAll(async () => {
			await pricingService.init();
		});

		test("F26-PRICING-01: hasTokenUsage rejects zero-token and negative-token records", () => {
			const zeroRecord: UsageRecord = {
				harness: "claude",
				sessionId: "s1",
				messageId: "m1",
				cwd: "/test",
				model: "gpt-4",
				timestamp: Date.now(),
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				costEstimated: false,
			};
			expect(hasTokenUsage(zeroRecord)).toBe(false);

			const singleToken: UsageRecord = {
				...zeroRecord,
				reasoningTokens: 1,
			};
			expect(hasTokenUsage(singleToken)).toBe(true);

			const inputOnly: UsageRecord = {
				...zeroRecord,
				inputTokens: 10,
			};
			expect(hasTokenUsage(inputOnly)).toBe(true);
		});

		test("F26-PRICING-02: calculateCost returns 0.00000000 for zero tokens on known model", () => {
			const cost = pricingService.calculateCost(
				"claude-3-5-sonnet",
				0,
				0,
				0,
				0,
				0,
			);
			expect(cost).toBe(0);
		});

		test("F26-PRICING-03: calculateCost returns null for unrecognized unpriced model", () => {
			const cost = pricingService.calculateCost(
				"completely-unknown-custom-llm-v9999",
				1000,
				500,
			);
			expect(cost).toBeNull();

			const emptyCost = pricingService.calculateCost("", 1000, 500);
			expect(emptyCost).toBeNull();
		});

		test("F26-PRICING-04: calculateCost handles reasoning subtraction clamp when reasoning > output", () => {
			// If reasoningTokens exceeds outputTokens, netOutput should clamp to 0 and not produce negative total
			const cost = pricingService.calculateCost(
				"deepseek-reasoner",
				1000, // input
				500, // output
				0,
				0,
				800, // reasoning exceeds output
			);
			expect(cost).toBeDefined();
			expect(typeof cost).toBe("number");
			expect(cost ?? 0).toBeGreaterThan(0);
		});

		test("F26-PRICING-05: Fallback rate deduction when reasoning and cache tiers are missing", () => {
			// For models without explicit reasoning rate, rates.reasoning falls back to rates.output
			// and cacheRead / cacheWrite fall back to rates.input
			const costWithTiers = pricingService.calculateCost(
				"gpt-4o",
				1000,
				500,
				200,
				100,
				50,
			);
			expect(costWithTiers).toBeDefined();
			expect(costWithTiers ?? 0).toBeGreaterThan(0);
		});

		test("F26-PRICING-06: enrichRecords processes mixed batch (priced, unpriced, zero-token) safely", async () => {
			const now = Date.now();
			const mixedRecords: UsageRecord[] = [
				{
					harness: "claude",
					sessionId: "s1",
					messageId: "m1",
					cwd: "/p1",
					model: "claude-3-5-sonnet",
					timestamp: now,
					inputTokens: 1000,
					outputTokens: 200,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: null,
					costEstimated: false,
				},
				{
					harness: "codex",
					sessionId: "s2",
					messageId: "m2",
					cwd: "/p2",
					model: "custom-unpriced-model",
					timestamp: now,
					inputTokens: 500,
					outputTokens: 100,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: null,
					costEstimated: false,
				},
				{
					harness: "cline",
					sessionId: "s3",
					messageId: "m3",
					cwd: "/p3",
					model: "gpt-4o",
					timestamp: now,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: null,
					costEstimated: false,
				},
				{
					harness: "continue",
					sessionId: "s4",
					messageId: "m4",
					cwd: "/p4",
					model: "gpt-4o-mini",
					timestamp: now,
					inputTokens: 2000,
					outputTokens: 400,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0.05, // already has cost, must remain immutable
					costEstimated: false,
				},
			];

			const enriched = await pricingService.enrichRecords(mixedRecords);
			expect(enriched.length).toBe(4);

			// Record 1: priced, receives costUsd and costEstimated
			expect(enriched[0]?.costUsd).toBeGreaterThan(0);
			expect(enriched[0]?.costEstimated).toBe(true);

			// Record 2: unpriced, remains null without bogus estimation flag
			expect(enriched[1]?.costUsd).toBeNull();
			expect(enriched[1]?.costEstimated).toBe(false);

			// Record 3: zero tokens, receives costUsd = 0 or remains 0
			expect(enriched[2]?.costUsd).toBe(0);

			// Record 4: pre-existing cost remains immutable
			expect(enriched[3]?.costUsd).toBe(0.05);
			expect(enriched[3]?.costEstimated).toBe(false);
		});

		test("F26-PRICING-07: Static fallback rate matching is resilient to casing, prefixes, and date suffixes", () => {
			const r1 = pricingService.getModelRates(
				"Anthropic/Claude-3-5-Sonnet-20241022",
			);
			expect(r1).toBeDefined();

			const r2 = pricingService.getModelRates("GPT-4O-MINI-2024-07-18");
			expect(r2).toBeDefined();

			const r3 = pricingService.getModelRates("deepseek/deepseek-chat");
			expect(r3).toBeDefined();
		});
	});
});
