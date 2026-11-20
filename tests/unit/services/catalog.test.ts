import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageRecord } from "@shared/types";
import {
	buildSessionCatalog,
	cleanSessionTitle,
	codexFallbackSource,
} from "../../../server/data/catalog";
import {
	createCatalogService,
	DefaultSessionCatalogService,
	defaultSessionCatalogService,
} from "../../../server/services/catalog";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import { DefaultHarnessRegistry } from "../../../src/providers/registry";
import { createStorageService } from "../../../src/services/storage";
import { DefaultTranscriptService } from "../../../src/services/transcripts";

describe("Services: Session Catalog & Title Sanitization (Feature 9)", () => {
	let tmpRoot = "";
	let codexHome = "";
	const originalEnv: Record<string, string | undefined> = {};
	const envKeys = [
		"HOME",
		"CODEX_HOME",
		"DSH_HOME",
		"OPENCODE_DATA_DIR",
		"OPENCODE_DB",
		"COMMANDCODE_HOME",
		"ANTIGRAVITY_HOME",
		"T3_USER_DATA_DIR",
	] as const;

	beforeAll(() => {
		tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ct-catalog-test-"));
		const emptyDir = path.join(tmpRoot, "empty");
		codexHome = path.join(tmpRoot, "codex");
		mkdirSync(emptyDir, { recursive: true });
		mkdirSync(codexHome, { recursive: true });

		for (const key of envKeys) {
			originalEnv[key] = process.env[key];
		}

		process.env.HOME = tmpRoot;
		process.env.CODEX_HOME = codexHome;
		process.env.DSH_HOME = emptyDir;
		process.env.OPENCODE_DATA_DIR = emptyDir;
		process.env.OPENCODE_DB = path.join(emptyDir, "opencode.db");
		process.env.COMMANDCODE_HOME = emptyDir;
		process.env.ANTIGRAVITY_HOME = emptyDir;
		process.env.T3_USER_DATA_DIR = emptyDir;
	});

	afterAll(() => {
		for (const key of envKeys) {
			const prev = originalEnv[key];
			if (prev === undefined) delete process.env[key];
			else process.env[key] = prev;
		}
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F9-T1-01: Session catalog building and grouping across multiple sessions", () => {
		const records: UsageRecord[] = [
			{
				harness: "codex",
				sessionId: "session-alpha",
				messageId: "m1",
				cwd: "/workspace/repo-a",
				model: "GPT-4o",
				timestamp: 1700000001000,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.001,
				costEstimated: false,
			},
			{
				harness: "codex",
				sessionId: "session-alpha",
				messageId: "m2",
				cwd: "/workspace/repo-a",
				model: "GPT-4o",
				timestamp: 1700000005000,
				inputTokens: 200,
				outputTokens: 80,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.002,
				costEstimated: false,
			},
			{
				harness: "dsh",
				sessionId: "session-beta",
				messageId: "m3",
				cwd: "/workspace/repo-b",
				model: "DeepSeek Chat",
				timestamp: 1700000010000,
				inputTokens: 500,
				outputTokens: 150,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.005,
				costEstimated: false,
				isSubagent: true,
			},
		];

		const catalog = buildSessionCatalog(records);

		expect(catalog.entries).toBeDefined();
		const alphaEntry = catalog.entries.get("codex:session-alpha");
		expect(alphaEntry).toBeDefined();
		expect(alphaEntry?.harness).toBe("codex");
		expect(alphaEntry?.sessionId).toBe("session-alpha");
		expect(alphaEntry?.cwd).toBe("/workspace/repo-a");
		expect(alphaEntry?.startedAt).toBe(1700000001000);

		const betaEntry = catalog.entries.get("dsh:session-beta");
		expect(betaEntry).toBeDefined();
		expect(betaEntry?.harness).toBe("dsh");
		expect(betaEntry?.sessionId).toBe("session-beta");
		expect(betaEntry?.cwd).toBe("/workspace/repo-b");
		expect(betaEntry?.startedAt).toBe(1700000010000);
		expect(betaEntry?.isSubagent).toBe(true);
	});

	test("F9-T1-02: User message and session title sanitization", () => {
		// Strips ## My request: prefix
		expect(cleanSessionTitle("## My request: Fix authentication bug")).toBe(
			"Fix authentication bug",
		);

		// Strips markdown headers and quotes
		expect(cleanSessionTitle('### "Refactor Database Module"')).toBe(
			"Refactor Database Module",
		);
		expect(cleanSessionTitle("`cargo test --release`")).toBe(
			"cargo test --release",
		);

		// Collapses internal whitespace and newlines
		expect(cleanSessionTitle("Line 1\nLine 2\tLine 3")).toBe(
			"Line 1 Line 2 Line 3",
		);
	});

	test("F9-T1-03: Codex fallback source helper returns null for missing and file source when present", () => {
		expect(codexFallbackSource("non-existent-session-id-12345")).toBeNull();

		const sessionsDir = path.join(codexHome, "sessions", "2026", "03", "01");
		mkdirSync(sessionsDir, { recursive: true });
		const rolloutPath = path.join(
			sessionsDir,
			"rollout-2026-03-01T10-00-00-fallback-sess-1.jsonl",
		);
		writeFileSync(
			rolloutPath,
			`${JSON.stringify({
				type: "session_meta",
				timestamp: "2026-03-01T10:00:00.000Z",
				payload: { id: "fallback-sess-1" },
			})}\n`,
			"utf8",
		);
		const found = codexFallbackSource("fallback-sess-1");
		expect(found).toEqual({ kind: "file", path: rolloutPath });
	});

	// =========================================================================
	// Tier 2: Boundary & Edge Cases
	// =========================================================================

	test("F9-T2-01: Empty records catalog building returns valid catalog structure without throwing", () => {
		const catalog = buildSessionCatalog([]);
		expect(catalog.entries).toBeInstanceOf(Map);
		expect(Array.isArray(catalog.warnings)).toBe(true);
	});

	test("F9-T2-02: Handling null, undefined, and empty string session titles", () => {
		expect(cleanSessionTitle(null)).toBe("Untitled session");
		expect(cleanSessionTitle(undefined)).toBe("Untitled session");
		expect(cleanSessionTitle("")).toBe("Untitled session");
		expect(cleanSessionTitle("    ")).toBe("Untitled session");
		expect(cleanSessionTitle("### ")).toBe("Untitled session");
	});

	test("F9-T2-03: Extreme title length truncation to <= 160 characters", () => {
		const longTitle = "A".repeat(300);
		const sanitized = cleanSessionTitle(longTitle);
		expect(Array.from(sanitized).length).toBeLessThanOrEqual(160);
		expect(sanitized.endsWith("…")).toBe(true);

		// Exactly 160 characters should not have ellipsis appended
		const exactTitle = "B".repeat(160);
		expect(cleanSessionTitle(exactTitle)).toBe(exactTitle);
	});

	test("F9-T2-04: Subagent and review flag propagation in catalog building", () => {
		const records: UsageRecord[] = [
			{
				harness: "opencode",
				sessionId: "sess-flags",
				messageId: "m1",
				cwd: null,
				model: "GPT-4o",
				timestamp: 1000,
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.0001,
				costEstimated: false,
				isSubagent: false,
				isReview: true,
			},
			{
				harness: "opencode",
				sessionId: "sess-flags",
				messageId: "m2",
				cwd: null,
				model: "GPT-4o",
				timestamp: 2000,
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.0001,
				costEstimated: false,
				isSubagent: true,
			},
		];

		const catalog = buildSessionCatalog(records);
		const entry = catalog.entries.get("opencode:sess-flags");
		expect(entry).toBeDefined();
		expect(entry?.isSubagent).toBe(true);
		expect(entry?.isReview).toBe(true);
	});
});

describe("Services: DefaultSessionCatalogService (Feature 9)", () => {
	let serviceTmpRoot = "";
	const originalEnv: Record<string, string | undefined> = {};
	const envKeys = [
		"HOME",
		"CODEX_HOME",
		"DSH_HOME",
		"OPENCODE_DATA_DIR",
		"OPENCODE_DB",
		"COMMANDCODE_HOME",
		"ANTIGRAVITY_HOME",
		"T3_USER_DATA_DIR",
	] as const;

	beforeAll(() => {
		serviceTmpRoot = mkdtempSync(
			path.join(os.tmpdir(), "ct-catalog-service-test-"),
		);
		const emptyDir = path.join(serviceTmpRoot, "empty");
		mkdirSync(emptyDir, { recursive: true });
		for (const key of envKeys) {
			originalEnv[key] = process.env[key];
		}
		process.env.HOME = serviceTmpRoot;
		process.env.CODEX_HOME = emptyDir;
		process.env.DSH_HOME = emptyDir;
		process.env.OPENCODE_DATA_DIR = emptyDir;
		process.env.OPENCODE_DB = path.join(emptyDir, "opencode.db");
		process.env.COMMANDCODE_HOME = emptyDir;
		process.env.ANTIGRAVITY_HOME = emptyDir;
		process.env.T3_USER_DATA_DIR = emptyDir;
	});

	afterAll(() => {
		for (const key of envKeys) {
			const prev = originalEnv[key];
			if (prev === undefined) delete process.env[key];
			else process.env[key] = prev;
		}
		if (serviceTmpRoot) {
			rmSync(serviceTmpRoot, { recursive: true, force: true });
		}
	});

	function createIsolatedCatalogDeps() {
		const mockPaths = new DefaultPlatformPathService(
			new MockOsEnvProvider({ platform: "darwin", home: serviceTmpRoot }),
		);
		const emptyRegistry = new DefaultHarnessRegistry();
		emptyRegistry.clear();
		const storage = createStorageService({
			dbPath: path.join(
				serviceTmpRoot,
				`catalog-${Math.random().toString(36).slice(2, 8)}.db`,
			),
		});
		const transcripts = new DefaultTranscriptService(mockPaths, emptyRegistry);
		return { mockPaths, emptyRegistry, storage, transcripts };
	}

	test("F9-T1-04: SessionCatalogService initialization and query APIs", async () => {
		const { mockPaths, emptyRegistry, storage, transcripts } =
			createIsolatedCatalogDeps();
		try {
			const catalogService = createCatalogService(
				storage,
				emptyRegistry,
				transcripts,
				mockPaths,
			);
			expect(catalogService).toBeInstanceOf(DefaultSessionCatalogService);

			await catalogService.init();

			const catalog = await catalogService.getCatalog();
			expect(catalog).toEqual([]);

			const summaries = await catalogService.getSessionSummaries({
				from: null,
				until: null,
			});
			expect(summaries).toEqual([]);

			const searchResult = await catalogService.search(
				"nonexistent_unique_term_9999",
			);
			expect(searchResult.sessions).toHaveLength(0);
		} finally {
			await storage.close();
		}
	});

	test("F9-T1-05: SessionCatalogService detail lookup for non-existent session returns null", async () => {
		const { mockPaths, emptyRegistry, storage, transcripts } =
			createIsolatedCatalogDeps();
		try {
			const catalogService = new DefaultSessionCatalogService(
				storage,
				emptyRegistry,
				transcripts,
				mockPaths,
			);
			const detail = await catalogService.getSessionDetail(
				"codex",
				"missing-id-999",
			);
			expect(detail).toBeNull();
		} finally {
			await storage.close();
		}
	});

	test("F9-T1-06: defaultSessionCatalogService singleton export", () => {
		expect(defaultSessionCatalogService).toBeDefined();
		expect(defaultSessionCatalogService).toBeInstanceOf(
			DefaultSessionCatalogService,
		);
	});
});
