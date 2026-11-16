import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { AntigravityProvider } from "../../../src/providers/antigravity";
import { CodexProvider } from "../../../src/providers/codex";
import { CommandCodeProvider } from "../../../src/providers/commandcode";
import { DshProvider } from "../../../src/providers/dsh";
import { OpenCodeProvider } from "../../../src/providers/opencode";
import {
	writeJsonlFile,
	writeZstdJsonlFile,
} from "../../fixtures/helpers/jsonl-generator";
import { withSandboxEnvironment } from "../../fixtures/helpers/mock-env";
import {
	buildAntigravityGenMetadata,
	buildAntigravityStepPayload,
	buildAntigravityTrajectoryMetadata,
	protoBytes,
	protoConcat,
	protoVarint,
} from "../../fixtures/helpers/protobuf-builder";
import {
	closeDatabase,
	createDatabase,
	seedAntigravityDb,
	seedAntigravitySummariesDb,
} from "../../fixtures/helpers/sqlite-fixtures";

/**
 * Scopes environment variables for a test run and guarantees full restoration.
 */
async function withScopedEnv<T>(
	envVars: Record<string, string>,
	fn: () => Promise<T> | T,
): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, val] of Object.entries(envVars)) {
		saved[key] = process.env[key];
		process.env[key] = val;
	}
	try {
		return await fn();
	} finally {
		for (const [key, val] of Object.entries(saved)) {
			if (val === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = val;
			}
		}
	}
}

// ============================================================================
// MODULE A: Codex Provider (`codex`)
// ============================================================================

describe("Core Provider: Codex (Feature 10)", () => {
	// --- Tier 1: Happy Path ---

	test("CDX-T1-01: Metadata and Contract Validation", () => {
		const provider = new CodexProvider();
		expect(provider.metadata.id).toBe("codex");
		expect(provider.metadata.displayName).toBe("Codex");
		expect(provider.metadata.shortLabel).toBe("Codex");
		expect(provider.metadata.color).toBeDefined();
		expect(provider.metadata.defaultEnabled).toBe(true);

		expect(typeof provider.isAvailable).toBe("function");
		expect(typeof provider.discoverSessions).toBe("function");
		expect(typeof provider.readUsage).toBe("function");
		expect(typeof provider.readTranscript).toBe("function");
		expect(typeof provider.computeFingerprint).toBe("function");
		expect(typeof provider.getWatchPaths).toBe("function");
	});

	test("CDX-T1-02: Isolated Sandbox Session Discovery", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(codexDir, "sessions", "2026", "03", "15");
				mkdirSync(sessionDir, { recursive: true });

				const rolloutPath = path.join(
					sessionDir,
					"rollout-2026-03-15T10-00-00-codex-sess-1.jsonl",
				);
				writeJsonlFile(rolloutPath, [
					{
						type: "session_meta",
						payload: {
							id: "codex-sess-1",
							cwd: "/workspace/codex-project",
							timestamp: "2026-03-15T10:00:00.000Z",
						},
					},
					{
						type: "turn_context",
						payload: { model: "gpt-5" },
					},
				]);

				const provider = new CodexProvider();
				const available = await provider.isAvailable(mockPaths);
				expect(available).toBe(true);

				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);
				expect(items[0]!.sessionId).toBe("codex-sess-1");
				expect(items[0]!.harness).toBe("codex");
				expect(items[0]!.cwd).toBe("/workspace/codex-project");
				expect(items[0]!.mtimeMs).toBeGreaterThan(0);
				expect(items[0]!.sizeBytes).toBeGreaterThan(0);
				expect(items[0]!.filePath).toContain(
					"rollout-2026-03-15T10-00-00-codex-sess-1.jsonl",
				);
			});
		});
	});

	test("CDX-T1-03: Single Session Usage Record Extraction with Token Math", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(codexDir, "sessions");
				mkdirSync(sessionDir, { recursive: true });

				const rolloutPath = path.join(
					sessionDir,
					"rollout-2026-03-15T10-00-00-codex-sess-1.jsonl",
				);
				writeJsonlFile(rolloutPath, [
					{
						type: "session_meta",
						payload: {
							id: "codex-sess-1",
							cwd: "/workspace/codex-project",
						},
					},
					{
						type: "turn_context",
						payload: { model: "gpt-5" },
					},
					{
						type: "response_item",
						payload: {
							type: "message",
							role: "user",
							content: "Run tests",
						},
					},
					{
						type: "token_usage_record",
						turn_id: "turn-1",
						payload: {
							usage: {
								input_tokens: 2000,
								output_tokens: 400,
								cached_input_tokens: 1200,
								reasoning_output_tokens: 60,
							},
						},
					},
				]);

				const provider = new CodexProvider();
				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);

				const result = await provider.readUsage(mockPaths, items[0]);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.sessionId).toBe("codex-sess-1");
				expect(result.records[0]!.model).toBe("gpt-5");
				// inputTokens is uncached: 2000 - 1200 = 800
				expect(result.records[0]!.inputTokens).toBe(800);
				expect(result.records[0]!.outputTokens).toBe(400);
				expect(result.records[0]!.cacheReadTokens).toBe(1200);
				expect(result.records[0]!.cacheWriteTokens).toBe(0);
				expect(result.records[0]!.reasoningTokens).toBe(60);
				expect(result.messages.get("codex-sess-1")).toBe(1);
			});
		});
	});

	test("CDX-T1-04: Full Directory Sweep & Deduplication Across Archived Sessions", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionsDir = path.join(codexDir, "sessions");
				const archivedDir = path.join(codexDir, "archived_sessions");
				mkdirSync(sessionsDir, { recursive: true });
				mkdirSync(archivedDir, { recursive: true });

				writeJsonlFile(
					path.join(sessionsDir, "rollout-2026-03-15-thread-sess-a.jsonl"),
					[
						{
							type: "session_meta",
							payload: { id: "sess-a", cwd: "/workspace/a" },
						},
						{ type: "turn_context", payload: { model: "gpt-4o" } },
						{
							type: "token_usage_record",
							turn_id: "turn-a1",
							payload: {
								response_id: "resp-a1",
								usage: { input_tokens: 100, output_tokens: 50 },
							},
						},
					],
				);

				writeJsonlFile(
					path.join(archivedDir, "rollout-2026-03-14-thread-sess-b.jsonl"),
					[
						{
							type: "session_meta",
							payload: { id: "sess-b", cwd: "/workspace/b" },
						},
						{ type: "turn_context", payload: { model: "gpt-4o-mini" } },
						{
							type: "token_usage_record",
							turn_id: "turn-b1",
							payload: {
								response_id: "resp-b1",
								usage: { input_tokens: 200, output_tokens: 80 },
							},
						},
					],
				);

				const provider = new CodexProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(2);
				expect(result.warnings.length).toBe(0);
				const sessionIds = result.records.map((r) => r.sessionId).sort();
				expect(sessionIds).toEqual(["sess-a", "sess-b"]);
			});
		});
	});

	test("CDX-T1-05: Single Transcript Reconstruction & Fingerprint Calculation", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionsDir = path.join(codexDir, "sessions");
				mkdirSync(sessionsDir, { recursive: true });

				const rolloutPath = path.join(
					sessionsDir,
					"rollout-2026-03-15-codex-sess-1.jsonl",
				);
				writeJsonlFile(rolloutPath, [
					{
						type: "session_meta",
						payload: { id: "codex-sess-1", cwd: "/workspace/demo" },
					},
					{
						type: "response_item",
						payload: {
							type: "message",
							role: "user",
							content: "Hello assistant",
						},
					},
					{
						type: "response_item",
						payload: {
							type: "message",
							role: "assistant",
							content: "Hello user!",
						},
					},
				]);

				const provider = new CodexProvider();
				const transcript = await provider.readTranscript(
					mockPaths,
					"codex-sess-1",
				);
				expect(transcript).not.toBeNull();
				expect(transcript!.sessionId).toBe("codex-sess-1");
				expect(transcript!.items.length).toBeGreaterThanOrEqual(2);

				const fp = await provider.computeFingerprint(mockPaths);
				expect(fp).toMatch(/^v12:1:[0-9a-f]{64}$/);

				const watchPaths = provider.getWatchPaths(mockPaths);
				expect(watchPaths.some((p) => p.includes("sessions"))).toBe(true);
			});
		});
	});

	// --- Tier 2: Boundary, Corruption & Variations ---

	test("CDX-T2-01: Missing Directories / Completely Unavailable", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const nonexistentDir = path.join(sandbox.rootDir, "nonexistent-codex");
			await withScopedEnv({ CODEX_HOME: nonexistentDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new CodexProvider();

				expect(await provider.isAvailable(mockPaths)).toBe(false);
				expect(await provider.discoverSessions(mockPaths)).toEqual([]);

				const usage = await provider.readUsage(mockPaths);
				expect(usage.available).toBe(false);
				expect(usage.records).toEqual([]);

				expect(await provider.readTranscript(mockPaths, "any-id")).toBeNull();
				expect(await provider.computeFingerprint(mockPaths)).toMatch(
					/^v12:0:[0-9a-f]{64}$/,
				);
				expect(provider.getWatchPaths(mockPaths)).toEqual([]);
			});
		});
	});

	test("CDX-T2-02: Corrupted JSONL Lines and Corrupted Zstd Binary Archive", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionsDir = path.join(codexDir, "sessions");
				mkdirSync(sessionsDir, { recursive: true });

				// Corrupted Zstd file that throws on decompression
				writeFileSync(
					path.join(sessionsDir, "rollout-corrupted.jsonl.zst"),
					Buffer.from("invalid-corrupted-zstd-content"),
				);

				const provider = new CodexProvider();
				// Must not crash; catches error and adds warning
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(result.warnings.length).toBeGreaterThanOrEqual(1);
				expect(
					result.warnings.some((w) =>
						w.toLowerCase().includes("failed to read"),
					),
				).toBe(true);
			});
		});
	});

	test("CDX-T2-03: Boundary Token Metrics & Non-Negative Clamping", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionsDir = path.join(codexDir, "sessions");
				mkdirSync(sessionsDir, { recursive: true });

				const rolloutPath = path.join(
					sessionsDir,
					"rollout-2026-03-15-boundary.jsonl",
				);
				writeJsonlFile(rolloutPath, [
					{
						type: "session_meta",
						payload: { id: "sess-boundary", cwd: "/workspace" },
					},
					{ type: "turn_context", payload: { model: "gpt-4o" } },
					// Cached tokens exceed input tokens -> must clamp input to 0, not negative
					{
						type: "token_usage_record",
						turn_id: "t1",
						payload: {
							response_id: "r1",
							usage: {
								input_tokens: 1000,
								cached_input_tokens: 1500,
								output_tokens: 200,
							},
						},
					},
					// Zero-token record -> should be filtered out by hasTokenUsage
					{
						type: "token_usage_record",
						turn_id: "t2",
						payload: {
							response_id: "r2",
							usage: { input_tokens: 0, output_tokens: 0 },
						},
					},
				]);

				const provider = new CodexProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.inputTokens).toBe(0); // Math.max(0, 1000 - 1500)
				expect(result.records[0]!.outputTokens).toBe(200);
				expect(result.records[0]!.cacheReadTokens).toBe(1500);
			});
		});
	});

	test("CDX-T2-04: Subagent & Guardian Review Origin Detection", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionsDir = path.join(codexDir, "sessions");
				mkdirSync(sessionsDir, { recursive: true });

				writeJsonlFile(path.join(sessionsDir, "rollout-subagent.jsonl"), [
					{
						type: "session_meta",
						payload: {
							id: "sess-subagent",
							source: { subagent: { type: "explorer" } },
						},
					},
					{ type: "turn_context", payload: { model: "gpt-4o" } },
					{
						type: "response_item",
						payload: {
							type: "message",
							role: "user",
							content: "Subagent prompt",
						},
					},
					{
						type: "token_usage_record",
						turn_id: "sub-1",
						payload: {
							response_id: "resp-sub-1",
							usage: { input_tokens: 500, output_tokens: 100 },
						},
					},
				]);

				writeJsonlFile(path.join(sessionsDir, "rollout-guardian.jsonl"), [
					{
						type: "session_meta",
						payload: {
							id: "sess-guardian",
							source: { subagent: { other: "guardian_review" } },
						},
					},
					{ type: "turn_context", payload: { model: "gpt-4o" } },
					{
						type: "token_usage_record",
						turn_id: "guard-1",
						payload: {
							response_id: "resp-guard-1",
							usage: { input_tokens: 300, output_tokens: 50 },
						},
					},
				]);

				const provider = new CodexProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.records.length).toBe(2);

				const subRecord = result.records.find(
					(r) => r.sessionId === "sess-subagent",
				);
				const guardRecord = result.records.find(
					(r) => r.sessionId === "sess-guardian",
				);

				expect(subRecord?.isSubagent).toBe(true);
				expect(subRecord?.isReview).toBeUndefined();

				expect(guardRecord?.isSubagent).toBe(true);
				expect(guardRecord?.isReview).toBe(true);

				// Subagent user turns should not count towards interactive message counts
				expect(result.messages.get("sess-subagent")).toBeUndefined();
			});
		});
	});

	test("CDX-T2-05: Multi-part Rollout Continuations and Zstd (.jsonl.zst) Decompression", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const codexDir = path.join(sandbox.homeDir, ".codex");
			await withScopedEnv({ CODEX_HOME: codexDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionsDir = path.join(codexDir, "sessions");
				mkdirSync(sessionsDir, { recursive: true });

				const baseEvents = [
					{
						type: "session_meta",
						payload: { id: "thread-multi", cwd: "/workspace/multi" },
					},
					{ type: "turn_context", payload: { model: "gpt-4o" } },
					{
						type: "token_usage_record",
						turn_id: "seg1",
						payload: {
							response_id: "r-seg1",
							usage: { input_tokens: 200, output_tokens: 50 },
						},
					},
				];

				const contEvents = [
					{
						type: "session_meta",
						payload: { id: "thread-multi", cwd: "/workspace/multi" },
					},
					{ type: "turn_context", payload: { model: "gpt-4o" } },
					{
						type: "token_usage_record",
						turn_id: "seg2",
						payload: {
							response_id: "r-seg2",
							usage: { input_tokens: 300, output_tokens: 80 },
						},
					},
				];

				writeJsonlFile(
					path.join(
						sessionsDir,
						"rollout-2026-03-15T10-00-00-thread-multi.jsonl",
					),
					baseEvents,
				);
				writeZstdJsonlFile(
					path.join(
						sessionsDir,
						"rollout-2026-03-15T10-01-00-thread-multi_continuation.jsonl.zst",
					),
					contEvents,
				);

				const provider = new CodexProvider();
				const sessions = await provider.discoverSessions(mockPaths);
				// Deduplicated by session id
				expect(sessions.length).toBe(1);
				expect(sessions[0]!.sessionId).toBe("thread-multi");

				const usage = await provider.readUsage(mockPaths);
				expect(usage.records.length).toBe(2);
			});
		});
	});
});

// ============================================================================
// MODULE B: DSH Provider (`dsh`)
// ============================================================================

describe("Core Provider: DSH (Feature 10)", () => {
	// --- Tier 1: Happy Path ---

	test("DSH-T1-01: Metadata and Contract Validation", () => {
		const provider = new DshProvider();
		expect(provider.metadata.id).toBe("dsh");
		expect(provider.metadata.displayName).toBe("DSH");
		expect(provider.metadata.shortLabel).toBe("DSH");
		expect(provider.metadata.color).toBeDefined();
		expect(provider.metadata.defaultEnabled).toBe(true);

		expect(typeof provider.isAvailable).toBe("function");
		expect(typeof provider.discoverSessions).toBe("function");
		expect(typeof provider.readUsage).toBe("function");
		expect(typeof provider.readTranscript).toBe("function");
		expect(typeof provider.computeFingerprint).toBe("function");
		expect(typeof provider.getWatchPaths).toBe("function");
	});

	test("DSH-T1-02: Isolated Sandbox Session Discovery", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(
					dshDir,
					"sessions",
					"--workspace-dsh-project--",
					"session-dsh-1",
				);
				mkdirSync(sessionDir, { recursive: true });

				const logFile = path.join(sessionDir, "session.jsonl");
				writeJsonlFile(logFile, [
					{
						type: "session",
						id: "dsh-sess-1",
						cwd: "/workspace/dsh-project",
						createdAt: "2026-03-15T10:00:00.000Z",
					},
					{
						type: "message",
						role: "user",
						content: "Do work",
					},
				]);

				const provider = new DshProvider();
				expect(await provider.isAvailable(mockPaths)).toBe(true);

				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);
				expect(items[0]!.sessionId).toBe("dsh-sess-1");
				expect(items[0]!.harness).toBe("dsh");
				expect(items[0]!.cwd).toBe("/workspace/dsh-project");
				expect(items[0]!.mtimeMs).toBeGreaterThan(0);
				expect(items[0]!.filePath).toContain("session.jsonl");
			});
		});
	});

	test("DSH-T1-03: Single Session Usage Record Extraction", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(
					dshDir,
					"sessions",
					"--workspace--",
					"dsh-sess-1",
				);
				mkdirSync(sessionDir, { recursive: true });

				const logFile = path.join(sessionDir, "session.jsonl");
				writeJsonlFile(logFile, [
					{
						type: "session",
						id: "dsh-sess-1",
						cwd: "/workspace/dsh-project",
					},
					{
						type: "user/message",
						data: {
							content: "Generate migration script",
						},
					},
					{
						type: "assistant/message",
						id: "msg-dsh-1",
						data: {
							message: {
								source: { provider: "deepseek", model: "deepseek-coder" },
							},
							usage: {
								inputTokens: 1800,
								outputTokens: 500,
								cacheReadTokens: 1000,
								reasoningTokens: 50,
							},
						},
					},
				]);

				const provider = new DshProvider();
				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);

				const result = await provider.readUsage(mockPaths, items[0]);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.model).toBe("deepseek/deepseek-coder");
				expect(result.records[0]!.pricingModel).toBe("deepseek/deepseek-coder");
				expect(result.records[0]!.inputTokens).toBe(1800);
				expect(result.records[0]!.outputTokens).toBe(500);
				expect(result.records[0]!.cacheReadTokens).toBe(1000);
				expect(result.records[0]!.reasoningTokens).toBe(50);
				expect(result.messages.get("dsh-sess-1")).toBe(1);
			});
		});
	});

	test("DSH-T1-04: Full Directory Sweep Across Multiple Workspace Directories", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const ws1 = path.join(dshDir, "sessions", "--workspace-a--", "s1");
				const ws2 = path.join(dshDir, "sessions", "--workspace-b--", "s2");
				mkdirSync(ws1, { recursive: true });
				mkdirSync(ws2, { recursive: true });

				writeJsonlFile(path.join(ws1, "session.jsonl"), [
					{ type: "session", id: "sess-1", cwd: "/a" },
					{
						type: "assistant/message",
						id: "m1",
						data: {
							message: {
								source: { provider: "deepseek", model: "deepseek-chat" },
							},
							usage: { inputTokens: 500, outputTokens: 100 },
						},
					},
				]);

				writeJsonlFile(path.join(ws2, "session.jsonl"), [
					{ type: "session", id: "sess-2", cwd: "/b" },
					{
						type: "assistant/message",
						id: "m2",
						data: {
							message: {
								source: { provider: "deepseek", model: "deepseek-chat" },
							},
							usage: { inputTokens: 800, outputTokens: 150 },
						},
					},
				]);

				const provider = new DshProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(2);
				expect(result.warnings.length).toBe(0);
			});
		});
	});

	test("DSH-T1-05: Single Transcript Reconstruction & Fingerprint Calculation", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(
					dshDir,
					"sessions",
					"--workspace--",
					"dsh-sess-1",
				);
				mkdirSync(sessionDir, { recursive: true });

				writeJsonlFile(path.join(sessionDir, "session.jsonl"), [
					{ type: "session", id: "dsh-sess-1", cwd: "/workspace" },
					{ type: "user/message", data: { content: "User prompt" } },
					{
						type: "assistant/message",
						data: { message: { content: "Assistant reply" } },
					},
				]);

				const provider = new DshProvider();
				const transcript = await provider.readTranscript(
					mockPaths,
					"dsh-sess-1",
				);
				expect(transcript).not.toBeNull();
				expect(transcript!.sessionId).toBe("dsh-sess-1");
				expect(transcript!.items.length).toBeGreaterThanOrEqual(2);

				const fp = await provider.computeFingerprint(mockPaths);
				expect(fp).toMatch(/^v12:1:[0-9a-f]{64}$/);

				const watchPaths = provider.getWatchPaths(mockPaths);
				expect(watchPaths.some((p) => p.includes("sessions"))).toBe(true);
			});
		});
	});

	// --- Tier 2: Boundary, Corruption & Variations ---

	test("DSH-T2-01: Missing Directories / Completely Unavailable", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const nonexistentDir = path.join(sandbox.rootDir, "nonexistent-dsh");
			await withScopedEnv({ DSH_HOME: nonexistentDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new DshProvider();

				expect(await provider.isAvailable(mockPaths)).toBe(false);
				expect(await provider.discoverSessions(mockPaths)).toEqual([]);

				const usage = await provider.readUsage(mockPaths);
				expect(usage.available).toBe(false);
				expect(usage.records).toEqual([]);

				expect(await provider.readTranscript(mockPaths, "missing")).toBeNull();
				expect(await provider.computeFingerprint(mockPaths)).toMatch(
					/^v12:0:[0-9a-f]{64}$/,
				);
				expect(provider.getWatchPaths(mockPaths)).toEqual([]);
			});
		});
	});

	test("DSH-T2-02: Corrupted JSONL Lines and Corrupted Zstd Stream", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(
					dshDir,
					"sessions",
					"--workspace--",
					"s-corrupt",
				);
				mkdirSync(sessionDir, { recursive: true });

				// Corrupted Zstd that throws on decompression
				writeFileSync(
					path.join(sessionDir, "session.v2.jsonl.zstd"),
					Buffer.from("invalid-corrupted-zstd-content"),
				);

				const provider = new DshProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(
					result.warnings.some((w) => w.includes("DSH: failed to read")),
				).toBe(true);
			});
		});
	});

	test("DSH-T2-03: Generational Session Log Superseding (v0 vs v1 vs v3.zstd)", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(
					dshDir,
					"sessions",
					"--workspace--",
					"s-gen",
				);
				mkdirSync(sessionDir, { recursive: true });

				// v0 (plain session.jsonl)
				writeJsonlFile(path.join(sessionDir, "session.jsonl"), [
					{
						type: "session",
						id: "sess-gen",
						createdAt: "2026-03-01T00:00:00Z",
					},
					{
						type: "assistant/message",
						id: "m0",
						data: { usage: { inputTokens: 100, outputTokens: 20 } },
					},
				]);

				// v1
				writeJsonlFile(path.join(sessionDir, "session.v1.jsonl"), [
					{
						type: "session",
						id: "sess-gen",
						createdAt: "2026-03-01T00:00:00Z",
					},
					{
						type: "assistant/message",
						id: "m1",
						data: { usage: { inputTokens: 200, outputTokens: 40 } },
					},
				]);

				// v3.zstd (highest generation)
				writeZstdJsonlFile(path.join(sessionDir, "session.v3.jsonl.zstd"), [
					{
						type: "session",
						id: "sess-gen",
						createdAt: "2026-03-01T00:00:00Z",
					},
					{
						type: "assistant/message",
						id: "m3",
						data: { usage: { inputTokens: 500, outputTokens: 100 } },
					},
				]);

				const provider = new DshProvider();
				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);
				expect(items[0]!.filePath).toContain("session.v3.jsonl.zstd");

				const usage = await provider.readUsage(mockPaths);
				// Only v3 is parsed for this session directory
				expect(usage.records.length).toBe(1);
				expect(usage.records[0]!.inputTokens).toBe(500);
			});
		});
	});

	test("DSH-T2-04: Streaming Chunk Usage Extraction (`data.stream`)", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDir = path.join(
					dshDir,
					"sessions",
					"--workspace--",
					"s-stream",
				);
				mkdirSync(sessionDir, { recursive: true });

				writeJsonlFile(path.join(sessionDir, "session.jsonl"), [
					{ type: "session", id: "sess-stream", cwd: "/workspace" },
					{
						type: "assistant/message",
						id: "m-stream-1",
						data: {
							message: {
								source: { provider: "deepseek", model: "deepseek-coder" },
							},
							// Omit direct data.usage; provide chunks in stream
							stream: [
								{ type: "text", delta: "Processing" },
								{
									type: "usage",
									usage: { inputTokens: 2500, outputTokens: 600 },
								},
							],
						},
					},
				]);

				const provider = new DshProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.inputTokens).toBe(2500);
				expect(result.records[0]!.outputTokens).toBe(600);
			});
		});
	});

	test("DSH-T2-05: Subagent Origin, Parent Session & Review Flags", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const dshDir = path.join(sandbox.homeDir, ".dsh");
			await withScopedEnv({ DSH_HOME: dshDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const sessionDirA = path.join(
					dshDir,
					"sessions",
					"--workspace--",
					"s-sub",
				);
				const sessionDirB = path.join(
					dshDir,
					"sessions",
					"--workspace--",
					"s-rev",
				);
				mkdirSync(sessionDirA, { recursive: true });
				mkdirSync(sessionDirB, { recursive: true });

				writeJsonlFile(path.join(sessionDirA, "session.jsonl"), [
					{
						type: "session",
						id: "sess-sub",
						origin: "subagent",
						parentSession: "parent-123",
						delegationDepth: 1,
					},
					{
						type: "user/message",
						data: {
							content: "Current runtime context.\nIgnore this prompt",
						},
					},
					{
						type: "assistant/message",
						id: "m-sub",
						data: { usage: { inputTokens: 100, outputTokens: 20 } },
					},
				]);

				writeJsonlFile(path.join(sessionDirB, "session.jsonl"), [
					{
						type: "session",
						id: "sess-rev",
						origin: "review",
					},
					{
						type: "assistant/message",
						id: "m-rev",
						data: { usage: { inputTokens: 200, outputTokens: 40 } },
					},
				]);

				const provider = new DshProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.records.length).toBe(2);

				const subRecord = result.records.find(
					(r) => r.sessionId === "sess-sub",
				);
				const revRecord = result.records.find(
					(r) => r.sessionId === "sess-rev",
				);

				expect(subRecord?.isSubagent).toBe(true);
				expect(revRecord?.isReview).toBe(true);

				// Prompt starting with "Current runtime context." should not increment messages
				expect(result.messages.get("sess-sub")).toBeUndefined();
			});
		});
	});
});

// ============================================================================
// MODULE C: OpenCode Provider (`opencode`)
// ============================================================================

describe("Core Provider: OpenCode (Feature 10)", () => {
	// --- Tier 1: Happy Path ---

	test("OPC-T1-01: Metadata and Contract Validation", () => {
		const provider = new OpenCodeProvider();
		expect(provider.metadata.id).toBe("opencode");
		expect(provider.metadata.displayName).toBe("OpenCode");
		expect(provider.metadata.shortLabel).toBe("OC");
		expect(provider.metadata.color).toBeDefined();
		expect(provider.metadata.defaultEnabled).toBe(true);

		expect(typeof provider.isAvailable).toBe("function");
		expect(typeof provider.discoverSessions).toBe("function");
		expect(typeof provider.readUsage).toBe("function");
		expect(typeof provider.readTranscript).toBe("function");
		expect(typeof provider.computeFingerprint).toBe("function");
		expect(typeof provider.getWatchPaths).toBe("function");
	});

	test("OPC-T1-02: Isolated Sandbox Session Discovery (V2 Schema)", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			const dbPath = path.join(opencodeDir, "opencode.db");
			const db = createDatabase(dbPath);
			db.run(
				"CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, title TEXT);",
			);
			db.run(
				"CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL, seq INTEGER);",
			);
			db.run(
				"INSERT INTO session_v2 VALUES ('oc-sess-default', '/workspace/opencode-demo', 1710000000000, 'Demo');",
			);
			closeDatabase(db);

			await withScopedEnv({ OPENCODE_DATA_DIR: opencodeDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();
				expect(await provider.isAvailable(mockPaths)).toBe(true);

				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);
				expect(items[0]!.sessionId).toBe("oc-sess-default");
				expect(items[0]!.harness).toBe("opencode");
				expect(items[0]!.cwd).toBe("/workspace/opencode-demo");
				expect(items[0]!.mtimeMs).toBeGreaterThan(0);
				expect(items[0]!.filePath).toContain("opencode.db");
			});
		});
	});

	test("OPC-T1-03: Single Session Usage Record Extraction (V2 Schema)", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			const dbPath = path.join(opencodeDir, "opencode.db");
			const db = createDatabase(dbPath);

			db.run(`
				CREATE TABLE session_v2 (
					id TEXT PRIMARY KEY,
					directory TEXT NOT NULL,
					time_created INTEGER NOT NULL,
					title TEXT,
					model TEXT
				);
				CREATE TABLE session_message (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					type TEXT NOT NULL,
					time_created INTEGER NOT NULL,
					data TEXT NOT NULL,
					seq INTEGER
				);
			`);

			db.run(
				`INSERT INTO session_v2 (id, directory, time_created) VALUES ('oc-sess-custom', '/workspace/opencode-proj', 1710000000000);`,
			);

			const messageData = JSON.stringify({
				model: "claude-3-5-sonnet",
				modelID: "claude-3-5-sonnet",
				providerID: "anthropic",
				tokens: {
					input: 2400,
					output: 580,
					reasoning: 60,
					cache: { read: 1200, write: 300 },
				},
				cost: 0.0125,
			});

			db.run(
				`INSERT INTO session_message VALUES ('msg-1', 'oc-sess-custom', 'user', 1710000000000, '{"text":"Hello"}', 1);`,
			);
			db.run(
				`INSERT INTO session_message VALUES ('msg-2', 'oc-sess-custom', 'assistant', 1710000010000, ?, 2);`,
				[messageData],
			);
			closeDatabase(db);

			await withScopedEnv({ OPENCODE_DATA_DIR: opencodeDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();
				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);

				const result = await provider.readUsage(mockPaths, items[0]);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.sessionId).toBe("oc-sess-custom");
				expect(result.records[0]!.model).toBe("claude-3-5-sonnet");
				expect(result.records[0]!.pricingModel).toBe(
					"anthropic/claude-3-5-sonnet",
				);
				expect(result.records[0]!.inputTokens).toBe(2400);
				// OpenCode sums output + reasoning: 580 + 60 = 640
				expect(result.records[0]!.outputTokens).toBe(640);
				expect(result.records[0]!.cacheReadTokens).toBe(1200);
				expect(result.records[0]!.cacheWriteTokens).toBe(300);
				expect(result.records[0]!.reasoningTokens).toBe(60);
				expect(result.records[0]!.costUsd).toBe(0.0125);
				expect(result.messages.get("oc-sess-custom")).toBe(1);
			});
		});
	});

	test("OPC-T1-04: Legacy V1 Schema Parsing Compatibility", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			const dbPath = path.join(opencodeDir, "opencode-legacy.db");
			const db = createDatabase(dbPath);
			db.run(
				"CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, title TEXT);",
			);
			db.run(
				"CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL);",
			);
			db.run(
				"INSERT INTO session VALUES ('oc-sess-default', '/workspace/legacy', 1000, 'Legacy');",
			);
			db.run(
				"INSERT INTO message VALUES ('m-user', 'oc-sess-default', 'user', '{\"role\":\"user\",\"text\":\"Hi\"}', 1000);",
			);
			db.run(
				'INSERT INTO message VALUES (\'m-asst\', \'oc-sess-default\', \'assistant\', \'{"role":"assistant","tokens":{"input":100,"output":50}}\', 1001);',
			);
			closeDatabase(db);

			await withScopedEnv({ OPENCODE_DATA_DIR: opencodeDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.sessionId).toBe("oc-sess-default");
				expect(result.messages.get("oc-sess-default")).toBe(1);
			});
		});
	});

	test("OPC-T1-05: Single Transcript Reconstruction & Fingerprint Calculation", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			const dbPath = path.join(opencodeDir, "opencode.db");
			const db = createDatabase(dbPath);
			db.run(
				"CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER);",
			);
			db.run(
				"CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT, time_created INTEGER, seq INTEGER);",
			);
			db.run("INSERT INTO session_v2 VALUES (?, ?, ?, ?);", [
				"oc-sess-1",
				"/workspace",
				"Session 1",
				1000,
			]);
			db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?);", [
				"m1",
				"oc-sess-1",
				"user",
				"{}",
				1000,
				1,
			]);
			db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?);", [
				"m2",
				"oc-sess-1",
				"assistant",
				JSON.stringify({ content: "Assistant response" }),
				1001,
				2,
			]);
			closeDatabase(db);

			await withScopedEnv(
				{ OPENCODE_DB: dbPath, OPENCODE_DATA_DIR: opencodeDir },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const provider = new OpenCodeProvider();
					const transcript = await provider.readTranscript(
						mockPaths,
						"oc-sess-1",
					);
					expect(transcript).not.toBeNull();
					expect(transcript!.sessionId).toBe("oc-sess-1");

					const fp = await provider.computeFingerprint(mockPaths);
					expect(fp).toMatch(/^v12:1:[0-9a-f]{64}$/);

					const watchPaths = provider.getWatchPaths(mockPaths);
					expect(watchPaths.some((p) => p.includes("opencode.db"))).toBe(true);
				},
			);
		});
	});

	// --- Tier 2: Boundary, Corruption & Variations ---

	test("OPC-T2-01: Missing Database / Completely Unavailable", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const nonexistentDir = path.join(sandbox.rootDir, "nonexistent-opencode");
			await withScopedEnv({ OPENCODE_DATA_DIR: nonexistentDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();

				expect(await provider.isAvailable(mockPaths)).toBe(false);
				expect(await provider.discoverSessions(mockPaths)).toEqual([]);

				const usage = await provider.readUsage(mockPaths);
				expect(usage.available).toBe(false);
				expect(usage.records).toEqual([]);

				expect(await provider.readTranscript(mockPaths, "missing")).toBeNull();
				expect(await provider.computeFingerprint(mockPaths)).toMatch(
					/^v12:0:[0-9a-f]{64}$/,
				);
				expect(provider.getWatchPaths(mockPaths)).toEqual([]);
			});
		});
	});

	test("OPC-T2-02: Corrupted SQLite Database File / Invalid Header", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			writeFileSync(
				path.join(opencodeDir, "opencode.db"),
				"THIS IS NOT A VALID SQLITE DATABASE FILE",
			);

			await withScopedEnv({ OPENCODE_DATA_DIR: opencodeDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();
				// Should catch SQLite error and not crash
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(
					result.warnings.some((w) => w.includes("OpenCode: failed to read")),
				).toBe(true);
			});
		});
	});

	test("OPC-T2-03: Malformed JSON in session_message.data", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			const dbPath = path.join(opencodeDir, "opencode.db");
			const db = createDatabase(dbPath);
			db.run(`
				CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, model TEXT);
				CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
			`);
			db.run(
				`INSERT INTO session_v2 (id, directory, time_created) VALUES ('oc-corrupt', '/workspace', 1000);`,
			);
			db.run(
				`INSERT INTO session_message VALUES ('m1', 'oc-corrupt', 'assistant', 1000, '{corrupted json line...');`,
			);
			closeDatabase(db);

			await withScopedEnv({ OPENCODE_DATA_DIR: opencodeDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(result.records).toEqual([]);
			});
		});
	});

	test("OPC-T2-04: Empty Tables & Zero-Token Assistant Messages", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			const dbPath = path.join(opencodeDir, "opencode.db");
			const db = createDatabase(dbPath);
			db.run(`
				CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, model TEXT);
				CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
			`);
			db.run(
				`INSERT INTO session_v2 (id, directory, time_created) VALUES ('oc-zero', '/workspace', 1000);`,
			);
			db.run(
				`INSERT INTO session_message VALUES ('m1', 'oc-zero', 'assistant', 1000, '{"tokens":{"input":0,"output":0}}');`,
			);
			closeDatabase(db);

			await withScopedEnv({ OPENCODE_DATA_DIR: opencodeDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.records).toEqual([]);
			});
		});
	});

	test("OPC-T2-05: Single Session Query Isolation & Safe Escaping", async () => {
		await withSandboxEnvironment("linux", async (sandbox) => {
			const opencodeDir = path.join(
				sandbox.homeDir,
				".local",
				"share",
				"opencode",
			);
			mkdirSync(opencodeDir, { recursive: true });

			const dbPath = path.join(opencodeDir, "opencode.db");
			const db = createDatabase(dbPath);
			db.run(`
				CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, model TEXT);
				CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
			`);
			db.run(
				`INSERT INTO session_v2 (id, directory, time_created) VALUES ('oc-1', '/a', 1000), ('oc-2', '/b', 1000);`,
			);
			db.run(
				`INSERT INTO session_message VALUES
				('m1', 'oc-1', 'assistant', 1000, '{"tokens":{"input":100,"output":50}}'),
				('m2', 'oc-2', 'assistant', 1000, '{"tokens":{"input":200,"output":80}}');`,
			);
			closeDatabase(db);

			await withScopedEnv({ OPENCODE_DATA_DIR: opencodeDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new OpenCodeProvider();
				// Filter by session oc-1
				const result = await provider.readUsage(mockPaths, {
					sessionId: "oc-1",
					harness: "opencode",
					filePath: dbPath,
					mtimeMs: Date.now(),
					sizeBytes: 1000,
				});

				expect(result.records.length).toBe(1);
				expect(result.records[0]!.sessionId).toBe("oc-1");
			});
		});
	});
});

// ============================================================================
// MODULE D: Command Code Provider (`commandcode`)
// ============================================================================

describe("Core Provider: Command Code (Feature 10)", () => {
	// --- Tier 1: Happy Path ---

	test("CMD-T1-01: Metadata and Contract Validation", () => {
		const provider = new CommandCodeProvider();
		expect(provider.metadata.id).toBe("commandcode");
		expect(provider.metadata.displayName).toBe("Command Code");
		expect(provider.metadata.shortLabel).toBe("CC");
		expect(provider.metadata.color).toBeDefined();
		expect(provider.metadata.defaultEnabled).toBe(true);

		expect(typeof provider.isAvailable).toBe("function");
		expect(typeof provider.discoverSessions).toBe("function");
		expect(typeof provider.readUsage).toBe("function");
		expect(typeof provider.readTranscript).toBe("function");
		expect(typeof provider.computeFingerprint).toBe("function");
		expect(typeof provider.getWatchPaths).toBe("function");
	});

	test("CMD-T1-02: Isolated Sandbox Session Discovery", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const projDir = path.join(cmdDir, "projects", "test-project");
				mkdirSync(projDir, { recursive: true });

				const sessionFile = path.join(projDir, "commandcode-1.jsonl");
				writeJsonlFile(sessionFile, [
					{
						type: "session",
						id: "cc-sess-1",
						cwd: "/workspace/commandcode-project",
						timestamp: "2026-03-15T10:00:00.000Z",
					},
					{
						type: "message",
						role: "user",
						content: "Build project",
					},
				]);

				const provider = new CommandCodeProvider();
				expect(await provider.isAvailable(mockPaths)).toBe(true);

				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);
				expect(items[0]!.sessionId).toBe("cc-sess-1");
				expect(items[0]!.harness).toBe("commandcode");
				expect(items[0]!.cwd).toBe("/workspace/commandcode-project");
				expect(items[0]!.mtimeMs).toBeGreaterThan(0);
				expect(items[0]!.filePath).toContain("commandcode-1.jsonl");
			});
		});
	});

	test("CMD-T1-03: Single Session Usage Record Extraction", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const projDir = path.join(cmdDir, "projects", "proj1");
				mkdirSync(projDir, { recursive: true });

				const sessionFile = path.join(projDir, "commandcode-1.jsonl");
				writeJsonlFile(sessionFile, [
					{
						type: "session",
						id: "cc-sess-1",
						cwd: "/workspace/cc-proj",
					},
					{
						type: "message",
						role: "user",
						message: { role: "user" },
						content: "Run build",
					},
					{
						type: "message",
						role: "assistant",
						message: { role: "assistant" },
						model: "claude-3-7-sonnet",
						usage: {
							inputTokens: 1600,
							outputTokens: 380,
							cacheReadTokens: 900,
							cacheWriteTokens: 150,
							reasoningTokens: 40,
							costUsd: 0.0075,
						},
					},
				]);

				const provider = new CommandCodeProvider();
				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);

				const result = await provider.readUsage(mockPaths, items[0]);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.model).toBe("claude-3-7-sonnet");
				expect(result.records[0]!.inputTokens).toBe(1600);
				expect(result.records[0]!.outputTokens).toBe(380);
				expect(result.records[0]!.cacheReadTokens).toBe(900);
				expect(result.records[0]!.cacheWriteTokens).toBe(150);
				expect(result.records[0]!.reasoningTokens).toBe(40);
				expect(result.records[0]!.costUsd).toBe(0.0075);
				expect(result.messages.get("cc-sess-1")).toBe(1);
			});
		});
	});

	test("CMD-T1-04: Multi-Project Directory Sweep", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const p1 = path.join(cmdDir, "projects", "proj-alpha");
				const p2 = path.join(cmdDir, "projects", "proj-beta");
				mkdirSync(p1, { recursive: true });
				mkdirSync(p2, { recursive: true });

				writeJsonlFile(path.join(p1, "sess-a.jsonl"), [
					{ type: "session", id: "sess-a", cwd: "/alpha" },
					{
						type: "message",
						role: "assistant",
						message: { role: "assistant" },
						model: "claude-3-5-sonnet",
						usage: { inputTokens: 500, outputTokens: 100 },
					},
				]);

				writeJsonlFile(path.join(p2, "sess-b.jsonl"), [
					{ type: "session", id: "sess-b", cwd: "/beta" },
					{
						type: "message",
						role: "assistant",
						message: { role: "assistant" },
						model: "claude-3-5-sonnet",
						usage: { inputTokens: 700, outputTokens: 120 },
					},
				]);

				const provider = new CommandCodeProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(result.records.length).toBe(2);
				expect(result.warnings.length).toBe(0);
			});
		});
	});

	test("CMD-T1-05: Single Transcript Reconstruction & Fingerprint Calculation", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const projDir = path.join(cmdDir, "projects", "proj1");
				mkdirSync(projDir, { recursive: true });

				writeJsonlFile(path.join(projDir, "cc-sess-1.jsonl"), [
					{ type: "session", id: "cc-sess-1", cwd: "/workspace" },
					{
						type: "message",
						role: "user",
						message: { role: "user", content: "Prompt" },
					},
					{
						type: "message",
						role: "assistant",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Response" }],
						},
					},
				]);

				const provider = new CommandCodeProvider();
				const transcript = await provider.readTranscript(
					mockPaths,
					"cc-sess-1",
				);
				expect(transcript).not.toBeNull();
				expect(transcript!.sessionId).toBe("cc-sess-1");
				expect(transcript!.items.length).toBeGreaterThanOrEqual(2);

				const fp = await provider.computeFingerprint(mockPaths);
				expect(fp).toMatch(/^v12:1:[0-9a-f]{64}$/);

				const watchPaths = provider.getWatchPaths(mockPaths);
				expect(watchPaths.some((p) => p.includes("projects"))).toBe(true);
			});
		});
	});

	// --- Tier 2: Boundary, Corruption & Variations ---

	test("CMD-T2-01: Missing Projects Root / Completely Unavailable", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const nonexistentDir = path.join(sandbox.rootDir, "nonexistent-cmd");
			await withScopedEnv({ COMMANDCODE_HOME: nonexistentDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const provider = new CommandCodeProvider();

				expect(await provider.isAvailable(mockPaths)).toBe(false);
				expect(await provider.discoverSessions(mockPaths)).toEqual([]);

				const usage = await provider.readUsage(mockPaths);
				expect(usage.available).toBe(false);
				expect(usage.records).toEqual([]);

				expect(await provider.readTranscript(mockPaths, "missing")).toBeNull();
				expect(await provider.computeFingerprint(mockPaths)).toMatch(
					/^v12:0:[0-9a-f]{64}$/,
				);
				expect(provider.getWatchPaths(mockPaths)).toEqual([]);
			});
		});
	});

	test("CMD-T2-02: Corrupted JSONL Lines and Empty Files", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const projDir = path.join(cmdDir, "projects", "proj-corrupt");
				mkdirSync(projDir, { recursive: true });

				writeFileSync(
					path.join(projDir, "corrupted.jsonl"),
					"truncated json line: {...\n",
				);
				writeFileSync(path.join(projDir, "empty.jsonl"), "");

				const provider = new CommandCodeProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.available).toBe(true);
				expect(Array.isArray(result.records)).toBe(true);
			});
		});
	});

	test("CMD-T2-03: Filtering Checkpoints and Prompts Files", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const projDir = path.join(cmdDir, "projects", "proj-filter");
				mkdirSync(projDir, { recursive: true });

				writeJsonlFile(path.join(projDir, "valid-session.jsonl"), [
					{ type: "session", id: "valid-1" },
					{
						type: "message",
						role: "assistant",
						message: { role: "assistant" },
						usage: { inputTokens: 100, outputTokens: 20 },
					},
				]);
				writeJsonlFile(path.join(projDir, "valid-session.checkpoints.jsonl"), [
					{ type: "checkpoint", id: "cp-1" },
				]);
				writeJsonlFile(path.join(projDir, "valid-session.prompts.jsonl"), [
					{ type: "prompt", id: "pr-1" },
				]);

				const provider = new CommandCodeProvider();
				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);
				expect(items[0]!.filePath).toContain("valid-session.jsonl");
				expect(items[0]!.filePath).not.toContain("checkpoints");
				expect(items[0]!.filePath).not.toContain("prompts");
			});
		});
	});

	test("CMD-T2-04: Missing Session Header and Fallback ID Inference", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const projDir = path.join(cmdDir, "projects", "proj-slug");
				mkdirSync(projDir, { recursive: true });

				// Omit type: "session" header
				writeJsonlFile(path.join(projDir, "custom-slug.jsonl"), [
					{ role: "user", content: "hi" },
					{
						type: "message",
						role: "assistant",
						message: { role: "assistant" },
						usage: { inputTokens: 50, outputTokens: 10 },
					},
				]);

				const provider = new CommandCodeProvider();
				const items = await provider.discoverSessions(mockPaths);
				expect(items.length).toBe(1);
				expect(items[0]!.sessionId).toBe("custom-slug");
			});
		});
	});

	test("CMD-T2-05: Field Variations: reasoning vs reasoningTokens & Role Skipping", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const cmdDir = path.join(sandbox.homeDir, ".commandcode");
			await withScopedEnv({ COMMANDCODE_HOME: cmdDir }, async () => {
				const mockPaths = new DefaultPlatformPathService(sandbox.provider);
				const projDir = path.join(cmdDir, "projects", "proj-var");
				mkdirSync(projDir, { recursive: true });

				writeJsonlFile(path.join(projDir, "var.jsonl"), [
					{ type: "session", id: "sess-var" },
					// Non-assistant role with usage -> must be skipped
					{
						type: "message",
						role: "system",
						message: { role: "system" },
						usage: { inputTokens: 100, outputTokens: 20 },
					},
					// Assistant role with `reasoning: 85` instead of `reasoningTokens`
					{
						type: "message",
						role: "assistant",
						message: { role: "assistant" },
						model: "claude-3-7-sonnet",
						usage: {
							inputTokens: 300,
							outputTokens: 100,
							reasoning: 85,
						},
					},
				]);

				const provider = new CommandCodeProvider();
				const result = await provider.readUsage(mockPaths);
				expect(result.records.length).toBe(1);
				expect(result.records[0]!.reasoningTokens).toBe(85);
			});
		});
	});
});

// ============================================================================
// MODULE E: Antigravity Provider (`antigravity`)
// ============================================================================

describe("Core Provider: Antigravity (Feature 10)", () => {
	// --- Tier 1: Happy Path ---

	test("AGV-T1-01: Metadata and Contract Validation", () => {
		const provider = new AntigravityProvider();
		expect(provider.metadata.id).toBe("antigravity");
		expect(provider.metadata.displayName).toBe("Antigravity");
		expect(provider.metadata.shortLabel).toBe("AG");
		expect(provider.metadata.color).toBeDefined();
		expect(provider.metadata.defaultEnabled).toBe(true);

		expect(typeof provider.isAvailable).toBe("function");
		expect(typeof provider.discoverSessions).toBe("function");
		expect(typeof provider.readUsage).toBe("function");
		expect(typeof provider.readTranscript).toBe("function");
		expect(typeof provider.computeFingerprint).toBe("function");
		expect(typeof provider.getWatchPaths).toBe("function");
	});

	test("AGV-T1-02: Isolated Sandbox Session Discovery", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					const dbPath = path.join(convDir, "ag-sess-1.db");
					const trajBlob = buildAntigravityTrajectoryMetadata({
						cwd: "/workspace/antigravity-project",
					});
					seedAntigravityDb(dbPath, {
						trajectoryBlob: trajBlob,
					});

					const provider = new AntigravityProvider();
					expect(await provider.isAvailable(mockPaths)).toBe(true);

					const items = await provider.discoverSessions(mockPaths);
					expect(items.length).toBe(1);
					expect(items[0]!.sessionId).toBe("ag-sess-1");
					expect(items[0]!.harness).toBe("antigravity");
					expect(items[0]!.cwd).toBe("/workspace/antigravity-project");
					expect(items[0]!.mtimeMs).toBeGreaterThan(0);
					expect(items[0]!.filePath).toContain("ag-sess-1.db");
				},
			);
		});
	});

	test("AGV-T1-03: Single Session Usage Parsing via gen_metadata (Mode A)", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					const dbPath = path.join(convDir, "ag-sess-1.db");
					const trajBlob = buildAntigravityTrajectoryMetadata({
						cwd: "/workspace/antigravity-project",
					});
					const genBlob = buildAntigravityGenMetadata({
						model: "gemini-2.5-pro",
						inputTokens: 2500,
						outputTokens: 450,
						cacheReadTokens: 1800,
						reasoningTokens: 50,
						requestId: "req-ag-1",
					});

					seedAntigravityDb(dbPath, {
						trajectoryBlob: trajBlob,
						genMetadata: [{ idx: 0, data: genBlob }],
						steps: [{ idx: 0, stepType: 14 }],
					});

					const provider = new AntigravityProvider();
					const items = await provider.discoverSessions(mockPaths);
					expect(items.length).toBe(1);

					const result = await provider.readUsage(mockPaths, items[0]);
					expect(result.available).toBe(true);
					expect(result.records.length).toBe(1);
					expect(result.records[0]!.sessionId).toBe("ag-sess-1");
					expect(result.records[0]!.model).toBe("gemini-2.5-pro");
					expect(result.records[0]!.messageId).toBe("req-ag-1");
					expect(result.records[0]!.inputTokens).toBe(2500);
					expect(result.records[0]!.outputTokens).toBe(450);
					expect(result.records[0]!.cacheReadTokens).toBe(1800);
					expect(result.records[0]!.reasoningTokens).toBe(50);
					expect(result.messages.get("ag-sess-1")).toBe(1);
				},
			);
		});
	});

	test("AGV-T1-04: Assistant Step Fallback Parsing (Mode B, No gen_metadata)", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					const dbPath = path.join(convDir, "ag-fallback.db");
					const db = createDatabase(dbPath);

					// Table steps exists, gen_metadata does not
					db.run(`
					CREATE TABLE steps (
						idx INTEGER PRIMARY KEY,
						step_type INTEGER,
						step_payload BLOB,
						metadata BLOB
					);
				`);

					const usageProto = protoConcat(
						protoVarint(2, 1500),
						protoVarint(3, 300),
						protoVarint(9, 25),
					);
					const payload = protoBytes(5, protoBytes(9, usageProto));

					db.run(
						`INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (1, 15, ?, NULL);`,
						[payload],
					);
					closeDatabase(db);

					const provider = new AntigravityProvider();
					const items = await provider.discoverSessions(mockPaths);
					expect(items.length).toBe(1);

					const result = await provider.readUsage(mockPaths, items[0]);
					expect(result.records.length).toBe(1);
					expect(result.records[0]!.inputTokens).toBe(1500);
					expect(result.records[0]!.outputTokens).toBe(300);
					expect(result.records[0]!.reasoningTokens).toBe(25);
				},
			);
		});
	});

	test("AGV-T1-05: Single Transcript Reconstruction & Fingerprint Calculation", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					const dbPath = path.join(convDir, "ag-sess-1.db");
					const trajBlob = buildAntigravityTrajectoryMetadata({
						cwd: "/workspace/antigravity-project",
					});
					seedAntigravityDb(dbPath, {
						trajectoryBlob: trajBlob,
						steps: [
							{ idx: 0, stepType: 14, payload: Buffer.from("User prompt") },
							{ idx: 1, stepType: 15, payload: Buffer.from("Assistant reply") },
						],
					});

					const provider = new AntigravityProvider();
					const transcript = await provider.readTranscript(
						mockPaths,
						"ag-sess-1",
					);
					expect(transcript).not.toBeNull();
					expect(transcript!.sessionId).toBe("ag-sess-1");

					const fp = await provider.computeFingerprint(mockPaths);
					expect(fp).toMatch(/^v12:1:[0-9a-f]{64}$/);

					const watchPaths = provider.getWatchPaths(mockPaths);
					expect(watchPaths.some((p) => p.includes("conversations"))).toBe(
						true,
					);
				},
			);
		});
	});

	// --- Tier 2: Boundary, Corruption & Variations ---

	test("AGV-T2-01: Missing Directories / Completely Unavailable", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const nonexistentDir = path.join(sandbox.rootDir, "nonexistent-agv");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: nonexistentDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const provider = new AntigravityProvider();

					expect(await provider.isAvailable(mockPaths)).toBe(false);
					expect(await provider.discoverSessions(mockPaths)).toEqual([]);

					const usage = await provider.readUsage(mockPaths);
					expect(usage.available).toBe(false);
					expect(usage.records).toEqual([]);

					expect(
						await provider.readTranscript(mockPaths, "missing"),
					).toBeNull();
					expect(await provider.computeFingerprint(mockPaths)).toMatch(
						/^v12:0:[0-9a-f]{64}$/,
					);
					expect(provider.getWatchPaths(mockPaths)).toEqual([]);
				},
			);
		});
	});

	test("AGV-T2-02: Corrupted SQLite Conversation DB and Truncated Protobuf Blobs", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					// Corrupted DB
					writeFileSync(
						path.join(convDir, "corrupted.db"),
						"THIS IS AN INVALID DATABASE FILE",
					);

					const provider = new AntigravityProvider();
					const result = await provider.readUsage(mockPaths);
					expect(result.available).toBe(true);
					expect(
						result.warnings.some((w) =>
							w.toLowerCase().includes("failed reading"),
						),
					).toBe(true);
				},
			);
		});
	});

	test("AGV-T2-03: Subagent Cascade & Worker Role Detection", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					const dbPath = path.join(convDir, "ag-subagent.db");
					const db = createDatabase(dbPath);

					db.run(`
					CREATE TABLE trajectory_metadata_blob (data BLOB);
					CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
					CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, payload BLOB, metadata BLOB);
				`);

					// Trajectory metadata with parentId
					const trajBlob = buildAntigravityTrajectoryMetadata({
						cwd: "/workspace",
						parentId: "parent-id-123",
						isSubagent: true,
					});
					db.run(`INSERT INTO trajectory_metadata_blob VALUES (?);`, [
						trajBlob,
					]);

					const genBlob = buildAntigravityGenMetadata({
						model: "gemini-2.5-flash",
						inputTokens: 800,
						outputTokens: 150,
						subagentType: "explorer",
					});
					db.run(`INSERT INTO gen_metadata VALUES (0, ?);`, [genBlob]);
					closeDatabase(db);

					const provider = new AntigravityProvider();
					const result = await provider.readUsage(mockPaths);
					expect(result.records.length).toBe(1);
					expect(result.records[0]!.isSubagent).toBe(true);
				},
			);
		});
	});

	test("AGV-T2-04: Sidecar .meta File and conversation_summaries.db CWD Fallbacks", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					// DB 1 has sidecar .meta file
					const dbPath1 = path.join(convDir, "ag-meta-fallback.db");
					seedAntigravityDb(dbPath1, {});
					writeFileSync(
						path.join(convDir, "ag-meta-fallback.meta"),
						JSON.stringify({ cwd: "/workspace/sidecar-dir" }),
					);

					// DB 2 has entry in conversation_summaries.db
					const dbPath2 = path.join(convDir, "ag-summary-fallback.db");
					seedAntigravityDb(dbPath2, {
						genMetadata: [
							{
								idx: 0,
								data: buildAntigravityGenMetadata({
									model: "gemini-2.5-pro",
									inputTokens: 100,
									outputTokens: 20,
								}),
							},
						],
					});
					const summariesDbPath = path.join(agDir, "conversation_summaries.db");
					seedAntigravitySummariesDb(summariesDbPath, {
						summaries: [
							{
								conversationId: "ag-summary-fallback",
								title: "Summary Title",
								workspaceUris: ["file:///workspace/summaries-dir"],
							},
						],
					});

					const provider = new AntigravityProvider();
					const items = await provider.discoverSessions(mockPaths);
					expect(items.length).toBe(2);

					const item1 = items.find((i) => i.sessionId === "ag-meta-fallback");
					expect(item1?.cwd).toBe("/workspace/sidecar-dir");

					// Usage parsing integrates conversation_summaries.db
					const usage = await provider.readUsage(mockPaths);
					const record2 = usage.records.find(
						(r) => r.sessionId === "ag-summary-fallback",
					);
					expect(record2?.cwd).toBe("/workspace/summaries-dir");
				},
			);
		});
	});

	test("AGV-T2-05: Tool Outcome Status Decoding in Transcripts", async () => {
		await withSandboxEnvironment("darwin", async (sandbox) => {
			const agDir = path.join(sandbox.homeDir, ".gemini", "antigravity");
			const emptyT3 = path.join(sandbox.rootDir, "empty_t3");
			mkdirSync(emptyT3, { recursive: true });
			await withScopedEnv(
				{ ANTIGRAVITY_HOME: agDir, T3_USER_DATA_DIR: emptyT3 },
				async () => {
					const mockPaths = new DefaultPlatformPathService(sandbox.provider);
					const convDir = path.join(agDir, "conversations");
					mkdirSync(convDir, { recursive: true });

					const dbPath = path.join(convDir, "ag-tool-status.db");
					seedAntigravityDb(dbPath, {
						steps: [
							{ idx: 0, stepType: 14, payload: Buffer.from("User prompt") },
							{
								idx: 1,
								stepType: 132,
								status: 7,
								payload: Buffer.from("Tool with error"),
							},
						],
					});

					const provider = new AntigravityProvider();
					const transcript = await provider.readTranscript(
						mockPaths,
						"ag-tool-status",
					);
					expect(transcript).not.toBeNull();
					expect(transcript!.sessionId).toBe("ag-tool-status");
				},
			);
		});
	});
});
