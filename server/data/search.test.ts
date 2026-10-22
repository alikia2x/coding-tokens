import { describe, expect, test } from "bun:test";
import {
	matchesSessionQuery,
	parseSearchQuery,
	type SearchableSession,
	scoreSessionQuery,
} from "../../shared/search";

const session: SearchableSession = {
	title: "Build dashboard filtering",
	projectName: "dashboard",
	cwd: "/Users/alikia/Code/dashboard",
	harness: "codex Codex",
	models: ["GPT-6.1 Sol"],
	sessionId: "01a14a84-35a7-7bd3-bcb0-924a1bf92fb1",
	isSubagent: false,
	hasTranscript: true,
	costUsd: 1.2,
};

describe("search query", () => {
	test("matches free text across title and project", () => {
		expect(matchesSessionQuery(session, parseSearchQuery("dashboard"))).toBe(
			true,
		);
		expect(matchesSessionQuery(session, parseSearchQuery("filtering"))).toBe(
			true,
		);
	});

	test("supports qualifiers", () => {
		expect(
			matchesSessionQuery(session, parseSearchQuery("harness:codex")),
		).toBe(true);
		expect(
			matchesSessionQuery(session, parseSearchQuery("project:dashboard")),
		).toBe(true);
		expect(matchesSessionQuery(session, parseSearchQuery("model:gemini"))).toBe(
			false,
		);
	});

	test("scores title matches above project matches", () => {
		const titleScore = scoreSessionQuery(
			session,
			parseSearchQuery("dashboard filtering"),
		);
		const projectScore = scoreSessionQuery(
			session,
			parseSearchQuery("dashboard"),
		);
		expect(titleScore).toBeGreaterThan(0);
		expect(projectScore).toBeGreaterThan(0);
	});
});
