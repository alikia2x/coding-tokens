import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { decodeProto } from "../../src/sources/antigravity";
import { readOpenCode } from "../../src/sources/opencode";
import {
	parseJsonl,
	readJsonlFile,
	readZstdJsonlFile,
	toJsonl,
	toJsonlWithCorruption,
	writeZstdJsonlFile,
} from "./helpers/jsonl-generator";
import {
	createMockEnv,
	createSandboxEnvironment,
	withSandboxEnvironment,
} from "./helpers/mock-env";
import {
	buildAntigravityGenMetadata,
	buildWindsurfChatStateBlob,
	protoBytes,
	protoConcat,
	protoVarint,
} from "./helpers/protobuf-builder";
import {
	closeDatabase,
	createDatabase,
	openReadonlyDb,
	seedOpenCodeDb,
} from "./helpers/sqlite-fixtures";

const FIXTURES_DIR = path.resolve(__dirname);
const HARNESSES_DIR = path.join(FIXTURES_DIR, "harnesses");
const PLATFORMS_DIR = path.join(FIXTURES_DIR, "platforms");

describe("Fixture Helper Utilities", () => {
	describe("mock-env", () => {
		test("creates darwin mock provider with correct homedir and environment", () => {
			const provider = createMockEnv("darwin", "/tmp/mock-darwin");
			expect(provider.platform()).toBe("darwin");
			expect(provider.homedir()).toBe("/tmp/mock-darwin/Users/testuser");
			expect(provider.get("HOME")).toBe("/tmp/mock-darwin/Users/testuser");
			expect(provider.get("USER")).toBe("testuser");
		});

		test("creates linux mock provider with XDG environment variables", () => {
			const provider = createMockEnv("linux", "/tmp/mock-linux");
			expect(provider.platform()).toBe("linux");
			expect(provider.homedir()).toBe("/tmp/mock-linux/home/testuser");
			expect(provider.get("XDG_CONFIG_HOME")).toBe(
				"/tmp/mock-linux/home/testuser/.config",
			);
			expect(provider.get("XDG_DATA_HOME")).toBe(
				"/tmp/mock-linux/home/testuser/.local/share",
			);
			expect(provider.get("XDG_CACHE_HOME")).toBe(
				"/tmp/mock-linux/home/testuser/.cache",
			);
		});

		test("creates win32 mock provider with case-insensitive environment variables", () => {
			const provider = createMockEnv("win32", "/tmp/mock-win");
			expect(provider.platform()).toBe("win32");
			expect(provider.homedir()).toBe("/tmp/mock-win/Users/testuser");
			expect(provider.get("USERPROFILE")).toBe("/tmp/mock-win/Users/testuser");
			expect(provider.get("userprofile")).toBe("/tmp/mock-win/Users/testuser");
			expect(provider.get("APPDATA")).toBe(
				"/tmp/mock-win/Users/testuser/AppData/Roaming",
			);
			expect(provider.get("appdata")).toBe(
				"/tmp/mock-win/Users/testuser/AppData/Roaming",
			);
			expect(provider.get("LOCALAPPDATA")).toBe(
				"/tmp/mock-win/Users/testuser/AppData/Local",
			);
		});

		test("win32 mock provider replaces existing variables case-insensitively on set and override", () => {
			const provider = createMockEnv("win32", "C:\\base", {
				appdata: "D:\\custom\\appdata",
			});
			expect(provider.get("appdata")).toBe("D:\\custom\\appdata");
			expect(provider.get("APPDATA")).toBe("D:\\custom\\appdata");

			provider.set("localappdata", "E:\\custom\\local");
			expect(provider.get("LOCALAPPDATA")).toBe("E:\\custom\\local");
			expect(provider.get("localappdata")).toBe("E:\\custom\\local");

			const all = provider.all();
			const upperKeys = Object.keys(all).map((k) => k.toUpperCase());
			const uniqueUpperKeys = new Set(upperKeys);
			expect(upperKeys.length).toBe(uniqueUpperKeys.size);

			provider.delete("USERPROFILE");
			expect(provider.get("userprofile")).toBeUndefined();
			expect(provider.get("USERPROFILE")).toBeUndefined();
		});

		test("createSandboxEnvironment sets up on-disk directory tree and cleans up", () => {
			const sandbox = createSandboxEnvironment("darwin", "ct-test-smoke-");
			expect(existsSync(sandbox.rootDir)).toBe(true);
			expect(existsSync(sandbox.homeDir)).toBe(true);
			expect(existsSync(sandbox.configDir)).toBe(true);
			expect(existsSync(sandbox.cacheDir)).toBe(true);
			sandbox.cleanup();
			expect(existsSync(sandbox.rootDir)).toBe(false);
		});

		test("withSandboxEnvironment runs scoped action and cleans up automatically", async () => {
			let recordedPath = "";
			await withSandboxEnvironment("linux", (sandbox) => {
				recordedPath = sandbox.rootDir;
				expect(existsSync(sandbox.rootDir)).toBe(true);
			});
			expect(existsSync(recordedPath)).toBe(false);
		});
	});

	describe("jsonl-generator", () => {
		test("serializes and parses clean JSONL streams", () => {
			const items = [
				{ id: 1, name: "alpha" },
				{ id: 2, name: "beta" },
			];
			const raw = toJsonl(items);
			expect(raw).toBe('{"id":1,"name":"alpha"}\n{"id":2,"name":"beta"}\n');
			const parsed = parseJsonl<{ id: number; name: string }>(raw);
			expect(parsed).toEqual(items);
		});

		test("compresses and decompresses Zstandard JSONL files", async () => {
			await withSandboxEnvironment("darwin", (sandbox) => {
				const testFile = path.join(sandbox.rootDir, "test.jsonl.zst");
				const items = [{ type: "event", count: 42 }];
				writeZstdJsonlFile(testFile, items);
				expect(existsSync(testFile)).toBe(true);

				const parsed = readZstdJsonlFile<{ type: string; count: number }>(
					testFile,
				);
				expect(parsed).toEqual(items);
			});
		});

		test("handles injected corrupted lines for boundary tests", () => {
			const items = [{ id: 1 }];
			const corrupted = toJsonlWithCorruption(items);
			expect(() => parseJsonl(corrupted)).toThrow();
		});
	});

	describe("sqlite-fixtures", () => {
		test("creates SQLite database with WAL mode and readonly opening", async () => {
			await withSandboxEnvironment("darwin", (sandbox) => {
				const dbPath = path.join(sandbox.rootDir, "test.db");
				const db = createDatabase(dbPath);
				db.run("CREATE TABLE test_table (id TEXT);");
				db.run("INSERT INTO test_table VALUES ('hello');");
				closeDatabase(db);

				const readonlyDb = openReadonlyDb(dbPath);
				const row = readonlyDb.query("SELECT id FROM test_table").get() as {
					id: string;
				};
				expect(row.id).toBe("hello");
				expect(() =>
					readonlyDb.run("INSERT INTO test_table VALUES ('fail');"),
				).toThrow();
				readonlyDb.close();
			});
		});

		test("seedOpenCodeDb supports legacy v1 schema with time_created column", async () => {
			await withSandboxEnvironment("darwin", (sandbox) => {
				const dbPath = path.join(sandbox.rootDir, "opencode-v1-test.db");
				const db = seedOpenCodeDb(dbPath, {
					version: "v1",
					sessions: [
						{
							id: "test-sess",
							directory: "/workspace/test",
							messages: [
								{
									id: "msg-1",
									type: "user",
									data: { role: "user", text: "query" },
									time: 1773500000000,
								},
							],
						},
					],
				});
				closeDatabase(db);

				const ro = openReadonlyDb(dbPath);
				const row = ro
					.query(
						"SELECT m.id, m.session_id, m.time_created, m.data FROM message AS m",
					)
					.get() as { id: string; time_created: number; data: string };
				expect(row.id).toBe("msg-1");
				expect(row.time_created).toBe(1773500000000);
				ro.close();
			});
		});
	});

	describe("protobuf-builder", () => {
		test("encodes varints and length-delimited bytes correctly", () => {
			const v = protoVarint(1, 150);
			expect(v.length).toBeGreaterThan(1);
			const b = protoBytes(2, "test-string");
			expect(b.length).toBeGreaterThan(11);
			const concat = protoConcat(v, b);
			expect(concat.length).toBe(v.length + b.length);
		});

		test("handles negative values and BigInts with 64-bit two's complement varints", () => {
			const vNeg = protoVarint(1, -1);
			expect(vNeg.length).toBe(11); // 1 byte tag + 10 bytes varint
			let val = 0n;
			let s = 0n;
			for (const b of vNeg.slice(1)) {
				val |= BigInt(b & 127) << s;
				s += 7n;
			}
			expect(BigInt.asIntN(64, val)).toBe(-1n);

			const vBig = protoVarint(2, 1000000000000n);
			let valBig = 0n;
			let sBig = 0n;
			for (const b of vBig.slice(1)) {
				valBig |= BigInt(b & 127) << sBig;
				sBig += 7n;
			}
			expect(valBig).toBe(1000000000000n);
		});

		test("builds Antigravity gen metadata with decodeProto compatibility", () => {
			const genMeta = buildAntigravityGenMetadata({
				model: "gemini-2.5-pro",
				inputTokens: 2500,
				outputTokens: 450,
				cacheReadTokens: 1800,
				reasoningTokens: 50,
				requestId: "req-smoke-test",
			});
			expect(genMeta.length).toBeGreaterThan(0);
			const decoded = decodeProto(genMeta);
			expect(decoded.length).toBeGreaterThan(0);
			expect(decoded[0]?.field).toBe(1);
		});

		test("builds Windsurf chat state blob with expected fields", () => {
			const blob = buildWindsurfChatStateBlob({
				conversationId: "conv-ws-1",
				model: "claude-3-5-sonnet",
				prompt: "Write tests",
				completion: "Done",
				inputTokens: 1000,
				outputTokens: 200,
			});
			expect(blob.length).toBeGreaterThan(0);
			const decoded = decodeProto(blob);
			expect(decoded.some((f) => f.field === 1)).toBe(true);
			expect(decoded.some((f) => f.field === 2)).toBe(true);
		});
	});
});

describe("Harness Synthetic Fixtures (All 15+ Harnesses)", () => {
	// 1. Claude Code
	test("Claude Code: stats-cache.json and project transcripts are valid", () => {
		const claudeDir = path.join(HARNESSES_DIR, "claude");
		const statsCachePath = path.join(claudeDir, "stats-cache.json");
		expect(existsSync(statsCachePath)).toBe(true);

		const stats = JSON.parse(readFileSync(statsCachePath, "utf8"));
		expect(stats.version).toBe(2);
		expect(stats.modelUsage["claude-3-7-sonnet"].inputTokens).toBe(25000);
		expect(stats.modelUsage["claude-3-7-sonnet"].cacheReadInputTokens).toBe(
			150000,
		);

		const transcriptPath = path.join(
			claudeDir,
			"projects",
			"sample-project",
			"ceda31df-a9d4-4ab8-9409-3f3ac444b272.jsonl",
		);
		expect(existsSync(transcriptPath)).toBe(true);
		const events = readJsonlFile<{ type: string; message: { role: string } }>(
			transcriptPath,
		);
		expect(events.length).toBe(2);
		expect(events[0]?.type).toBe("user");
		expect(events[1]?.type).toBe("assistant");

		const emptyPath = path.join(claudeDir, "boundary-empty.jsonl");
		expect(statSync(emptyPath).size).toBe(0);

		const corruptedPath = path.join(claudeDir, "boundary-corrupted.jsonl");
		expect(() => readJsonlFile(corruptedPath)).toThrow();
	});

	// 2. Cline
	test("Cline: taskHistory.json and ui_messages.json token telemetry are valid", () => {
		const clineDir = path.join(HARNESSES_DIR, "cline");
		const historyPath = path.join(clineDir, "taskHistory.json");
		const history = JSON.parse(readFileSync(historyPath, "utf8"));
		expect(history.length).toBeGreaterThan(0);
		expect(history[0].id).toBe("task-cline-101");
		expect(history[0].tokensIn).toBe(45000);

		const uiMessagesPath = path.join(
			clineDir,
			"tasks",
			"task-cline-101",
			"ui_messages.json",
		);
		const messages = JSON.parse(readFileSync(uiMessagesPath, "utf8"));
		const apiReq = messages.find(
			(m: { say?: string }) => m.say === "api_req_started",
		);
		expect(apiReq).toBeDefined();
		const reqData = JSON.parse(apiReq.text);
		expect(reqData.tokensIn).toBe(12500);
		expect(reqData.tokensOut).toBe(850);

		const zeroPath = path.join(
			clineDir,
			"tasks",
			"boundary-zero-tokens",
			"ui_messages.json",
		);
		const zeroMessages = JSON.parse(readFileSync(zeroPath, "utf8"));
		const zeroReq = JSON.parse(zeroMessages[0].text);
		expect(zeroReq.tokensIn).toBe(0);
		expect(zeroReq.tokensOut).toBe(0);
	});

	// 3. Roo Code
	test("Roo Code: taskHistory.json and ui_messages.json include mode attributes", () => {
		const rooDir = path.join(HARNESSES_DIR, "roo");
		const historyPath = path.join(rooDir, "taskHistory.json");
		const history = JSON.parse(readFileSync(historyPath, "utf8"));
		expect(history.some((t: { mode?: string }) => t.mode === "architect")).toBe(
			true,
		);
		expect(history.some((t: { mode?: string }) => t.mode === "code")).toBe(
			true,
		);

		const uiPath = path.join(
			rooDir,
			"tasks",
			"task-roo-101",
			"ui_messages.json",
		);
		const messages = JSON.parse(readFileSync(uiPath, "utf8"));
		expect(messages[0].mode).toBe("architect");
	});

	// 4. Continue
	test("Continue: sessions, dev_data tokensGenerated.jsonl and devdata.sqlite are valid", () => {
		const continueDir = path.join(HARNESSES_DIR, "continue");
		const sessionsCatalog = JSON.parse(
			readFileSync(path.join(continueDir, "sessions", "sessions.json"), "utf8"),
		);
		expect(sessionsCatalog[0].sessionId).toBe("cont-sess-01");

		const tokensGen = readJsonlFile<{
			eventName: string;
			promptTokens: number;
		}>(path.join(continueDir, "dev_data", "tokensGenerated.jsonl"));
		expect(tokensGen.length).toBeGreaterThan(0);
		expect(tokensGen[0]?.eventName).toBe("tokensGenerated");

		const devdataDbPath = path.join(continueDir, "dev_data", "devdata.sqlite");
		const db = openReadonlyDb(devdataDbPath);
		const row = db
			.query(
				"SELECT count(*) as c, sum(tokens_generated) as total FROM tokens_generated",
			)
			.get() as { c: number; total: number };
		expect(row.c).toBe(2);
		expect(row.total).toBe(1420);
		db.close();
	});

	// 5. Cursor
	test("Cursor: globalStorage/state.vscdb and workspaceStorage are valid SQLite DBs", () => {
		const cursorDir = path.join(HARNESSES_DIR, "cursor");
		const globalDb = openReadonlyDb(
			path.join(cursorDir, "globalStorage", "state.vscdb"),
		);
		const kvRow = globalDb
			.query(
				"SELECT value FROM cursorDiskKV WHERE key = 'composerData:cursor-comp-1'",
			)
			.get() as { value: string };
		expect(kvRow).toBeDefined();
		const compData = JSON.parse(kvRow.value);
		expect(compData.composerId).toBe("cursor-comp-1");
		expect(compData.unifiedMode).toBe("agent");
		globalDb.close();

		const wsDir = path.join(
			cursorDir,
			"workspaceStorage",
			"2ee3deeb64ace8c807fd30c35b249ed0",
		);
		const wsMeta = JSON.parse(
			readFileSync(path.join(wsDir, "workspace.json"), "utf8"),
		);
		expect(wsMeta.folder).toContain("personal-website-v3");

		const wsDb = openReadonlyDb(path.join(wsDir, "state.vscdb"));
		const itemRow = wsDb
			.query("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
			.get() as { value: string };
		expect(itemRow).toBeDefined();
		wsDb.close();
	});

	// 6. GitHub Copilot
	test("GitHub Copilot: chatSessions JSON has responderUsername and requests", () => {
		const copilotDir = path.join(HARNESSES_DIR, "copilot");
		const chatSession = JSON.parse(
			readFileSync(
				path.join(copilotDir, "chatSessions", "copilot-sess-1.json"),
				"utf8",
			),
		);
		expect(chatSession.responderUsername).toBe("GitHub Copilot");
		expect(chatSession.requests.length).toBe(1);
		expect(chatSession.requests[0].modelId).toBe("copilot/gpt-4o");
	});

	// 7. Aider
	test("Aider: markdown transcript and analytics JSONL are valid", () => {
		const aiderDir = path.join(HARNESSES_DIR, "aider");
		const md = readFileSync(
			path.join(aiderDir, ".aider.chat.history.md"),
			"utf8",
		);
		expect(md).toContain("# aider chat started at");
		expect(md).toContain("#### Write a binary search function");

		const analytics = readJsonlFile<{ tokens_in: number; cost: number }>(
			path.join(aiderDir, "analytics.jsonl"),
		);
		expect(analytics[0]?.tokens_in).toBe(1400);
		expect(analytics[0]?.cost).toBe(0.0082);
	});

	// 8. Windsurf
	test("Windsurf: Protobuf wire blob and cascade plans are valid", () => {
		const windsurfDir = path.join(HARNESSES_DIR, "windsurf");
		const pbPath = path.join(
			windsurfDir,
			"chat_state",
			"codeium_chat_state_file_workspace_windsurf_project.pb",
		);
		expect(existsSync(pbPath)).toBe(true);
		const pbBytes = readFileSync(pbPath);
		expect(pbBytes.length).toBeGreaterThan(0);

		const decoded = decodeProto(pbBytes);
		expect(decoded.length).toBeGreaterThan(0);
	});

	// 9. Goose
	test("Goose: sessions.db has sessions and messages tables and legacy JSONL", () => {
		const gooseDir = path.join(HARNESSES_DIR, "goose");
		const db = openReadonlyDb(path.join(gooseDir, "sessions.db"));
		const sess = db.query("SELECT * FROM sessions").get() as {
			id: string;
			description: string;
		};
		expect(sess.id).toBe("goose-sess-1");

		const msgs = db
			.query(
				"SELECT count(*) as c, sum(accumulated_input_tokens) as total_in FROM messages",
			)
			.get() as { c: number; total_in: number };
		expect(msgs.c).toBe(2);
		expect(msgs.total_in).toBe(1800);
		db.close();

		const legacy = readJsonlFile<{ id: string }>(
			path.join(gooseDir, "legacy-sessions", "legacy-session.jsonl"),
		);
		expect(legacy[0]?.id).toBe("goose-legacy-1");
	});

	// 10. OpenHands
	test("OpenHands: base_state.json and sequential event stream are valid", () => {
		const openhandsDir = path.join(HARNESSES_DIR, "openhands");
		const baseState = JSON.parse(
			readFileSync(
				path.join(
					openhandsDir,
					"conversations",
					"conv-12345",
					"base_state.json",
				),
				"utf8",
			),
		);
		expect(baseState.agent_name).toBe("CodeActAgent");
		expect(baseState.metrics.prompt_tokens).toBe(13000);

		const ev0 = JSON.parse(
			readFileSync(
				path.join(
					openhandsDir,
					"conversations",
					"conv-12345",
					"events",
					"event-0.json",
				),
				"utf8",
			),
		);
		const ev1 = JSON.parse(
			readFileSync(
				path.join(
					openhandsDir,
					"conversations",
					"conv-12345",
					"events",
					"event-1.json",
				),
				"utf8",
			),
		);
		expect(ev0.source).toBe("user");
		expect(ev1.source).toBe("agent");
		expect(ev1.metrics.prompt_tokens).toBe(1400);
	});

	// 11. Codex CLI
	test("Codex: rollout-*.jsonl and .zst decompress and match events", () => {
		const codexDir = path.join(
			HARNESSES_DIR,
			"codex",
			"sessions",
			"2026",
			"03",
			"15",
		);
		const plain = readJsonlFile<{ type: string }>(
			path.join(codexDir, "rollout-thread-1.jsonl"),
		);
		const compressed = readZstdJsonlFile<{ type: string }>(
			path.join(codexDir, "rollout-thread-compressed.jsonl.zst"),
		);
		expect(plain.length).toBe(4);
		expect(compressed).toEqual(plain);
		expect(plain[0]?.type).toBe("session_meta");
		expect(plain[3]?.type).toBe("token_usage_record");
	});

	// 12. DSH
	test("DSH: session.v3.jsonl.zstd decompresses with usage metrics and plain session.jsonl", () => {
		const dshDir = path.join(
			HARNESSES_DIR,
			"dsh",
			"sessions",
			"--workspace-dsh-project--",
			"session-dsh-1",
		);
		const plain = readJsonlFile<{ type: string }>(
			path.join(dshDir, "session.jsonl"),
		);
		const compressed = readZstdJsonlFile<{
			type: string;
			data?: { usage?: { inputTokens: number } };
		}>(path.join(dshDir, "session.v3.jsonl.zstd"));
		expect(plain.length).toBe(3);
		expect(compressed.length).toBe(3);
		expect(compressed[2]?.data?.usage?.inputTokens).toBe(1800);
	});

	// 13. OpenCode
	test("OpenCode: opencode-v2.db (v2 schema) and opencode-legacy.db (v1 schema) are queryable", () => {
		const opencodeDir = path.join(HARNESSES_DIR, "opencode");

		const v2Db = openReadonlyDb(path.join(opencodeDir, "opencode-v2.db"));
		const sessV2 = v2Db.query("SELECT * FROM session_v2").get() as {
			id: string;
			model: string;
		};
		expect(sessV2.id).toBe("oc-sess-1");
		const msgV2 = v2Db
			.query("SELECT data FROM session_message WHERE type = 'assistant'")
			.get() as { data: string };
		const parsedMsg = JSON.parse(msgV2.data);
		expect(parsedMsg.tokens.input).toBe(2200);
		v2Db.close();

		const legDb = openReadonlyDb(path.join(opencodeDir, "opencode-legacy.db"));
		const legSess = legDb.query("SELECT * FROM session").get() as {
			id: string;
		};
		expect(legSess.id).toBe("oc-sess-legacy-1");
		const legMsg = legDb
			.query(
				"SELECT m.id, m.data, m.session_id, m.time_created, s.directory " +
					"FROM message AS m JOIN session AS s ON s.id = m.session_id WHERE m.id = 'msg-leg-a1'",
			)
			.get() as { id: string; time_created: number; data: string };
		expect(legMsg).toBeDefined();
		expect(legMsg.time_created).toBeGreaterThan(0);
		legDb.close();

		// Verify readOpenCode() extracts records from opencode-legacy.db without error
		const prevDb = process.env.OPENCODE_DB;
		try {
			process.env.OPENCODE_DB = path.join(opencodeDir, "opencode-legacy.db");
			const res = readOpenCode();
			expect(res.warnings.length).toBe(0);
			expect(res.records.length).toBeGreaterThan(0);
			expect(res.records[0]?.sessionId).toBe("oc-sess-legacy-1");
		} finally {
			if (prevDb !== undefined) {
				process.env.OPENCODE_DB = prevDb;
			} else {
				delete process.env.OPENCODE_DB;
			}
		}
	});

	// 14. Command Code
	test("Command Code: commandcode-1.jsonl and history.jsonl are valid", () => {
		const ccDir = path.join(HARNESSES_DIR, "commandcode");
		const events = readJsonlFile<{
			type: string;
			usage?: { inputTokens: number };
		}>(path.join(ccDir, "projects", "test-project", "commandcode-1.jsonl"));
		expect(events.length).toBe(3);
		expect(events[2]?.usage?.inputTokens).toBe(1600);

		const history = readJsonlFile<{ command: string }>(
			path.join(ccDir, "history.jsonl"),
		);
		expect(history[0]?.command).toBe("run unit test");
	});

	// 15. Antigravity
	test("Antigravity: conversations/*.db has Protobuf metadata and summaries DB is valid", () => {
		const agDir = path.join(HARNESSES_DIR, "antigravity");
		const convDb = openReadonlyDb(
			path.join(agDir, "conversations", "ag-sess-1.db"),
		);
		const traj = convDb
			.query("SELECT data FROM trajectory_metadata_blob")
			.get() as { data: Uint8Array };
		expect(traj.data.length).toBeGreaterThan(0);
		const trajFields = decodeProto(traj.data);
		expect(trajFields.some((f) => f.field === 6)).toBe(true);

		const gen = convDb.query("SELECT data FROM gen_metadata").get() as {
			data: Uint8Array;
		};
		const genFields = decodeProto(gen.data);
		expect(genFields.some((f) => f.field === 1)).toBe(true);
		convDb.close();

		const sumDb = openReadonlyDb(path.join(agDir, "conversation_summaries.db"));
		const sumRow = sumDb
			.query(
				"SELECT * FROM conversation_summaries WHERE conversation_id = 'ag-sess-1'",
			)
			.get() as { title: string };
		expect(sumRow.title).toBe("Fix typecheck error");
		sumDb.close();
	});
});

describe("Cross-Platform Directory Mocks", () => {
	test("Darwin (macOS) mock environment contains Library paths and dotfiles", () => {
		const darwinDir = path.join(PLATFORMS_DIR, "darwin");
		expect(
			existsSync(
				path.join(
					darwinDir,
					"Library",
					"Application Support",
					"Cursor",
					"User",
					"globalStorage",
					"state.vscdb",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(
					darwinDir,
					"Library",
					"Application Support",
					"Code",
					"User",
					"globalStorage",
					"saoudrizwan.claude-dev",
					"taskHistory.json",
				),
			),
		).toBe(true);
		expect(
			existsSync(path.join(darwinDir, ".claude", "stats-cache.json")),
		).toBe(true);
		expect(
			existsSync(
				path.join(
					darwinDir,
					"Library",
					"Caches",
					"harness-token-usage",
					"models.dev.json",
				),
			),
		).toBe(true);
	});

	test("Linux mock environment contains XDG config, data, cache, and dotfiles", () => {
		const linuxDir = path.join(PLATFORMS_DIR, "linux");
		expect(
			existsSync(
				path.join(
					linuxDir,
					".config",
					"Code",
					"User",
					"globalStorage",
					"rooveterinaryinc.roo-cline",
					"taskHistory.json",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(linuxDir, ".local", "share", "opencode", "opencode.db"),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(
					linuxDir,
					".local",
					"share",
					"goose",
					"sessions",
					"sessions.db",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(linuxDir, ".cache", "harness-token-usage", "models.dev.json"),
			),
		).toBe(true);
	});

	test("Windows mock environment contains AppData Roaming, Local, and UserProfile dotfiles", () => {
		const winDir = path.join(PLATFORMS_DIR, "win32");
		expect(
			existsSync(
				path.join(
					winDir,
					"AppData",
					"Roaming",
					"Cursor",
					"User",
					"globalStorage",
					"state.vscdb",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(
					winDir,
					"AppData",
					"Roaming",
					"Code",
					"User",
					"globalStorage",
					"saoudrizwan.claude-dev",
					"taskHistory.json",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(
					winDir,
					"AppData",
					"Roaming",
					"Block",
					"goose",
					"data",
					"sessions",
					"sessions.db",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(winDir, "AppData", "Local", "opencode", "opencode.db"),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(
					winDir,
					"AppData",
					"Local",
					"harness-token-usage",
					"Cache",
					"models.dev.json",
				),
			),
		).toBe(true);
		expect(existsSync(path.join(winDir, ".claude", "stats-cache.json"))).toBe(
			true,
		);
	});
});
