import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { AiderProvider } from "../../../src/providers/aider";
import { ClaudeProvider } from "../../../src/providers/claude";
import { GooseProvider } from "../../../src/providers/goose";
import { OpenHandsProvider } from "../../../src/providers/openhands";
import { seedGooseDb } from "../../fixtures/helpers/sqlite-fixtures";

describe("Milestone 3 Batch 1: Major CLI & Autonomous Agents", () => {
	const tmpDir = path.join(
		os.tmpdir(),
		`ct-cli-agents-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// =========================================================================
	// 1. Claude Code Provider
	// =========================================================================
	describe("Claude Code CLI Provider (Front & Center)", () => {
		test("CLAUDE-01: Metadata adheres to specification and color is #D97706", () => {
			const provider = new ClaudeProvider();
			expect(provider.metadata.id).toBe("claude");
			expect(provider.metadata.displayName).toBe("Claude Code");
			expect(provider.metadata.shortLabel).toBe("Claude");
			expect(provider.metadata.color).toBe("#D97706");
			expect(provider.metadata.defaultEnabled).toBe(true);
		});

		test("CLAUDE-02: Discovers projects and sessions across platform paths (macOS, Linux, Windows)", async () => {
			const mockHome = path.join(tmpDir, "claude-mock-home");
			const projectsDir = path.join(
				mockHome,
				".claude",
				"projects",
				"-Users-test-my-app",
			);
			const subagentsDir = path.join(projectsDir, "sess-1234", "subagents");
			mkdirSync(subagentsDir, { recursive: true });

			const mainSessionFile = path.join(projectsDir, "sess-1234.jsonl");
			const subagentSessionFile = path.join(subagentsDir, "sub-5678.jsonl");

			const mainData = [
				{
					type: "user",
					sessionId: "sess-1234",
					uuid: "u1",
					cwd: "/Users/test/my-app",
					timestamp: "2026-03-15T10:00:00.000Z",
					message: { role: "user", content: "Build login" },
				},
				{
					type: "assistant",
					sessionId: "sess-1234",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-3-7-sonnet",
						usage: {
							input_tokens: 1200,
							cache_read_input_tokens: 8000,
							cache_creation_input_tokens: 500,
							output_tokens: 400,
						},
						content: [
							{ type: "thinking", thinking: "Analyzing auth requirements..." },
							{ type: "text", text: "Creating auth.ts." },
							{
								type: "tool_use",
								id: "t1",
								name: "write_file",
								input: { path: "auth.ts" },
							},
						],
					},
					timestamp: "2026-03-15T10:00:05.000Z",
				},
			];

			const subData = [
				{
					type: "user",
					sessionId: "sub-5678",
					isSidechain: true,
					message: { role: "user", content: "Subagent prompt" },
				},
				{
					type: "assistant",
					sessionId: "sub-5678",
					isSidechain: true,
					message: {
						id: "sub-msg-1",
						role: "assistant",
						model: "claude-3-5-haiku",
						usage: { input_tokens: 300, output_tokens: 80 },
						content: [{ type: "text", text: "Subagent done." }],
					},
				},
			];

			writeFileSync(
				mainSessionFile,
				mainData.map((d) => JSON.stringify(d)).join("\n"),
			);
			writeFileSync(
				subagentSessionFile,
				subData.map((d) => JSON.stringify(d)).join("\n"),
			);

			// Test macOS mock
			const macEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: mockHome,
			});
			const macPaths = new DefaultPlatformPathService(macEnv);
			const claudeMac = new ClaudeProvider();

			expect(await claudeMac.isAvailable(macPaths)).toBe(true);
			const sessions = await claudeMac.discoverSessions(macPaths);
			expect(sessions.length).toBe(2);

			const mainSess = sessions.find((s) => s.sessionId === "sess-1234");
			expect(mainSess).toBeDefined();
			expect(mainSess?.cwd).toBe("/Users/test/my-app");
			expect(mainSess?.harness).toBe("claude");

			const subSess = sessions.find((s) => s.sessionId === "sub-5678");
			expect(subSess).toBeDefined();

			// Test Windows mock path resolution
			const winEnv = new MockOsEnvProvider({
				platform: "win32",
				home: mockHome,
				env: {
					USERPROFILE: mockHome,
					CLAUDE_CONFIG_DIR: path.join(mockHome, ".claude"),
				},
			});
			const winPaths = new DefaultPlatformPathService(winEnv);
			expect(await claudeMac.isAvailable(winPaths)).toBe(true);
		});

		test("CLAUDE-03: Usage extraction correctly differentiates prompt caching and reasoning tokens", async () => {
			const mockHome = path.join(tmpDir, "claude-usage-home");
			const projectsDir = path.join(
				mockHome,
				".claude",
				"projects",
				"-project-a",
			);
			mkdirSync(projectsDir, { recursive: true });

			const sessionFile = path.join(projectsDir, "session-usage.jsonl");
			const sessionLines = [
				{
					type: "user",
					sessionId: "session-usage",
					uuid: "u1",
					timestamp: "2026-03-15T12:00:00.000Z",
					message: { role: "user", content: "Optimize database queries" },
				},
				// Progressive assistant message chunk 1 (thinking)
				{
					type: "assistant",
					sessionId: "session-usage",
					requestId: "req-1",
					uuid: "asst-uuid-1",
					timestamp: "2026-03-15T12:00:05.000Z",
					message: {
						id: "msg-stream-1",
						role: "assistant",
						model: "claude-3-7-sonnet-20250219",
						content: [
							{
								type: "thinking",
								thinking:
									"We should create an index on user_id and optimize joins.",
							},
						],
						usage: {
							input_tokens: 4500,
							cache_read_input_tokens: 32000,
							cache_creation_input_tokens: 1500,
							output_tokens: 650,
						},
					},
					costUSD: 0.085,
				},
				// Progressive assistant message chunk 2 (same requestId & message.id - must be deduplicated!)
				{
					type: "assistant",
					sessionId: "session-usage",
					requestId: "req-1",
					uuid: "asst-uuid-2",
					timestamp: "2026-03-15T12:00:06.000Z",
					message: {
						id: "msg-stream-1",
						role: "assistant",
						model: "claude-3-7-sonnet-20250219",
						content: [{ type: "text", text: "Indexes created successfully." }],
						usage: {
							input_tokens: 4500,
							cache_read_input_tokens: 32000,
							cache_creation_input_tokens: 1500,
							output_tokens: 650,
						},
					},
					costUSD: 0.085,
				},
			];

			writeFileSync(
				sessionFile,
				sessionLines.map((l) => JSON.stringify(l)).join("\n"),
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: mockHome,
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const claude = new ClaudeProvider();

			const usage = await claude.readUsage(paths);
			expect(usage.records.length).toBe(1); // Deduplication works: exactly 1 record, not 2!

			const rec = usage.records[0];
			expect(rec).toBeDefined();
			expect(rec?.harness).toBe("claude");
			expect(rec?.sessionId).toBe("session-usage");
			expect(rec?.model).toBe("claude-3-7-sonnet-20250219");

			// Anthropic prompt caching verification:
			// inputTokens MUST be 4500 (already uncached prompt tokens, NOT subtracted by cacheRead)
			expect(rec?.inputTokens).toBe(4500);
			expect(rec?.cacheReadTokens).toBe(32000);
			expect(rec?.cacheWriteTokens).toBe(1500);
			expect(rec?.outputTokens).toBe(650);
			// Reasoning tokens extracted from thinking content block:
			expect(rec?.reasoningTokens).toBeGreaterThan(0);
			expect(rec?.costUsd).toBe(0.085);
			expect(usage.messages.get("session-usage")).toBe(1);
		});

		test("CLAUDE-04: Transcripts reconstruct user prompts, thinking, tool calls, and results", async () => {
			const mockHome = path.join(tmpDir, "claude-transcript-home");
			const projectsDir = path.join(
				mockHome,
				".claude",
				"projects",
				"-test-transcript",
			);
			mkdirSync(projectsDir, { recursive: true });

			const sessionFile = path.join(projectsDir, "sess-tr-1.jsonl");
			const events = [
				{
					type: "user",
					sessionId: "sess-tr-1",
					uuid: "u-1",
					timestamp: "2026-03-15T14:00:00.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "Run lint check" }],
					},
				},
				{
					type: "assistant",
					sessionId: "sess-tr-1",
					uuid: "a-1",
					timestamp: "2026-03-15T14:00:02.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "I will run bun run check." },
							{
								type: "tool_use",
								id: "tool-1",
								name: "run_command",
								input: { command: "bun run check" },
							},
						],
					},
				},
				{
					type: "attachment",
					sessionId: "sess-tr-1",
					uuid: "att-1",
					attachment: {
						toolUseID: "tool-1",
						exitCode: 0,
						stdout: "Checked 100 files, 0 errors found.",
					},
					timestamp: "2026-03-15T14:00:05.000Z",
				},
				{
					type: "assistant",
					sessionId: "sess-tr-1",
					uuid: "a-2",
					timestamp: "2026-03-15T14:00:06.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "All checks passed cleanly!" }],
					},
				},
			];

			writeFileSync(
				sessionFile,
				events.map((e) => JSON.stringify(e)).join("\n"),
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: mockHome,
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const claude = new ClaudeProvider();

			const transcript = await claude.readTranscript(paths, "sess-tr-1");
			expect(transcript).not.toBeNull();
			expect(transcript?.sessionId).toBe("sess-tr-1");
			expect(transcript?.title).toContain("Run lint check");

			const items = transcript?.items ?? [];
			expect(items.length).toBe(5);

			// Item 0: User prompt
			expect(items[0]?.role).toBe("user");
			expect(items[0]?.text).toBe("Run lint check");

			// Item 1: Assistant text before tool call
			expect(items[1]?.role).toBe("assistant");
			expect(items[1]?.text).toBe("I will run bun run check.");

			// Item 2: Tool call
			expect(items[2]?.role).toBe("tool");
			expect(items[2]?.kind).toBe("tool_call");
			expect(items[2]?.name).toBe("run_command");
			expect(items[2]?.category).toBe("command");

			// Item 3: Tool result
			expect(items[3]?.role).toBe("tool");
			expect(items[3]?.kind).toBe("tool_result");
			expect(items[3]?.output).toBe("Checked 100 files, 0 errors found.");

			// Item 4: Final assistant message
			expect(items[4]?.role).toBe("assistant");
			expect(items[4]?.text).toBe("All checks passed cleanly!");
			expect(items[4]?.phase).toBe("final");
		});

		test("CLAUDE-05: Isolated ~/.claude compatibility test with multi-project sessions", async () => {
			const mockHome = path.join(tmpDir, "claude-compat-home");
			const projectDir = path.join(
				mockHome,
				".claude",
				"projects",
				"-Users-dev-compat-app",
			);
			mkdirSync(projectDir, { recursive: true });

			writeFileSync(
				path.join(projectDir, "compat-sess-1.jsonl"),
				[
					JSON.stringify({
						type: "user",
						sessionId: "compat-sess-1",
						uuid: "u-compat-1",
						cwd: "/Users/dev/compat-app",
						timestamp: "2026-04-01T10:00:00.000Z",
						message: { role: "user", content: "Summarize build errors" },
					}),
					JSON.stringify({
						type: "assistant",
						sessionId: "compat-sess-1",
						timestamp: "2026-04-01T10:00:05.000Z",
						message: {
							id: "msg-compat-1",
							role: "assistant",
							model: "claude-sonnet-4-5",
							usage: {
								input_tokens: 600,
								output_tokens: 150,
							},
							content: [{ type: "text", text: "No build errors remain." }],
						},
					}),
				].join("\n"),
			);

			const paths = new DefaultPlatformPathService(
				new MockOsEnvProvider({ platform: "darwin", home: mockHome }),
			);
			const claude = new ClaudeProvider();
			const isAvail = await claude.isAvailable(paths);
			expect(isAvail).toBe(true);

			const sessions = await claude.discoverSessions(paths);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.sessionId).toBe("compat-sess-1");

			const usage = await claude.readUsage(paths);
			expect(usage.harness).toBe("claude");
			expect(usage.records).toHaveLength(1);
			expect(usage.records[0]?.inputTokens).toBe(600);
			expect(usage.records[0]?.outputTokens).toBe(150);
		});

		test("CLAUDE-06: Fallback to stats-cache.json when projects directory has no session files", async () => {
			const mockHome = path.join(tmpDir, "claude-cache-home");
			const claudeDir = path.join(mockHome, ".claude");
			mkdirSync(claudeDir, { recursive: true });

			const statsCache = {
				version: 2,
				lastComputedDate: "2026-03-15",
				modelUsage: {
					"claude-3-7-sonnet": {
						inputTokens: 10000,
						outputTokens: 2500,
						cacheReadInputTokens: 50000,
						cacheCreationInputTokens: 3000,
						costUSD: 0.45,
					},
				},
			};
			writeFileSync(
				path.join(claudeDir, "stats-cache.json"),
				JSON.stringify(statsCache),
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: mockHome,
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const claude = new ClaudeProvider();

			expect(await claude.isAvailable(paths)).toBe(true);
			const usage = await claude.readUsage(paths);
			expect(usage.records.length).toBe(1);
			expect(usage.records[0]?.inputTokens).toBe(10000);
			expect(usage.records[0]?.costUsd).toBe(0.45);
		});
	});

	// =========================================================================
	// 2. Aider Provider
	// =========================================================================
	describe("Aider CLI Provider", () => {
		test("AIDER-01: Metadata and availability", () => {
			const aider = new AiderProvider();
			expect(aider.metadata.id).toBe("aider");
			expect(aider.metadata.displayName).toBe("Aider");
			expect(aider.metadata.shortLabel).toBe("Aid");
			expect(aider.metadata.defaultEnabled).toBe(true);
		});

		test("AIDER-02: Parses .aider.chat.history.md and extracts multi-session boundaries", async () => {
			const projectDir = path.join(tmpDir, "aider-project");
			mkdirSync(projectDir, { recursive: true });

			const historyMarkdown = `# aider chat started at 2026-03-15 09:00:00

#### Session 1 user prompt

> git status
> Clean working tree

Assistant reply for session 1.

# aider chat started at 2026-03-15 14:30:00

#### Session 2 user prompt

> /test
> PASS

Assistant reply for session 2.
`;
			writeFileSync(
				path.join(projectDir, ".aider.chat.history.md"),
				historyMarkdown,
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "linux",
				home: tmpDir,
				env: { AIDER_HOME: projectDir },
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const aider = new AiderProvider();

			expect(await aider.isAvailable(paths)).toBe(true);
			const sessions = await aider.discoverSessions(paths);
			expect(sessions.length).toBe(2);

			const sess1 = sessions.find((s) => s.sessionId.includes("09-00-00"));
			const sess2 = sessions.find((s) => s.sessionId.includes("14-30-00"));
			expect(sess1).toBeDefined();
			expect(sess2).toBeDefined();

			if (!sess1 || !sess2) {
				throw new Error("Expected both sessions to be discovered");
			}

			const tr1 = await aider.readTranscript(paths, sess1.sessionId);
			expect(tr1).not.toBeNull();
			expect(tr1?.title).toBe("Session 1 user prompt");
			expect(tr1?.items.length).toBe(4); // user, tool_call (git status), tool_result (Clean working tree), assistant

			const tr2 = await aider.readTranscript(paths, sess2.sessionId);
			expect(tr2).not.toBeNull();
			expect(tr2?.title).toBe("Session 2 user prompt");
		});

		test("AIDER-03: Parses --analytics-log JSONL entries accurately", async () => {
			const projectDir = path.join(tmpDir, "aider-analytics-project");
			mkdirSync(projectDir, { recursive: true });

			const analyticsJsonl = [
				{
					timestamp: "2026-03-15T10:00:00.000Z",
					session_id: "2026-03-15-10-00-00",
					main_model: "claude-3-5-sonnet",
					tokens_in: 5400,
					tokens_out: 1200,
					tokens_cached: 1800,
					cost: 0.034,
				},
				{
					timestamp: "2026-03-15T10:15:00.000Z",
					session_id: "2026-03-15-10-00-00",
					main_model: "claude-3-5-sonnet",
					tokens_in: 6100,
					tokens_out: 950,
					tokens_cached: 2400,
					cost: 0.029,
				},
			];

			writeFileSync(
				path.join(projectDir, "analytics.jsonl"),
				analyticsJsonl.map((l) => JSON.stringify(l)).join("\n"),
			);
			writeFileSync(
				path.join(projectDir, ".aider.chat.history.md"),
				"# aider chat started at 2026-03-15 10:00:00\n\n#### Prompt\n\nAnswer",
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: tmpDir,
				env: { AIDER_HOME: projectDir },
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const aider = new AiderProvider();

			const usage = await aider.readUsage(paths);
			expect(usage.records.length).toBe(2);

			const r0 = usage.records[0];
			expect(r0).toBeDefined();
			expect(r0?.inputTokens).toBe(5400);
			expect(r0?.outputTokens).toBe(1200);
			expect(r0?.cacheReadTokens).toBe(1800);
			expect(r0?.costUsd).toBe(0.034);
			expect(r0?.costEstimated).toBe(false);
		});
	});

	// =========================================================================
	// 3. Goose Provider
	// =========================================================================
	describe("Goose CLI & Desktop Provider", () => {
		test("GOOSE-01: Metadata and availability", () => {
			const goose = new GooseProvider();
			expect(goose.metadata.id).toBe("goose");
			expect(goose.metadata.displayName).toBe("Goose");
			expect(goose.metadata.shortLabel).toBe("Goose");
		});

		test("GOOSE-02: Parses SQLite sessions.db (sessions, messages, model_config_json)", async () => {
			const gooseDir = path.join(tmpDir, "goose-data");
			mkdirSync(gooseDir, { recursive: true });
			const dbPath = path.join(gooseDir, "sessions.db");

			const db = seedGooseDb(dbPath, {
				sessions: [
					{
						id: "goose-sess-alpha",
						description: "Build microservice",
						workingDir: "/workspace/backend",
						createdAt: 1773500000000,
						updatedAt: 1773500120000,
						messages: [
							{
								role: "user",
								content: "Create server entrypoint",
								accumulatedInputTokens: 0,
								accumulatedOutputTokens: 0,
								createdAt: 1773500000000,
							},
							{
								role: "assistant",
								content: "server.ts created.",
								accumulatedInputTokens: 3500,
								accumulatedOutputTokens: 450,
								modelConfig: {
									model: "claude-3-7-sonnet",
									provider: "anthropic",
								},
								createdAt: 1773500060000,
							},
							{
								role: "user",
								content: "Add healthcheck",
								accumulatedInputTokens: 3500,
								accumulatedOutputTokens: 450,
								createdAt: 1773500070000,
							},
							{
								role: "assistant",
								content: "Healthcheck route added.",
								accumulatedInputTokens: 7200, // Cumulative: delta is 7200 - 3500 = 3700
								accumulatedOutputTokens: 900, // Cumulative: delta is 900 - 450 = 450
								modelConfig: {
									model: "claude-3-7-sonnet",
									provider: "anthropic",
								},
								createdAt: 1773500120000,
							},
						],
					},
				],
			});
			db.close();

			const mockEnv = new MockOsEnvProvider({
				platform: "darwin",
				home: tmpDir,
				env: { GOOSE_PATH_ROOT: gooseDir },
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const goose = new GooseProvider();

			expect(await goose.isAvailable(paths)).toBe(true);
			const sessions = await goose.discoverSessions(paths);
			expect(sessions.length).toBe(1);
			expect(sessions[0]?.sessionId).toBe("goose-sess-alpha");
			expect(sessions[0]?.cwd).toBe("/workspace/backend");

			// Usage records: verify delta token calculation
			const usage = await goose.readUsage(paths);
			expect(usage.records.length).toBe(2);

			expect(usage.records[0]?.inputTokens).toBe(3500);
			expect(usage.records[0]?.outputTokens).toBe(450);

			expect(usage.records[1]?.inputTokens).toBe(3700); // 7200 - 3500
			expect(usage.records[1]?.outputTokens).toBe(450); // 900 - 450

			expect(usage.messages.get("goose-sess-alpha")).toBe(2);

			// Transcript reconstruction
			const tr = await goose.readTranscript(paths, "goose-sess-alpha");
			expect(tr).not.toBeNull();
			expect(tr?.items.length).toBe(4);
			expect(tr?.items[0]?.role).toBe("user");
			expect(tr?.items[1]?.role).toBe("assistant");
			expect(tr?.items[2]?.role).toBe("user");
			expect(tr?.items[3]?.role).toBe("assistant");
			expect(tr?.items[3]?.phase).toBe("final");
		});

		test("GOOSE-03: Deduplication prioritizes SQLite over legacy JSONL", async () => {
			const gooseDir = path.join(tmpDir, "goose-dedup");
			mkdirSync(gooseDir, { recursive: true });
			const dbPath = path.join(gooseDir, "sessions.db");

			const db = seedGooseDb(dbPath, {
				sessions: [
					{
						id: "shared-sess-id",
						description: "From SQLite",
						workingDir: "/workspace/sqlite-version",
						messages: [
							{
								role: "assistant",
								content: "SQLite assistant",
								accumulatedInputTokens: 500,
								accumulatedOutputTokens: 100,
							},
						],
					},
				],
			});
			db.close();

			// Add legacy session with same ID
			const legacyDir = path.join(gooseDir, "legacy-sessions");
			mkdirSync(legacyDir, { recursive: true });
			writeFileSync(
				path.join(legacyDir, "legacy.jsonl"),
				`${JSON.stringify({
					sessionId: "shared-sess-id",
					working_dir: "/workspace/legacy-version",
					input_tokens: 100,
					output_tokens: 50,
				})}\n`,
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "linux",
				home: tmpDir,
				env: { GOOSE_PATH_ROOT: gooseDir },
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const goose = new GooseProvider();

			const sessions = await goose.discoverSessions(paths);
			const matches = sessions.filter((s) => s.sessionId === "shared-sess-id");
			expect(matches.length).toBe(1);
			expect(matches[0]?.cwd).toBe("/workspace/sqlite-version");

			const usage = await goose.readUsage(paths);
			const recs = usage.records.filter(
				(r) => r.sessionId === "shared-sess-id",
			);
			expect(recs.length).toBe(1);
			expect(recs[0]?.inputTokens).toBe(500);
		});
	});

	// =========================================================================
	// 4. OpenHands Provider
	// =========================================================================
	describe("OpenHands Provider", () => {
		test("OPENHANDS-01: Metadata and availability", () => {
			const openhands = new OpenHandsProvider();
			expect(openhands.metadata.id).toBe("openhands");
			expect(openhands.metadata.displayName).toBe("OpenHands");
			expect(openhands.metadata.shortLabel).toBe("OH");
		});

		test("OPENHANDS-02: Parses base_state.json and fine-grained event streams", async () => {
			const baseDir = path.join(
				tmpDir,
				"openhands-store",
				"conversations",
				"conv-999",
			);
			const eventsDir = path.join(baseDir, "events");
			mkdirSync(eventsDir, { recursive: true });

			const baseState = {
				conversation_id: "conv-999",
				workspace_path: "/workspace/openhands-demo",
				agent_name: "CodeActAgent",
				model_name: "claude-3-5-sonnet",
				metrics: {
					accumulated_cost: 0.08,
					total_tokens: 22000,
					prompt_tokens: 18000,
					completion_tokens: 4000,
				},
				created_at: "2026-03-15T15:00:00Z",
			};
			writeFileSync(
				path.join(baseDir, "base_state.json"),
				JSON.stringify(baseState),
			);

			const event0 = {
				id: 0,
				timestamp: "2026-03-15T15:00:05Z",
				source: "user",
				message: "Fix test suite failures",
			};
			const event1 = {
				id: 1,
				timestamp: "2026-03-15T15:00:20Z",
				source: "agent",
				action: "run",
				thought: "Running test runner to see failures",
				args: { command: "bun test" },
				metrics: {
					prompt_tokens: 3200,
					completion_tokens: 280,
					cost: 0.012,
				},
			};
			const event2 = {
				id: 2,
				timestamp: "2026-03-15T15:00:25Z",
				source: "environment",
				observation: "1 failure in auth.test.ts",
			};
			const event3 = {
				id: 3,
				timestamp: "2026-03-15T15:00:40Z",
				source: "agent",
				action: "edit",
				thought: "Fixing auth logic",
				args: { file: "auth.ts" },
				metrics: {
					prompt_tokens: 4100,
					completion_tokens: 350,
					cost: 0.016,
				},
			};

			writeFileSync(
				path.join(eventsDir, "event-0.json"),
				JSON.stringify(event0),
			);
			writeFileSync(
				path.join(eventsDir, "event-1.json"),
				JSON.stringify(event1),
			);
			writeFileSync(
				path.join(eventsDir, "event-2.json"),
				JSON.stringify(event2),
			);
			writeFileSync(
				path.join(eventsDir, "event-3.json"),
				JSON.stringify(event3),
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "linux",
				home: tmpDir,
				env: { OPENHANDS_DIR: path.join(tmpDir, "openhands-store") },
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const openhands = new OpenHandsProvider();

			expect(await openhands.isAvailable(paths)).toBe(true);
			const sessions = await openhands.discoverSessions(paths);
			expect(sessions.length).toBe(1);
			expect(sessions[0]?.sessionId).toBe("conv-999");
			expect(sessions[0]?.cwd).toBe("/workspace/openhands-demo");

			const usage = await openhands.readUsage(paths);
			// 2 agent events with metrics
			expect(usage.records.length).toBe(2);
			expect(usage.records[0]?.inputTokens).toBe(3200);
			expect(usage.records[0]?.outputTokens).toBe(280);
			expect(usage.records[0]?.costUsd).toBe(0.012);

			expect(usage.records[1]?.inputTokens).toBe(4100);
			expect(usage.records[1]?.outputTokens).toBe(350);
			expect(usage.records[1]?.costUsd).toBe(0.016);

			expect(usage.messages.get("conv-999")).toBe(1);

			// Transcript checks
			const tr = await openhands.readTranscript(paths, "conv-999");
			expect(tr).not.toBeNull();
			expect(tr?.items.length).toBe(6); // user, thought, tool_call, tool_result, thought, tool_call
			expect(tr?.items[0]?.role).toBe("user");
			expect(tr?.items[0]?.text).toBe("Fix test suite failures");
		});

		test("OPENHANDS-03: Fallbacks to base_state.metrics when no event files exist", async () => {
			const baseDir = path.join(
				tmpDir,
				"openhands-fallback",
				"conversations",
				"conv-fallback",
			);
			mkdirSync(baseDir, { recursive: true });

			const baseState = {
				conversation_id: "conv-fallback",
				workspace_path: "/workspace/fallback",
				model_name: "gpt-4o",
				metrics: {
					prompt_tokens: 5000,
					completion_tokens: 1000,
					accumulated_cost: 0.045,
				},
				created_at: "2026-03-15T16:00:00Z",
			};
			writeFileSync(
				path.join(baseDir, "base_state.json"),
				JSON.stringify(baseState),
			);

			const mockEnv = new MockOsEnvProvider({
				platform: "win32",
				home: tmpDir,
				env: {
					USERPROFILE: tmpDir,
					APPDATA: tmpDir,
					OPENHANDS_DIR: path.join(tmpDir, "openhands-fallback"),
				},
			});
			const paths = new DefaultPlatformPathService(mockEnv);
			const openhands = new OpenHandsProvider();

			const usage = await openhands.readUsage(paths);
			expect(usage.records.length).toBe(1);
			expect(usage.records[0]?.inputTokens).toBe(5000);
			expect(usage.records[0]?.outputTokens).toBe(1000);
			expect(usage.records[0]?.costUsd).toBe(0.045);
		});
	});

	// =========================================================================
	// 5. Fingerprint & Determinism
	// =========================================================================
	describe("Cache Fingerprinting & Watch Paths", () => {
		test("BATCH1-FP-01: Fingerprint follows v12:count:sha256 format across all 4 providers", async () => {
			const fpHome = path.join(tmpDir, "fp-isolated-home");
			mkdirSync(fpHome, { recursive: true });
			const isolatedPaths = new DefaultPlatformPathService(
				new MockOsEnvProvider({ platform: "darwin", home: fpHome }),
			);
			const providers = [
				new ClaudeProvider(),
				new AiderProvider(),
				new GooseProvider(),
				new OpenHandsProvider(),
			];

			for (const p of providers) {
				const fp = await p.computeFingerprint(isolatedPaths);
				expect(fp).toMatch(/^v12:0:[0-9a-f]{64}$/);

				const watch = p.getWatchPaths(isolatedPaths);
				expect(Array.isArray(watch)).toBe(true);
			}
		});
	});
});
