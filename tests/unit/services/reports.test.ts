import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "@shared/types";
import { harnessPaths } from "../../../server/data/paths";
import {
	harnessReportPayload,
	modelReportPayload,
	overviewPayload,
	overviewSummaryText,
	projectReportPayload,
} from "../../../server/data/reports";
import {
	addRecord,
	bucketize,
	chooseBucketUnit,
	emptyTotals,
	filterRecords,
	mergeTotals,
	projectName,
	roundTotals,
	sparkline,
	summarizeRecords,
	summarizeSessionRecords,
	totalTokens,
} from "../../../server/data/totals";
import {
	createReportingService,
	DefaultReportingService,
	defaultReportingService,
	type ReportingDataProvider,
} from "../../../server/services/reporting";

describe("Services: Reporting & Multi-Dimensional Aggregations (Feature 9)", () => {
	const sampleRecords: UsageRecord[] = [
		{
			harness: "codex",
			sessionId: "sess-1",
			messageId: "m1",
			cwd: "/Users/dev/project-alpha",
			model: "GPT-4o",
			timestamp: 1700000000000,
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200,
			cacheWriteTokens: 100,
			reasoningTokens: 50,
			costUsd: 0.015,
			costEstimated: false,
		},
		{
			harness: "codex",
			sessionId: "sess-1",
			messageId: "m2",
			cwd: "/Users/dev/project-alpha",
			model: "GPT-4o",
			timestamp: 1700003600000,
			inputTokens: 2000,
			outputTokens: 800,
			cacheReadTokens: 400,
			cacheWriteTokens: 200,
			reasoningTokens: 100,
			costUsd: 0.03,
			costEstimated: true,
		},
		{
			harness: "antigravity",
			sessionId: "sess-2",
			messageId: "m3",
			cwd: "/Users/dev/project-beta",
			model: "Claude 3.5 Sonnet",
			timestamp: 1700086400000,
			inputTokens: 5000,
			outputTokens: 1500,
			cacheReadTokens: 1000,
			cacheWriteTokens: 500,
			reasoningTokens: 0,
			costUsd: 0.08,
			costEstimated: false,
		},
	];

	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F9-T1-01: summarizeRecords aggregates multi-session usage metrics correctly", () => {
		const totals = summarizeRecords(sampleRecords);

		expect(totals.sessions).toBe(2);
		expect(totals.requests).toBe(3);
		expect(totals.inputTokens).toBe(8000);
		expect(totals.outputTokens).toBe(2800);
		expect(totals.cacheReadTokens).toBe(1600);
		expect(totals.cacheWriteTokens).toBe(800);
		expect(totals.reasoningTokens).toBe(150);
		expect(totals.costUsd).toBeCloseTo(0.125, 4);
		expect(totals.estimatedRequests).toBe(1);
		expect(totals.unpricedRequests).toBe(0);

		// Total tokens helper
		expect(totalTokens(totals)).toBe(8000 + 2800 + 1600 + 800);
	});

	test("F9-T1-02: chooseBucketUnit selects appropriate time resolution", () => {
		// <= 48 hours -> hour
		const hourSpan = 24 * 60 * 60 * 1000;
		expect(chooseBucketUnit(1000, 1000 + hourSpan)).toBe("hour");

		// < 89 days -> day
		const daySpan = 30 * 24 * 60 * 60 * 1000;
		expect(chooseBucketUnit(1000, 1000 + daySpan)).toBe("day");

		// >= 89 days (e.g. 90d / 200d) -> month
		const ninetyDaySpan = 89 * 24 * 60 * 60 * 1000;
		expect(chooseBucketUnit(1000, 1000 + ninetyDaySpan)).toBe("month");
		const longSpan = 200 * 24 * 60 * 60 * 1000;
		expect(chooseBucketUnit(1000, 1000 + longSpan)).toBe("month");

		// null bounds default to day when no records provided
		expect(chooseBucketUnit(null, null)).toBe("day");

		// null or single-sided bounds resolve from actual record timestamps
		const baseRecord = sampleRecords[0];
		if (!baseRecord) throw new Error("expected sampleRecord");
		const oldRecord = {
			...baseRecord,
			timestamp: new Date(2026, 0, 1).getTime(),
		};
		const newRecord = {
			...baseRecord,
			timestamp: new Date(2026, 5, 1).getTime(),
		};
		expect(chooseBucketUnit(null, null, [oldRecord, newRecord])).toBe("month");
		expect(
			chooseBucketUnit(new Date(2026, 0, 1).getTime(), null, [
				oldRecord,
				newRecord,
			]),
		).toBe("month");
		expect(
			chooseBucketUnit(null, new Date(2026, 0, 2).getTime(), [oldRecord]),
		).toBe("hour");
	});

	test("F9-T1-03: bucketize groups records into temporal intervals with totals", () => {
		const from = 1700000000000;
		const until = 1700100000000;
		const buckets = bucketize(sampleRecords, from, until, "day");

		expect(buckets.length).toBeGreaterThan(0);
		let bucketRequestSum = 0;
		for (const bucket of buckets) {
			expect(typeof bucket.key).toBe("string");
			expect(typeof bucket.label).toBe("string");
			expect(bucket.start).toBeLessThan(bucket.end);
			expect(bucket.totals.requests).toBeGreaterThanOrEqual(0);
			expect(bucket.totals.costUsd).toBeGreaterThanOrEqual(0);
			bucketRequestSum += bucket.totals.requests;
		}
		expect(bucketRequestSum).toBe(3);
	});

	test("F9-T1-04: sparkline generates fixed-length normalized cost series", () => {
		const points = 14;
		const series = sparkline(
			sampleRecords,
			1700000000000,
			1700100000000,
			points,
		);

		expect(series.length).toBe(points);
		for (const pt of series) {
			expect(typeof pt).toBe("number");
			expect(pt).toBeGreaterThanOrEqual(0);
		}

		// Sum of sparkline costs matches total cost of records
		const sparkSum = series.reduce((a, b) => a + b, 0);
		expect(sparkSum).toBeCloseTo(0.125, 4);
	});

	test("F9-T1-05: Overview, Project, Model and Harness report payloads return valid structures", () => {
		// Overview payload
		const overview = overviewPayload({});
		expect(overview.totals.sessions).toBeGreaterThanOrEqual(0);
		expect(overview.totals.requests).toBeGreaterThanOrEqual(0);
		expect(overview.totals.costUsd).toBeGreaterThanOrEqual(0);
		expect(Array.isArray(overview.buckets)).toBe(true);
		expect(Array.isArray(overview.harnesses)).toBe(true);
		expect(Array.isArray(overview.models)).toBe(true);
		expect(Array.isArray(overview.projects)).toBe(true);
		expect(Array.isArray(overview.warnings)).toBe(true);

		// Overview summary text
		const summaryText = overviewSummaryText(overview.totals);
		expect(typeof summaryText).toBe("string");
		expect(summaryText.length).toBeGreaterThan(0);

		// Project report payload
		const projectRep = projectReportPayload({});
		expect(projectRep.totals.sessions).toBe(overview.totals.sessions);
		expect(Array.isArray(projectRep.rows)).toBe(true);

		// Model report payload
		const modelRep = modelReportPayload({});
		expect(modelRep.totals.requests).toBe(overview.totals.requests);
		expect(Array.isArray(modelRep.rows)).toBe(true);

		// Harness report payload
		const harnessRep = harnessReportPayload({}, harnessPaths());
		expect(harnessRep.totals.costUsd).toBe(overview.totals.costUsd);
		expect(harnessRep.rows.length).toBe(15);
	});

	// =========================================================================
	// Tier 2: Boundary, Zero & Filter Edge Cases
	// =========================================================================

	test("F9-T2-01: Empty records return zeroed totals and empty sparkline without NaN", () => {
		const empty = summarizeRecords([]);
		expect(empty.sessions).toBe(0);
		expect(empty.messages).toBe(0);
		expect(empty.requests).toBe(0);
		expect(empty.costUsd).toBe(0);
		expect(totalTokens(empty)).toBe(0);

		const emptySpark = sparkline([], null, null);
		expect(emptySpark).toEqual([]);
	});

	test("F9-T2-02: filterRecords and recordMatches boundary filtering", () => {
		// Timestamp filtering
		const midTimestamp = 1700003600000;
		const filteredTime = filterRecords(sampleRecords, {
			from: midTimestamp,
			until: midTimestamp + 1000,
		});
		expect(filteredTime.length).toBe(1);
		expect(filteredTime[0]?.messageId).toBe("m2");

		// Harness filtering
		const filteredHarness = filterRecords(sampleRecords, {
			harnesses: new Set(["antigravity"]),
		});
		expect(filteredHarness.length).toBe(1);
		expect(filteredHarness[0]?.harness).toBe("antigravity");

		// Project cwd filtering
		const filteredProject = filterRecords(sampleRecords, {
			projects: new Set(["/Users/dev/project-alpha"]),
		});
		expect(filteredProject.length).toBe(2);

		// Model filtering
		const filteredModel = filterRecords(sampleRecords, {
			models: new Set(["Claude 3.5 Sonnet"]),
		});
		expect(filteredModel.length).toBe(1);

		// Inverted range (from > until) returns no records
		const inverted = filterRecords(sampleRecords, {
			from: 2000,
			until: 1000,
		});
		expect(inverted.length).toBe(0);
	});

	test("F9-T2-03: Cumulative record handling in summarizeSessionRecords", () => {
		const cumulativeRecords: UsageRecord[] = [
			{
				harness: "antigravity",
				sessionId: "sess-cum",
				messageId: "m1",
				cwd: null,
				model: "Gemini 2.0 Flash",
				timestamp: 1000,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0.001,
				costEstimated: false,
			},
			{
				harness: "antigravity",
				sessionId: "sess-cum",
				messageId: "m1:cumulative-total", // Cumulative final record
				cwd: null,
				model: "Gemini 2.0 Flash",
				timestamp: 2000,
				inputTokens: 500, // Cumulative total represents whole session
				outputTokens: 250,
				cacheReadTokens: 50,
				cacheWriteTokens: 20,
				reasoningTokens: 0,
				costUsd: 0.005,
				costEstimated: false,
			},
		];

		const summary = summarizeSessionRecords(cumulativeRecords);
		// Cumulative record basis replaces individual additions
		expect(summary.inputTokens).toBe(500);
		expect(summary.outputTokens).toBe(250);
		expect(summary.costUsd).toBe(0.005);
		expect(summary.requests).toBe(1); // non-cumulative request count
	});

	test("F9-T2-04: projectName sanitization and fallback", () => {
		expect(projectName("/Users/dev/workspace/my-app")).toBe("my-app");
		expect(projectName("C:/Users/dev/workspace/win-repo")).toBe("win-repo");
		expect(projectName(null)).toBe("Unknown project");
		expect(projectName("")).toBe("Unknown project");
		expect(projectName("/trailing/slash/")).toBe("slash");
	});

	test("F9-T2-05: roundTotals, addRecord, and mergeTotals numeric safety", () => {
		const t1 = emptyTotals();
		const t2 = emptyTotals();

		t1.costUsd = 0.123456789123;
		const rounded = roundTotals(t1);
		expect(rounded.costUsd).toBe(0.12345679);

		addRecord(t2, {
			harness: "codex",
			sessionId: "s",
			messageId: "m",
			cwd: null,
			model: "m",
			timestamp: null,
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: null, // Unpriced
			costEstimated: false,
		});
		expect(t2.unpricedRequests).toBe(1);

		mergeTotals(t1, t2);
		expect(t1.requests).toBe(1);
		expect(t1.unpricedRequests).toBe(1);
	});
});

describe("Services: DefaultReportingService (Feature 9)", () => {
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
		expect(heatmap.from).toBeLessThan(heatmap.until);
		expect(heatmap.days.length).toBeGreaterThanOrEqual(21);
		expect(heatmap.totals.requests).toBeGreaterThanOrEqual(0);

		// Explore report
		const explore = customReporting.getExploreReport({
			dimension: "model",
			filters: {},
			mode: "time",
			metric: "tokens",
			bucket: "day",
			breakdown: "none",
		});
		expect(explore.dimension).toBe("model");
		expect(explore.totals.requests).toBe(3);
		expect(explore.totals.inputTokens).toBe(6000);
		expect(explore.rows.length).toBeGreaterThan(0);
	});

	test("F9-T1-03: defaultReportingService singleton conforms to ReportingService interface", () => {
		expect(defaultReportingService).toBeInstanceOf(DefaultReportingService);
		expect(typeof defaultReportingService.getOverview).toBe("function");
		expect(typeof defaultReportingService.getProjectReport).toBe("function");
		expect(typeof defaultReportingService.getModelReport).toBe("function");
		expect(typeof defaultReportingService.getHarnessReport).toBe("function");
	});
});
