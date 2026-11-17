import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { openSafeReadonlyDatabase } from "../../../src/platform/sqlite";
import { AiderProvider } from "../../../src/providers/aider";
import { ClaudeProvider } from "../../../src/providers/claude";
import { ClineProvider } from "../../../src/providers/cline";
import { ContinueProvider } from "../../../src/providers/continue";
import { CopilotProvider } from "../../../src/providers/copilot";
import { CursorProvider } from "../../../src/providers/cursor";
import { GooseProvider } from "../../../src/providers/goose";
import { OpenHandsProvider } from "../../../src/providers/openhands";
import { RooProvider } from "../../../src/providers/roo";
import { WindsurfProvider } from "../../../src/providers/windsurf";
import {
	protoBytes,
	protoConcat,
	protoVarint,
} from "../../fixtures/helpers/protobuf-builder";
import {
	createDatabase,
	seedContinueDb,
	seedCursorDb,
	seedGooseDb,
} from "../../fixtures/helpers/sqlite-fixtures";

const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");
const HARNESSES_DIR = path.join(FIXTURES_DIR, "harnesses");

describe("Milestone 3 Mainstream Providers Suite (100 Tests: Features 11-20)", () => {
	const suiteTmp = path.join(
		os.tmpdir(),
		`ct-mainstream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	beforeAll(() => {
		mkdirSync(suiteTmp, { recursive: true });
	});

	afterAll(() => {
		try {
			rmSync(suiteTmp, { recursive: true, force: true });
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
	// 1. Claude Code Provider (Feature 11)
	// =========================================================================
	describe("1. Claude Code Provider (Feature 11)", () => {
		const claudeFixtureDir = path.join(HARNESSES_DIR, "claude");

		test("F11-T1-01: Metadata Integrity", () => {
			const provider = new ClaudeProvider();
			expect(provider.metadata.id).toBe("claude");
			expect(provider.metadata.displayName).toBe("Claude Code");
			expect(provider.metadata.shortLabel).toBe("Claude");
			expect(provider.metadata.color).toBeDefined();
			expect(provider.metadata.defaultEnabled).toBe(true);
		});

		test("F11-T1-02: Availability Detection", async () => {
			const provider = new ClaudeProvider();
			const activePaths = makePaths(suiteTmp, {
				CLAUDE_CONFIG_DIR: claudeFixtureDir,
			});
			expect(await provider.isAvailable(activePaths)).toBe(true);

			const emptyPaths = makePaths(path.join(suiteTmp, "empty-claude"));
			expect(await provider.isAvailable(emptyPaths)).toBe(false);
		});

		test("F11-T1-03: Session Discovery", async () => {
			const provider = new ClaudeProvider();
			const paths = makePaths(suiteTmp, {
				CLAUDE_CONFIG_DIR: claudeFixtureDir,
			});
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			const sample = sessions.find(
				(s) =>
					s.filePath.includes("ceda31df") || s.sessionId === "claude-sess-1",
			);
			expect(sample).toBeDefined();
			expect(sample?.harness).toBe("claude");
		});

		test("F11-T1-04: Usage & Token Extraction", async () => {
			const provider = new ClaudeProvider();
			const paths = makePaths(suiteTmp, {
				CLAUDE_CONFIG_DIR: claudeFixtureDir,
			});
			const sessions = await provider.discoverSessions(paths);
			const session = sessions.find(
				(s) =>
					s.filePath.includes("ceda31df") || s.sessionId === "claude-sess-1",
			);
			expect(session).toBeDefined();

			if (!session) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, session);
			expect(usage.records.length).toBeGreaterThan(0);
			const rec = usage.records[0];
			if (!rec) throw new Error("Expected usage record");
			expect(rec.inputTokens).toBe(1500);
			expect(rec.outputTokens).toBe(450);
			expect(rec.cacheReadTokens).toBe(8000);
			expect(rec.cacheWriteTokens).toBe(1200);
			expect(rec.model).toContain("claude-3-7-sonnet");
		});

		test("F11-T1-05: Transcript Reconstruction", async () => {
			const provider = new ClaudeProvider();
			const paths = makePaths(suiteTmp, {
				CLAUDE_CONFIG_DIR: claudeFixtureDir,
			});
			const transcript = await provider.readTranscript(
				paths,
				"ceda31df-a9d4-4ab8-9409-3f3ac444b272",
			);
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThanOrEqual(2);
			const userMsg = transcript?.items.find((i) => i.role === "user");
			expect(userMsg?.text).toContain("Implement the login endpoint");
			const assistantMsg = transcript?.items.find(
				(i) => i.role === "assistant",
			);
			expect(assistantMsg?.text).toContain("I will create auth.ts.");
		});

		test("F11-T2-01: Corrupted JSONL Recovery", async () => {
			const provider = new ClaudeProvider();
			const corruptedDir = path.join(
				suiteTmp,
				"claude-corrupt",
				".claude",
				"projects",
				"sample",
			);
			mkdirSync(corruptedDir, { recursive: true });
			const corruptedSrc = path.join(
				claudeFixtureDir,
				"boundary-corrupted.jsonl",
			);
			writeFileSync(
				path.join(corruptedDir, "corrupted-sess.jsonl"),
				readFileSync(corruptedSrc),
			);

			const paths = makePaths(path.join(suiteTmp, "claude-corrupt"));
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			const usage = await provider.readUsage(paths, sessions[0]);
			expect(usage.records.length).toBeGreaterThanOrEqual(1);
		});

		test("F11-T2-02: Zero-Byte Session Handling", async () => {
			const provider = new ClaudeProvider();
			const emptyDir = path.join(
				suiteTmp,
				"claude-empty",
				".claude",
				"projects",
				"sample",
			);
			mkdirSync(emptyDir, { recursive: true });
			writeFileSync(path.join(emptyDir, "empty-sess.jsonl"), "");

			const paths = makePaths(path.join(suiteTmp, "claude-empty"));
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			const usage = await provider.readUsage(paths, sessions[0]);
			expect(usage.records.length).toBe(0);
		});

		test("F11-T2-03: Anthropic Prompt Cache Hit Semantics", async () => {
			const provider = new ClaudeProvider();
			const paths = makePaths(suiteTmp, {
				CLAUDE_CONFIG_DIR: claudeFixtureDir,
			});
			const sessions = await provider.discoverSessions(paths);
			const session = sessions.find((s) => s.sessionId.includes("ceda31df"));
			const usage = await provider.readUsage(paths, session);
			const rec = usage.records[0];
			if (!rec) throw new Error("Expected usage record");
			// Uncached input must not be subtracted by cacheRead
			expect(rec.inputTokens).toBe(1500);
			expect(rec.cacheReadTokens).toBe(8000);
		});

		test("F11-T2-04: Subagent Hierarchy Discovery", async () => {
			const provider = new ClaudeProvider();
			const subDir = path.join(
				suiteTmp,
				"claude-sub",
				".claude",
				"projects",
				"proj",
				"main-sess",
				"subagents",
			);
			mkdirSync(subDir, { recursive: true });
			const subSessionFile = path.join(subDir, "sub-agent-1.jsonl");
			writeFileSync(
				subSessionFile,
				`${JSON.stringify({
					type: "assistant",
					sessionId: "sub-agent-1",
					parentUuid: "p1",
					message: {
						id: "sub-m1",
						role: "assistant",
						model: "claude-3-5-haiku",
						content: [{ type: "text", text: "Subagent running task." }],
						usage: { input_tokens: 300, output_tokens: 80 },
					},
				})}\n`,
			);

			const paths = makePaths(path.join(suiteTmp, "claude-sub"));
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			const sub = sessions.find((s) => s.sessionId.includes("sub-agent-1"));
			expect(sub).toBeDefined();
		});

		test("F11-T2-05: Windows Drive Letter Path Encoding", async () => {
			const provider = new ClaudeProvider();
			const winDir = path.join(
				suiteTmp,
				"claude-win",
				".claude",
				"projects",
				"C-Users-testuser-Code-Project",
			);
			mkdirSync(winDir, { recursive: true });
			writeFileSync(
				path.join(winDir, "sess-win.jsonl"),
				`${JSON.stringify({
					type: "user",
					sessionId: "sess-win",
					message: {
						role: "user",
						content: [{ type: "text", text: "Win query" }],
					},
				})}\n`,
			);

			const paths = makePaths(path.join(suiteTmp, "claude-win"));
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.cwd).toBeDefined();
		});
	});

	// =========================================================================
	// 2. Cline Provider (Feature 12)
	// =========================================================================
	describe("2. Cline Provider (Feature 12)", () => {
		const clineFixtureDir = path.join(HARNESSES_DIR, "cline");

		test("F12-T1-01: Metadata Integrity", () => {
			const provider = new ClineProvider();
			expect(provider.metadata.id).toBe("cline");
			expect(provider.metadata.displayName).toBe("Cline");
			expect(provider.metadata.shortLabel).toBe("Cline");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F12-T1-02: Multi-Path Availability", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-avail");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(path.join(codeStorage, "taskHistory.json"), "[]");

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F12-T1-03: Session Discovery", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-disc");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				readFileSync(path.join(clineFixtureDir, "taskHistory.json")),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.sessionId).toBe("task-cline-101");
		});

		test("F12-T1-04: Per-Request Telemetry Parsing", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-telemetry");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
			);
			const taskDir = path.join(codeStorage, "tasks", "task-cline-101");
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				readFileSync(path.join(clineFixtureDir, "taskHistory.json")),
			);
			writeFileSync(
				path.join(taskDir, "ui_messages.json"),
				readFileSync(
					path.join(
						clineFixtureDir,
						"tasks",
						"task-cline-101",
						"ui_messages.json",
					),
				),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const firstSession = sessions[0];
			if (!firstSession) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, firstSession);
			expect(usage.records.length).toBeGreaterThan(0);
			const rec = usage.records[0];
			if (!rec) throw new Error("Expected usage record");
			expect(rec.inputTokens).toBe(12500);
			expect(rec.outputTokens).toBe(850);
			expect(rec.cacheReadTokens).toBe(6000);
			expect(rec.cacheWriteTokens).toBe(500);
		});

		test("F12-T1-05: Transcript Turn Reconstruction", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-transcript");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
			);
			const taskDir = path.join(codeStorage, "tasks", "task-cline-101");
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, "ui_messages.json"),
				readFileSync(
					path.join(
						clineFixtureDir,
						"tasks",
						"task-cline-101",
						"ui_messages.json",
					),
				),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "task-cline-101");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThanOrEqual(2);
		});

		test("F12-T2-01: Zero-Token Turn Telemetry", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-zero");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
			);
			const taskDir = path.join(codeStorage, "tasks", "boundary-zero-tokens");
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, "ui_messages.json"),
				readFileSync(
					path.join(
						clineFixtureDir,
						"tasks",
						"boundary-zero-tokens",
						"ui_messages.json",
					),
				),
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths, {
				harness: "cline",
				sessionId: "boundary-zero-tokens",
				filePath: path.join(taskDir, "ui_messages.json"),
				mtimeMs: Date.now(),
				sizeBytes: 100,
				cwd: "/workspace",
			});
			expect(usage).toBeDefined();
		});

		test("F12-T2-02: Missing ui_messages.json Fallback", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-fallback");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				readFileSync(path.join(clineFixtureDir, "taskHistory.json")),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			const firstSession = sessions[0];
			if (!firstSession) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, firstSession);
			expect(usage.records.length).toBeGreaterThan(0);
		});

		test("F12-T2-03: Malformed Inner JSON in api_req_started", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-malformed");
			const taskDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
				"tasks",
				"t-bad",
			);
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, "ui_messages.json"),
				JSON.stringify([
					{ type: "say", say: "api_req_started", text: "{not-valid-json..." },
				]),
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths, {
				harness: "cline",
				sessionId: "t-bad",
				filePath: path.join(taskDir, "ui_messages.json"),
				mtimeMs: Date.now(),
				sizeBytes: 100,
				cwd: "/workspace",
			});
			expect(usage).toBeDefined();
		});

		test("F12-T2-04: Orphaned Task Directories", async () => {
			const provider = new ClineProvider();
			const mockHome = path.join(suiteTmp, "cline-orphan");
			const taskDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
				"tasks",
				"task-orphan-99",
			);
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, "task_metadata.json"),
				JSON.stringify({ id: "task-orphan-99" }),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.some((s) => s.sessionId === "task-orphan-99")).toBe(true);
		});

		test("F12-T2-05: Cross-Platform Path Handling", async () => {
			const provider = new ClineProvider();
			const linuxHome = path.join(suiteTmp, "cline-linux");
			const linuxStorage = path.join(
				linuxHome,
				".config",
				"Code",
				"User",
				"globalStorage",
				"saoudrizwan.claude-dev",
			);
			mkdirSync(linuxStorage, { recursive: true });
			writeFileSync(path.join(linuxStorage, "taskHistory.json"), "[]");

			const paths = makePaths(linuxHome, {}, "linux");
			expect(await provider.isAvailable(paths)).toBe(true);
		});
	});

	// =========================================================================
	// 3. Roo Code Provider (Feature 13)
	// =========================================================================
	describe("3. Roo Code Provider (Feature 13)", () => {
		const rooFixtureDir = path.join(HARNESSES_DIR, "roo");

		test("F13-T1-01: Metadata Integrity", () => {
			const provider = new RooProvider();
			expect(provider.metadata.id).toBe("roo");
			expect(provider.metadata.displayName).toBe("Roo Code");
			expect(provider.metadata.shortLabel).toBe("Roo");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F13-T1-02: Extension Directory Availability", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-avail");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(path.join(codeStorage, "taskHistory.json"), "[]");

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F13-T1-03: Mode-Aware Discovery", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-disc");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				readFileSync(path.join(rooFixtureDir, "taskHistory.json")),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThanOrEqual(2);
			expect(sessions.some((s) => s.sessionId === "task-roo-101")).toBe(true);
			expect(sessions.some((s) => s.sessionId === "task-roo-102")).toBe(true);
		});

		test("F13-T1-04: Mode-Aware Usage Parsing", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-usage");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				readFileSync(path.join(rooFixtureDir, "taskHistory.json")),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const session = sessions.find((s) => s.sessionId === "task-roo-101");
			expect(session).toBeDefined();

			if (!session) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, session);
			expect(usage.records.length).toBeGreaterThan(0);
			expect(usage.records[0]?.inputTokens).toBe(50000);
			expect(usage.records[0]?.outputTokens).toBe(4500);
		});

		test("F13-T1-05: Transcript Reconstruction", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-transcript");
			const taskDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
				"tasks",
				"task-roo-101",
			);
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, "ui_messages.json"),
				JSON.stringify([
					{
						type: "say",
						say: "user_feedback",
						text: "Design microservices architecture",
					},
					{
						type: "say",
						say: "text",
						text: "Here is the architectural diagram.",
					},
				]),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "task-roo-101");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThanOrEqual(2);
		});

		test("F13-T2-01: Custom Mode Resilience", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-custom-mode");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				JSON.stringify([
					{
						id: "task-custom-mode",
						ts: Date.now(),
						task: "Custom mode task",
						mode: "super-architect-v9",
						tokensIn: 1000,
						tokensOut: 200,
					},
				]),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBe(1);
		});

		test("F13-T2-02: Multi-Mode Switching within Task", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-multimode");
			const taskDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
				"tasks",
				"t-multi",
			);
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, "ui_messages.json"),
				JSON.stringify([
					{ type: "say", say: "mode_switched", text: "architect" },
					{ type: "say", say: "text", text: "Plan outline" },
					{ type: "say", say: "mode_switched", text: "code" },
					{ type: "say", say: "text", text: "Implementation code" },
				]),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "t-multi");
			expect(transcript).not.toBeNull();
		});

		test("F13-T2-03: Legacy Session without Mode", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-legacy");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
			);
			mkdirSync(codeStorage, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				JSON.stringify([
					{ id: "t-legacy", ts: Date.now(), task: "Old format task" },
				]),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBe(1);
		});

		test("F13-T2-04: Corrupted taskHistory.json", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-corrupt");
			const codeStorage = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
			);
			const taskDir = path.join(codeStorage, "tasks", "task-recovered");
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(codeStorage, "taskHistory.json"),
				"{invalid-json-content...",
			);
			writeFileSync(
				path.join(taskDir, "task_metadata.json"),
				JSON.stringify({ id: "task-recovered" }),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.some((s) => s.sessionId === "task-recovered")).toBe(true);
		});

		test("F13-T2-05: Partial Task Missing task_metadata.json", async () => {
			const provider = new RooProvider();
			const mockHome = path.join(suiteTmp, "roo-partial");
			const taskDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"rooveterinaryinc.roo-cline",
				"tasks",
				"t-partial",
			);
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(
				path.join(taskDir, "ui_messages.json"),
				JSON.stringify([
					{
						type: "say",
						say: "api_req_started",
						text: JSON.stringify({ tokensIn: 400, tokensOut: 100 }),
					},
				]),
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths, {
				harness: "roo",
				sessionId: "t-partial",
				filePath: path.join(taskDir, "ui_messages.json"),
				mtimeMs: Date.now(),
				sizeBytes: 100,
				cwd: "/workspace",
			});
			expect(usage.records.length).toBeGreaterThan(0);
		});
	});

	// =========================================================================
	// 4. Continue Provider (Feature 14)
	// =========================================================================
	describe("4. Continue Provider (Feature 14)", () => {
		const continueFixtureDir = path.join(HARNESSES_DIR, "continue");

		test("F14-T1-01: Metadata Integrity", () => {
			const provider = new ContinueProvider();
			expect(provider.metadata.id).toBe("continue");
			expect(provider.metadata.displayName).toBe("Continue");
			expect(provider.metadata.shortLabel).toBe("Cont");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F14-T1-02: Global Directory Availability", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-avail");
			mkdirSync(path.join(mockHome, ".continue", "sessions"), {
				recursive: true,
			});
			writeFileSync(
				path.join(mockHome, ".continue", "sessions", "sessions.json"),
				"[]",
			);

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F14-T1-03: Session Discovery", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-disc");
			mkdirSync(path.join(mockHome, ".continue", "sessions"), {
				recursive: true,
			});
			writeFileSync(
				path.join(mockHome, ".continue", "sessions", "sessions.json"),
				readFileSync(
					path.join(continueFixtureDir, "sessions", "sessions.json"),
				),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.sessionId).toBe("cont-sess-01");
			expect(sessions[0]?.cwd).toBe("/workspace/project-alpha");
		});

		test("F14-T1-04: Token Stream Extraction", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-tokens");
			mkdirSync(path.join(mockHome, ".continue", "dev_data"), {
				recursive: true,
			});
			writeFileSync(
				path.join(mockHome, ".continue", "dev_data", "tokensGenerated.jsonl"),
				readFileSync(
					path.join(continueFixtureDir, "dev_data", "tokensGenerated.jsonl"),
				),
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths);
			expect(usage.records.length).toBeGreaterThanOrEqual(2);
			const first = usage.records[0];
			if (!first) throw new Error("Expected usage record");
			expect(first.inputTokens).toBe(2500);
			expect(first.outputTokens).toBe(600);
			expect(first.model).toBe("gpt-4o");
		});

		test("F14-T1-05: Transcript History Reconstruction", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-transcript");
			const sessDir = path.join(mockHome, ".continue", "sessions");
			mkdirSync(sessDir, { recursive: true });
			writeFileSync(
				path.join(sessDir, "cont-sess-01.json"),
				readFileSync(
					path.join(continueFixtureDir, "sessions", "cont-sess-01.json"),
				),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "cont-sess-01");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThan(0);
		});

		test("F14-T2-01: SQLite Fallback Storage", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-sqlite");
			const devDataDir = path.join(mockHome, ".continue", "dev_data");
			mkdirSync(devDataDir, { recursive: true });
			seedContinueDb(path.join(devDataDir, "devdata.sqlite"));

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths);
			expect(usage.records.length).toBeGreaterThan(0);
		});

		test("F14-T2-02: Malformed JSONL Line Handling", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-malformed");
			const devDataDir = path.join(mockHome, ".continue", "dev_data");
			mkdirSync(devDataDir, { recursive: true });
			const lines = [
				JSON.stringify({
					eventName: "tokensGenerated",
					promptTokens: 100,
					generatedTokens: 20,
				}),
				"{truncated-bad-json...",
				JSON.stringify({
					eventName: "tokensGenerated",
					promptTokens: 200,
					generatedTokens: 40,
				}),
			];
			writeFileSync(
				path.join(devDataDir, "tokensGenerated.jsonl"),
				lines.join("\n"),
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths);
			expect(usage.records.length).toBe(2);
		});

		test("F14-T2-03: URL-Encoded Workspace URI", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-url-decode");
			const sessDir = path.join(mockHome, ".continue", "sessions");
			mkdirSync(sessDir, { recursive: true });
			writeFileSync(
				path.join(sessDir, "sessions.json"),
				JSON.stringify([
					{
						sessionId: "s-space",
						workspaceDirectory: "file:///Users/user/My%20Projects/App%231",
					},
				]),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions[0]?.cwd).toBe("/Users/user/My Projects/App#1");
		});

		test("F14-T2-04: Empty Session Catalog", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-empty-catalog");
			const sessDir = path.join(mockHome, ".continue", "sessions");
			mkdirSync(sessDir, { recursive: true });
			writeFileSync(path.join(sessDir, "sessions.json"), "[]");
			writeFileSync(
				path.join(sessDir, "stray-session.json"),
				JSON.stringify({ sessionId: "stray-1", history: [] }),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(
				sessions.some(
					(s) => s.sessionId === "stray-1" || s.sessionId === "stray-session",
				),
			).toBe(true);
		});

		test("F14-T2-05: Versioned DevData Subdirectory Support", async () => {
			const provider = new ContinueProvider();
			const mockHome = path.join(suiteTmp, "cont-versioned");
			const versionedDir = path.join(
				mockHome,
				".continue",
				"dev_data",
				"0.2.0",
			);
			mkdirSync(versionedDir, { recursive: true });
			writeFileSync(
				path.join(versionedDir, "tokensGenerated.jsonl"),
				`${JSON.stringify({
					eventName: "tokensGenerated",
					promptTokens: 300,
					generatedTokens: 50,
				})}\n`,
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths);
			expect(usage.records.length).toBeGreaterThan(0);
		});
	});

	// =========================================================================
	// 5. Cursor Provider (Feature 15)
	// =========================================================================
	describe("5. Cursor Provider (Feature 15)", () => {
		const cursorFixtureDir = path.join(HARNESSES_DIR, "cursor");

		test("F15-T1-01: Metadata Integrity", () => {
			const provider = new CursorProvider();
			expect(provider.metadata.id).toBe("cursor");
			expect(provider.metadata.displayName).toBe("Cursor");
			expect(provider.metadata.shortLabel).toBe("Cur");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F15-T1-02: User Storage Availability", async () => {
			const provider = new CursorProvider();
			const mockHome = path.join(suiteTmp, "cursor-avail");
			const globalDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Cursor",
				"User",
				"globalStorage",
			);
			mkdirSync(globalDir, { recursive: true });
			createDatabase(path.join(globalDir, "state.vscdb"));

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F15-T1-03: Session Discovery & Workspace Mapping", async () => {
			const provider = new CursorProvider();
			const mockHome = path.join(suiteTmp, "cursor-disc");
			const wsDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Cursor",
				"User",
				"workspaceStorage",
				"2ee3deeb64ace8c807fd30c35b249ed0",
			);
			mkdirSync(wsDir, { recursive: true });
			writeFileSync(
				path.join(wsDir, "workspace.json"),
				JSON.stringify({ folder: "file:///workspace/my-cursor-app" }),
			);
			seedCursorDb(path.join(wsDir, "state.vscdb"));

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.cwd).toBe("/workspace/my-cursor-app");
		});

		test("F15-T1-04: Usage Extraction from cursorDiskKV", async () => {
			const provider = new CursorProvider();
			const mockHome = path.join(suiteTmp, "cursor-usage");
			const globalDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Cursor",
				"User",
				"globalStorage",
			);
			mkdirSync(globalDir, { recursive: true });
			seedCursorDb(path.join(globalDir, "state.vscdb"));

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths);
			expect(usage.records.length).toBeGreaterThan(0);
			const rec = usage.records[0];
			if (!rec) throw new Error("Expected usage record");
			expect(rec.inputTokens).toBeGreaterThan(0);
			expect(rec.outputTokens).toBeGreaterThan(0);
		});

		test("F15-T1-05: Transcript Reconstruction", async () => {
			const provider = new CursorProvider();
			const mockHome = path.join(suiteTmp, "cursor-transcript");
			const globalDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Cursor",
				"User",
				"globalStorage",
			);
			mkdirSync(globalDir, { recursive: true });
			seedCursorDb(path.join(globalDir, "state.vscdb"));

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(
				paths,
				"cursor-comp-default-1",
			);
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThan(0);
		});

		test("F15-T2-01: Readonly SQLite Concurrency", () => {
			const dbPath = path.join(
				cursorFixtureDir,
				"globalStorage",
				"state.vscdb",
			);
			expect(existsSync(dbPath)).toBe(true);
			const db = openSafeReadonlyDatabase(dbPath);
			expect(db).toBeDefined();
			const row = db.db
				.prepare("SELECT count(*) as count FROM cursorDiskKV")
				.get() as { count: number };
			expect(row.count).toBeGreaterThan(0);
			db.close();
		});

		test("F15-T2-02: Untitled / Orphaned Workspaces", async () => {
			const provider = new CursorProvider();
			const mockHome = path.join(suiteTmp, "cursor-orphaned");
			const wsDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Cursor",
				"User",
				"workspaceStorage",
				"hash-without-workspace-json",
			);
			mkdirSync(wsDir, { recursive: true });
			seedCursorDb(path.join(wsDir, "state.vscdb"));

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
		});

		test("F15-T2-03: Corrupted KV Value Handling", async () => {
			const provider = new CursorProvider();
			const mockHome = path.join(suiteTmp, "cursor-bad-kv");
			const globalDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Cursor",
				"User",
				"globalStorage",
			);
			mkdirSync(globalDir, { recursive: true });
			const db = createDatabase(path.join(globalDir, "state.vscdb"));
			db.run("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
			db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
				"composerData:corrupt-1",
				"{invalid-json-content...",
			]);
			db.close();

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths);
			expect(usage.records.length).toBe(0);
		});

		test("F15-T2-04: Empty Conversation Bubbles", async () => {
			const provider = new CursorProvider();
			const mockHome = path.join(suiteTmp, "cursor-empty-bubbles");
			const globalDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Cursor",
				"User",
				"globalStorage",
			);
			mkdirSync(globalDir, { recursive: true });
			const db = createDatabase(path.join(globalDir, "state.vscdb"));
			db.run("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
			db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
				"composerData:empty-1",
				JSON.stringify({ conversation: [] }),
			]);
			db.close();

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "empty-1");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBe(0);
		});

		test("F15-T2-05: Cross-Platform Path Detection", async () => {
			const provider = new CursorProvider();
			const winHome = path.join(suiteTmp, "cursor-win");
			const winGlobal = path.join(
				winHome,
				"AppData",
				"Roaming",
				"Cursor",
				"User",
				"globalStorage",
			);
			mkdirSync(winGlobal, { recursive: true });
			createDatabase(path.join(winGlobal, "state.vscdb"));

			const paths = makePaths(
				winHome,
				{ APPDATA: path.join(winHome, "AppData", "Roaming") },
				"win32",
			);
			expect(await provider.isAvailable(paths)).toBe(true);
		});
	});

	// =========================================================================
	// 6. GitHub Copilot Provider (Feature 16)
	// =========================================================================
	describe("6. GitHub Copilot Provider (Feature 16)", () => {
		const copilotFixtureDir = path.join(HARNESSES_DIR, "copilot");

		test("F16-T1-01: Metadata Integrity", () => {
			const provider = new CopilotProvider();
			expect(provider.metadata.id).toBe("copilot");
			expect(provider.metadata.displayName).toBe("GitHub Copilot");
			expect(provider.metadata.shortLabel).toBe("GH");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F16-T1-02: Workspace Storage Availability", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-avail");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(path.join(chatDir, "copilot-sess-1.json"), "{}");

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F16-T1-03: Session Discovery", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-disc");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "copilot-sess-1.json"),
				readFileSync(
					path.join(copilotFixtureDir, "chatSessions", "copilot-sess-1.json"),
				),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.sessionId).toBe("copilot-sess-1");
		});

		test("F16-T1-04: Turn Parsing", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-turns");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "copilot-sess-1.json"),
				readFileSync(
					path.join(copilotFixtureDir, "chatSessions", "copilot-sess-1.json"),
				),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const firstSession = sessions[0];
			if (!firstSession) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, firstSession);
			expect(usage.records.length).toBeGreaterThan(0);
			expect(usage.records[0]?.model).toBe("copilot/gpt-4o");
		});

		test("F16-T1-05: Transcript Reconstruction", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-trans");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "copilot-sess-1.json"),
				readFileSync(
					path.join(copilotFixtureDir, "chatSessions", "copilot-sess-1.json"),
				),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "copilot-sess-1");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThanOrEqual(2);
		});

		test("F16-T2-01: JSON vs JSONL Format Resilience", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-jsonl");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "session-line.jsonl"),
				`${JSON.stringify({
					requests: [
						{
							message: { text: "Explain quicksort" },
							response: [{ value: "Done" }],
						},
					],
				})}\n`,
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
		});

		test("F16-T2-02: Incomplete Turns (Pending Response)", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-incomplete");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "pending.json"),
				JSON.stringify({
					sessionId: "pending-1",
					requests: [{ message: { text: "Pending answer" }, response: [] }],
				}),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "pending-1");
			expect(transcript).not.toBeNull();
		});

		test("F16-T2-03: Token Count Estimation", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-est");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "copilot-est.json"),
				readFileSync(
					path.join(copilotFixtureDir, "chatSessions", "copilot-sess-1.json"),
				),
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths, {
				harness: "copilot",
				sessionId: "copilot-est",
				filePath: path.join(chatDir, "copilot-est.json"),
				mtimeMs: Date.now(),
				sizeBytes: 100,
				cwd: "/workspace",
			});
			expect(usage.records.length).toBeGreaterThan(0);
			expect(usage.records[0]?.costEstimated).toBe(true);
		});

		test("F16-T2-04: Multi-Fragment Responses", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-fragments");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-1",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "frag.json"),
				JSON.stringify({
					sessionId: "frag-1",
					requests: [
						{
							message: { text: "Multiple parts" },
							response: [
								{ value: "Part 1. " },
								{ value: "Part 2. " },
								{ value: "Part 3." },
							],
						},
					],
				}),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "frag-1");
			expect(transcript).not.toBeNull();
			const assistantItem = transcript?.items.find(
				(i) => i.role === "assistant",
			);
			expect(assistantItem?.text).toContain("Part 1");
		});

		test("F16-T2-05: Missing Workspace Folder", async () => {
			const provider = new CopilotProvider();
			const mockHome = path.join(suiteTmp, "copilot-missing-ws");
			const chatDir = path.join(
				mockHome,
				"Library",
				"Application Support",
				"Code",
				"User",
				"workspaceStorage",
				"ws-without-json",
				"chatSessions",
			);
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "sess-missing-ws.json"),
				JSON.stringify({ sessionId: "sess-missing-ws", requests: [] }),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.some((s) => s.sessionId === "sess-missing-ws")).toBe(
				true,
			);
		});
	});

	// =========================================================================
	// 7. Aider Provider (Feature 17)
	// =========================================================================
	describe("7. Aider Provider (Feature 17)", () => {
		const aiderFixtureDir = path.join(HARNESSES_DIR, "aider");

		test("F17-T1-01: Metadata Integrity", () => {
			const provider = new AiderProvider();
			expect(provider.metadata.id).toBe("aider");
			expect(provider.metadata.displayName).toBe("Aider");
			expect(provider.metadata.shortLabel).toBe("Aid");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F17-T1-02: Repository & Home Availability", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-avail");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			writeFileSync(path.join(mockHome, ".aider", "analytics.jsonl"), "");

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F17-T1-03: Analytics Log Token Extraction", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-analytics");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			writeFileSync(
				path.join(mockHome, ".aider", "analytics.jsonl"),
				readFileSync(path.join(aiderFixtureDir, "analytics.jsonl")),
			);

			const paths = makePaths(mockHome);
			const usage = await provider.readUsage(paths);
			expect(usage.records.length).toBeGreaterThan(0);
			const rec = usage.records[0];
			if (!rec) throw new Error("Expected usage record");
			expect(rec.inputTokens).toBe(1400);
			expect(rec.outputTokens).toBe(320);
			expect(rec.model).toBe("gpt-4o");
		});

		test("F17-T1-04: Markdown Turn Parsing", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-md");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			writeFileSync(
				path.join(mockHome, ".aider", ".aider.chat.history.md"),
				readFileSync(path.join(aiderFixtureDir, ".aider.chat.history.md")),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
		});

		test("F17-T1-05: Tool Command Parsing", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-cmd");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			writeFileSync(
				path.join(mockHome, ".aider", ".aider.chat.history.md"),
				readFileSync(path.join(aiderFixtureDir, ".aider.chat.history.md")),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const transcript = await provider.readTranscript(
				paths,
				sessions[0]?.sessionId ?? "",
			);
			expect(transcript).not.toBeNull();
		});

		test("F17-T2-01: Multi-Session Delimiting", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-multi-sess");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			const content = [
				"# aider chat started at 2026-03-15 10:00:00",
				"#### Query 1",
				"Response 1",
				"# aider chat started at 2026-03-15 11:00:00",
				"#### Query 2",
				"Response 2",
			].join("\n");
			writeFileSync(
				path.join(mockHome, ".aider", ".aider.chat.history.md"),
				content,
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBe(2);
		});

		test("F17-T2-02: Missing Analytics Log Fallback", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-no-analytics");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			const content = [
				"# aider chat started at 2026-03-15 10:00:00",
				"#### Estimate tokens from text",
				"Here is a lengthy response providing code.",
			].join("\n");
			writeFileSync(
				path.join(mockHome, ".aider", ".aider.chat.history.md"),
				content,
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const usage = await provider.readUsage(paths, sessions[0]);
			expect(usage.records.length).toBeGreaterThan(0);
		});

		test("F17-T2-03: Empty Markdown File", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-empty");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			writeFileSync(
				path.join(mockHome, ".aider", ".aider.chat.history.md"),
				"",
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThanOrEqual(0);
			if (sessions.length > 0) {
				const usage = await provider.readUsage(paths, sessions[0]);
				expect(usage.records.length).toBe(0);
			}
		});

		test("F17-T2-04: Non-Standard Headings", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-headings");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			const content = [
				"# aider chat started at 2026-03-15 10:00:00",
				"## Secondary Heading",
				"Text under heading",
			].join("\n");
			writeFileSync(
				path.join(mockHome, ".aider", ".aider.chat.history.md"),
				content,
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBe(1);
		});

		test("F17-T2-05: Search/Replace Diff Blocks", async () => {
			const provider = new AiderProvider();
			const mockHome = path.join(suiteTmp, "aider-diff");
			mkdirSync(path.join(mockHome, ".aider"), { recursive: true });
			const content = [
				"# aider chat started at 2026-03-15 10:00:00",
				"#### Apply diff",
				"```diff",
				"- oldLine",
				"+ newLine",
				"```",
			].join("\n");
			writeFileSync(
				path.join(mockHome, ".aider", ".aider.chat.history.md"),
				content,
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const transcript = await provider.readTranscript(
				paths,
				sessions[0]?.sessionId ?? "",
			);
			expect(transcript?.items.length).toBeGreaterThan(0);
		});
	});

	// =========================================================================
	// 8. Windsurf Provider (Feature 18)
	// =========================================================================
	describe("8. Windsurf Provider (Feature 18)", () => {
		const windsurfFixtureDir = path.join(HARNESSES_DIR, "windsurf");

		test("F18-T1-01: Metadata Integrity", () => {
			const provider = new WindsurfProvider();
			expect(provider.metadata.id).toBe("windsurf");
			expect(provider.metadata.displayName).toBe("Windsurf");
			expect(provider.metadata.shortLabel).toBe("Wind");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F18-T1-02: Application Directory Availability", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-avail");
			mkdirSync(path.join(mockHome, ".codeium", "chat_state"), {
				recursive: true,
			});
			writeFileSync(
				path.join(mockHome, ".codeium", "chat_state", "test.pb"),
				"mock",
			);

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F18-T1-03: Session Discovery", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-disc");
			const chatDir = path.join(mockHome, ".codeium", "chat_state");
			mkdirSync(chatDir, { recursive: true });
			const pbName = "codeium_chat_state_file_workspace_windsurf_project.pb";
			writeFileSync(
				path.join(chatDir, pbName),
				readFileSync(path.join(windsurfFixtureDir, "chat_state", pbName)),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.sessionId).toBe("windsurf-sess-1");
			expect(sessions[0]?.filePath).toContain("workspace_windsurf_project");
		});

		test("F18-T1-04: Protobuf Wire Decoding", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-usage");
			const chatDir = path.join(mockHome, ".codeium", "chat_state");
			mkdirSync(chatDir, { recursive: true });
			const pbName = "codeium_chat_state_file_workspace_windsurf_project.pb";
			writeFileSync(
				path.join(chatDir, pbName),
				readFileSync(path.join(windsurfFixtureDir, "chat_state", pbName)),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const firstSession = sessions[0];
			if (!firstSession) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, firstSession);
			expect(usage.records.length).toBeGreaterThan(0);
			expect(usage.records[0]?.inputTokens).toBeGreaterThan(0);
		});

		test("F18-T1-05: Cascade Plan Integration", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-cascade");
			const chatDir = path.join(mockHome, ".codeium", "chat_state");
			const plansDir = path.join(mockHome, ".codeium", "cascade", "plans");
			mkdirSync(chatDir, { recursive: true });
			mkdirSync(plansDir, { recursive: true });
			const pbName = "codeium_chat_state_file_workspace_windsurf_project.pb";
			writeFileSync(
				path.join(chatDir, pbName),
				readFileSync(path.join(windsurfFixtureDir, "chat_state", pbName)),
			);
			writeFileSync(
				path.join(plansDir, "plan-1.md"),
				"# Implementation Plan\n- Step 1",
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const transcript = await provider.readTranscript(
				paths,
				sessions[0]?.sessionId ?? "",
			);
			expect(transcript).not.toBeNull();
		});

		test("F18-T2-01: Corrupted / Truncated Protobuf", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-corrupt-pb");
			const chatDir = path.join(mockHome, ".codeium", "chat_state");
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(
				path.join(chatDir, "codeium_chat_state_file_corrupt.pb"),
				Buffer.from([0x08, 0x96, 0x01, 0x12]),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			const usage = await provider.readUsage(paths, sessions[0]);
			expect(usage).toBeDefined();
		});

		test("F18-T2-02: Unknown Field Tags", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-unknown-tags");
			const chatDir = path.join(mockHome, ".codeium", "chat_state");
			mkdirSync(chatDir, { recursive: true });
			// Field tag 99 (unknown)
			const unknownTagBlob = protoConcat(
				protoVarint(99, 12345),
				protoBytes(1, new TextEncoder().encode("conv-1")),
			);
			writeFileSync(
				path.join(chatDir, "codeium_chat_state_file_tags.pb"),
				unknownTagBlob,
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
		});

		test("F18-T2-03: Zero-Byte .pb File", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-empty");
			const chatDir = path.join(mockHome, ".codeium", "chat_state");
			mkdirSync(chatDir, { recursive: true });
			writeFileSync(path.join(chatDir, "codeium_chat_state_file_zero.pb"), "");

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const usage = await provider.readUsage(paths, sessions[0]);
			expect(usage.records.length).toBe(0);
		});

		test("F18-T2-04: URL-Encoded Path in Filename", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-decode");
			const chatDir = path.join(mockHome, ".codeium", "chat_state");
			mkdirSync(chatDir, { recursive: true });
			const pbName = "codeium_chat_state_file_workspace_my_20project_app.pb";
			writeFileSync(path.join(chatDir, pbName), "dummy");

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions[0]?.cwd).toBeDefined();
		});

		test("F18-T2-05: Dual Directory Coexistence", async () => {
			const provider = new WindsurfProvider();
			const mockHome = path.join(suiteTmp, "wind-dual");
			mkdirSync(path.join(mockHome, ".codeium", "chat_state"), {
				recursive: true,
			});
			mkdirSync(path.join(mockHome, ".windsurf", "chat_state"), {
				recursive: true,
			});
			writeFileSync(
				path.join(
					mockHome,
					".codeium",
					"chat_state",
					"codeium_chat_state_file_common.pb",
				),
				"1",
			);
			writeFileSync(
				path.join(
					mockHome,
					".windsurf",
					"chat_state",
					"codeium_chat_state_file_common.pb",
				),
				"2",
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBe(1); // deduplicated
		});
	});

	// =========================================================================
	// 9. Goose Provider (Feature 19)
	// =========================================================================
	describe("9. Goose Provider (Feature 19)", () => {
		const gooseFixtureDir = path.join(HARNESSES_DIR, "goose");

		test("F19-T1-01: Metadata Integrity", () => {
			const provider = new GooseProvider();
			expect(provider.metadata.id).toBe("goose");
			expect(provider.metadata.displayName).toBe("Goose");
			expect(provider.metadata.shortLabel).toBe("Goose");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F19-T1-02: Database Availability", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-avail");
			const gooseDir = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"sessions",
			);
			mkdirSync(gooseDir, { recursive: true });
			createDatabase(path.join(gooseDir, "sessions.db"));

			const paths = makePaths(mockHome, {}, "linux");
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F19-T1-03: Session Discovery", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-disc");
			const gooseDir = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"sessions",
			);
			mkdirSync(gooseDir, { recursive: true });
			seedGooseDb(path.join(gooseDir, "sessions.db"));

			const paths = makePaths(mockHome, {}, "linux");
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.sessionId).toContain("goose-sess");
		});

		test("F19-T1-04: Accumulated Token Delta Calculation", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-usage");
			const gooseDir = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"sessions",
			);
			mkdirSync(gooseDir, { recursive: true });
			seedGooseDb(path.join(gooseDir, "sessions.db"));

			const paths = makePaths(mockHome, {}, "linux");
			const sessions = await provider.discoverSessions(paths);
			const firstSession = sessions[0];
			if (!firstSession) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, firstSession);
			expect(usage.records.length).toBeGreaterThan(0);
			const rec = usage.records[0];
			if (!rec) throw new Error("Expected usage record");
			expect(rec.inputTokens).toBeGreaterThan(0);
			expect(rec.outputTokens).toBeGreaterThan(0);
		});

		test("F19-T1-05: Transcript Reconstruction", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-trans");
			const gooseDir = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"sessions",
			);
			mkdirSync(gooseDir, { recursive: true });
			seedGooseDb(path.join(gooseDir, "sessions.db"));

			const paths = makePaths(mockHome, {}, "linux");
			const sessions = await provider.discoverSessions(paths);
			const transcript = await provider.readTranscript(
				paths,
				sessions[0]?.sessionId ?? "",
			);
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThan(0);
		});

		test("F19-T2-01: Legacy JSONL Session Support", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-legacy");
			const legacyDir = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"legacy-sessions",
			);
			mkdirSync(legacyDir, { recursive: true });
			writeFileSync(
				path.join(legacyDir, "legacy-session.jsonl"),
				readFileSync(
					path.join(gooseFixtureDir, "legacy-sessions", "legacy-session.jsonl"),
				),
			);

			const paths = makePaths(mockHome, {}, "linux");
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
		});

		test("F19-T2-02: Counter Resets", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-resets");
			const dbPath = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"sessions",
				"sessions.db",
			);
			mkdirSync(path.dirname(dbPath), { recursive: true });
			const db = createDatabase(dbPath);
			db.run(
				"CREATE TABLE sessions (id TEXT PRIMARY KEY, description TEXT, working_dir TEXT, created_at INTEGER, updated_at INTEGER)",
			);
			db.run(
				"CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER)",
			);
			db.run(
				"INSERT INTO sessions VALUES ('sess-reset', 'Reset session', '/workspace', 1000, 2000)",
			);
			// Message 2 has lower accumulated count than Message 1 (counter reset)
			db.run(
				"INSERT INTO messages VALUES ('m1', 'sess-reset', 'assistant', 'Reply 1', 1100, 1000, 200)",
			);
			db.run(
				"INSERT INTO messages VALUES ('m2', 'sess-reset', 'assistant', 'Reply 2', 1200, 500, 100)",
			);
			db.close();

			const paths = makePaths(mockHome, {}, "linux");
			const usage = await provider.readUsage(paths, {
				harness: "goose",
				sessionId: "sess-reset",
				filePath: dbPath,
				mtimeMs: Date.now(),
				sizeBytes: 100,
				cwd: "/workspace",
			});
			for (const r of usage.records) {
				expect(r.inputTokens).toBeGreaterThanOrEqual(0);
				expect(r.outputTokens).toBeGreaterThanOrEqual(0);
			}
		});

		test("F19-T2-03: Malformed Model Config JSON", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-bad-json");
			const dbPath = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"sessions",
				"sessions.db",
			);
			mkdirSync(path.dirname(dbPath), { recursive: true });
			const db = createDatabase(dbPath);
			db.run(
				"CREATE TABLE sessions (id TEXT PRIMARY KEY, description TEXT, working_dir TEXT, created_at INTEGER, updated_at INTEGER, model_config_json TEXT)",
			);
			db.run(
				"INSERT INTO sessions VALUES ('s-bad-model', 'Bad model', '/workspace', 1000, 2000, '{invalid-json...')",
			);
			db.close();

			const paths = makePaths(mockHome, {}, "linux");
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBe(1);
		});

		test("F19-T2-04: SQLite Readonly Concurrency", () => {
			const dbPath = path.join(gooseFixtureDir, "sessions.db");
			expect(existsSync(dbPath)).toBe(true);
			const db = openSafeReadonlyDatabase(dbPath);
			const row = db.db
				.prepare("SELECT count(*) as count FROM sessions")
				.get() as { count: number };
			expect(row.count).toBeGreaterThan(0);
			db.close();
		});

		test("F19-T2-05: Empty Session Messages", async () => {
			const provider = new GooseProvider();
			const mockHome = path.join(suiteTmp, "goose-empty-msgs");
			const dbPath = path.join(
				mockHome,
				".local",
				"share",
				"goose",
				"sessions",
				"sessions.db",
			);
			mkdirSync(path.dirname(dbPath), { recursive: true });
			const db = createDatabase(dbPath);
			db.run(
				"CREATE TABLE sessions (id TEXT PRIMARY KEY, description TEXT, working_dir TEXT, created_at INTEGER, updated_at INTEGER)",
			);
			db.run(
				"CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER)",
			);
			db.run(
				"INSERT INTO sessions VALUES ('sess-empty', 'Empty session', '/workspace', 1000, 2000)",
			);
			db.close();

			const paths = makePaths(mockHome, {}, "linux");
			const transcript = await provider.readTranscript(paths, "sess-empty");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBe(0);
		});
	});

	// =========================================================================
	// 10. OpenHands Provider (Feature 20)
	// =========================================================================
	describe("10. OpenHands Provider (Feature 20)", () => {
		const openhandsFixtureDir = path.join(HARNESSES_DIR, "openhands");

		test("F20-T1-01: Metadata Integrity", () => {
			const provider = new OpenHandsProvider();
			expect(provider.metadata.id).toBe("openhands");
			expect(provider.metadata.displayName).toBe("OpenHands");
			expect(provider.metadata.shortLabel).toBe("OH");
			expect(provider.metadata.color).toBeDefined();
		});

		test("F20-T1-02: Directory Availability", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-avail");
			mkdirSync(path.join(mockHome, ".openhands", "conversations", "conv-1"), {
				recursive: true,
			});
			writeFileSync(
				path.join(
					mockHome,
					".openhands",
					"conversations",
					"conv-1",
					"base_state.json",
				),
				"{}",
			);

			const paths = makePaths(mockHome);
			expect(await provider.isAvailable(paths)).toBe(true);
		});

		test("F20-T1-03: Session Discovery", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-disc");
			const convDir = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-12345",
			);
			mkdirSync(convDir, { recursive: true });
			writeFileSync(
				path.join(convDir, "base_state.json"),
				readFileSync(
					path.join(
						openhandsFixtureDir,
						"conversations",
						"conv-12345",
						"base_state.json",
					),
				),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions[0]?.sessionId).toBe("conv-12345");
			expect(sessions[0]?.cwd).toBe("/workspace/openhands-project");
		});

		test("F20-T1-04: Token & Cost Extraction", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-usage");
			const convDir = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-12345",
			);
			mkdirSync(convDir, { recursive: true });
			writeFileSync(
				path.join(convDir, "base_state.json"),
				readFileSync(
					path.join(
						openhandsFixtureDir,
						"conversations",
						"conv-12345",
						"base_state.json",
					),
				),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const firstSession = sessions[0];
			if (!firstSession) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, firstSession);
			expect(usage.records.length).toBeGreaterThan(0);
			const rec = usage.records[0];
			if (!rec) throw new Error("Expected usage record");
			expect(rec.inputTokens).toBe(13000);
			expect(rec.outputTokens).toBe(3000);
			expect(rec.costUsd).toBe(0.052);
		});

		test("F20-T1-05: Event Stream Transcript Reconstruction", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-trans");
			const convDir = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-12345",
			);
			const eventsDir = path.join(convDir, "events");
			mkdirSync(eventsDir, { recursive: true });
			writeFileSync(
				path.join(convDir, "base_state.json"),
				readFileSync(
					path.join(
						openhandsFixtureDir,
						"conversations",
						"conv-12345",
						"base_state.json",
					),
				),
			);
			writeFileSync(
				path.join(eventsDir, "0.json"),
				JSON.stringify({
					id: 0,
					source: "user",
					message: "Build a microservice",
					timestamp: "2026-03-15T10:00:00Z",
				}),
			);
			writeFileSync(
				path.join(eventsDir, "1.json"),
				JSON.stringify({
					id: 1,
					source: "agent",
					thought: "Creating directories",
					action: "run_command",
					args: { command: "mkdir service" },
					timestamp: "2026-03-15T10:01:00Z",
				}),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "conv-12345");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBeGreaterThanOrEqual(2);
		});

		test("F20-T2-01: Gaps in Event Sequence", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-gaps");
			const eventsDir = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-gap",
				"events",
			);
			mkdirSync(eventsDir, { recursive: true });
			writeFileSync(
				path.join(path.dirname(eventsDir), "base_state.json"),
				JSON.stringify({
					conversation_id: "conv-gap",
					metrics: { total_tokens: 100 },
				}),
			);
			writeFileSync(
				path.join(eventsDir, "0.json"),
				JSON.stringify({ id: 0, source: "user", message: "Step 0" }),
			);
			// Event 1 is missing, event 2 exists
			writeFileSync(
				path.join(eventsDir, "2.json"),
				JSON.stringify({ id: 2, source: "agent", thought: "Step 2" }),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "conv-gap");
			expect(transcript).not.toBeNull();
			expect(transcript?.items.length).toBe(2);
		});

		test("F20-T2-02: Missing Event Metrics", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-no-event-metrics");
			const convDir = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-agg",
			);
			mkdirSync(convDir, { recursive: true });
			writeFileSync(
				path.join(convDir, "base_state.json"),
				JSON.stringify({
					conversation_id: "conv-agg",
					metrics: {
						prompt_tokens: 5000,
						completion_tokens: 1000,
						accumulated_cost: 0.02,
					},
				}),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			const firstSession = sessions[0];
			if (!firstSession) throw new Error("Expected session");
			const usage = await provider.readUsage(paths, firstSession);
			expect(usage.records.length).toBeGreaterThan(0);
			expect(usage.records[0]?.inputTokens).toBe(5000);
		});

		test("F20-T2-03: Status Variations", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-status");
			const c1 = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-running",
			);
			const c2 = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-error",
			);
			mkdirSync(c1, { recursive: true });
			mkdirSync(c2, { recursive: true });
			writeFileSync(
				path.join(c1, "base_state.json"),
				JSON.stringify({ conversation_id: "conv-running", status: "RUNNING" }),
			);
			writeFileSync(
				path.join(c2, "base_state.json"),
				JSON.stringify({ conversation_id: "conv-error", status: "ERROR" }),
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions.some((s) => s.sessionId === "conv-running")).toBe(true);
			expect(sessions.some((s) => s.sessionId === "conv-error")).toBe(true);
		});

		test("F20-T2-04: Empty Thought / Complex Action Args", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-complex");
			const eventsDir = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-cx",
				"events",
			);
			mkdirSync(eventsDir, { recursive: true });
			writeFileSync(
				path.join(path.dirname(eventsDir), "base_state.json"),
				JSON.stringify({ conversation_id: "conv-cx" }),
			);
			writeFileSync(
				path.join(eventsDir, "0.json"),
				JSON.stringify({
					id: 0,
					source: "agent",
					thought: "",
					action: "custom_tool",
					args: { nested: { array: [1, 2, 3] }, flag: true },
				}),
			);

			const paths = makePaths(mockHome);
			const transcript = await provider.readTranscript(paths, "conv-cx");
			expect(transcript).not.toBeNull();
		});

		test("F20-T2-05: Corrupted base_state.json", async () => {
			const provider = new OpenHandsProvider();
			const mockHome = path.join(suiteTmp, "oh-corrupt-base");
			const convDir = path.join(
				mockHome,
				".openhands",
				"conversations",
				"conv-corrupt",
			);
			mkdirSync(convDir, { recursive: true });
			writeFileSync(
				path.join(convDir, "base_state.json"),
				"{invalid-json-base...",
			);

			const paths = makePaths(mockHome);
			const sessions = await provider.discoverSessions(paths);
			expect(sessions).toBeDefined();
		});
	});
});
