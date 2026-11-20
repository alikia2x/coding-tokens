import type { HeatmapDay, HeatmapPayload } from "@shared/types";
import { localDate } from "../../src/util";
import type { ReportingDataSource } from "./reports";
import { store } from "./store";

export function heatmapPayload(
	weeks = 53,
	source?: Pick<ReportingDataSource, "getRecords">,
): HeatmapPayload {
	const safeWeeks = Math.min(260, Math.max(1, Math.trunc(weeks) || 53));
	const end = new Date();
	end.setHours(0, 0, 0, 0);
	end.setDate(end.getDate() + 1);
	const start = new Date(end);
	start.setDate(start.getDate() - safeWeeks * 7);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - start.getDay());

	const days: HeatmapDay[] = [];
	const byDate = new Map<string, HeatmapDay>();
	const sessionSets = new Map<string, Set<string>>();
	for (
		let cursor = new Date(start);
		cursor < end;
		cursor.setDate(cursor.getDate() + 1)
	) {
		const key = localDate(cursor.getTime());
		const day: HeatmapDay = {
			date: key,
			start: cursor.getTime(),
			requests: 0,
			tokens: 0,
			costUsd: 0,
			sessions: 0,
		};
		days.push(day);
		byDate.set(key, day);
	}
	const fromMs = start.getTime();
	const untilMs = end.getTime();
	const allSessions = new Set<string>();
	const records = source ? source.getRecords() : store.allRecords();
	for (const record of records) {
		if (
			record.timestamp === null ||
			record.timestamp < fromMs ||
			record.timestamp >= untilMs
		)
			continue;
		const key = localDate(record.timestamp);
		const day = byDate.get(key);
		if (!day) continue;
		day.requests += 1;
		day.tokens +=
			record.inputTokens +
			record.outputTokens +
			record.cacheReadTokens +
			record.cacheWriteTokens;
		day.costUsd += record.costUsd ?? 0;
		const sessionKey = `${record.harness}:${record.sessionId}`;
		const sessions = sessionSets.get(key) ?? new Set<string>();
		sessions.add(sessionKey);
		sessionSets.set(key, sessions);
		allSessions.add(sessionKey);
	}
	let maxTokens = 0;
	let requests = 0;
	let tokens = 0;
	let costUsd = 0;
	for (const day of days) {
		day.sessions = sessionSets.get(day.date)?.size ?? 0;
		day.costUsd = Number(day.costUsd.toFixed(6));
		maxTokens = Math.max(maxTokens, day.tokens);
		requests += day.requests;
		tokens += day.tokens;
		costUsd += day.costUsd;
	}
	return {
		from: fromMs,
		until: untilMs,
		days,
		totals: {
			requests,
			tokens,
			costUsd: Number(costUsd.toFixed(6)),
			sessions: allSessions.size,
		},
		maxTokens,
	};
}
