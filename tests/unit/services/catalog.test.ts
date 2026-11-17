import { describe, expect, test } from "bun:test";
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
import { DefaultHarnessRegistry } from "../../../src/providers/registry";

describe("Services: Session Catalog & Title Sanitization (Feature 9)", () => {
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

	test("F9-T1-03: Codex fallback source helper returns null or valid file source", () => {
		const fallback = codexFallbackSource("non-existent-session-id-12345");
		expect(fallback === null || fallback.kind === "file").toBe(true);
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
	test("F9-T1-04: SessionCatalogService initialization and query APIs", async () => {
		const emptyRegistry = new DefaultHarnessRegistry();
		emptyRegistry.clear();
		const catalogService = createCatalogService(undefined, emptyRegistry);
		expect(catalogService).toBeInstanceOf(DefaultSessionCatalogService);

		await catalogService.init();

		const catalog = await catalogService.getCatalog();
		expect(Array.isArray(catalog)).toBe(true);

		const summaries = await catalogService.getSessionSummaries({
			from: null,
			until: null,
		});
		expect(Array.isArray(summaries)).toBe(true);

		const searchResult = await catalogService.search(
			"nonexistent_unique_term_9999",
		);
		expect(searchResult).toBeDefined();
		expect(searchResult.sessions).toHaveLength(0);
	}, 15000);

	test("F9-T1-05: SessionCatalogService detail lookup for non-existent session returns null", async () => {
		const emptyRegistry = new DefaultHarnessRegistry();
		emptyRegistry.clear();
		const catalogService = new DefaultSessionCatalogService(
			undefined,
			emptyRegistry,
		);
		const detail = await catalogService.getSessionDetail(
			"codex",
			"missing-id-999",
		);
		expect(detail).toBeNull();
	}, 15000);

	test("F9-T1-06: defaultSessionCatalogService singleton export", () => {
		expect(defaultSessionCatalogService).toBeDefined();
		expect(defaultSessionCatalogService).toBeInstanceOf(
			DefaultSessionCatalogService,
		);
	});
});
