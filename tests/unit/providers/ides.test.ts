import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { openSafeReadonlyDatabase } from "../../../src/platform/sqlite";
import { CopilotProvider } from "../../../src/providers/copilot";
import { CursorProvider } from "../../../src/providers/cursor";
import { DefaultHarnessRegistry } from "../../../src/providers/registry";
import { WindsurfProvider } from "../../../src/providers/windsurf";
import {
	createMockEnv,
	createSandboxEnvironment,
} from "../../fixtures/helpers/mock-env";
import { buildWindsurfChatStateBlob } from "../../fixtures/helpers/protobuf-builder";
import { seedCursorDb } from "../../fixtures/helpers/sqlite-fixtures";

const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");
const HARNESSES_DIR = path.join(FIXTURES_DIR, "harnesses");

describe("Milestone 3 Batch 3: AI IDEs & Copilots Providers", () => {
	const suiteTmp = mkdtempSync(path.join(os.tmpdir(), "ct-ides-test-"));

	afterAll(() => {
		rmSync(suiteTmp, { recursive: true, force: true });
	});

	function createIsolatedPaths(homeDir: string) {
		return new DefaultPlatformPathService(
			new MockOsEnvProvider({ platform: "darwin", home: homeDir }),
		);
	}

	function createStagedIdePaths(
		harness: "cursor" | "windsurf" | "copilot",
		sourceDir: string,
	) {
		const homeDir = path.join(
			suiteTmp,
			`${harness}-${Math.random().toString(36).slice(2, 8)}`,
		);
		const paths = createIsolatedPaths(homeDir);
		const resolved = paths.resolveHarnessPaths(harness);
		const targetRoot =
			harness === "cursor"
				? path.dirname(resolved[0] ?? "")
				: (resolved[0] ?? "");
		if (!targetRoot) throw new Error(`No resolved path for ${harness}`);
		mkdirSync(path.dirname(targetRoot), { recursive: true });
		cpSync(sourceDir, targetRoot, { recursive: true });
		return paths;
	}
	// =========================================================================
	// 1. Metadata Conformance
	// =========================================================================
	describe("1. Metadata Conformance", () => {
		test("CursorProvider conforms to HarnessProvider metadata contract", () => {
			const provider = new CursorProvider();
			expect(provider.metadata.id).toBe("cursor");
			expect(provider.metadata.displayName).toBe("Cursor");
			expect(provider.metadata.shortLabel).toBe("Cur");
			expect(provider.metadata.color).toBe("#10B981");
			expect(provider.metadata.defaultEnabled).toBe(true);
		});

		test("WindsurfProvider conforms to HarnessProvider metadata contract", () => {
			const provider = new WindsurfProvider();
			expect(provider.metadata.id).toBe("windsurf");
			expect(provider.metadata.displayName).toBe("Windsurf");
			expect(provider.metadata.shortLabel).toBe("Wind");
			expect(provider.metadata.color).toBe("#06B6D4");
			expect(provider.metadata.defaultEnabled).toBe(true);
		});

		test("CopilotProvider conforms to HarnessProvider metadata contract", () => {
			const provider = new CopilotProvider();
			expect(provider.metadata.id).toBe("copilot");
			expect(provider.metadata.displayName).toBe("GitHub Copilot");
			expect(provider.metadata.shortLabel).toBe("GH");
			expect(provider.metadata.color).toBe("#6366F1");
			expect(provider.metadata.defaultEnabled).toBe(true);
		});
	});

	// =========================================================================
	// 2. Cursor IDE Provider: Discovery, Usage & Transcripts
	// =========================================================================
	describe("2. Cursor IDE Provider", () => {
		const cursorFixtureDir = path.join(HARNESSES_DIR, "cursor");
		const mockCursorPaths = createStagedIdePaths("cursor", cursorFixtureDir);

		test("isAvailable returns true when fixture databases exist", async () => {
			const provider = new CursorProvider();
			const isAvail = await provider.isAvailable(mockCursorPaths);
			expect(isAvail).toBe(true);
		});

		test("isAvailable returns false when directory is empty", async () => {
			const emptyDir = path.join(
				suiteTmp,
				`empty-cursor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			);
			mkdirSync(emptyDir, { recursive: true });

			const emptyPaths = createIsolatedPaths(emptyDir);

			const provider = new CursorProvider();
			const isAvail = await provider.isAvailable(emptyPaths);
			expect(isAvail).toBe(false);

			rmSync(emptyDir, { recursive: true, force: true });
		});

		test("discoverSessions resolves composer session with workspace CWD from workspace.json", async () => {
			const provider = new CursorProvider();
			const sessions = await provider.discoverSessions(mockCursorPaths);
			expect(sessions.length).toBeGreaterThanOrEqual(1);

			const composerSession = sessions.find(
				(s) => s.sessionId === "cursor-comp-1",
			);
			expect(composerSession).toBeDefined();
			expect(composerSession?.harness).toBe("cursor");
			expect(composerSession?.cwd).toBe("/workspace/personal-website-v3");
			expect(composerSession?.mtimeMs).toBe(1773500000000);
		});

		test("readUsage extracts token usage and model metadata correctly", async () => {
			const provider = new CursorProvider();
			const usage = await provider.readUsage(mockCursorPaths);
			expect(usage.available).toBe(true);
			expect(usage.harness).toBe("cursor");
			expect(usage.records.length).toBeGreaterThanOrEqual(1);

			const rec = usage.records.find((r) => r.sessionId === "cursor-comp-1");
			expect(rec).toBeDefined();
			expect(rec?.model).toBe("claude-3-5-sonnet");
			expect(rec?.cwd).toBe("/workspace/personal-website-v3");
			expect(rec?.inputTokens).toBe(3200);
			expect(rec?.outputTokens).toBe(450);
			expect(rec?.costEstimated).toBe(false);
			expect(usage.messages.get("cursor-comp-1")).toBeGreaterThanOrEqual(1);
		});

		test("readTranscript reconstructs user and ai conversation turns", async () => {
			const provider = new CursorProvider();
			const transcript = await provider.readTranscript(
				mockCursorPaths,
				"cursor-comp-1",
			);
			expect(transcript).not.toBeNull();
			expect(transcript?.sessionId).toBe("cursor-comp-1");
			expect(transcript?.harness).toBe("cursor");
			expect(transcript?.cwd).toBe("/workspace/personal-website-v3");
			expect(transcript?.items.length).toBe(2);

			const userMsg = transcript?.items[0];
			expect(userMsg?.role).toBe("user");
			expect(userMsg?.text).toBe("Create API routes");

			const aiMsg = transcript?.items[1];
			expect(aiMsg?.role).toBe("assistant");
			expect(aiMsg?.text).toBe("Creating routes...");
		});

		test("getWatchPaths and computeFingerprint comply with specifications", async () => {
			const provider = new CursorProvider();
			const watchPaths = provider.getWatchPaths(mockCursorPaths);
			expect(watchPaths.length).toBe(2);

			const fp = await provider.computeFingerprint(mockCursorPaths);
			expect(fp).toMatch(/^v12:\d+:[0-9a-f]{64}$/);
		});
	});

	// =========================================================================
	// 3. Windsurf / Codeium Cascade Provider: Discovery, Protobuf & Transcripts
	// =========================================================================
	describe("3. Windsurf / Codeium Cascade Provider", () => {
		const windsurfFixtureDir = path.join(HARNESSES_DIR, "windsurf");
		const mockWindsurfPaths = createStagedIdePaths(
			"windsurf",
			windsurfFixtureDir,
		);

		test("isAvailable returns true when .pb files exist", async () => {
			const provider = new WindsurfProvider();
			const isAvail = await provider.isAvailable(mockWindsurfPaths);
			expect(isAvail).toBe(true);
		});

		test("discoverSessions extracts conversationId and decodes escaped cwd path", async () => {
			const provider = new WindsurfProvider();
			const sessions = await provider.discoverSessions(mockWindsurfPaths);
			expect(sessions.length).toBeGreaterThanOrEqual(1);

			const sess = sessions.find((s) => s.sessionId === "windsurf-sess-1");
			expect(sess).toBeDefined();
			expect(sess?.harness).toBe("windsurf");
			expect(sess?.cwd).toBe("/workspace/windsurf/project");
		});

		test("readUsage extracts Protobuf wire tokens and model information", async () => {
			const provider = new WindsurfProvider();
			const usage = await provider.readUsage(mockWindsurfPaths);
			expect(usage.available).toBe(true);
			expect(usage.harness).toBe("windsurf");
			expect(usage.records.length).toBeGreaterThanOrEqual(1);

			const rec = usage.records.find((r) => r.sessionId === "windsurf-sess-1");
			expect(rec).toBeDefined();
			expect(rec?.model).toBe("claude-3-5-sonnet");
			expect(rec?.cwd).toBe("/workspace/windsurf/project");
			expect(rec?.inputTokens).toBe(2800);
			expect(rec?.outputTokens).toBe(520);
			expect(rec?.costEstimated).toBe(false);
			expect(usage.messages.get("windsurf-sess-1")).toBe(1);
		});

		test("readTranscript parses Protobuf turns into user and assistant items", async () => {
			const provider = new WindsurfProvider();
			const transcript = await provider.readTranscript(
				mockWindsurfPaths,
				"windsurf-sess-1",
			);
			expect(transcript).not.toBeNull();
			expect(transcript?.sessionId).toBe("windsurf-sess-1");
			expect(transcript?.harness).toBe("windsurf");
			expect(transcript?.cwd).toBe("/workspace/windsurf/project");
			expect(transcript?.items.length).toBe(2);

			expect(transcript?.items[0]?.role).toBe("user");
			expect(transcript?.items[0]?.text).toBe(
				"Implement cascade plan for telemetry",
			);

			expect(transcript?.items[1]?.role).toBe("assistant");
			expect(transcript?.items[1]?.text).toBe(
				"Plan implemented with full wire compatibility.",
			);
		});

		test("getWatchPaths and computeFingerprint operate cleanly", async () => {
			const provider = new WindsurfProvider();
			const watchPaths = provider.getWatchPaths(mockWindsurfPaths);
			expect(watchPaths.length).toBeGreaterThan(0);

			const fp = await provider.computeFingerprint(mockWindsurfPaths);
			expect(fp).toMatch(/^v12:\d+:[0-9a-f]{64}$/);
		});
	});

	// =========================================================================
	// 4. GitHub Copilot Provider: Discovery, Usage & Transcripts
	// =========================================================================
	describe("4. GitHub Copilot Provider", () => {
		const copilotFixtureDir = path.join(HARNESSES_DIR, "copilot");
		const mockCopilotPaths = createStagedIdePaths("copilot", copilotFixtureDir);

		test("isAvailable returns true when fixture files exist", async () => {
			const provider = new CopilotProvider();
			const isAvail = await provider.isAvailable(mockCopilotPaths);
			expect(isAvail).toBe(true);
		});

		test("discoverSessions detects workspace chat session files", async () => {
			const provider = new CopilotProvider();
			const sessions = await provider.discoverSessions(mockCopilotPaths);
			expect(sessions.length).toBeGreaterThanOrEqual(1);

			const sess = sessions.find((s) => s.sessionId === "copilot-sess-1");
			expect(sess).toBeDefined();
			expect(sess?.harness).toBe("copilot");
			expect(sess?.mtimeMs).toBe(1773500100000);
		});

		test("readUsage parses chat session requests with token estimation", async () => {
			const provider = new CopilotProvider();
			const usage = await provider.readUsage(mockCopilotPaths);
			expect(usage.available).toBe(true);
			expect(usage.harness).toBe("copilot");
			expect(usage.records.length).toBeGreaterThanOrEqual(1);

			const rec = usage.records.find((r) => r.sessionId === "copilot-sess-1");
			expect(rec).toBeDefined();
			expect(rec?.model).toBe("copilot/gpt-4o");
			expect(rec?.inputTokens).toBeGreaterThan(0);
			expect(rec?.outputTokens).toBeGreaterThan(0);
			expect(rec?.costUsd).toBeNull();
			expect(rec?.costEstimated).toBe(false);
			expect(usage.messages.get("copilot-sess-1")).toBe(1);
		});

		test("readTranscript reconstructs chat requests and responses", async () => {
			const provider = new CopilotProvider();
			const transcript = await provider.readTranscript(
				mockCopilotPaths,
				"copilot-sess-1",
			);
			expect(transcript).not.toBeNull();
			expect(transcript?.sessionId).toBe("copilot-sess-1");
			expect(transcript?.harness).toBe("copilot");
			expect(transcript?.items.length).toBe(2);

			expect(transcript?.items[0]?.role).toBe("user");
			expect(transcript?.items[0]?.text).toBe("Write a binary search function");

			expect(transcript?.items[1]?.role).toBe("assistant");
			expect(transcript?.items[1]?.text).toContain("function binarySearch");
		});

		test("getWatchPaths and computeFingerprint operate cleanly", async () => {
			const provider = new CopilotProvider();
			const watchPaths = provider.getWatchPaths(mockCopilotPaths);
			expect(watchPaths.length).toBeGreaterThan(0);

			const fp = await provider.computeFingerprint(mockCopilotPaths);
			expect(fp).toMatch(/^v12:\d+:[0-9a-f]{64}$/);
		});
	});

	// =========================================================================
	// 5. Cross-Platform Path Handling (Darwin, Linux, Win32)
	// =========================================================================
	describe("5. Cross-Platform Path Resolution & Sandboxing", () => {
		test("Cursor resolves correct OS paths across macOS, Linux, and Windows", () => {
			// Darwin
			const darwinEnv = createMockEnv("darwin", "/mock/darwin");
			const darwinPaths = new DefaultPlatformPathService(darwinEnv);
			const darwinRoots = darwinPaths.resolveHarnessPaths("cursor");
			expect(darwinRoots[0]).toContain(
				"Library/Application Support/Cursor/User/globalStorage",
			);

			// Linux
			const linuxEnv = createMockEnv("linux", "/mock/linux");
			const linuxPaths = new DefaultPlatformPathService(linuxEnv);
			const linuxRoots = linuxPaths.resolveHarnessPaths("cursor");
			expect(linuxRoots[0]).toContain(".config/Cursor/User/globalStorage");

			// Windows
			const winEnv = createMockEnv("win32", "C:\\mock\\win");
			const winPaths = new DefaultPlatformPathService(winEnv);
			const winRoots = winPaths.resolveHarnessPaths("cursor");
			expect(winRoots[0]).toContain(
				"AppData/Roaming/Cursor/User/globalStorage",
			);
		});

		test("Windsurf resolves correct OS paths across platforms", () => {
			const darwinEnv = createMockEnv("darwin", "/mock/darwin");
			const darwinPaths = new DefaultPlatformPathService(darwinEnv);
			const darwinRoots = darwinPaths.resolveHarnessPaths("windsurf");
			expect(darwinRoots[0]).toContain(".codeium");
			expect(darwinRoots[1]).toContain(".windsurf");

			const winEnv = createMockEnv("win32", "C:\\mock\\win");
			const winPaths = new DefaultPlatformPathService(winEnv);
			const winRoots = winPaths.resolveHarnessPaths("windsurf");
			expect(winRoots[2]).toContain(
				"AppData/Roaming/Windsurf/User/globalStorage",
			);
		});

		test("Copilot resolves correct workspaceStorage across platforms", () => {
			const darwinEnv = createMockEnv("darwin", "/mock/darwin");
			const darwinPaths = new DefaultPlatformPathService(darwinEnv);
			const darwinRoots = darwinPaths.resolveHarnessPaths("copilot");
			expect(darwinRoots[0]).toContain(
				"Library/Application Support/Code/User/workspaceStorage",
			);

			const winEnv = createMockEnv("win32", "C:\\mock\\win");
			const winPaths = new DefaultPlatformPathService(winEnv);
			const winRoots = winPaths.resolveHarnessPaths("copilot");
			expect(winRoots[0]).toContain(
				"AppData/Roaming/Code/User/workspaceStorage",
			);
		});

		test("Dynamic synthetic sandbox execution on Windows mock environment", async () => {
			const sandbox = createSandboxEnvironment("win32");
			try {
				const cursorGlobalDir = path.join(
					sandbox.configDir,
					"Cursor",
					"User",
					"globalStorage",
				);
				mkdirSync(cursorGlobalDir, { recursive: true });

				// Seed SQLite DB
				const db = seedCursorDb(path.join(cursorGlobalDir, "state.vscdb"), {
					composers: [
						{
							composerId: "win-test-comp",
							createdAt: 1774000000000,
							unifiedMode: "agent",
							modelName: "gpt-4o",
							text: "Windows integration test prompt",
							conversationMap: {
								b1: { type: "user", text: "Windows integration test prompt" },
								b2: {
									type: "ai",
									text: "Running on Windows filesystem mock",
									tokenUsage: { inputTokens: 1500, outputTokens: 250 },
								},
							},
						},
					],
				});
				db.close();

				const winPathService = new DefaultPlatformPathService(sandbox.provider);
				const cursorProvider = new CursorProvider();

				const isAvail = await cursorProvider.isAvailable(winPathService);
				expect(isAvail).toBe(true);

				const sessions = await cursorProvider.discoverSessions(winPathService);
				expect(sessions.length).toBe(1);
				expect(sessions[0]?.sessionId).toBe("win-test-comp");

				const usage = await cursorProvider.readUsage(winPathService);
				expect(usage.records.length).toBe(1);
				expect(usage.records[0]?.model).toBe("gpt-4o");
				expect(usage.records[0]?.inputTokens).toBe(1500);
				expect(usage.records[0]?.outputTokens).toBe(250);

				const transcript = await cursorProvider.readTranscript(
					winPathService,
					"win-test-comp",
				);
				expect(transcript).not.toBeNull();
				expect(transcript?.items.length).toBe(2);
			} finally {
				sandbox.cleanup();
			}
		});
	});

	// =========================================================================
	// 6. SQLite Safety & EBUSY / WAL Locks
	// =========================================================================
	describe("6. SQLite Safety & Lock Resilience", () => {
		test("openSafeReadonlyDatabase successfully opens databases with WAL and journal sidecars", () => {
			const tmpDir = path.join(
				os.tmpdir(),
				`sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			);
			mkdirSync(tmpDir, { recursive: true });

			const dbPath = path.join(tmpDir, "test-wal.vscdb");
			const walPath = path.join(tmpDir, "test-wal.vscdb-wal");

			const db = seedCursorDb(dbPath, {
				composers: [
					{
						composerId: "wal-comp-1",
						createdAt: 1775000000000,
						unifiedMode: "agent",
					},
				],
			});
			db.close();

			// Create dummy non-empty WAL sidecar
			writeFileSync(walPath, Buffer.alloc(32));

			const handle = openSafeReadonlyDatabase(dbPath);
			expect(handle.db).toBeDefined();
			const row = handle.db
				.query<{ key: string }, []>(
					"SELECT key FROM cursorDiskKV WHERE key = 'composerData:wal-comp-1'",
				)
				.get();
			expect(row?.key).toBe("composerData:wal-comp-1");
			handle.close();

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	// =========================================================================
	// 7. Registry Integration
	// =========================================================================
	describe("7. Registry Integration & Dynamic Registration", () => {
		test("Cursor, Windsurf, and Copilot register dynamically and are discoverable", () => {
			const registry = new DefaultHarnessRegistry();

			registry.register(new CursorProvider());
			registry.register(new WindsurfProvider());
			registry.register(new CopilotProvider());

			expect(registry.has("cursor")).toBe(true);
			expect(registry.has("windsurf")).toBe(true);
			expect(registry.has("copilot")).toBe(true);

			expect(registry.get("CURSOR")?.metadata.displayName).toBe("Cursor");
			expect(registry.get("WindSurf")?.metadata.displayName).toBe("Windsurf");
			expect(registry.get("CoPiLoT")?.metadata.displayName).toBe(
				"GitHub Copilot",
			);
		});
	});

	// =========================================================================
	// 8. Edge Cases, Resiliency & Hardening
	// =========================================================================
	describe("8. Edge Cases, Resiliency & Hardening", () => {
		test("CursorProvider handles corrupted or empty JSON in composerData gracefully", async () => {
			const tmpDir = path.join(
				suiteTmp,
				`cursor-corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			);
			const mockPaths = createIsolatedPaths(tmpDir);
			const gStorage = mockPaths.resolveHarnessPaths("cursor")[0];
			if (!gStorage) throw new Error("Missing cursor globalStorage path");
			mkdirSync(gStorage, { recursive: true });

			const db = seedCursorDb(path.join(gStorage, "state.vscdb"), {
				composers: [],
			});
			db.run(
				"INSERT INTO cursorDiskKV (key, value) VALUES ('composerData:bad-1', 'not valid json');",
			);
			db.close();

			const provider = new CursorProvider();
			const usage = await provider.readUsage(mockPaths);
			expect(usage.available).toBe(true);
			expect(usage.records.length).toBe(0); // Safely skipped malformed JSON

			rmSync(tmpDir, { recursive: true, force: true });
		});

		test("WindsurfProvider handles truncated or corrupted Protobuf safely", async () => {
			const tmpDir = path.join(
				suiteTmp,
				`windsurf-corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			);
			const mockPaths = createIsolatedPaths(tmpDir);
			const chatDir = path.join(
				mockPaths.resolveHarnessPaths("windsurf")[0] ?? "",
				"chat_state",
			);
			mkdirSync(chatDir, { recursive: true });

			writeFileSync(
				path.join(chatDir, "codeium_chat_state_file_corrupt.pb"),
				Buffer.from([0x08, 0xff, 0xff]), // Malformed varint/wire
			);

			const provider = new WindsurfProvider();
			const usage = await provider.readUsage(mockPaths);
			expect(Array.isArray(usage.records)).toBe(true);

			rmSync(tmpDir, { recursive: true, force: true });
		});

		test("CopilotProvider parses standalone CLI logs and toolCallRounds in chat", async () => {
			const tmpDir = path.join(
				suiteTmp,
				`copilot-tools-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			);
			const mockPaths = createIsolatedPaths(tmpDir);
			const wsRoot = mockPaths.resolveHarnessPaths("copilot")[0];
			if (!wsRoot) throw new Error("Missing copilot workspaceStorage path");
			const chatDir = path.join(wsRoot, "chatSessions");
			const logsDir = path.join(wsRoot, "logs");
			mkdirSync(chatDir, { recursive: true });
			mkdirSync(logsDir, { recursive: true });

			// 1. Chat with tool call rounds
			writeFileSync(
				path.join(chatDir, "copilot-tool-sess.json"),
				JSON.stringify({
					version: 3,
					sessionId: "copilot-tool-sess",
					creationDate: 1774000000000,
					requests: [
						{
							timestamp: 1774000010000,
							modelId: "copilot/claude-3.5-sonnet",
							message: { text: "List directory files" },
							response: [{ value: "Here are the files: a.ts, b.ts" }],
							result: {
								metadata: {
									toolCallRounds: [
										{
											toolCalls: [
												{
													name: "list_dir",
													input: { path: "." },
													result: { files: ["a.ts", "b.ts"] },
												},
											],
										},
									],
								},
							},
						},
					],
				}),
			);

			// 2. CLI log
			writeFileSync(
				path.join(logsDir, "process-1234.log"),
				"2026-03-15T12:00:00.000Z [INFO] Copilot agent started\n2026-03-15T12:00:05.000Z [INFO] Request completed\n",
			);

			const provider = new CopilotProvider();
			const usage = await provider.readUsage(mockPaths);
			expect(usage.records.length).toBe(2);

			const transcript = await provider.readTranscript(
				mockPaths,
				"copilot-tool-sess",
			);
			expect(transcript).not.toBeNull();
			// Should contain user message, tool call, and assistant message
			expect(transcript?.items.length).toBe(3);
			expect(transcript?.items.some((i) => i.kind === "tool_call")).toBe(true);

			rmSync(tmpDir, { recursive: true, force: true });
		});

		test("WindsurfProvider decodes multi-turn interaction with cache tokens and reasoning", async () => {
			const tmpDir = path.join(
				suiteTmp,
				`windsurf-multiturn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			);
			const mockPaths = createIsolatedPaths(tmpDir);
			const chatDir = path.join(
				mockPaths.resolveHarnessPaths("windsurf")[0] ?? "",
				"chat_state",
			);
			mkdirSync(chatDir, { recursive: true });

			const blob = buildWindsurfChatStateBlob({
				conversationId: "windsurf-multi-1",
				model: "claude-3-7-sonnet",
				prompt: "Perform deep architectural analysis",
				completion: "Here is the comprehensive analysis...",
				inputTokens: 5000,
				outputTokens: 1200,
				timestamp: 1774500000,
			});

			writeFileSync(
				path.join(chatDir, "codeium_chat_state_file_Users_alice_project.pb"),
				blob,
			);

			const provider = new WindsurfProvider();
			const sessions = await provider.discoverSessions(mockPaths);
			expect(sessions.length).toBe(1);
			expect(sessions[0]?.cwd).toBe("/Users/alice/project");

			const usage = await provider.readUsage(mockPaths, sessions[0]);
			expect(usage.records.length).toBe(1);
			expect(usage.records[0]?.inputTokens).toBe(5000);
			expect(usage.records[0]?.outputTokens).toBe(1200);
			expect(usage.records[0]?.model).toBe("claude-3-7-sonnet");

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});
});
