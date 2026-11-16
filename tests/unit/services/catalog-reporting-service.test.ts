import { describe, expect, test } from "bun:test";
import {
	createCatalogService,
	DefaultSessionCatalogService,
	defaultSessionCatalogService,
} from "../../../server/services/catalog";
import {
	createReportingService,
	DefaultReportingService,
	defaultReportingService,
	type ReportingDataProvider,
} from "../../../server/services/reporting";
import type { UsageRecord } from "../../../shared/types";
import { DefaultHarnessRegistry } from "../../../src/providers/registry";

describe("Services: Catalog & Reporting Services (Feature 9)", () => {
	const sampleRecords: UsageRecord[] = [
		{
			harness: "codex",
			sessionId: "sess-rep-1",
			messageId: "m1",
			turnId: "t1",
			isSubagent: false,
			cwd: "/users/dev/app",
			model: "gpt-4o",
			timestamp: 1700000000000,
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 100,
			cacheWriteTokens: 50,
			reasoningTokens: 20,
			costUsd: 0.015,
			costEstimated: false,
		},
		{
			harness: "codex",
			sessionId: "sess-rep-1",
			messageId: "m2",
			turnId: "t2",
			isSubagent: false,
			cwd: "/users/dev/app",
			model: "gpt-4o",
			timestamp: 1700000005000,
			inputTokens: 2000,
			outputTokens: 800,
			cacheReadTokens: 200,
			cacheWriteTokens: 100,
			reasoningTokens: 50,
			costUsd: 0.025,
			costEstimated: false,
		},
		{
			harness: "dsh",
			sessionId: "sess-rep-2",
			messageId: "m3",
			turnId: "t1",
			isSubagent: false,
			cwd: "/users/dev/web",
			model: "claude-3-5-sonnet",
			timestamp: 1700000010000,
			inputTokens: 3000,
			outputTokens: 1000,
			cacheReadTokens: 500,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.035,
			costEstimated: false,
		},
	];

	// =========================================================================
	// ReportingService Tests
	// =========================================================================

	test("F9-T1-01: ReportingService calculateTotals performs accurate token and cost summation", () => {
		const service = new DefaultReportingService();
		const totals = service.calculateTotals(sampleRecords);

		expect(totals.inputTokens).toBe(6000);
		expect(totals.outputTokens).toBe(2300);
		expect(totals.cacheReadTokens).toBe(800);
		expect(totals.cacheWriteTokens).toBe(150);
		expect(totals.reasoningTokens).toBe(70);
		expect(totals.costUsd).toBeCloseTo(0.075, 4);
	});

	test("F9-T1-02: ReportingService with custom ReportingDataProvider mock", () => {
		const mockProvider: ReportingDataProvider = {
			getRecords: () => sampleRecords,
			getMessagesFor: (_records) => 3,
			getSessionSummaries: (_range) => [
				{
					key: "codex:sess-rep-1",
					sessionId: "sess-rep-1",
					harness: "codex",
					title: "Test Session 1",
					cwd: "/users/dev/app",
					projectName: "app",
					models: ["gpt-4o"],
					startedAt: 1700000000000,
					lastActivityAt: 1700000005000,
					durationMs: 5000,
					totals: {
						sessions: 1,
						messages: 2,
						requests: 2,
						inputTokens: 3000,
						outputTokens: 1300,
						cacheReadTokens: 300,
						cacheWriteTokens: 150,
						reasoningTokens: 70,
						costUsd: 0.04,
						estimatedRequests: 0,
						unpricedRequests: 0,
					},
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
				},
			],
			getWarnings: () => ["Warning A"],
			getLastIndexedAt: () => 1700000020000,
			getSourcePaths: () => ({ codex: ["/mock/codex"] }),
		};

		const customReporting = createReportingService(mockProvider);
		expect(customReporting).toBeInstanceOf(DefaultReportingService);

		// Heatmap report
		const heatmap = customReporting.getHeatmapReport(4);
		expect(heatmap).toBeDefined();
		expect(Array.isArray(heatmap.days)).toBe(true);

		// Explore report
		const explore = customReporting.getExploreReport({
			dimension: "model",
			filters: {},
			mode: "time",
			metric: "tokens",
			bucket: "day",
			breakdown: "none",
		});
		expect(explore).toBeDefined();
		expect(explore.dimension).toBe("model");
	});

	test("F9-T1-03: defaultReportingService singleton conforms to ReportingService interface", () => {
		expect(defaultReportingService).toBeDefined();
		expect(typeof defaultReportingService.getOverview).toBe("function");
		expect(typeof defaultReportingService.getProjectReport).toBe("function");
		expect(typeof defaultReportingService.getModelReport).toBe("function");
		expect(typeof defaultReportingService.getHarnessReport).toBe("function");
	});

	// =========================================================================
	// SessionCatalogService Tests
	// =========================================================================

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
