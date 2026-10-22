import {
	matchesSessionQuery,
	matchesTextQuery,
	normalizeSearchText,
	parseSearchQuery,
	type SearchableSession,
	scoreSessionQuery,
} from "@shared/search";
import type {
	HarnessName,
	SearchPayload,
	SearchSessionResult,
	SessionSummary,
	UsageRecord,
} from "@shared/types";
import { HARNESS_LABELS, HARNESS_NAMES } from "@shared/types";
import { store } from "./store";
import {
	filterRecords,
	projectName,
	summarizeRecords,
	totalTokens,
} from "./totals";

function sessionSearchable(session: SessionSummary): SearchableSession {
	return {
		title: session.title,
		projectName: session.projectName,
		cwd: session.cwd,
		harness: `${session.harness} ${HARNESS_LABELS[session.harness]}`,
		models: session.models,
		sessionId: session.sessionId,
		isSubagent: session.isSubagent,
		hasTranscript: session.hasTranscript,
		costUsd: session.totals.costUsd,
	};
}

function toSearchSession(
	session: SessionSummary,
	score: number,
): SearchSessionResult {
	return {
		key: session.key,
		harness: session.harness,
		sessionId: session.sessionId,
		title: session.title,
		projectName: session.projectName,
		cwd: session.cwd,
		models: session.models,
		lastActivityAt: session.lastActivityAt,
		costUsd: session.totals.costUsd,
		score,
	};
}

export function searchPayload(raw: string, limit = 8): SearchPayload {
	const query = parseSearchQuery(raw);
	const records = store.allRecords();
	const sessions = store.sessionSummaries({ from: null, until: null });
	const matchedSessions = sessions
		.map((session) => {
			const searchable = sessionSearchable(session);
			const matches = matchesSessionQuery(searchable, query);
			if (!matches) return null;
			return toSearchSession(session, scoreSessionQuery(searchable, query));
		})
		.filter((session): session is SearchSessionResult => session !== null)
		.sort(
			(left, right) =>
				right.score - left.score ||
				(right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0),
		)
		.slice(0, limit);

	const projectGroups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = record.cwd ?? "";
		const list = projectGroups.get(key) ?? [];
		list.push(record);
		projectGroups.set(key, list);
	}
	const projects = [...projectGroups.entries()]
		.map(([cwd, groupRecords]) => {
			const name = projectName(cwd || null);
			return {
				cwd: cwd || null,
				name,
				sessions: new Set(
					groupRecords.map((record) => `${record.harness}:${record.sessionId}`),
				).size,
				costUsd: summarizeRecords(groupRecords).costUsd,
				tokens: totalTokens(summarizeRecords(groupRecords)),
			};
		})
		.filter((project) =>
			matchesTextQuery(query, [project.name, project.cwd ?? ""]),
		)
		.sort((left, right) => right.costUsd - left.costUsd)
		.slice(0, limit / 2);

	const modelGroups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const list = modelGroups.get(record.model) ?? [];
		list.push(record);
		modelGroups.set(record.model, list);
	}
	const models = [...modelGroups.entries()]
		.map(([model, groupRecords]) => ({
			model,
			costUsd: summarizeRecords(groupRecords).costUsd,
			requests: groupRecords.length,
			tokens: totalTokens(summarizeRecords(groupRecords)),
		}))
		.filter((model) => matchesTextQuery(query, [model.model]))
		.sort((left, right) => right.costUsd - left.costUsd)
		.slice(0, limit / 2);

	const harnesses = HARNESS_NAMES.map((harness) => {
		const harnessRecords = filterRecords(records, {
			harnesses: new Set<HarnessName>([harness]),
		});
		return {
			harness,
			label: HARNESS_LABELS[harness],
			sessions: new Set(
				harnessRecords.map((record) => `${record.harness}:${record.sessionId}`),
			).size,
			costUsd: summarizeRecords(harnessRecords).costUsd,
		};
	})
		.filter(
			(row) =>
				matchesTextQuery(query, [row.label, row.harness]) ||
				normalizeSearchText(raw).length === 0,
		)
		.map(({ label: _label, ...row }) => row);

	return {
		query: raw,
		sessions: matchedSessions,
		projects: projects.map(({ tokens: _tokens, ...project }) => project),
		models: models.map(({ tokens: _tokens, ...model }) => model),
		harnesses,
	};
}
