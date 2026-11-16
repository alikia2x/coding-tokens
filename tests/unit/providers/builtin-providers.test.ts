import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../../src/platform/env";
import {
	DefaultPlatformPathService,
	defaultPlatformPathService,
} from "../../../src/platform/paths";
import { AntigravityProvider } from "../../../src/providers/antigravity";
import { CodexProvider } from "../../../src/providers/codex";
import { CommandCodeProvider } from "../../../src/providers/commandcode";
import { DshProvider } from "../../../src/providers/dsh";
import { OpenCodeProvider } from "../../../src/providers/opencode";
import { computeFilesFingerprint } from "../../../src/providers/utils";

describe("Providers: Built-in Harness Providers (Feature 10)", () => {
	const tmpDir = path.join(
		os.tmpdir(),
		`ct-builtin-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	test("F10-T1-01: Metadata validation across all 5 built-in providers", () => {
		const codex = new CodexProvider();
		expect(codex.metadata.id).toBe("codex");
		expect(codex.metadata.displayName).toBe("Codex");
		expect(codex.metadata.color).toBeDefined();

		const dsh = new DshProvider();
		expect(dsh.metadata.id).toBe("dsh");
		expect(dsh.metadata.displayName).toBe("DSH");
		expect(dsh.metadata.color).toBeDefined();

		const opencode = new OpenCodeProvider();
		expect(opencode.metadata.id).toBe("opencode");
		expect(opencode.metadata.displayName).toBe("OpenCode");
		expect(opencode.metadata.color).toBeDefined();

		const commandcode = new CommandCodeProvider();
		expect(commandcode.metadata.id).toBe("commandcode");
		expect(commandcode.metadata.displayName).toBe("Command Code");
		expect(commandcode.metadata.color).toBeDefined();

		const antigravity = new AntigravityProvider();
		expect(antigravity.metadata.id).toBe("antigravity");
		expect(antigravity.metadata.displayName).toBe("Antigravity");
		expect(antigravity.metadata.color).toBeDefined();
	});

	test("F10-T1-02: Fingerprint format complies with v12:count:sha256", () => {
		mkdirSync(tmpDir, { recursive: true });
		const file1 = path.join(tmpDir, "file1.txt");
		const file2 = path.join(tmpDir, "file2.txt");

		writeFileSync(file1, "content-1");
		writeFileSync(file2, "content-2");

		const fpEmpty = computeFilesFingerprint([]);
		expect(fpEmpty).toMatch(/^v12:0:[0-9a-f]{64}$/);

		const fpTwo = computeFilesFingerprint([file1, file2]);
		expect(fpTwo).toMatch(/^v12:2:[0-9a-f]{64}$/);

		// Determinism test: same files produce identical fingerprint
		const fpTwoRepeat = computeFilesFingerprint([file2, file1]); // order should be normalized
		expect(fpTwoRepeat).toBe(fpTwo);

		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("F10-T1-03: Provider methods execute cleanly against host paths", async () => {
		const providers = [
			new CodexProvider(),
			new DshProvider(),
			new OpenCodeProvider(),
			new CommandCodeProvider(),
			new AntigravityProvider(),
		];

		for (const provider of providers) {
			const watchPaths = provider.getWatchPaths(defaultPlatformPathService);
			expect(Array.isArray(watchPaths)).toBe(true);
			expect(watchPaths.length).toBeGreaterThan(0);

			const isAvail = await provider.isAvailable(defaultPlatformPathService);
			expect(typeof isAvail).toBe("boolean");

			const sessions = await provider.discoverSessions(
				defaultPlatformPathService,
			);
			expect(Array.isArray(sessions)).toBe(true);

			const fp = await provider.computeFingerprint(defaultPlatformPathService);
			expect(fp).toMatch(/^v12:\d+:[0-9a-f]{64}$/);

			const transcriptNull = await provider.readTranscript(
				defaultPlatformPathService,
				"non-existent-session-id-12345",
			);
			expect(transcriptNull).toBeNull();
		}
	}, 20000);

	test("F10-T1-04: Isolated Mock PlatformPathService session discovery and usage", async () => {
		const mockRoot = path.join(
			os.tmpdir(),
			`ct-mock-paths-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		);
		const mockCodexDir = path.join(mockRoot, ".codex", "sessions");
		mkdirSync(mockCodexDir, { recursive: true });

		const rolloutFile = path.join(
			mockCodexDir,
			"rollout-2026-11-16T12-00-00-thread-mock1.jsonl",
		);
		const sampleLine = JSON.stringify({
			timestamp: "2026-11-16T12:00:00.000Z",
			type: "turn_context",
			turn_id: "t1",
			payload: {
				cwd: "/home/user/project",
				model: "gpt-4o",
			},
		});
		const sampleUsageLine = JSON.stringify({
			timestamp: "2026-11-16T12:00:01.000Z",
			type: "token_usage_record",
			turn_id: "t1",
			payload: {
				usage: {
					input_tokens: 100,
					output_tokens: 50,
				},
			},
		});
		writeFileSync(rolloutFile, `${sampleLine}\n${sampleUsageLine}\n`);

		// Create mock platform path service pointing home to mockRoot
		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: mockRoot,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);

		const codex = new CodexProvider();
		const isAvail = await codex.isAvailable(mockPaths);
		expect(isAvail).toBe(true);

		const discovered = await codex.discoverSessions(mockPaths);
		expect(discovered.length).toBeGreaterThanOrEqual(1);
		expect(discovered[0]?.sessionId).toContain("mock1");

		const usage = await codex.readUsage(mockPaths);
		expect(usage.records.length).toBeGreaterThanOrEqual(1);
		expect(usage.records[0]?.inputTokens).toBe(100);
		expect(usage.records[0]?.outputTokens).toBe(50);

		rmSync(mockRoot, { recursive: true, force: true });
	});
});
