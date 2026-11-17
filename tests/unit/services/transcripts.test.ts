import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchesTextQuery, parseSearchQuery } from "@shared/search";
import { extractSnippet } from "../../../server/data/search";
import { renderSessionMarkdown } from "../../../src/exporter";
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
import {
	extractHarnessSearchTexts,
	filterTranscriptSessions,
	type TranscriptItem,
	type TranscriptSession,
} from "../../../src/transcripts";

describe("Services: Transcript Services, Snippets & Search (Feature 9)", () => {
	const sampleItems: TranscriptItem[] = [
		{
			id: "item-1",
			order: 1,
			turnId: "turn-1",
			role: "user",
			kind: "message",
			phase: "unknown",
			text: "Please refactor the database storage module to use WAL mode.",
			timestamp: 1700000001000,
		},
		{
			id: "item-2",
			order: 2,
			turnId: "turn-1",
			role: "assistant",
			kind: "message",
			phase: "intermediate",
			text: "I will inspect the existing database schema first.",
			timestamp: 1700000002000,
		},
		{
			id: "item-3",
			order: 3,
			turnId: "turn-1",
			role: "tool",
			kind: "tool_call",
			phase: "unknown",
			name: "read_file",
			input: { path: "server/data/database.ts" },
			timestamp: 1700000003000,
		},
		{
			id: "item-4",
			order: 4,
			turnId: "turn-1",
			role: "tool",
			kind: "tool_result",
			phase: "unknown",
			name: "read_file",
			output: "export function openStoreDatabase() { ... }",
			timestamp: 1700000004000,
		},
		{
			id: "item-5",
			order: 5,
			turnId: "turn-1",
			role: "assistant",
			kind: "message",
			phase: "final",
			text: "The database module has been updated to use SQLite WAL mode and atomic transactions.",
			timestamp: 1700000005000,
		},
	];

	const sampleSession: TranscriptSession = {
		harness: "codex",
		sessionId: "session-transcript-1",
		title: "Refactor Database Module",
		cwd: "/Users/dev/coding-tokens",
		startedAt: 1700000001000,
		items: sampleItems,
		usageRecords: [
			{
				harness: "codex",
				sessionId: "session-transcript-1",
				messageId: "item-5",
				cwd: "/Users/dev/coding-tokens",
				model: "GPT-4o",
				timestamp: 1700000005000,
				inputTokens: 1500,
				outputTokens: 600,
				cacheReadTokens: 300,
				cacheWriteTokens: 100,
				reasoningTokens: 0,
				costUsd: 0.015,
				costEstimated: false,
			},
		],
	};

	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F9-T1-01: Search snippet extraction with centered context around term", () => {
		const body =
			"This is an introductory paragraph describing the architecture. We then proceed to refactor the database storage subsystem to use WAL mode. Finally we run comprehensive verification tests.";
		const snippet = extractSnippet(body, ["refactor"], 60);

		expect(snippet).toBeDefined();
		expect(snippet).toContain("refactor");
		// Check leading and trailing ellipsis when centered inside text
		expect(snippet?.startsWith("…")).toBe(true);
		expect(snippet?.endsWith("…")).toBe(true);
	});

	test("F9-T1-02: extractHarnessSearchTexts aggregates searchable text map from harness sources", () => {
		const searchMap = extractHarnessSearchTexts("codex");
		expect(searchMap).toBeInstanceOf(Map);
	});

	test("F9-T1-03: filterTranscriptSessions filters by harness, cwd and date ranges", () => {
		const filteredHarness = filterTranscriptSessions([sampleSession], {
			harnesses: new Set(["codex"]),
		});
		expect(filteredHarness.length).toBe(1);

		const excludedHarness = filterTranscriptSessions([sampleSession], {
			harnesses: new Set(["dsh"]),
		});
		expect(excludedHarness.length).toBe(0);

		const filteredProject = filterTranscriptSessions([sampleSession], {
			harnesses: new Set(["codex"]),
			projects: new Set(["/Users/dev/coding-tokens"]),
		});
		expect(filteredProject.length).toBe(1);
	});

	test("F9-T1-04: renderSessionMarkdown renders markdown with headers and token stats", () => {
		const markdown = renderSessionMarkdown(sampleSession, {
			detail: "chat",
			includeTimestamps: true,
			includeTokenStats: true,
		});

		expect(markdown).toBeDefined();
		expect(typeof markdown).toBe("string");
		expect(markdown).toContain("# Refactor Database Module");
		expect(markdown).toContain("Please refactor the database storage module");
		expect(markdown).toContain("The database module has been updated");
	});

	// =========================================================================
	// Tier 2: Boundary, Detail Hierarchy & Edge Cases
	// =========================================================================

	test("F9-T2-01: Detail level hierarchy filtering verification", () => {
		// user_only: includes only user messages
		const mdUserOnly = renderSessionMarkdown(sampleSession, {
			detail: "user_only",
		});
		expect(mdUserOnly).toContain("Please refactor the database storage module");
		expect(mdUserOnly).not.toContain(
			"I will inspect the existing database schema first",
		);
		expect(mdUserOnly).not.toContain("read_file");

		// chat_compact: includes user and final assistant message (omits commentary and tools)
		const mdCompact = renderSessionMarkdown(sampleSession, {
			detail: "chat_compact",
		});
		expect(mdCompact).toContain("Please refactor the database storage module");
		expect(mdCompact).toContain("The database module has been updated");
		expect(mdCompact).not.toContain(
			"I will inspect the existing database schema first",
		);
		expect(mdCompact).not.toContain("read_file");

		// chat: includes user and all assistant messages (omits tools)
		const mdChat = renderSessionMarkdown(sampleSession, {
			detail: "chat",
		});
		expect(mdChat).toContain("Please refactor the database storage module");
		expect(mdChat).toContain(
			"I will inspect the existing database schema first",
		);
		expect(mdChat).toContain("The database module has been updated");
		expect(mdChat).not.toContain("read_file");

		// chat_tools: includes user, assistant messages, and tools summary markdown
		const mdTools = renderSessionMarkdown(sampleSession, {
			detail: "chat_tools",
		});
		expect(mdTools).toContain("Please refactor the database storage module");
		expect(mdTools).toContain("[TOOLS]");

		// agent: includes tool calls and results inline
		const mdAgent = renderSessionMarkdown(sampleSession, {
			detail: "agent",
		});
		expect(mdAgent).toContain("read_file");
	});

	test("F9-T2-02: Full-text search negative keyword filtering and phrase matching", () => {
		const text = "Refactoring the storage layer for performance and security";

		// Positive term match
		const q1 = parseSearchQuery("storage performance");
		expect(matchesTextQuery(q1, [text])).toBe(true);

		// Negative keyword filtering: excludes when negative term present
		const q2 = parseSearchQuery("storage -deprecated");
		expect(matchesTextQuery(q2, [text])).toBe(true);

		const q3 = parseSearchQuery("storage -security");
		expect(matchesTextQuery(q3, [text])).toBe(false);

		// Quoted phrase matching
		const q4 = parseSearchQuery('"storage layer"');
		expect(matchesTextQuery(q4, [text])).toBe(true);

		const q5 = parseSearchQuery('"database layer"');
		expect(matchesTextQuery(q5, [text])).toBe(false);
	});

	test("F9-T2-03: extractSnippet boundary cases", () => {
		// Empty body or empty terms
		expect(extractSnippet("", ["test"])).toBeNull();
		expect(extractSnippet("some text", [])).toBeNull();
		expect(extractSnippet(undefined, ["test"])).toBeNull();

		// Term not found
		expect(extractSnippet("hello world", ["nonexistent"])).toBeNull();

		// Term at very start of text (no leading ellipsis)
		const startSnippet = extractSnippet(
			"Keyword at the very beginning of line",
			["Keyword"],
			30,
		);
		expect(startSnippet?.startsWith("…")).toBe(false);
		expect(startSnippet?.startsWith("Keyword")).toBe(true);

		// Term at very end of text (no trailing ellipsis)
		const endSnippet = extractSnippet(
			"Text ending with target",
			["target"],
			30,
		);
		expect(endSnippet?.endsWith("…")).toBe(false);
		expect(endSnippet?.endsWith("target")).toBe(true);
	});

	test("F9-T2-04: renderSessionMarkdown returns null when session has no matching items", () => {
		const emptySession: TranscriptSession = {
			harness: "codex",
			sessionId: "empty-session",
			cwd: null,
			startedAt: null,
			items: [],
		};

		const result = renderSessionMarkdown(emptySession, {
			detail: "chat",
		});
		expect(result).toBeNull();
	});
});

describe("Services: DefaultTranscriptService & Markdown Export (Feature 9)", () => {
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
