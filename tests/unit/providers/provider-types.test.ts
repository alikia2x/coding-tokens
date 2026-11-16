import { describe, expect, test } from "bun:test";
import { defaultPlatformPathService } from "../../../src/platform/paths";
import type {
	HarnessProvider,
	SessionDiscoveryItem,
} from "../../../src/providers/types";
import type { SourceResult, TranscriptSession } from "../../../src/types";

describe("Providers: Provider Types & Interface Contract (Feature 5)", () => {
	test("F5-T1-01: SessionDiscoveryItem interface conforms to specification", () => {
		const item: SessionDiscoveryItem = {
			sessionId: "session-abc-123",
			harness: "codex",
			filePath: "/home/user/.codex/rollouts/rollout-1.jsonl",
			mtimeMs: 1700000000000,
			sizeBytes: 1048576,
			cwd: "/home/user/projects/my-app",
		};

		expect(item.sessionId).toBe("session-abc-123");
		expect(item.harness).toBe("codex");
		expect(item.filePath).toBe("/home/user/.codex/rollouts/rollout-1.jsonl");
		expect(item.mtimeMs).toBe(1700000000000);
		expect(item.sizeBytes).toBe(1048576);
		expect(item.cwd).toBe("/home/user/projects/my-app");
	});

	test("F5-T1-02: SessionDiscoveryItem allows null and undefined cwd", () => {
		const itemWithNullCwd: SessionDiscoveryItem = {
			sessionId: "session-null-cwd",
			harness: "dsh",
			filePath: "/home/user/.dsh/session.json",
			mtimeMs: 1700000001000,
			sizeBytes: 2048,
			cwd: null,
		};
		expect(itemWithNullCwd.cwd).toBeNull();

		const itemWithoutCwd: SessionDiscoveryItem = {
			sessionId: "session-no-cwd",
			harness: "opencode",
			filePath: "/home/user/.opencode/sessions/1.db",
			mtimeMs: 1700000002000,
			sizeBytes: 4096,
		};
		expect(itemWithoutCwd.cwd).toBeUndefined();
	});

	test("F5-T1-03: HarnessProvider contract implementation and method invocations", async () => {
		const mockSession: SessionDiscoveryItem = {
			sessionId: "sess-1",
			harness: "codex",
			filePath: "/path/to/sess-1.jsonl",
			mtimeMs: 1000,
			sizeBytes: 500,
			cwd: "/path/to/cwd",
		};

		const mockTranscript: TranscriptSession = {
			sessionId: "sess-1",
			harness: "codex",
			cwd: "/path/to/cwd",
			title: "Mock Transcript Session",
			startedAt: 1000,
			items: [],
		};

		const mockUsage: SourceResult = {
			harness: "codex",
			available: true,
			warnings: [],
			messages: new Map([["sess-1", 1]]),
			records: [
				{
					harness: "codex",
					sessionId: "sess-1",
					messageId: "msg-1",
					turnId: "turn-1",
					isSubagent: false,
					cwd: "/path/to/cwd",
					model: "gpt-4o",
					timestamp: 1000,
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					costUsd: 0.001,
					costEstimated: true,
				},
			],
		};

		const mockProvider: HarnessProvider = {
			metadata: {
				id: "codex",
				displayName: "Codex",
				shortLabel: "Codex",
				description: "Mock Codex Provider",
				color: "#10a37f",
			},
			async isAvailable(paths) {
				return paths.getHomeDir().length > 0;
			},
			async discoverSessions(_paths) {
				return [mockSession];
			},
			async readUsage(_paths, item) {
				if (item) {
					return {
						...mockUsage,
						records: mockUsage.records.filter(
							(r) => r.sessionId === item.sessionId,
						),
					};
				}
				return mockUsage;
			},
			async readTranscript(_paths, sessionId) {
				return sessionId === "sess-1" ? mockTranscript : null;
			},
			async computeFingerprint(_paths) {
				return "v12:1:mockhash";
			},
			getWatchPaths(_paths) {
				return ["/mock/watch/path"];
			},
			async readTranscripts(_paths, targetFiles) {
				return {
					harness: "codex",
					available: true,
					sessions: [mockTranscript],
					warnings: [],
					indexedFiles: targetFiles
						? Array.from(targetFiles)
						: ["/path/to/sess-1.jsonl"],
				};
			},
		};

		// Test metadata
		expect(mockProvider.metadata.id).toBe("codex");
		expect(mockProvider.metadata.displayName).toBe("Codex");
		expect(mockProvider.metadata.color).toBe("#10a37f");

		// Test isAvailable
		const available = await mockProvider.isAvailable(
			defaultPlatformPathService,
		);
		expect(typeof available).toBe("boolean");

		// Test discoverSessions
		const discovered = await mockProvider.discoverSessions(
			defaultPlatformPathService,
		);
		expect(discovered).toHaveLength(1);
		expect(discovered[0]?.sessionId).toBe("sess-1");

		// Test readUsage with item
		const singleUsage = await mockProvider.readUsage(
			defaultPlatformPathService,
			mockSession,
		);
		expect(singleUsage.records).toHaveLength(1);
		expect(singleUsage.records[0]?.messageId).toBe("msg-1");

		// Test readUsage without item
		const fullUsage = await mockProvider.readUsage(defaultPlatformPathService);
		expect(fullUsage.records).toHaveLength(1);
		expect(fullUsage.available).toBe(true);

		// Test readTranscript hit & miss
		const transcriptHit = await mockProvider.readTranscript(
			defaultPlatformPathService,
			"sess-1",
		);
		expect(transcriptHit?.sessionId).toBe("sess-1");
		const transcriptMiss = await mockProvider.readTranscript(
			defaultPlatformPathService,
			"non-existent",
		);
		expect(transcriptMiss).toBeNull();

		// Test computeFingerprint
		const fp = await mockProvider.computeFingerprint(
			defaultPlatformPathService,
		);
		expect(fp).toBe("v12:1:mockhash");

		// Test getWatchPaths
		const watchPaths = mockProvider.getWatchPaths(defaultPlatformPathService);
		expect(watchPaths).toEqual(["/mock/watch/path"]);

		// Test optional readTranscripts
		expect(mockProvider.readTranscripts).toBeDefined();
		const batch = await mockProvider.readTranscripts?.(
			defaultPlatformPathService,
		);
		expect(batch?.sessions).toHaveLength(1);
	});
});
