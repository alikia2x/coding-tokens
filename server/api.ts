import path from "node:path";
import { isKnownHarness } from "@shared/colors";
import type {
	HarnessName,
	SessionDetailLevel,
	SessionsPayload,
	StatusPayload,
} from "@shared/types";
import { HARNESS_NAMES, SESSION_DETAIL_LEVELS } from "@shared/types";
import { defaultHarnessRegistry } from "../src/providers/registry";
import { explorePayload } from "./data/explore";
import { heatmapPayload } from "./data/heatmap";
import {
	harnessReportPayload,
	modelReportPayload,
	overviewPayload,
	projectReportPayload,
} from "./data/reports";
import { searchPayload, sessionSearchMatches } from "./data/search";
import { sessionDetailPayload } from "./data/session-detail";
import {
	exportSessionMarkdown,
	exportSessionsBatchMarkdown,
} from "./data/session-export";
import { store } from "./data/store";
import type { RecordFilters } from "./data/totals";

function isValidHarness(id: string): boolean {
	return (
		defaultHarnessRegistry.has(id) ||
		isKnownHarness(id) ||
		(HARNESS_NAMES as readonly string[]).includes(id)
	);
}

const levelSet = new Set<string>(
	SESSION_DETAIL_LEVELS.map((item) => item.value),
);

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function numberParam(url: URL, name: string): number | null {
	const raw = url.searchParams.get(name);
	if (raw === null || raw.trim() === "") return null;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
	return value;
}

function listParam(url: URL, name: string): string[] {
	const values = url.searchParams
		.getAll(name)
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set(values)];
}

function filtersFrom(url: URL): RecordFilters {
	const from = numberParam(url, "from");
	const until = numberParam(url, "until");
	if (from !== null && until !== null && from >= until)
		throw new Error("from must be earlier than until");
	const harnesses = listParam(url, "harness");
	for (const harness of harnesses) {
		if (!isValidHarness(harness))
			throw new Error(`Unknown harness: ${harness}`);
	}
	const projects = listParam(url, "project").map((value) =>
		path.normalize(value),
	);
	const models = listParam(url, "model");
	return {
		from,
		until,
		harnesses: harnesses.length ? new Set(harnesses as HarnessName[]) : null,
		projects: projects.length ? new Set(projects) : null,
		models: models.length ? new Set(models) : null,
	};
}

function rangeFrom(url: URL): { from: number | null; until: number | null } {
	return {
		from: numberParam(url, "from"),
		until: numberParam(url, "until"),
	};
}

export async function handleApi(request: Request, url: URL): Promise<Response> {
	const segments = url.pathname.split("/").filter(Boolean);
	const resource = segments[1] ?? "";
	const method = request.method.toUpperCase();
	try {
		if (resource === "settings" && method === "GET")
			return json(store.readSettings());

		if (resource === "settings" && method === "PUT") {
			const body = (await request.json()) as Record<string, unknown>;
			return json(store.writeSettings(body));
		}

		if (resource === "status" && method === "GET")
			return json(store.status() satisfies StatusPayload);

		if (resource === "refresh" && method === "POST") {
			void store.start();
			return json({ started: true, status: store.status() }, 202);
		}

		if (resource === "search" && method === "GET") {
			await store.ensureReady();
			const query = url.searchParams.get("q") ?? "";
			const limit = Math.min(
				20,
				Math.max(1, Number(url.searchParams.get("limit") ?? 8) || 8),
			);
			return json(searchPayload(query, limit));
		}

		await store.ensureReady();

		if (resource === "overview" && method === "GET")
			return json(overviewPayload(filtersFrom(url)));

		if (resource === "explore" && method === "GET") {
			const filters = filtersFrom(url);
			const mode =
				url.searchParams.get("mode") === "dimension" ? "dimension" : "time";
			const metric = (
				["tokens", "cost", "requests", "sessions"].includes(
					url.searchParams.get("metric") ?? "",
				)
					? url.searchParams.get("metric")
					: "cost"
			) as "tokens" | "cost" | "requests" | "sessions";
			const dimension = (
				["harness", "project", "model"].includes(
					url.searchParams.get("dimension") ?? "",
				)
					? url.searchParams.get("dimension")
					: "model"
			) as "harness" | "project" | "model";
			const bucket = (
				["hour", "day", "week", "month"].includes(
					url.searchParams.get("bucket") ?? "",
				)
					? url.searchParams.get("bucket")
					: "day"
			) as "hour" | "day" | "week" | "month";
			const breakdownValue = url.searchParams.get("breakdown") ?? "none";
			const breakdown = (
				["none", "harness", "project", "model"].includes(breakdownValue)
					? breakdownValue
					: "none"
			) as "none" | "harness" | "project" | "model";
			return json(
				explorePayload({
					filters,
					mode,
					metric,
					dimension,
					bucket,
					breakdown,
					limit: 8,
				}),
			);
		}

		if (resource === "heatmap" && method === "GET")
			return json(
				heatmapPayload(Number(url.searchParams.get("weeks") ?? 53) || 53),
			);

		if (
			resource === "sessions" &&
			method === "POST" &&
			segments.length === 3 &&
			segments[2] === "export"
		) {
			const body = (await request.json().catch(() => ({}))) as {
				keys?: unknown;
				level?: unknown;
				includeTimestamps?: unknown;
				includeTokenStats?: unknown;
				directory?: unknown;
			};
			const keys = Array.isArray(body.keys)
				? body.keys.filter(
						(item): item is string =>
							typeof item === "string" && item.trim().length > 0,
					)
				: [];
			if (keys.length === 0) {
				return json({ error: "At least one session key is required" }, 400);
			}
			const level =
				typeof body.level === "string" && levelSet.has(body.level)
					? (body.level as SessionDetailLevel)
					: "chat";
			const includeTimestamps =
				typeof body.includeTimestamps === "boolean"
					? body.includeTimestamps
					: true;
			const includeTokenStats =
				typeof body.includeTokenStats === "boolean"
					? body.includeTokenStats
					: true;
			const directory =
				typeof body.directory === "string" && body.directory.trim()
					? body.directory
					: undefined;
			const result = await exportSessionsBatchMarkdown({
				keys,
				detail: level,
				includeTimestamps,
				includeTokenStats,
				directory,
			});
			return json(result);
		}

		if (
			resource === "sessions" &&
			method === "POST" &&
			segments.length >= 5 &&
			segments.at(-1) === "export"
		) {
			const harness = segments[2] ?? "";
			if (!isValidHarness(harness))
				return json({ error: `Unknown harness: ${harness}` }, 400);
			const sessionId = decodeURIComponent(segments.slice(3, -1).join("/"));
			const body = (await request.json().catch(() => ({}))) as {
				level?: unknown;
				directory?: unknown;
			};
			const level =
				typeof body.level === "string" && levelSet.has(body.level)
					? (body.level as SessionDetailLevel)
					: "chat";
			const directory =
				typeof body.directory === "string" && body.directory.trim()
					? body.directory
					: undefined;
			const result = await exportSessionMarkdown(
				`${harness}:${sessionId}`,
				level,
				directory,
			);
			return json(result);
		}

		if (
			resource === "sessions" &&
			segments.length === 3 &&
			segments[2] === "search" &&
			method === "GET"
		) {
			const query = url.searchParams.get("q") ?? "";
			return json(sessionSearchMatches(query, rangeFrom(url)));
		}

		if (resource === "sessions" && segments.length >= 3 && method === "GET") {
			const harness = segments[2] ?? "";
			if (!isValidHarness(harness))
				return json({ error: `Unknown harness: ${harness}` }, 400);
			const sessionId = decodeURIComponent(segments.slice(3).join("/"));
			const key = `${harness}:${sessionId}`;
			const rawLevel = url.searchParams.get("level") ?? "chat";
			if (!levelSet.has(rawLevel))
				return json({ error: `Unknown detail level: ${rawLevel}` }, 400);
			return json(
				await sessionDetailPayload(key, rawLevel as SessionDetailLevel),
			);
		}

		if (resource === "sessions" && method === "GET") {
			const range = rangeFrom(url);
			const payload: SessionsPayload = {
				sessions: store.sessionSummaries(range),
				indexedAt: store.lastIndexedAt(),
				warnings: store.warningList(),
			};
			return json(payload);
		}

		if (resource === "projects" && method === "GET")
			return json(projectReportPayload(filtersFrom(url)));

		if (resource === "models" && method === "GET")
			return json(modelReportPayload(filtersFrom(url)));

		if (resource === "harnesses" && method === "GET")
			return json(harnessReportPayload(filtersFrom(url), store.sourcePaths()));

		return json({ error: "Not found" }, 404);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[api] ${url.pathname}: ${message}`);
		return json({ error: message }, store.isReady ? 400 : 503);
	}
}
