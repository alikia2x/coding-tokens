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
		for (const code of ["zh-CN", "en"] as const) {
			const axisA = formatBucketLabelFor(first.start, "hour", code);
			const axisB = formatBucketLabelFor(second.start, "hour", code);
			expect(axisA).toBe(axisB);

			const tipA = formatBucketTooltipLabelFor(first.start, "hour", code);
			const tipB = formatBucketTooltipLabelFor(second.start, "hour", code);
			expect(tipA).not.toBe(tipB);
		}
	});
});
