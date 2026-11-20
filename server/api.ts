import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { isKnownHarness } from "@shared/colors";
import type {
	AppLocale,
	AppSettings,
	BatchExportOrganization,
	CustomModelPriceRule,
	HarnessName,
	SessionDetailLevel,
	SessionsPayload,
	StatusPayload,
} from "@shared/types";
import { HARNESS_NAMES, SESSION_DETAIL_LEVELS } from "@shared/types";
import { defaultPlatformPathService } from "../src/platform/paths";
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
	buildSessionsBatchZip,
	exportSessionMarkdown,
	exportSessionsBatchMarkdown,
	renderSingleSessionExport,
} from "./data/session-export";
import { store } from "./data/store";
import type { RecordFilters } from "./data/totals";

class ApiValidationError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.name = "ApiValidationError";
		this.status = status;
	}
}

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function isLocalhostHostname(hostname: string): boolean {
	return LOCALHOST_HOSTS.has(hostname.toLowerCase());
}

function parseHostHeaderHostname(hostHeader: string): string | null {
	const trimmed = hostHeader.trim();
	if (!trimmed) return null;
	try {
		return new URL(`http://${trimmed}`).hostname;
	} catch {
		return null;
	}
}

function assertLocalhostRequest(request: Request): Response | null {
	const hostHeader = request.headers.get("host");
	if (hostHeader !== null) {
		const hostname = parseHostHeaderHostname(hostHeader);
		if (!hostname || !isLocalhostHostname(hostname)) {
			return json({ error: "Forbidden host" }, 403);
		}
	}
	const origin = request.headers.get("origin");
	if (origin !== null) {
		if (!origin || origin === "null") {
			return json({ error: "Forbidden origin" }, 403);
		}
		try {
			const parsed = new URL(origin);
			if (!isLocalhostHostname(parsed.hostname)) {
				return json({ error: "Forbidden origin" }, 403);
			}
		} catch {
			return json({ error: "Forbidden origin" }, 403);
		}
		return null;
	}
	const referer = request.headers.get("referer");
	if (referer !== null) {
		try {
			const parsed = new URL(referer);
			if (!isLocalhostHostname(parsed.hostname)) {
				return json({ error: "Forbidden referer" }, 403);
			}
		} catch {
			return json({ error: "Forbidden referer" }, 403);
		}
	}
	return null;
}

async function readJsonBody(
	request: Request,
): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("content-type") ?? "";
	const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") {
		throw new ApiValidationError("Content-Type must be application/json", 415);
	}
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		throw new ApiValidationError("Request body must be valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ApiValidationError("Request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

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
const themeSet = new Set(["light", "dark", "system"]);
const localeSet = new Set<AppLocale>([
	"en",
	"zh-CN",
	"zh-TW",
	"ja",
	"ko",
	"es",
	"fr",
	"de",
]);
const exploreModeSet = new Set(["time", "dimension"]);
const exploreMetricSet = new Set(["tokens", "cost", "requests", "sessions"]);
const exploreDimensionSet = new Set(["harness", "project", "model"]);
const exploreBucketSet = new Set(["hour", "day", "week", "month"]);
const exploreBreakdownSet = new Set(["harness", "project", "model", "none"]);
const exploreChartSet = new Set(["bar", "line", "area"]);
const overviewModelsMetricSet = new Set(["cost", "tokens"]);
const overviewShareDimensionSet = new Set(["project", "harness"]);
const organizationSet = new Set<BatchExportOrganization>([
	"flat",
	"harness",
	"date",
	"project",
	"custom",
]);

function assertEnum<T extends string>(
	value: unknown,
	allowed: ReadonlySet<string>,
	field: string,
): T {
	if (typeof value !== "string" || !allowed.has(value)) {
		throw new ApiValidationError(`Invalid ${field}`);
	}
	return value as T;
}

function assertBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new ApiValidationError(`${field} must be a boolean`);
	}
	return value;
}

function validateSettingsPatch(
	body: Record<string, unknown>,
): Partial<AppSettings> {
	const patch: Partial<AppSettings> = {};
	for (const [key, value] of Object.entries(body)) {
		switch (key) {
			case "theme":
				patch.theme = assertEnum(value, themeSet, key);
				break;
			case "locale":
				patch.locale = assertEnum<AppLocale>(value, localeSet, key);
				break;
			case "defaultRange":
				if (typeof value !== "string" || !value.trim() || value.length > 64) {
					throw new ApiValidationError("Invalid defaultRange");
				}
				patch.defaultRange = value.trim();
				break;
			case "defaultDetailLevel":
				patch.defaultDetailLevel = assertEnum<SessionDetailLevel>(
					value,
					levelSet,
					key,
				);
				break;
			case "includeInternal":
				patch.includeInternal = assertBoolean(value, key);
				break;
			case "exploreMode":
				patch.exploreMode = assertEnum(value, exploreModeSet, key);
				break;
			case "exploreMetric":
				patch.exploreMetric = assertEnum(value, exploreMetricSet, key);
				break;
			case "exploreDimension":
				patch.exploreDimension = assertEnum(value, exploreDimensionSet, key);
				break;
			case "exploreBucket":
				patch.exploreBucket = assertEnum(value, exploreBucketSet, key);
				break;
			case "exploreBreakdown":
				patch.exploreBreakdown = assertEnum(value, exploreBreakdownSet, key);
				break;
			case "exploreChart":
				patch.exploreChart = assertEnum(value, exploreChartSet, key);
				break;
			case "autoRefreshMinutes":
				if (
					typeof value !== "number" ||
					!Number.isFinite(value) ||
					value < 0 ||
					value > 1440
				) {
					throw new ApiValidationError(
						"autoRefreshMinutes must be between 0 and 1440",
					);
				}
				patch.autoRefreshMinutes = value;
				break;
			case "overviewModelsMetric":
				patch.overviewModelsMetric = assertEnum(
					value,
					overviewModelsMetricSet,
					key,
				);
				break;
			case "overviewShareDimension":
				patch.overviewShareDimension = assertEnum(
					value,
					overviewShareDimensionSet,
					key,
				);
				break;
			case "batchExportDetailLevel":
				if (value !== undefined) {
					patch.batchExportDetailLevel = assertEnum<SessionDetailLevel>(
						value,
						levelSet,
						key,
					);
				}
				break;
			case "batchExportOrganization":
				patch.batchExportOrganization = assertEnum<BatchExportOrganization>(
					value,
					organizationSet,
					key,
				);
				break;
			case "batchExportPathTemplate":
				if (typeof value !== "string" || value.length > 512) {
					throw new ApiValidationError("Invalid batchExportPathTemplate");
				}
				patch.batchExportPathTemplate = value;
				break;
			case "batchExportIncludeTimestamps":
				patch.batchExportIncludeTimestamps = assertBoolean(value, key);
				break;
			case "batchExportIncludeTokenStats":
				patch.batchExportIncludeTokenStats = assertBoolean(value, key);
				break;
			case "batchExportAsZip":
				patch.batchExportAsZip = assertBoolean(value, key);
				break;
			default:
				throw new ApiValidationError(`Unknown setting: ${key}`);
		}
	}
	return patch;
}

function validateExportDirectory(raw: unknown): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "string") {
		throw new ApiValidationError("directory must be a string");
	}
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (
		trimmed.includes("\0") ||
		/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)
	) {
		throw new ApiValidationError(
			"directory must be a valid local directory path",
		);
	}
	const isWinAbsolute = /^[a-zA-Z]:[/\\]/u.test(trimmed);
	if (!path.isAbsolute(trimmed) && !isWinAbsolute) {
		throw new ApiValidationError("directory must be an absolute path");
	}
	const normalized = defaultPlatformPathService.normalize(trimmed);
	if (existsSync(normalized)) {
		try {
			if (!statSync(normalized).isDirectory()) {
				throw new ApiValidationError("directory path is not a directory");
			}
		} catch (error) {
			if (error instanceof ApiValidationError) throw error;
			throw new ApiValidationError("directory could not be accessed");
		}
	}
	return normalized;
}

function validateRevealPath(raw: unknown): string {
	if (typeof raw !== "string") {
		throw new ApiValidationError("path is required");
	}
	const trimmed = raw.trim();
	if (!trimmed || trimmed.includes("\0")) {
		throw new ApiValidationError("path is required");
	}
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)) {
		throw new ApiValidationError("path must be a local filesystem path");
	}
	const isWinAbsolute = /^[a-zA-Z]:[/\\]/u.test(trimmed);
	if (!path.isAbsolute(trimmed) && !isWinAbsolute) {
		throw new ApiValidationError("path must be an absolute local path");
	}
	if (!existsSync(trimmed)) {
		throw new ApiValidationError("path does not exist");
	}
	return trimmed;
}

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
	if (!Number.isFinite(value)) {
		throw new ApiValidationError(`${name} must be a number`);
	}
	return value;
}

function limitParam(url: URL, defaultValue: number, maxValue: number): number {
	const raw = url.searchParams.get("limit");
	if (raw === null || raw.trim() === "") return defaultValue;
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		throw new ApiValidationError("limit must be a positive integer");
	}
	return Math.min(maxValue, value);
}

function safeDecodeComponent(raw: string, label: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new ApiValidationError(`Invalid ${label} encoding`);
	}
}

function listParam(url: URL, name: string, splitCommas = false): string[] {
	const rawValues = url.searchParams.getAll(name);
	const values = (
		splitCommas ? rawValues.flatMap((value) => value.split(",")) : rawValues
	)
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set(values)];
}

function rangeFrom(url: URL): { from: number | null; until: number | null } {
	const from = numberParam(url, "from");
	const until = numberParam(url, "until");
	if (from !== null && until !== null && from >= until) {
		throw new ApiValidationError("from must be earlier than until");
	}
	return { from, until };
}

function filtersFrom(url: URL): RecordFilters {
	const { from, until } = rangeFrom(url);
	const harnesses = listParam(url, "harness", true);
	for (const harness of harnesses) {
		if (!isValidHarness(harness)) {
			throw new ApiValidationError(`Unknown harness: ${harness}`);
		}
	}
	const projects = listParam(url, "project", false).map((value) =>
		defaultPlatformPathService.normalize(value),
	);
	const models = listParam(url, "model", false);
	return {
		from,
		until,
		harnesses: harnesses.length ? new Set(harnesses as HarnessName[]) : null,
		projects: projects.length ? new Set(projects) : null,
		models: models.length ? new Set(models) : null,
	};
}

export async function handleApi(request: Request, url: URL): Promise<Response> {
	const segments = url.pathname.split("/").filter(Boolean);
	const resource = segments[1] ?? "";
	const method = request.method.toUpperCase();
	if (MUTATING_METHODS.has(method)) {
		const forbidden = assertLocalhostRequest(request);
		if (forbidden) return forbidden;
	}
	try {
		if (resource === "settings" && method === "GET")
			return json(store.readSettings());

		if (resource === "settings" && method === "PUT") {
			const body = await readJsonBody(request);
			const patch = validateSettingsPatch(body);
			return json(store.writeSettings(patch));
		}

		if (resource === "status" && method === "GET") {
			if (!store.hasStarted()) {
				setTimeout(() => void store.start(), 0);
			}
			return json(store.status() satisfies StatusPayload);
		}

		if (resource === "refresh" && method === "POST") {
			void store.refresh();
			return json({ started: true, status: store.status() }, 202);
		}

		if (resource === "pricing" && segments.length === 2 && method === "GET") {
			return json(store.pricingPayload());
		}

		if (
			resource === "pricing" &&
			segments[2] === "catalog" &&
			method === "GET"
		) {
			const query = url.searchParams.get("q") ?? "";
			const limit = limitParam(url, 25, 100);
			return json({ items: store.searchPricingCatalog(query, limit) });
		}

		if (
			resource === "pricing" &&
			segments[2] === "settings" &&
			method === "PUT"
		) {
			const body = await readJsonBody(request);
			if (
				body.cacheTtlHours !== undefined &&
				(typeof body.cacheTtlHours !== "number" ||
					!Number.isFinite(body.cacheTtlHours) ||
					body.cacheTtlHours <= 0)
			) {
				throw new ApiValidationError("cacheTtlHours must be a positive number");
			}
			try {
				return json(
					store.updatePricingSettings({
						...(typeof body.autoFetch === "boolean"
							? { autoFetch: body.autoFetch }
							: {}),
						...(typeof body.endpoint === "string"
							? { endpoint: body.endpoint }
							: {}),
						...(typeof body.cacheTtlHours === "number"
							? { cacheTtlHours: body.cacheTtlHours }
							: {}),
					}),
				);
			} catch (err) {
				throw new ApiValidationError(
					err instanceof Error ? err.message : String(err),
				);
			}
		}

		if (
			resource === "pricing" &&
			segments[2] === "refresh" &&
			method === "POST"
		) {
			const result = await store.refreshPricingCatalog("manual");
			return json({
				attempt: result.attempt,
				...result.payload,
			});
		}

		if (resource === "search" && method === "GET") {
			await store.ensureReady();
			const query = url.searchParams.get("q") ?? "";
			const limit = limitParam(url, 8, 20);
			return json(searchPayload(query, limit));
		}

		await store.ensureReady();

		if (
			resource === "pricing" &&
			segments[2] === "rules" &&
			segments.length === 3 &&
			method === "PUT"
		) {
			const body = (await readJsonBody(request)) as {
				rule?: Omit<CustomModelPriceRule, "updatedAt">;
				rules?: Record<string, unknown>;
				replace?: boolean;
			};
			try {
				if (
					body.rule &&
					typeof body.rule === "object" &&
					!Array.isArray(body.rule)
				) {
					return json(store.upsertCustomPriceRule(body.rule));
				}
				if (
					body.rules &&
					typeof body.rules === "object" &&
					!Array.isArray(body.rules)
				) {
					return json(
						store.importCustomPriceRules(body.rules, body.replace === true),
					);
				}
			} catch (err) {
				throw new ApiValidationError(
					err instanceof Error ? err.message : String(err),
				);
			}
			return json({ error: "rule or rules is required" }, 400);
		}

		if (
			resource === "pricing" &&
			segments[2] === "rules" &&
			segments.length >= 4 &&
			method === "DELETE"
		) {
			const modelKey = safeDecodeComponent(
				segments.slice(3).join("/"),
				"model key",
			);
			if (!modelKey.trim()) {
				throw new ApiValidationError("model key is required");
			}
			return json(store.deleteCustomPriceRule(modelKey));
		}

		if (resource === "overview" && method === "GET") {
			const bucketParam = url.searchParams.get("bucket");
			const bucket = (
				["hour", "day", "week", "month"].includes(bucketParam ?? "")
					? bucketParam
					: undefined
			) as "hour" | "day" | "week" | "month" | undefined;
			return json(overviewPayload(filtersFrom(url), bucket));
		}

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

		if (resource === "heatmap" && method === "GET") {
			const weeksParam = numberParam(url, "weeks");
			if (
				weeksParam !== null &&
				(!Number.isInteger(weeksParam) || weeksParam < 1 || weeksParam > 260)
			) {
				throw new ApiValidationError(
					"weeks must be an integer between 1 and 260",
				);
			}
			return json(heatmapPayload(weeksParam ?? 53));
		}

		if (
			resource === "dialog" &&
			segments[2] === "directory" &&
			method === "POST"
		) {
			if (!store.canPickDirectory()) {
				return json({ supported: false, path: null, cancelled: false });
			}
			const chosen = await store.chooseDirectory();
			return json({
				supported: true,
				path: chosen,
				cancelled: chosen === null,
			});
		}

		if (
			resource === "dialog" &&
			segments[2] === "reveal" &&
			method === "POST"
		) {
			const body = await readJsonBody(request);
			const targetPath = validateRevealPath(body.path);
			await store.revealInFileManager(targetPath);
			return json({ ok: true });
		}

		if (
			resource === "sessions" &&
			method === "POST" &&
			segments.length === 3 &&
			segments[2] === "export"
		) {
			const body = await readJsonBody(request);
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
			const directory = validateExportDirectory(body.directory);
			const asZip = body.asZip === true;
			const organization = (
				typeof body.organization === "string" &&
				organizationSet.has(body.organization as BatchExportOrganization)
					? body.organization
					: "flat"
			) as BatchExportOrganization;
			const pathTemplate =
				typeof body.pathTemplate === "string" ? body.pathTemplate : undefined;

			if (body.stream === true) {
				const encoder = new TextEncoder();
				const downloadMode = body.download === true;
				const exportAbort = new AbortController();
				const onRequestAbort = () => exportAbort.abort();
				request.signal.addEventListener("abort", onRequestAbort, {
					once: true,
				});
				const stream = new ReadableStream({
					async start(controller) {
						const emit = (payload: unknown) => {
							try {
								controller.enqueue(
									encoder.encode(`${JSON.stringify(payload)}\n`),
								);
							} catch {}
						};
						try {
							if (downloadMode) {
								const built = await buildSessionsBatchZip({
									keys,
									detail: level,
									includeTimestamps,
									includeTokenStats,
									organization,
									pathTemplate,
									signal: exportAbort.signal,
									onProgress: (progress) =>
										emit({ type: "progress", ...progress }),
								});
								emit({
									type: "done",
									result: {
										directory: "",
										outputPath: "",
										zipPath: "",
										filename: built.filename,
										bytes: built.zipBytes.byteLength,
										filesWritten: built.filesWritten,
										skippedCount: built.skippedCount,
										warnings: built.warnings,
									},
									zipBase64: Buffer.from(built.zipBytes).toString("base64"),
								});
							} else {
								const result = await exportSessionsBatchMarkdown({
									keys,
									detail: level,
									includeTimestamps,
									includeTokenStats,
									directory,
									asZip,
									organization,
									pathTemplate,
									signal: exportAbort.signal,
									onProgress: (progress) =>
										emit({ type: "progress", ...progress }),
								});
								emit({ type: "done", result });
							}
						} catch (err) {
							if (!(err instanceof DOMException && err.name === "AbortError")) {
								emit({
									type: "error",
									error: err instanceof Error ? err.message : String(err),
								});
							}
						} finally {
							request.signal.removeEventListener("abort", onRequestAbort);
							try {
								controller.close();
							} catch {}
						}
					},
					cancel() {
						exportAbort.abort();
					},
				});
				return new Response(stream, {
					headers: {
						"Content-Type": "application/x-ndjson; charset=utf-8",
						"Cache-Control": "no-cache",
					},
				});
			}

			const result = await exportSessionsBatchMarkdown({
				keys,
				detail: level,
				includeTimestamps,
				includeTokenStats,
				directory,
				asZip,
				organization,
				pathTemplate,
				signal: request.signal,
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
			const sessionId = safeDecodeComponent(
				segments.slice(3, -1).join("/"),
				"sessionId",
			);
			if (!sessionId.trim()) {
				throw new ApiValidationError("sessionId is required");
			}
			const body = await readJsonBody(request);
			const level =
				typeof body.level === "string" && levelSet.has(body.level)
					? (body.level as SessionDetailLevel)
					: "chat";
			const directory = validateExportDirectory(body.directory);
			if (body.download === true) {
				const rendered = await renderSingleSessionExport(
					`${harness}:${sessionId}`,
					level,
				);
				return new Response(rendered.markdown, {
					headers: {
						"Content-Type": "text/markdown; charset=utf-8",
						"Content-Disposition": `attachment; filename="${rendered.filename}"`,
					},
				});
			}
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
			const sessionId = safeDecodeComponent(
				segments.slice(3).join("/"),
				"sessionId",
			);
			if (!sessionId.trim()) {
				throw new ApiValidationError("sessionId is required");
			}
			const rawLevel = url.searchParams.get("level") ?? "chat";
			if (!levelSet.has(rawLevel))
				return json({ error: `Unknown detail level: ${rawLevel}` }, 400);
			const key = `${harness}:${sessionId}`;
			if (!store.sessionEntry(key)) {
				return json({ error: "Session not found" }, 404);
			}
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
		if (error instanceof ApiValidationError) {
			return json({ error: error.message }, error.status);
		}
		if (error instanceof SyntaxError) {
			return json({ error: "Request body must be valid JSON" }, 400);
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[api] ${url.pathname}: ${message}`);
		return json({ error: message }, store.isReady ? 500 : 503);
	}
}
