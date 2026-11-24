export interface SearchFilters {
	harness: string[];
	project: string[];
	model: string[];
	id: string[];
	title: string[];
	is: string[];
	has: string[];
}

export type SearchAstNode =
	| { type: "term"; value: string }
	| { type: "filter"; key: keyof SearchFilters; value: string }
	| { type: "and"; children: SearchAstNode[] }
	| { type: "or"; children: SearchAstNode[] }
	| { type: "not"; child: SearchAstNode };

export interface ParsedSearch {
	raw: string;
	terms: string[];
	negativeTerms: string[];
	filters: SearchFilters;
	negativeFilters: SearchFilters;
	ast?: SearchAstNode;
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
	lastActivityAt?: number | null;
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

type Token =
	| { type: "lparen" }
	| { type: "rparen" }
	| { type: "or" }
	| { type: "and" }
	| { type: "not" }
	| { type: "filter"; key: keyof SearchFilters; value: string }
	| { type: "term"; value: string };

function tokenizeSearchQuery(raw: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const len = raw.length;

	while (i < len) {
		const ch = raw[i];
		if (!ch) {
			i++;
			continue;
		}

		if (/\s/u.test(ch)) {
			i++;
			continue;
		}

		if (ch === "(") {
			tokens.push({ type: "lparen" });
			i++;
			continue;
		}

		if (ch === ")") {
			tokens.push({ type: "rparen" });
			i++;
			continue;
		}

		if (ch === "|") {
			tokens.push({ type: "or" });
			i++;
			continue;
		}

		if (ch === "-") {
			const nextCh = raw[i + 1];
			if (nextCh && !/\s/u.test(nextCh) && nextCh !== ")") {
				tokens.push({ type: "not" });
				i++;
				continue;
			}
			i++;
			continue;
		}

		if (ch === '"') {
			i++;
			let phrase = "";
			while (i < len && raw[i] !== '"') {
				phrase += raw[i] ?? "";
				i++;
			}
			if (i < len && raw[i] === '"') {
				i++;
			}
			const normalized = normalizeSearchText(phrase);
			if (normalized) {
				tokens.push({ type: "term", value: normalized });
			}
			continue;
		}

		let word = "";
		while (i < len) {
			const curr = raw[i];
			if (
				!curr ||
				/\s/u.test(curr) ||
				curr === "(" ||
				curr === ")" ||
				curr === "|"
			) {
				break;
			}
			if (curr === '"' && word.endsWith(":")) {
				break;
			}
			word += curr;
			i++;
		}

		if (word.endsWith(":") && i < len && raw[i] === '"') {
			const key = word.slice(0, -1).toLowerCase();
			i++;
			let phrase = "";
			while (i < len && raw[i] !== '"') {
				phrase += raw[i];
				i++;
			}
			if (i < len && raw[i] === '"') {
				i++;
			}
			const normVal = normalizeSearchText(phrase);
			if (qualifiers.has(key)) {
				if (normVal) {
					tokens.push({
						type: "filter",
						key: key as keyof SearchFilters,
						value: normVal,
					});
				}
			} else {
				const fullTerm = normalizeSearchText(`${word}"${phrase}"`);
				if (fullTerm) {
					tokens.push({ type: "term", value: fullTerm });
				}
			}
			continue;
		}

		if (word === "OR") {
			tokens.push({ type: "or" });
			continue;
		}
		if (word === "AND") {
			tokens.push({ type: "and" });
			continue;
		}
		if (word === "NOT") {
			tokens.push({ type: "not" });
			continue;
		}

		const colonIdx = word.indexOf(":");
		if (colonIdx > 0) {
			const key = word.slice(0, colonIdx).toLowerCase();
			const val = word.slice(colonIdx + 1);
			if (qualifiers.has(key)) {
				const normVal = normalizeSearchText(val);
				if (normVal) {
					tokens.push({
						type: "filter",
						key: key as keyof SearchFilters,
						value: normVal,
					});
				}
				continue;
			}
		}

		const normWord = normalizeSearchText(word);
		if (normWord) {
			tokens.push({ type: "term", value: normWord });
		}
	}

	return tokens;
}

class QueryParser {
	private pos = 0;
	constructor(private tokens: Token[]) {}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private next(): Token | undefined {
		return this.tokens[this.pos++];
	}

	private match(type: Token["type"]): Token | undefined {
		if (this.tokens[this.pos]?.type === type) {
			return this.tokens[this.pos++];
		}
		return undefined;
	}

	parse(): SearchAstNode | null {
		const children: SearchAstNode[] = [];
		while (this.pos < this.tokens.length) {
			const expr = this.parseAnd();
			if (expr) {
				children.push(expr);
			} else {
				this.pos++;
			}
		}
		if (children.length === 0) return null;
		if (children.length === 1) return children[0] ?? null;
		return { type: "and", children };
	}

	private parseAnd(): SearchAstNode | null {
		const left = this.parseOr();
		if (!left) return null;

		const andChildren: SearchAstNode[] = [left];
		while (this.pos < this.tokens.length) {
			const token = this.peek();
			if (!token || token.type === "rparen") {
				break;
			}
			if (token.type === "and") {
				this.next();
			}
			const right = this.parseOr();
			if (right) {
				andChildren.push(right);
			} else {
				break;
			}
		}

		if (andChildren.length === 1) return andChildren[0] ?? null;
		return { type: "and", children: andChildren };
	}

	private parseOr(): SearchAstNode | null {
		const left = this.parseUnary();
		if (!left) return null;

		const orChildren: SearchAstNode[] = [left];
		while (this.peek()?.type === "or") {
			this.next();
			const right = this.parseUnary();
			if (right) {
				orChildren.push(right);
			} else {
				break;
			}
		}

		if (orChildren.length === 1) return orChildren[0] ?? null;
		return { type: "or", children: orChildren };
	}

	private parseUnary(): SearchAstNode | null {
		if (this.match("not")) {
			const child = this.parseUnary();
			if (!child) return null;
			return { type: "not", child };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): SearchAstNode | null {
		if (this.match("lparen")) {
			let inner: SearchAstNode | null = null;
			const innerChildren: SearchAstNode[] = [];
			while (this.pos < this.tokens.length && this.peek()?.type !== "rparen") {
				const expr = this.parseAnd();
				if (expr) {
					innerChildren.push(expr);
				} else {
					this.pos++;
				}
			}
			this.match("rparen");

			if (innerChildren.length === 1) {
				inner = innerChildren[0] ?? null;
			} else if (innerChildren.length > 1) {
				inner = { type: "and", children: innerChildren };
			}
			return inner;
		}

		const token = this.peek();
		if (token?.type === "filter") {
			this.next();
			return { type: "filter", key: token.key, value: token.value };
		}
		if (token?.type === "term") {
			this.next();
			return { type: "term", value: token.value };
		}

		return null;
	}
}

function collectSearchElements(
	node: SearchAstNode | null,
	isNegative = false,
): {
	terms: string[];
	negativeTerms: string[];
	filters: SearchFilters;
	negativeFilters: SearchFilters;
} {
	const result = {
		terms: [] as string[],
		negativeTerms: [] as string[],
		filters: emptyFilters(),
		negativeFilters: emptyFilters(),
	};

	if (!node) return result;

	function walk(current: SearchAstNode, negative: boolean) {
		switch (current.type) {
			case "term": {
				const list = negative ? result.negativeTerms : result.terms;
				if (!list.includes(current.value)) list.push(current.value);
				break;
			}
			case "filter": {
				const target = negative ? result.negativeFilters : result.filters;
				addFilter(target, current.key, current.value);
				break;
			}
			case "not":
				walk(current.child, !negative);
				break;
			case "and":
			case "or":
				for (const child of current.children) {
					walk(child, negative);
				}
				break;
		}
	}

	walk(node, isNegative);
	return result;
}

export function parseSearchQuery(raw: string): ParsedSearch {
	const tokens = tokenizeSearchQuery(raw);
	const parser = new QueryParser(tokens);
	const ast = parser.parse();
	const collected = collectSearchElements(ast);

	return {
		raw,
		terms: collected.terms,
		negativeTerms: collected.negativeTerms,
		filters: collected.filters,
		negativeFilters: collected.negativeFilters,
		ast: ast ?? undefined,
	};
}

export function isEmptySearch(query: ParsedSearch): boolean {
	return (
		!query.ast &&
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

function evaluateSessionAst(
	node: SearchAstNode,
	session: SearchableSession,
	haystack: string,
): boolean {
	switch (node.type) {
		case "term":
			return haystack.includes(node.value);
		case "filter": {
			const values = filterValues(session, node.key).map(normalizeSearchText);
			return values.some((val) => val.includes(node.value));
		}
		case "not":
			return !evaluateSessionAst(node.child, session, haystack);
		case "and":
			return node.children.every((child) =>
				evaluateSessionAst(child, session, haystack),
			);
		case "or":
			return node.children.some((child) =>
				evaluateSessionAst(child, session, haystack),
			);
	}
}

export function matchesSessionQuery(
	session: SearchableSession,
	query: ParsedSearch,
): boolean {
	if (isEmptySearch(query)) return true;
	const haystack = haystackFor(session);
	if (query.ast) {
		return evaluateSessionAst(query.ast, session, haystack);
	}
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
	const raw = normalizeSearchText(query.raw);
	const sessionId = session.sessionId.toLowerCase();

	let score = 0;

	// 1. Raw full query phrase matches
	if (raw) {
		if (title === raw) {
			score += 120;
		} else if (title.startsWith(raw)) {
			score += 60;
		} else if (title.includes(raw)) {
			score += 35;
		}

		if (sessionId === raw) {
			score += 150;
		} else if (raw.length >= 6 && sessionId.startsWith(raw)) {
			score += 80;
		}

		if (
			session.projectName &&
			normalizeSearchText(session.projectName) === raw
		) {
			score += 50;
		}

		if (body.includes(raw) && raw.length > 3) {
			score += 20;
		}
	}

	// 2. Individual term scoring across fields
	let matchedTermsCount = 0;
	for (const term of query.terms) {
		if (!term) continue;
		let termMatched = false;

		// Title scoring
		if (title === term) {
			score += 50;
			termMatched = true;
		} else if (title.startsWith(term)) {
			score += 30;
			termMatched = true;
		} else if (title.includes(term)) {
			const wordBoundary = new RegExp(
				`(?:^|\\s)${escapeRegExp(term)}(?:$|\\s)`,
				"u",
			);
			if (wordBoundary.test(title)) {
				score += 22;
			} else {
				score += 14;
			}
			termMatched = true;
		}

		// Session ID prefix match
		if (term.length >= 6 && sessionId.startsWith(term)) {
			score += 60;
			termMatched = true;
		}

		// Project scoring
		if (
			session.projectName &&
			normalizeSearchText(session.projectName) === term
		) {
			score += 25;
			termMatched = true;
		} else if (project.includes(term)) {
			score += 10;
			termMatched = true;
		}

		// Model scoring
		if (session.models.some((m) => normalizeSearchText(m) === term)) {
			score += 20;
			termMatched = true;
		} else if (models.includes(term)) {
			score += 8;
			termMatched = true;
		}

		// Harness scoring
		const harnessNorm = normalizeSearchText(session.harness);
		if (harnessNorm === term) {
			score += 20;
			termMatched = true;
		} else if (harnessNorm.includes(term)) {
			score += 8;
			termMatched = true;
		}

		// Body scoring
		if (body.includes(term)) {
			score += 6;
			termMatched = true;
			const occurrences = (
				body.match(new RegExp(escapeRegExp(term), "gu")) || []
			).length;
			score += Math.min(6, Math.max(0, occurrences - 1));
		}

		if (termMatched) {
			matchedTermsCount++;
		}
	}

	// 3. Multi-term Coverage Bonus (Crucial for AND / OR)
	if (query.terms.length > 1 && matchedTermsCount > 0) {
		const coverageRatio = matchedTermsCount / query.terms.length;
		score += Math.round(coverageRatio * 30);
		if (matchedTermsCount === query.terms.length) {
			score += 15;
		}
	}

	// 4. Freshness / Recency Boost
	if (session.lastActivityAt) {
		const ageHours = (Date.now() - session.lastActivityAt) / (1000 * 60 * 60);
		if (ageHours < 24) {
			score += 15;
		} else if (ageHours < 24 * 7) {
			score += 10;
		} else if (ageHours < 24 * 30) {
			score += 5;
		}
	}

	// 5. Activity quality signal
	if (session.costUsd > 0 || session.hasTranscript) {
		score += 5;
	}

	return score;
}

function evaluateTextAst(
	node: SearchAstNode,
	haystack: string,
	facets?: Partial<Record<keyof SearchFilters, string[]>>,
): boolean {
	switch (node.type) {
		case "term":
			return haystack.includes(node.value);
		case "filter": {
			const facetValues = facets?.[node.key];
			if (!facetValues?.length) return false;
			const normalized = facetValues.map(normalizeSearchText);
			return normalized.some((item) => item.includes(node.value));
		}
		case "not":
			return !evaluateTextAst(node.child, haystack, facets);
		case "and":
			return node.children.every((child) =>
				evaluateTextAst(child, haystack, facets),
			);
		case "or":
			return node.children.some((child) =>
				evaluateTextAst(child, haystack, facets),
			);
	}
}

export function matchesTextQuery(
	query: ParsedSearch,
	values: string[],
	facets?: Partial<Record<keyof SearchFilters, string[]>>,
): boolean {
	if (isEmptySearch(query)) return true;
	const haystack = normalizeSearchText(values.join("\n"));
	if (query.ast) {
		return evaluateTextAst(query.ast, haystack, facets);
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
