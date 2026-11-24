import { modelProvider } from "@shared/models";
import {
	isEmptySearch,
	matchesSessionQuery,
	matchesTextQuery,
	normalizeSearchText,
	type ParsedSearch,
	parseSearchQuery,
	type SearchAstNode,
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
import { projectName, summarizeRecords, totalTokens } from "./totals";

export interface SearchDataSource {
	allRecords(): readonly UsageRecord[];
	sessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): SessionSummary[];
	searchTextKeysFts(ftsQuery: string, limit?: number): Set<string> | null;
	sessionTextsByKeys(keys: readonly string[]): Map<string, string>;
	searchTextsBySubstring(terms: readonly string[]): Map<string, string>;
	harnessIds?(): HarnessName[];
	harnessLabel?(harness: HarnessName): string;
}

const defaultSearchSource: SearchDataSource = {
	allRecords: () => store.allRecords(),
	sessionSummaries: (range) => store.sessionSummaries(range),
	searchTextKeysFts: (ftsQuery, limit) =>
		store.searchTextKeysFts(ftsQuery, limit),
	sessionTextsByKeys: (keys) => store.sessionTextsByKeys(keys),
	searchTextsBySubstring: (terms) => store.searchTextsBySubstring(terms),
};

function buildFtsTermClause(term: string): string | null {
	const tokens = term.match(/[\p{L}\p{N}]+/gu);
	if (!tokens || tokens.length === 0) return null;
	return tokens.map((token) => `"${token.replaceAll(/"/gu, '""')}"*`).join(" ");
}

function buildFtsFromAst(node: SearchAstNode): string | null {
	switch (node.type) {
		case "term":
			return buildFtsTermClause(node.value);
		case "filter":
			return null;
		case "not":
			return null;
		case "and": {
			const clauses = node.children
				.map(buildFtsFromAst)
				.filter((c): c is string => c !== null);
			if (clauses.length === 0) return null;
			if (clauses.length === 1) return clauses[0] ?? null;
			return `(${clauses.join(" ")})`;
		}
		case "or": {
			const clauses = node.children
				.map(buildFtsFromAst)
				.filter((c): c is string => c !== null);
			if (clauses.length === 0) return null;
			if (clauses.length === 1) return clauses[0] ?? null;
			return `(${clauses.join(" OR ")})`;
		}
	}
}

function buildFtsOrQuery(terms: readonly string[]): {
	ftsQuery: string;
	fallbackTerms: string[];
} {
	const clauses: string[] = [];
	const fallbackTerms: string[] = [];
	for (const term of terms) {
		const clause = buildFtsTermClause(term);
		if (clause) {
			clauses.push(`(${clause})`);
		} else if (term.trim()) {
			fallbackTerms.push(term);
		}
	}
	return {
		ftsQuery: clauses.join(" OR "),
		fallbackTerms,
	};
}

function loadCandidateBodies(
	sessions: readonly SessionSummary[],
	query: ParsedSearch,
	source: SearchDataSource,
): Map<string, string> {
	const bodies = new Map<string, string>();
	if (query.terms.length === 0 && query.negativeTerms.length === 0) {
		return bodies;
	}

	const keysToFetch = new Set<string>();

	if (query.ast) {
		const ftsQuery = buildFtsFromAst(query.ast);
		let ftsFailed = false;
		if (ftsQuery) {
			const ftsHits = source.searchTextKeysFts(ftsQuery);
			if (ftsHits === null) {
				ftsFailed = true;
			} else {
				for (const key of ftsHits) keysToFetch.add(key);
			}
		} else {
			ftsFailed = true;
		}

		if (ftsFailed && query.terms.length > 0) {
			const { ftsQuery: fallbackFts, fallbackTerms } = buildFtsOrQuery(
				query.terms,
			);
			let orFtsFailed = false;
			if (fallbackFts) {
				const ftsHits = source.searchTextKeysFts(fallbackFts);
				if (ftsHits === null) {
					orFtsFailed = true;
				} else {
					for (const key of ftsHits) keysToFetch.add(key);
				}
			}
			if (orFtsFailed) {
				for (const [key, body] of source.searchTextsBySubstring(query.terms)) {
					bodies.set(key, body);
				}
			} else if (fallbackTerms.length > 0) {
				for (const [key, body] of source.searchTextsBySubstring(
					fallbackTerms,
				)) {
					bodies.set(key, body);
				}
			}
		}
	} else if (query.terms.length > 0) {
		const { ftsQuery, fallbackTerms } = buildFtsOrQuery(query.terms);
		let ftsFailed = false;
		if (ftsQuery) {
			const ftsHits = source.searchTextKeysFts(ftsQuery);
			if (ftsHits === null) {
				ftsFailed = true;
			} else {
				for (const key of ftsHits) keysToFetch.add(key);
			}
		}
		if (ftsFailed) {
			for (const [key, body] of source.searchTextsBySubstring(query.terms)) {
				bodies.set(key, body);
			}
		} else if (fallbackTerms.length > 0) {
			for (const [key, body] of source.searchTextsBySubstring(fallbackTerms)) {
				bodies.set(key, body);
			}
		}
	}

	if (query.negativeTerms.length > 0) {
		// Any session that could match via metadata (or positive body hits) also
		// needs negative terms checked against its transcript body.
		const { ftsQuery, fallbackTerms } = buildFtsOrQuery(query.negativeTerms);
		let ftsFailed = false;
		if (ftsQuery) {
			const negHits = source.searchTextKeysFts(ftsQuery);
			if (negHits === null) {
				ftsFailed = true;
			} else {
				for (const key of negHits) keysToFetch.add(key);
			}
		}
		if (ftsFailed) {
			for (const [key, body] of source.searchTextsBySubstring(
				query.negativeTerms,
			)) {
				bodies.set(key, body);
			}
		} else if (fallbackTerms.length > 0) {
			for (const [key, body] of source.searchTextsBySubstring(fallbackTerms)) {
				bodies.set(key, body);
			}
		}
	}

	const sessionKeySet = new Set(sessions.map((session) => session.key));
	const missingKeys: string[] = [];
	for (const key of keysToFetch) {
		if (sessionKeySet.has(key) && !bodies.has(key)) {
			missingKeys.push(key);
		}
	}
	if (missingKeys.length > 0) {
		for (const [key, body] of source.sessionTextsByKeys(missingKeys)) {
			bodies.set(key, body);
		}
	}
	return bodies;
}

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
		lastActivityAt: session.lastActivityAt,
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
	source: SearchDataSource = defaultSearchSource,
): SessionsSearchPayload {
	const query = parseSearchQuery(raw);
	const sessions = source.sessionSummaries(range);
	if (isEmptySearch(query)) {
		return {
			query: raw,
			keys: sessions.map((session) => session.key),
			snippets: {},
		};
	}
	const candidateBodies = loadCandidateBodies(sessions, query, source);
	const keys: string[] = [];
	const snippets: Record<string, string> = {};
	const hasTextTerms = query.terms.length > 0;
	for (const session of sessions) {
		const body = candidateBodies.get(session.key);
		if (!matchesSessionQuery(sessionSearchable(session, body), query)) continue;
		keys.push(session.key);
		if (hasTextTerms) {
			const snippet = extractSnippet(body, query.terms);
			if (snippet) snippets[session.key] = snippet;
		}
	}
	return { query: raw, keys, snippets };
}

function scoreEntityRelevance(
	query: ParsedSearch,
	primary: string,
	secondary?: string,
): number {
	const p = normalizeSearchText(primary);
	const s = secondary ? normalizeSearchText(secondary) : "";
	const raw = normalizeSearchText(query.raw);
	let score = 0;
	if (raw) {
		if (p === raw) score += 100;
		else if (p.startsWith(raw)) score += 50;
		else if (p.includes(raw)) score += 25;
		else if (s?.includes(raw)) score += 10;
	}
	for (const term of query.terms) {
		if (p === term) score += 40;
		else if (p.startsWith(term)) score += 20;
		else if (p.includes(term)) score += 10;
		else if (s?.includes(term)) score += 5;
	}
	return score;
}

export function searchPayload(
	raw: string,
	limit = 8,
	source: SearchDataSource = defaultSearchSource,
): SearchPayload {
	const query = parseSearchQuery(raw);
	const records = source.allRecords();
	const sessions = source.sessionSummaries({ from: null, until: null });
	const candidateBodies = loadCandidateBodies(sessions, query, source);
	const matchedSessions = sessions
		.map((session) => {
			const body = candidateBodies.get(session.key);
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
	const modelGroups = new Map<string, UsageRecord[]>();
	const harnessGroups = new Map<HarnessName, UsageRecord[]>();
	for (const record of records) {
		const projectKey = record.cwd ?? "";
		const pList = projectGroups.get(projectKey) ?? [];
		pList.push(record);
		projectGroups.set(projectKey, pList);

		const mList = modelGroups.get(record.model) ?? [];
		mList.push(record);
		modelGroups.set(record.model, mList);

		const hList = harnessGroups.get(record.harness) ?? [];
		hList.push(record);
		harnessGroups.set(record.harness, hList);
	}

	const projects = [...projectGroups.entries()]
		.map(([cwd, groupRecords]) => {
			const name = projectName(cwd || null);
			const totals = summarizeRecords(groupRecords);
			const score = scoreEntityRelevance(query, name, cwd || "");
			return {
				cwd: cwd || null,
				name,
				sessions: totals.sessions,
				costUsd: totals.costUsd,
				tokens: totalTokens(totals),
				score,
			};
		})
		.filter((project) =>
			matchesTextQuery(query, [project.name, project.cwd ?? ""], {
				project: [project.name, project.cwd ?? ""],
			}),
		)
		.sort(
			(left, right) => right.score - left.score || right.costUsd - left.costUsd,
		)
		.slice(0, limit / 2);

	const models = [...modelGroups.entries()]
		.map(([model, groupRecords]) => {
			const totals = summarizeRecords(groupRecords);
			const provider = modelProvider(model) ?? "";
			const score = scoreEntityRelevance(query, model, provider);
			return {
				model,
				provider,
				costUsd: totals.costUsd,
				requests: groupRecords.length,
				tokens: totalTokens(totals),
				score,
			};
		})
		.filter((model) =>
			matchesTextQuery(query, [model.model, model.provider], {
				model: [model.model],
			}),
		)
		.sort(
			(left, right) => right.score - left.score || right.costUsd - left.costUsd,
		)
		.slice(0, limit / 2);

	const allHarnesses =
		source.harnessIds?.() ??
		defaultHarnessRegistry.getAll().map((p) => p.metadata.id);
	const harnesses = allHarnesses
		.map((harness) => {
			const harnessRecords = harnessGroups.get(harness) ?? [];
			const totals = summarizeRecords(harnessRecords);
			const provider = defaultHarnessRegistry.get(harness);
			const label =
				source.harnessLabel?.(harness) ??
				HARNESS_LABELS[harness] ??
				provider?.metadata.displayName ??
				harness;
			const score = scoreEntityRelevance(query, label, harness);
			return {
				harness,
				label,
				sessions: totals.sessions,
				costUsd: totals.costUsd,
				score,
			};
		})
		.filter(
			(row) =>
				isEmptySearch(query) ||
				matchesTextQuery(query, [row.label, row.harness], {
					harness: [row.label, row.harness],
				}),
		)
		.sort(
			(left, right) => right.score - left.score || right.costUsd - left.costUsd,
		)
		.map(({ label: _label, score: _score, ...row }) => row);

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
