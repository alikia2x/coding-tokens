import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { ClineProvider } from "../../../src/providers/cline";
import { ContinueProvider } from "../../../src/providers/continue";
import { decodeWorkspaceUri } from "../../../src/providers/continue/discovery";
import { RooProvider } from "../../../src/providers/roo";

const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");
const HARNESSES_FIXTURES = path.join(FIXTURES_DIR, "harnesses");
const PLATFORMS_FIXTURES = path.join(FIXTURES_DIR, "platforms");

describe("Providers: VS Code Extension Ecosystem (Milestone 3 Batch 2)", () => {
	const suiteTmp = mkdtempSync(path.join(os.tmpdir(), "ct-extensions-test-"));

	afterAll(() => {
		rmSync(suiteTmp, { recursive: true, force: true });
	});

	function createIsolatedPaths(
		homeDir: string,
		platform: "darwin" | "linux" = "darwin",
		env?: Record<string, string>,
	) {
		return new DefaultPlatformPathService(
			new MockOsEnvProvider({ platform, home: homeDir, env }),
		);
	}

	function createStagedPaths(
		harness: "cline" | "roo" | "continue",
		sourceDir: string,
	) {
		const homeDir = path.join(
			suiteTmp,
			`${harness}-${Math.random().toString(36).slice(2, 8)}`,
		);
		const paths = createIsolatedPaths(homeDir);
		const targetRoot = paths.resolveHarnessPaths(harness)[0];
		if (!targetRoot) throw new Error(`No resolved path for ${harness}`);
		mkdirSync(path.dirname(targetRoot), { recursive: true });
		cpSync(sourceDir, targetRoot, { recursive: true });
		return paths;
	}
	// =========================================================================
	// 1. CLINE PROVIDER
	// =========================================================================
	describe("Cline Provider", () => {
		test("M3-B2-01: Metadata and interface contract compliance", () => {
			const provider = new ClineProvider();
			expect(provider.metadata.id).toBe("cline");
			expect(provider.metadata.displayName).toBe("Cline");
			expect(provider.metadata.color).toBeDefined();
			expect(typeof provider.isAvailable).toBe("function");
			expect(typeof provider.discoverSessions).toBe("function");
			expect(typeof provider.readUsage).toBe("function");
			expect(typeof provider.readTranscript).toBe("function");
			expect(typeof provider.computeFingerprint).toBe("function");
			expect(typeof provider.getWatchPaths).toBe("function");
		});

		test("M3-B2-02: Session discovery against fixture storage", async () => {
			const clineDir = path.join(HARNESSES_FIXTURES, "cline");
			const mockPaths = createStagedPaths("cline", clineDir);

			const provider = new ClineProvider();
			const isAvail = await provider.isAvailable(mockPaths);
			expect(isAvail).toBe(true);

			const sessions = await provider.discoverSessions(mockPaths);
			expect(sessions.length).toBeGreaterThanOrEqual(1);

			const mainTask = sessions.find((s) => s.sessionId === "task-cline-101");
			expect(mainTask).toBeDefined();
			expect(mainTask?.harness).toBe("cline");
			expect(mainTask?.cwd).toBe("/workspace/project-alpha");
			expect(mainTask?.filePath).toContain("task-cline-101");
		});

		test("M3-B2-03: Usage extraction from taskHistory.json and ui_messages.json telemetry", async () => {
			const clineDir = path.join(HARNESSES_FIXTURES, "cline");
			const mockPaths = createStagedPaths("cline", clineDir);

			const provider = new ClineProvider();
			const usage = await provider.readUsage(mockPaths);

			expect(usage.available).toBe(true);
			expect(usage.harness).toBe("cline");
			expect(usage.records.length).toBeGreaterThanOrEqual(1);

			// Check granular api_req_started record from ui_messages.json
			const granular = usage.records.find(
				(r) => r.sessionId === "task-cline-101",
			);
			expect(granular).toBeDefined();
			expect(granular?.inputTokens).toBe(12500);
			expect(granular?.outputTokens).toBe(850);
			expect(granular?.cacheWriteTokens).toBe(500);
			expect(granular?.cacheReadTokens).toBe(6000);
			expect(granular?.costUsd).toBe(0.042);
			expect(granular?.model).toBe("claude-3-5-sonnet-20241022");
			expect(granular?.pricingModel).toBe(
				"anthropic/claude-3-5-sonnet-20241022",
			);

			// Check user message count
			expect(usage.messages.get("task-cline-101")).toBe(1);

			// Test boundary condition: boundary-zero-tokens must not produce invalid positive token records
			const zeroRecords = usage.records.filter(
				(r) => r.sessionId === "boundary-zero-tokens",
			);
			expect(zeroRecords.length).toBe(0);
		});

		test("M3-B2-04: Transcript extraction with user, assistant, and tool executions", async () => {
			const clineDir = path.join(HARNESSES_FIXTURES, "cline");
			const mockPaths = createStagedPaths("cline", clineDir);

			const provider = new ClineProvider();
			const transcript = await provider.readTranscript(
				mockPaths,
				"task-cline-101",
			);

			expect(transcript).not.toBeNull();
			expect(transcript?.sessionId).toBe("task-cline-101");
			expect(transcript?.harness).toBe("cline");
			expect(transcript?.items.length).toBeGreaterThanOrEqual(2);

			const userMsg = transcript?.items.find((i) => i.role === "user");
			expect(userMsg).toBeDefined();
			expect(userMsg?.text).toContain("Refactor token counter");

			const asstMsg = transcript?.items.find((i) => i.role === "assistant");
			expect(asstMsg).toBeDefined();
			expect(asstMsg?.text).toContain("Refactoring completed successfully.");
			expect(asstMsg?.phase).toBe("final");
		});

		test("M3-B2-05: Cross-platform directory discovery for macOS, Linux, and Windows", async () => {
			// Darwin
			const darwinEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: "/Users/testuser",
			});
			const darwinPaths = new DefaultPlatformPathService(darwinEnv);
			const darwinResolved = darwinPaths.resolveHarnessPaths("cline");
			expect(darwinResolved[0]).toBe("/Users/testuser/.cline");
			expect(darwinResolved[1]).toContain(
				"Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev",
			);

			// Linux
			const linuxEnv = new MockOsEnvProvider({
				platform: "linux",
				home: "/home/testuser",
				env: { XDG_CONFIG_HOME: "/home/testuser/.config" },
			});
			const linuxPaths = new DefaultPlatformPathService(linuxEnv);
			const linuxResolved = linuxPaths.resolveHarnessPaths("cline");
			expect(linuxResolved[0]).toBe("/home/testuser/.cline");
			expect(linuxResolved[1]).toBe(
				"/home/testuser/.config/Code/User/globalStorage/saoudrizwan.claude-dev",
			);

			// Windows
			const winEnv = new MockOsEnvProvider({
				platform: "win32",
				home: "C:/Users/testuser",
				env: { APPDATA: "C:/Users/testuser/AppData/Roaming" },
			});
			const winPaths = new DefaultPlatformPathService(winEnv);
			const winResolved = winPaths.resolveHarnessPaths("cline");
			expect(winResolved[0]).toBe("C:/Users/testuser/.cline");
			expect(winResolved[1]).toContain(
				"C:/Users/testuser/AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev",
			);
		});

		test("M3-B2-06: Task history summary fallback when ui_messages.json is missing", async () => {
			const mockHome = path.join(
				suiteTmp,
				`ct-cline-summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			);
			const clineRoot = path.join(mockHome, ".cline");
			mkdirSync(path.join(clineRoot, "state"), { recursive: true });

			const taskHistory = [
				{
					id: "task-summary-only",
					ts: 1773600000000,
					task: "Summary only test",
					tokensIn: 8000,
					tokensOut: 600,
					cacheWrites: 200,
					cacheReads: 4000,
					totalCost: 0.05,
					cwdOnTaskInitialization: "/test/summary",
					modelId: "gpt-4o",
				},
			];
			writeFileSync(
				path.join(clineRoot, "state", "taskHistory.json"),
				JSON.stringify(taskHistory),
			);

			const mockPaths = createIsolatedPaths(mockHome);

			const provider = new ClineProvider();
			const usage = await provider.readUsage(mockPaths);
			expect(usage.records.length).toBe(1);
			expect(usage.records[0]?.sessionId).toBe("task-summary-only");
			expect(usage.records[0]?.inputTokens).toBe(8000);
			expect(usage.records[0]?.outputTokens).toBe(600);
			expect(usage.records[0]?.costUsd).toBe(0.05);

			rmSync(mockHome, { recursive: true, force: true });
		});
	});

	// =========================================================================
	// 2. ROO CODE PROVIDER
	// =========================================================================
	describe("Roo Code Provider", () => {
		test("M3-B2-07: Metadata and interface contract compliance", () => {
			const provider = new RooProvider();
			expect(provider.metadata.id).toBe("roo");
			expect(provider.metadata.displayName).toBe("Roo Code");
			expect(provider.metadata.color).toBeDefined();
			expect(typeof provider.isAvailable).toBe("function");
			expect(typeof provider.discoverSessions).toBe("function");
			expect(typeof provider.readUsage).toBe("function");
			expect(typeof provider.readTranscript).toBe("function");
		});

		test("M3-B2-08: Mode-aware session discovery and task history parsing", async () => {
			const rooDir = path.join(HARNESSES_FIXTURES, "roo");
			const mockPaths = createStagedPaths("roo", rooDir);

			const provider = new RooProvider();
			const isAvail = await provider.isAvailable(mockPaths);
			expect(isAvail).toBe(true);

			const sessions = await provider.discoverSessions(mockPaths);
			expect(sessions.length).toBeGreaterThanOrEqual(2);

			const architectTask = sessions.find(
				(s) => s.sessionId === "task-roo-101",
			);
			expect(architectTask).toBeDefined();
			expect(architectTask?.cwd).toBe("/workspace/project-beta");

			const codeTask = sessions.find((s) => s.sessionId === "task-roo-102");
			expect(codeTask).toBeDefined();
		});

		test("M3-B2-09: Mode-aware telemetry usage extraction (Architect & Code modes)", async () => {
			const rooDir = path.join(HARNESSES_FIXTURES, "roo");
			const mockPaths = createStagedPaths("roo", rooDir);

			const provider = new RooProvider();
			const usage = await provider.readUsage(mockPaths);

			expect(usage.available).toBe(true);
			expect(usage.harness).toBe("roo");
			expect(usage.records.length).toBeGreaterThanOrEqual(2);

			// Task 101 has granular api_req_started in architect mode
			const rec101 = usage.records.find((r) => r.sessionId === "task-roo-101");
			expect(rec101).toBeDefined();
			expect(rec101?.inputTokens).toBe(18000);
			expect(rec101?.outputTokens).toBe(1200);
			expect(rec101?.cacheReadTokens).toBe(8000);
			expect(rec101?.costUsd).toBe(0.065);
			expect(rec101?.turnId).toContain("architect");

			// Task 102 falls back to summary in code mode
			const rec102 = usage.records.find((r) => r.sessionId === "task-roo-102");
			expect(rec102).toBeDefined();
			expect(rec102?.inputTokens).toBe(32000);
			expect(rec102?.outputTokens).toBe(2800);
			expect(rec102?.turnId).toContain("code");
		});

		test("M3-B2-10: Mode-aware transcript parsing with status and turn attribution", async () => {
			const rooDir = path.join(HARNESSES_FIXTURES, "roo");
			const mockPaths = createStagedPaths("roo", rooDir);

			const provider = new RooProvider();
			const transcript = await provider.readTranscript(
				mockPaths,
				"task-roo-101",
			);

			expect(transcript).not.toBeNull();
			expect(transcript?.sessionId).toBe("task-roo-101");
			expect(transcript?.harness).toBe("roo");
			expect(transcript?.items.length).toBeGreaterThanOrEqual(1);

			const userMsg = transcript?.items.find((i) => i.role === "user");
			expect(userMsg).toBeDefined();
			expect(userMsg?.text).toContain("Design system architecture");
			expect(userMsg?.status).toBe("architect");
			expect(userMsg?.turnId).toContain("architect");
		});

		test("M3-B2-11: Platform fixture discovery on Linux", async () => {
			const linuxHome = path.join(PLATFORMS_FIXTURES, "linux");
			const mockPaths = createIsolatedPaths(linuxHome, "linux", {
				XDG_CONFIG_HOME: path.join(linuxHome, ".config"),
			});

			const provider = new RooProvider();
			const isAvail = await provider.isAvailable(mockPaths);
			expect(isAvail).toBe(true);

			const sessions = await provider.discoverSessions(mockPaths);
			expect(sessions.length).toBeGreaterThanOrEqual(1);
			expect(sessions[0]?.sessionId).toBe("task-roo-101");
		});
	});

	// =========================================================================
	// 3. CONTINUE PROVIDER
	// =========================================================================
	describe("Continue Provider", () => {
		test("M3-B2-12: Metadata and interface contract compliance", () => {
			const provider = new ContinueProvider();
			expect(provider.metadata.id).toBe("continue");
			expect(provider.metadata.displayName).toBe("Continue");
			expect(provider.metadata.color).toBeDefined();
			expect(typeof provider.isAvailable).toBe("function");
			expect(typeof provider.discoverSessions).toBe("function");
			expect(typeof provider.readUsage).toBe("function");
			expect(typeof provider.readTranscript).toBe("function");
		});

		test("M3-B2-13: Workspace URI decoding for local paths", () => {
			expect(decodeWorkspaceUri("file:///workspace/project-alpha")).toBe(
				"/workspace/project-alpha",
			);
			expect(decodeWorkspaceUri("file:///C:/Users/name/code")).toBe(
				"C:/Users/name/code",
			);
			expect(decodeWorkspaceUri("file:///Users/name/Project%20Alpha")).toBe(
				"/Users/name/Project Alpha",
			);
			expect(decodeWorkspaceUri(null)).toBeNull();
		});

		test("M3-B2-14: Session discovery from sessions.json catalog and session files", async () => {
			const continueDir = path.join(HARNESSES_FIXTURES, "continue");
			const mockPaths = createStagedPaths("continue", continueDir);

			const provider = new ContinueProvider();
			const isAvail = await provider.isAvailable(mockPaths);
			expect(isAvail).toBe(true);

			const sessions = await provider.discoverSessions(mockPaths);
			expect(sessions.length).toBeGreaterThanOrEqual(1);

			const mainSess = sessions.find((s) => s.sessionId === "cont-sess-01");
			expect(mainSess).toBeDefined();
			expect(mainSess?.harness).toBe("continue");
			expect(mainSess?.cwd).toBe("/workspace/project-alpha");
		});

		test("M3-B2-15: Usage extraction from devdata.sqlite and tokensGenerated.jsonl", async () => {
			const continueDir = path.join(HARNESSES_FIXTURES, "continue");
			const mockPaths = createStagedPaths("continue", continueDir);

			const provider = new ContinueProvider();
			const usage = await provider.readUsage(mockPaths);

			expect(usage.available).toBe(true);
			expect(usage.harness).toBe("continue");
			expect(usage.records.length).toBeGreaterThanOrEqual(2);

			const totalPrompt = usage.records.reduce(
				(acc, r) => acc + r.inputTokens,
				0,
			);
			const totalGen = usage.records.reduce(
				(acc, r) => acc + r.outputTokens,
				0,
			);

			expect(totalPrompt).toBe(5600); // 2500 + 3100
			expect(totalGen).toBe(1420); // 600 + 820
			expect(usage.records[0]?.model).toBe("gpt-4o");
			expect(usage.records[0]?.pricingModel).toBe("openai/gpt-4o");
		});

		test("M3-B2-16: Transcript extraction from session JSON with tool calls from chatInteraction.jsonl", async () => {
			const continueDir = path.join(HARNESSES_FIXTURES, "continue");
			const mockPaths = createStagedPaths("continue", continueDir);

			const provider = new ContinueProvider();
			const transcript = await provider.readTranscript(
				mockPaths,
				"cont-sess-01",
			);

			expect(transcript).not.toBeNull();
			expect(transcript?.sessionId).toBe("cont-sess-01");
			expect(transcript?.cwd).toBe("/workspace/project-alpha");
			expect(transcript?.items.length).toBeGreaterThanOrEqual(2);

			const userMsg = transcript?.items.find((i) => i.role === "user");
			expect(userMsg).toBeDefined();
			expect(userMsg?.text).toContain("Add caching support");

			const asstMsg = transcript?.items.find((i) => i.role === "assistant");
			expect(asstMsg).toBeDefined();
			expect(asstMsg?.text).toContain(
				"Here is the caching layer implementation.",
			);

			// Tools from chatInteraction.jsonl should be present
			const tools = transcript?.items.filter((i) => i.kind === "tool_call");
			expect(tools?.length).toBeGreaterThanOrEqual(1);
			const toolNames = tools?.map((t) => t.name);
			expect(toolNames).toContain("read_file");
		});

		test("M3-B2-17: Cross-platform directory resolution for Continue", () => {
			// Darwin
			const darwinEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: "/Users/testuser",
			});
			const darwinPaths = new DefaultPlatformPathService(darwinEnv);
			expect(darwinPaths.resolveHarnessPaths("continue")).toEqual([
				"/Users/testuser/.continue",
			]);

			// Linux
			const linuxEnv = new MockOsEnvProvider({
				platform: "linux",
				home: "/home/testuser",
			});
			const linuxPaths = new DefaultPlatformPathService(linuxEnv);
			expect(linuxPaths.resolveHarnessPaths("continue")).toEqual([
				"/home/testuser/.continue",
			]);

			// Windows
			const winEnv = new MockOsEnvProvider({
				platform: "win32",
				home: "C:/Users/testuser",
			});
			const winPaths = new DefaultPlatformPathService(winEnv);
			expect(winPaths.resolveHarnessPaths("continue")).toEqual([
				"C:/Users/testuser/.continue",
			]);
		});
	});

	// =========================================================================
	// 4. INTEGRITY, DETERMINISM & FINGERPRINTING
	// =========================================================================
	describe("Determinism, WatchPaths and Fingerprinting", () => {
		test("M3-B2-18: Deterministic fingerprint format v12:count:hash for all Batch 2 providers", async () => {
			const clinePaths = createStagedPaths(
				"cline",
				path.join(HARNESSES_FIXTURES, "cline"),
			);
			const clineProvider = new ClineProvider();
			const clineFp = await clineProvider.computeFingerprint(clinePaths);
			expect(clineFp).toMatch(/^v12:\d+:[0-9a-f]{64}$/);

			const rooPaths = createStagedPaths(
				"roo",
				path.join(HARNESSES_FIXTURES, "roo"),
			);
			const rooProvider = new RooProvider();
			const rooFp = await rooProvider.computeFingerprint(rooPaths);
			expect(rooFp).toMatch(/^v12:\d+:[0-9a-f]{64}$/);

			const contPaths = createStagedPaths(
				"continue",
				path.join(HARNESSES_FIXTURES, "continue"),
			);
			const contProvider = new ContinueProvider();
			const contFp = await contProvider.computeFingerprint(contPaths);
			expect(contFp).toMatch(/^v12:\d+:[0-9a-f]{64}$/);
		});

		test("M3-B2-19: WatchPaths return existing directories for file watching", () => {
			const clinePaths = createStagedPaths(
				"cline",
				path.join(HARNESSES_FIXTURES, "cline"),
			);
			const clineProvider = new ClineProvider();
			const clineWatch = clineProvider.getWatchPaths(clinePaths);
			expect(clineWatch.length).toBeGreaterThan(0);

			const contPaths = createStagedPaths(
				"continue",
				path.join(HARNESSES_FIXTURES, "continue"),
			);
			const contProvider = new ContinueProvider();
			const contWatch = contProvider.getWatchPaths(contPaths);
			expect(contWatch.length).toBeGreaterThan(0);
		});
	});

	// =========================================================================
	// 5. ISOLATED EMPTY & STAGED SANDBOX VERIFICATION
	// =========================================================================
	describe("Isolated Sandbox Verification", () => {
		test("M3-B2-20: Extension discovery executes cleanly against isolated empty and staged homes", async () => {
			const emptyHome = path.join(suiteTmp, "empty-ext-home");
			mkdirSync(emptyHome, { recursive: true });
			const emptyPaths = createIsolatedPaths(emptyHome);

			const clineProvider = new ClineProvider();
			const rooProvider = new RooProvider();
			const contProvider = new ContinueProvider();

			expect(await clineProvider.isAvailable(emptyPaths)).toBe(false);
			expect(await clineProvider.discoverSessions(emptyPaths)).toEqual([]);
			expect(await rooProvider.isAvailable(emptyPaths)).toBe(false);
			expect(await rooProvider.discoverSessions(emptyPaths)).toEqual([]);
			expect(await contProvider.isAvailable(emptyPaths)).toBe(false);
			expect(await contProvider.discoverSessions(emptyPaths)).toEqual([]);

			const clinePaths = createStagedPaths(
				"cline",
				path.join(HARNESSES_FIXTURES, "cline"),
			);
			const clineUsage = await clineProvider.readUsage(clinePaths);
			expect(clineUsage.available).toBe(true);
			expect(clineUsage.harness).toBe("cline");
			expect(clineUsage.records.length).toBeGreaterThan(0);

			const rooPaths = createStagedPaths(
				"roo",
				path.join(HARNESSES_FIXTURES, "roo"),
			);
			const rooSessions = await rooProvider.discoverSessions(rooPaths);
			expect(rooSessions.length).toBeGreaterThan(0);

			const contPaths = createStagedPaths(
				"continue",
				path.join(HARNESSES_FIXTURES, "continue"),
			);
			const contUsage = await contProvider.readUsage(contPaths);
			expect(contUsage.available).toBe(true);
			expect(contUsage.harness).toBe("continue");
			expect(contUsage.records.length).toBeGreaterThan(0);
		});
	});
});
