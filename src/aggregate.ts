import { normalizePath } from "./platform/normalizer";
import type { SourceResult, UsageRecord, UsageTotals } from "./types";
import { localDate } from "./util";

export type GroupField = "harness" | "project" | "model" | "day" | "session";

export interface GroupRow extends UsageTotals {
	values: Partial<Record<GroupField, string>>;
}

export interface Report {
	totals: UsageTotals;
	groups: GroupRow[];
}

export interface ReportFilters {
	harnesses?: Set<string>;
	projects?: Set<string>;
	date?: string;
	/** Inclusive lower bound in epoch milliseconds. */
	since?: number;
	/** Exclusive upper bound in epoch milliseconds. */
	until?: number;
	groupBy: GroupField[];
}

function projectName(record: UsageRecord): string {
	return record.cwd ? normalizePath(record.cwd) : "Unknown project";
}

function isCumulative(record: UsageRecord): boolean {
	return record.messageId.endsWith(":cumulative-total");
}

function groupValue(field: GroupField, record: UsageRecord): string {
	switch (field) {
		case "harness":
			return record.harness;
		case "project":
			return projectName(record);
		case "model":
			return record.model;
		case "day":
			return localDate(record.timestamp);
		case "session":
			return record.sessionId;
	}
}

function recordMatches(
	record: UsageRecord,
	filters: ReportFilters,
	normalizedProjects: ReadonlySet<string> | undefined,
): boolean {
	if (filters.harnesses && !filters.harnesses.has(record.harness)) return false;
	if (normalizedProjects) {
		const project = record.cwd ? normalizePath(record.cwd) : null;
		if (!project || !normalizedProjects.has(project)) return false;
	}
	if (
		filters.date !== undefined &&
		localDate(record.timestamp) !== filters.date
	) {
		return false;
	}
	if (filters.since === undefined && filters.until === undefined) return true;
	const timestamp = record.timestamp;
	if (timestamp === null || !Number.isFinite(timestamp)) return false;
	if (filters.since !== undefined && timestamp < filters.since) return false;
	if (filters.until !== undefined && timestamp >= filters.until) return false;
	return true;
}

function emptyTotals(): UsageTotals {
	return {
		sessions: 0,
		messages: 0,
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: 0,
		estimatedRequests: 0,
		unpricedRequests: 0,
	};
}

function addRecord(
	totals: UsageTotals,
	record: UsageRecord,
	countRequest = true,
): void {
	if (countRequest) totals.requests += 1;
	totals.inputTokens += record.inputTokens;
	totals.outputTokens += record.outputTokens;
	totals.cacheReadTokens += record.cacheReadTokens;
	totals.cacheWriteTokens += record.cacheWriteTokens;
	totals.reasoningTokens += record.reasoningTokens;
	if (record.costUsd === null) {
		totals.unpricedRequests += 1;
	} else {
		totals.costUsd += record.costUsd;
		if (record.costEstimated) totals.estimatedRequests += 1;
	}
}

export function createReport(
	sourceResults: SourceResult[],
	filters: ReportFilters,
): Report {
	const totals = emptyTotals();
	const sessions = new Set<string>();
	const groups = new Map<string, GroupRow & { sessionIds: Set<string> }>();
	const normalizedProjects = filters.projects
		? new Set([...filters.projects].map((p) => normalizePath(p)))
		: undefined;

	const getGroup = (record: UsageRecord) => {
		const values = Object.fromEntries(
			filters.groupBy.map((field) => [field, groupValue(field, record)]),
		) as Partial<Record<GroupField, string>>;
		const key = JSON.stringify(filters.groupBy.map((field) => values[field]));
		let group = groups.get(key);
		if (!group) {
			group = { values, ...emptyTotals(), sessionIds: new Set() };
			groups.set(key, group);
		}
		return group;
	};

	const bySession = new Map<string, UsageRecord[]>();
	for (const source of sourceResults) {
		for (const record of source.records) {
			if (!recordMatches(record, filters, normalizedProjects)) continue;
			const sessionId = `${record.harness}:${record.sessionId}`;
			const list = bySession.get(sessionId) ?? [];
			list.push(record);
			bySession.set(sessionId, list);
		}
	}

	for (const [sessionId, sessionRecords] of bySession) {
		sessions.add(sessionId);
		const cumulative = sessionRecords.filter(isCumulative);
		if (cumulative.length > 0) {
			const basis = cumulative.at(-1) as UsageRecord;
			addRecord(totals, basis, false);
			const basisGroup = getGroup(basis);
			addRecord(basisGroup, basis, false);
			basisGroup.sessionIds.add(sessionId);

			for (const rec of sessionRecords) {
				if (isCumulative(rec)) continue;
				totals.requests += 1;
				const recGroup = getGroup(rec);
				recGroup.requests += 1;
				recGroup.sessionIds.add(sessionId);
			}
			continue;
		}

		for (const record of sessionRecords) {
			addRecord(totals, record, true);
			const group = getGroup(record);
			addRecord(group, record, true);
			group.sessionIds.add(sessionId);
		}
	}
	totals.sessions = sessions.size;
	totals.costUsd = Number(totals.costUsd.toFixed(8));

	const sortedGroups = [...groups.values()].map((group) => {
		const { sessionIds, ...row } = group;
		return {
			...row,
			sessions: sessionIds.size,
			costUsd: Number(row.costUsd.toFixed(8)),
		};
	});
	sortedGroups.sort((left, right) => {
		const leftVolume = left.inputTokens + left.outputTokens;
		const rightVolume = right.inputTokens + right.outputTokens;
		return (
			rightVolume - leftVolume ||
			JSON.stringify(left.values).localeCompare(JSON.stringify(right.values))
		);
	});
	return {
		totals,
		groups: sortedGroups,
	};
}
