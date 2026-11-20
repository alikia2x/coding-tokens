import { describe, expect, test } from "bun:test";
import {
	formatBucketLabelFor,
	formatBucketTooltipLabelFor,
} from "../app/lib/date-locale";
import { bucketize } from "../server/data/totals";
import { usageRecord } from "./util";

describe("hourly chart bucket keys and tooltip labels", () => {
	test("keeps bucket keys unique across multi-day hourly ranges and includes date in tooltip labels", () => {
		const dayOneThreeAm = new Date(2026, 10, 14, 3, 15, 0, 0).getTime();
		const dayTwoThreeAm = new Date(2026, 10, 15, 3, 15, 0, 0).getTime();
		const from = new Date(2026, 10, 14, 0, 0, 0, 0).getTime();
		const until = new Date(2026, 10, 15, 12, 0, 0, 0).getTime();

		const buckets = bucketize(
			[
				usageRecord(
					{
						harness: "codex",
						sessionId: "s1",
						messageId: "m1",
						cwd: "/repo",
						model: "gpt-5",
						timestamp: dayOneThreeAm,
					},
					{ input: 100, output: 50, cost: 0.62 },
				),
				usageRecord(
					{
						harness: "codex",
						sessionId: "s1",
						messageId: "m2",
						cwd: "/repo",
						model: "gpt-5",
						timestamp: dayTwoThreeAm,
					},
					{ input: 1000, output: 500, cost: 10.6 },
				),
			],
			from,
			until,
			"hour",
		);

		const threeAmBuckets = buckets.filter(
			(bucket) => new Date(bucket.start).getHours() === 3,
		);
		expect(threeAmBuckets).toHaveLength(2);

		const [first, second] = threeAmBuckets;
		if (!first || !second) throw new Error("expected two 3:00 buckets");
		expect(first.key).not.toBe(second.key);
		expect(first.totals.costUsd).toBeCloseTo(0.62, 4);
		expect(second.totals.costUsd).toBeCloseTo(10.6, 4);

		// Compact axis labels collide on clock hour, which is why charts must key by bucket.key
		// and display formatBucketTooltipLabelFor in tooltips.
		for (const code of [
			"en",
			"zh-CN",
			"zh-TW",
			"ja",
			"ko",
			"es",
			"fr",
			"de",
		] as const) {
			const axisA = formatBucketLabelFor(first.start, "hour", code);
			const axisB = formatBucketLabelFor(second.start, "hour", code);
			expect(axisA).toBe(axisB);

			const tipA = formatBucketTooltipLabelFor(first.start, "hour", code);
			const tipB = formatBucketTooltipLabelFor(second.start, "hour", code);
			expect(tipA).not.toBe(tipB);
		}
	});
});

describe("weekly and monthly bucket aggregation and axis labels", () => {
	test("weekly bucketize aggregates records from Monday through Sunday into the same week bucket", () => {
		const from = new Date(2026, 2, 16, 0, 0, 0, 0).getTime(); // Mon Mar 16, 2026
		const until = new Date(2026, 2, 23, 0, 0, 0, 0).getTime(); // Mon Mar 23, 2026
		const wednesday = new Date(2026, 2, 18, 14, 0, 0, 0).getTime();
		const sunday = new Date(2026, 2, 22, 20, 0, 0, 0).getTime();

		const buckets = bucketize(
			[
				usageRecord(
					{
						harness: "codex",
						sessionId: "s1",
						messageId: "m1",
						cwd: "/repo",
						model: "gpt-5",
						timestamp: wednesday,
					},
					{ input: 100, output: 50, cost: 1.25 },
				),
				usageRecord(
					{
						harness: "codex",
						sessionId: "s2",
						messageId: "m2",
						cwd: "/repo",
						model: "gpt-5",
						timestamp: sunday,
					},
					{ input: 200, output: 100, cost: 2.5 },
				),
			],
			from,
			until,
			"week",
		);

		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.totals.requests).toBe(2);
		expect(buckets[0]?.totals.sessions).toBe(2);
		expect(buckets[0]?.totals.inputTokens).toBe(300);
		expect(buckets[0]?.totals.costUsd).toBeCloseTo(3.75, 4);
	});

	test("formats week buckets as date ranges and month buckets without day numbers", () => {
		const weekStart = new Date(2026, 2, 16, 0, 0, 0, 0).getTime(); // Mar 16 - 22
		const crossMonthWeek = new Date(2026, 2, 30, 0, 0, 0, 0).getTime(); // Mar 30 - Apr 5
		const monthStart = new Date(2026, 2, 1, 0, 0, 0, 0).getTime(); // Mar 2026

		expect(formatBucketLabelFor(weekStart, "week", "zh-CN")).toBe(
			"3月16日–22日",
		);
		expect(formatBucketLabelFor(crossMonthWeek, "week", "zh-CN")).toBe(
			"3月30日–4月5日",
		);
		expect(formatBucketLabelFor(monthStart, "month", "zh-CN")).toBe(
			"2026年3月",
		);
		expect(formatBucketLabelFor(monthStart, "month", "en")).toBe("Mar 2026");
		expect(formatBucketLabelFor(weekStart, "week", "en")).not.toBe("Mar 16");
	});
});
