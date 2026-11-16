import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { DefaultHarnessRegistry } from "../../../src/providers/registry";
import type { HarnessProvider } from "../../../src/providers/types";
import {
	createTranscriptService,
	DefaultTranscriptService,
	defaultTranscriptService,
	extractSearchText,
	resolveExportPath,
} from "../../../src/services/transcripts";
import type { TranscriptSession } from "../../../src/types";

describe("Services: TranscriptService & Markdown Export (Feature 9)", () => {
	const tmpRoot = path.join(
		os.tmpdir(),
		`ct-transcripts-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);

	afterAll(() => {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	});

	const sampleSession: TranscriptSession = {
		sessionId: "sess-abc-789",
		harness: "codex",
		title: "Refactoring Database Layer",
		cwd: "/workspace/my-app",
		startedAt: 1700000000000,
		items: [
			{
				id: "item-1",
				order: 1,
				turnId: "turn-1",
				role: "user",
				kind: "message",
				phase: "final",
				text: "Please check the database connection",
				timestamp: 1700000001000,
			},
			{
				id: "item-2",
				order: 2,
				turnId: "turn-1",
				role: "tool",
				kind: "tool_call",
				phase: "final",
				name: "bash",
				input: { command: "sqlite3 app.db .tables" },
				timestamp: 1700000005000,
			},
			{
				id: "item-3",
				order: 3,
				turnId: "turn-1",
				role: "tool",
				kind: "tool_result",
				phase: "final",
				output: "usage_records session_messages",
				timestamp: 1700000010000,
			},
			{
				id: "item-4",
				order: 4,
				turnId: "turn-1",
				role: "assistant",
				kind: "message",
				phase: "final",
				text: "The tables exist and the connection is healthy.",
				timestamp: 1700000015000,
			},
		],
	};

	test("F9-T1-01: Export path resolves to ~/Downloads with standardized filename", () => {
		const mockHome = path.join(tmpRoot, "mock-home");
		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: mockHome,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);

		const exportPath = resolveExportPath("session-xyz-123", mockPaths);
		expect(exportPath).toBe(
			path.join(mockHome, "Downloads", "session-session-xyz-123.md"),
		);
	});

	test("F9-T1-02: renderMarkdown formats session with headers and turns", () => {
		const service = new DefaultTranscriptService();
		const mdFull = service.renderMarkdown(sampleSession, {
			detail: "agent_full",
		});
		expect(mdFull).toContain("Refactoring Database Layer");
		expect(mdFull).toContain("Please check the database connection");
		expect(mdFull).toContain("The tables exist and the connection is healthy.");

		const mdSummary = service.renderMarkdown(sampleSession, {
			detail: "user_only",
		});
		expect(mdSummary).toContain("Refactoring Database Layer");
	});

	test("F9-T1-03: extractSearchText extracts text across user and assistant messages", () => {
		const text = extractSearchText(sampleSession);
		expect(text).toContain("Please check the database connection");
		expect(text).toContain("The tables exist and the connection is healthy.");
	});

	test("F9-T1-04: TranscriptService delegates to HarnessRegistry for session lookup", async () => {
		const registry = new DefaultHarnessRegistry();
		registry.clear();

		const mockProvider: HarnessProvider = {
			metadata: {
				id: "codex",
				displayName: "Codex",
				shortLabel: "Codex",
				color: "#000",
			},
			async isAvailable() {
				return true;
			},
			async discoverSessions() {
				return [];
			},
			async readUsage() {
				return {
					harness: "codex",
					available: true,
					records: [],
					warnings: [],
					messages: new Map(),
				};
			},
			async readTranscript(_paths, sessionId) {
				return sessionId === sampleSession.sessionId ? sampleSession : null;
			},
			async computeFingerprint() {
				return "v12:0:hash";
			},
			getWatchPaths() {
				return [];
			},
		};

		registry.register(mockProvider);

		const service = new DefaultTranscriptService(undefined, registry);

		// Hit
		const found = await service.getTranscript("codex", sampleSession.sessionId);
		expect(found?.title).toBe("Refactoring Database Layer");

		// Session miss
		const missing = await service.getTranscript(
			"codex",
			"non-existent-session",
		);
		expect(missing).toBeNull();

		// Harness miss
		const missingHarness = await service.getTranscript(
			"unknown-harness",
			sampleSession.sessionId,
		);
		expect(missingHarness).toBeNull();
	});

	test("F9-T1-05: exportMarkdown writes markdown file to disk", async () => {
		const mockHome = path.join(tmpRoot, "export-test-home");
		mkdirSync(path.join(mockHome, "Downloads"), { recursive: true });

		const mockEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: mockHome,
		});
		const mockPaths = new DefaultPlatformPathService(mockEnv);

		const service = new DefaultTranscriptService(mockPaths);
		const result = await service.exportMarkdown(sampleSession, {
			detail: "agent_full",
		});

		expect(existsSync(result.filePath)).toBe(true);
		const content = readFileSync(result.filePath, "utf-8");
		expect(content).toContain("Refactoring Database Layer");
	});

	test("F9-T1-06: Factory createTranscriptService and defaultTranscriptService singleton", () => {
		const custom = createTranscriptService();
		expect(custom).toBeInstanceOf(DefaultTranscriptService);
		expect(defaultTranscriptService).toBeInstanceOf(DefaultTranscriptService);
	});
});
