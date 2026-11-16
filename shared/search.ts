export interface SearchFilters {
	harness: string[];
	project: string[];
	model: string[];
	id: string[];
	title: string[];
	is: string[];
	has: string[];
}

export interface ParsedSearch {
	raw: string;
	terms: string[];
	negativeTerms: string[];
	filters: SearchFilters;
	negativeFilters: SearchFilters;
}

export interface SearchableSession {
	title: string;
	projectName: string;
	cwd: string | null;
	harness: string;
	models: string[];
	sessionId: string;
	isSubagent: boolean;
	hasTranscript: boolean;
	costUsd: number;
	body?: string;
}

const qualifiers = new Set([
	"harness",
	"project",
	"model",
	"id",
	"title",
	"is",
	"has",
]);

export function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.replaceAll(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replaceAll(/\s+/gu, " ")
		.trim();
}

function emptyFilters(): SearchFilters {
	return {
		harness: [],
		project: [],
		model: [],
		id: [],
		title: [],
		is: [],
		has: [],
	};
}

function addFilter(
	filters: SearchFilters,
	key: string,
	value: string,
): boolean {
	if (!qualifiers.has(key)) return false;
	const list = filters[key as keyof SearchFilters];
	if (!list) return false;
	if (!list.includes(value)) list.push(value);
	return true;
}

export function parseSearchQuery(raw: string): ParsedSearch {
	const parsed: ParsedSearch = {
		raw,
		terms: [],
		negativeTerms: [],
		filters: emptyFilters(),
		negativeFilters: emptyFilters(),
	};
	const pattern = /"([^"]*)"|(\S+)/gu;
	for (const match of raw.matchAll(pattern)) {
		const token = (match[1] ?? match[2] ?? "").trim();
		if (!token) continue;
		const negative = token.startsWith("-") && token.length > 1;
		const body = negative ? token.slice(1) : token;
		const colon = body.indexOf(":");
		const key = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
		const value = colon > 0 ? body.slice(colon + 1).trim() : "";
		if (
			value &&
			addFilter(
				negative ? parsed.negativeFilters : parsed.filters,
				key,
				normalizeSearchText(value),
			)
		) {
			continue;
		}
		const term = normalizeSearchText(body);
		if (!term) continue;
		(negative ? parsed.negativeTerms : parsed.terms).push(term);
	}
	return parsed;
}

export function isEmptySearch(query: ParsedSearch): boolean {
	return (
		query.terms.length === 0 &&
		query.negativeTerms.length === 0 &&
		Object.values(query.filters).every((list) => list.length === 0) &&
		Object.values(query.negativeFilters).every((list) => list.length === 0)
	);
}

function haystackFor(session: SearchableSession): string {
	return normalizeSearchText(
		[
			session.title,
			session.projectName,
			session.cwd ?? "",
			session.harness,
			session.sessionId,
			...session.models,
			session.body ?? "",
		].join("\n"),
	);
}

function matchesTerms(haystack: string, terms: string[]): boolean {
	return terms.every((term) => haystack.includes(term));
}

function matchesAnyTerm(haystack: string, terms: string[]): boolean {
	return terms.some((term) => haystack.includes(term));
}

function filterValues(
	session: SearchableSession,
	key: keyof SearchFilters,
): string[] {
	switch (key) {
		case "harness":
			return [session.harness];
		case "project":
			return [session.projectName, session.cwd ?? ""];
		case "model":
			return session.models;
		case "id":
			return [session.sessionId];
		case "title":
			return [session.title];
		case "is":
			return [
				session.isSubagent ? "subagent" : "main",
				session.hasTranscript ? "transcript" : "metadata",
			];
		case "has":
			return [
				...(session.models.length ? ["model"] : []),
				...(session.costUsd > 0 ? ["cost"] : []),
			];
		default:
			return [];
	}
}

function matchesFilterList(
	session: SearchableSession,
	filters: SearchFilters,
): boolean {
	for (const key of Object.keys(filters) as Array<keyof SearchFilters>) {
		const wanted = filters[key];
		if (!wanted.length) continue;
		const values = filterValues(session, key).map(normalizeSearchText);
		if (!wanted.some((value) => values.some((item) => item.includes(value))))
			return false;
	}
	return true;
}

export function matchesSessionQuery(
	session: SearchableSession,
	query: ParsedSearch,
): boolean {
	const haystack = haystackFor(session);
	if (!matchesTerms(haystack, query.terms)) return false;
	if (
		query.negativeTerms.length &&
		matchesAnyTerm(haystack, query.negativeTerms)
	)
		return false;
	if (!matchesFilterList(session, query.filters)) return false;
	if (
		Object.values(query.negativeFilters).some((list) => list.length) &&
		matchesFilterList(session, query.negativeFilters)
	)
		return false;
	return true;
}

export function scoreSessionQuery(
	session: SearchableSession,
	query: ParsedSearch,
): number {
	const title = normalizeSearchText(session.title);
	const project = normalizeSearchText(
		`${session.projectName} ${session.cwd ?? ""}`,
	);
	const models = normalizeSearchText(session.models.join(" "));
	const body = session.body ? normalizeSearchText(session.body) : "";
	let score = 0;
	if (query.raw.trim()) {
		const raw = normalizeSearchText(query.raw);
		if (title === raw) score += 40;
		else if (title.startsWith(raw)) score += 24;
		else if (title.includes(raw)) score += 14;
	}
	for (const term of query.terms) {
		if (title === term) score += 18;
		else if (title.startsWith(term)) score += 11;
		else if (title.includes(term)) score += 7;
		if (session.sessionId.toLowerCase().startsWith(term)) score += 10;
		if (project.includes(term)) score += 3;
		if (models.includes(term)) score += 3;
		if (body?.includes(term)) score += 2;
	}
	return score;
}

export function matchesTextQuery(
	query: ParsedSearch,
	values: string[],
	facets?: Partial<Record<keyof SearchFilters, string[]>>,
): boolean {
	if (isEmptySearch(query)) return true;
	const haystack = normalizeSearchText(values.join("\n"));
	if (!matchesTerms(haystack, query.terms)) return false;
	if (
		query.negativeTerms.length &&
		matchesAnyTerm(haystack, query.negativeTerms)
	)
		return false;

	for (const key of Object.keys(query.filters) as Array<keyof SearchFilters>) {
		const wanted = query.filters[key];
		if (!wanted.length) continue;
		const facetValues = facets?.[key];
		if (!facetValues) return false;
		const normalized = facetValues.map(normalizeSearchText);
		if (
			!wanted.every((value) => normalized.some((item) => item.includes(value)))
		)
			return false;
	}

	for (const key of Object.keys(query.negativeFilters) as Array<
		keyof SearchFilters
	>) {
		const excluded = query.negativeFilters[key];
		if (!excluded.length) continue;
		const facetValues = facets?.[key];
		if (!facetValues) continue;
		const normalized = facetValues.map(normalizeSearchText);
		if (
			excluded.some((value) => normalized.some((item) => item.includes(value)))
		)
			return false;
	}

	return true;
}

export function highlightTerms(query: ParsedSearch): string[] {
	return [...new Set(query.terms.filter((term) => term.length > 0))].sort(
		(left, right) => right.length - left.length,
	);
}

export function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
