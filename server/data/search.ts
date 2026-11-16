import { modelProvider } from "@shared/models";
import {
	isEmptySearch,
	matchesSessionQuery,
	matchesTextQuery,
	parseSearchQuery,
	type SearchableSession,
	scoreSessionQuery,
} from "@shared/search";
import type {
	HarnessName,
	SearchPayload,
	SearchSessionResult,
	SessionSummary,
	SessionsSearchPayload,
	UsageRecord,
} from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import { store } from "./store";
import {
	filterRecords,
	projectName,
	summarizeRecords,
	totalTokens,
} from "./totals";

function sessionSearchable(
	session: SessionSummary,
	body?: string,
): SearchableSession {
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
		body,
	};
}

export function extractSnippet(
	body: string | undefined,
	terms: readonly string[],
	maxLength = 140,
): string | null {
	if (!body || !terms.length) return null;
	const lower = body.toLowerCase();
	let bestIndex = -1;
	let bestLen = 0;
	for (const term of terms) {
		if (!term) continue;
		const index = lower.indexOf(term.toLowerCase());
		if (index >= 0 && (bestIndex === -1 || index < bestIndex)) {
			bestIndex = index;
			bestLen = term.length;
		}
	}
	if (bestIndex < 0) return null;
	const lead = Math.min(36, Math.floor((maxLength - bestLen) / 3));
	const start = Math.max(0, bestIndex - lead);
	const end = Math.min(body.length, start + maxLength);
	const slice = body.slice(start, end).replaceAll(/\s+/gu, " ").trim();
	if (!slice) return null;
	return `${start > 0 ? "…" : ""}${slice}${end < body.length ? "…" : ""}`;
}

function toSearchSession(
	session: SessionSummary,
	score: number,
	snippet: string | null,
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
		snippet,
	};
}

export function sessionSearchMatches(
	raw: string,
	range: { from: number | null; until: number | null } = {
		from: null,
		until: null,
	},
): SessionsSearchPayload {
	const query = parseSearchQuery(raw);
	const sessions = store.sessionSummaries(range);
	if (isEmptySearch(query)) {
		return {
			query: raw,
			keys: sessions.map((session) => session.key),
			snippets: {},
		};
	}
	const keys: string[] = [];
	const snippets: Record<string, string> = {};
	for (const session of sessions) {
		const body = store.sessionText(session.key);
		if (!matchesSessionQuery(sessionSearchable(session, body), query)) continue;
		keys.push(session.key);
		const snippet = extractSnippet(body, query.terms);
		if (snippet) snippets[session.key] = snippet;
	}
	return { query: raw, keys, snippets };
}

export function searchPayload(raw: string, limit = 8): SearchPayload {
	const query = parseSearchQuery(raw);
	const records = store.allRecords();
	const sessions = store.sessionSummaries({ from: null, until: null });
	const matchedSessions = sessions
		.map((session) => {
			const body = store.sessionText(session.key);
			const searchable = sessionSearchable(session, body);
			if (!matchesSessionQuery(searchable, query)) return null;
			return toSearchSession(
				session,
				scoreSessionQuery(searchable, query),
				extractSnippet(body, query.terms),
			);
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
			matchesTextQuery(query, [project.name, project.cwd ?? ""], {
				project: [project.name, project.cwd ?? ""],
			}),
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
			provider: modelProvider(model) ?? "",
			costUsd: summarizeRecords(groupRecords).costUsd,
			requests: groupRecords.length,
			tokens: totalTokens(summarizeRecords(groupRecords)),
		}))
		.filter((model) =>
			matchesTextQuery(query, [model.model, model.provider], {
				model: [model.model],
			}),
		)
		.sort((left, right) => right.costUsd - left.costUsd)
		.slice(0, limit / 2);

	const allHarnesses = defaultHarnessRegistry
		.getAll()
		.map((p) => p.metadata.id);
	const harnesses = allHarnesses
		.map((harness) => {
			const harnessRecords = filterRecords(records, {
				harnesses: new Set<HarnessName>([harness]),
			});
			const provider = defaultHarnessRegistry.get(harness);
			const label =
				HARNESS_LABELS[harness] ?? provider?.metadata.displayName ?? harness;
			return {
				harness,
				label,
				sessions: new Set(
					harnessRecords.map(
						(record) => `${record.harness}:${record.sessionId}`,
					),
				).size,
				costUsd: summarizeRecords(harnessRecords).costUsd,
			};
		})
		.filter(
			(row) =>
				isEmptySearch(query) ||
				matchesTextQuery(query, [row.label, row.harness], {
					harness: [row.label, row.harness],
				}),
		)
		.map(({ label: _label, ...row }) => row);

	return {
		query: raw,
		sessions: matchedSessions,
		projects: projects.map(({ tokens: _tokens, ...project }) => project),
		models: models.map(
			({ tokens: _tokens, provider: _provider, ...model }) => model,
		),
		harnesses,
	};
}
