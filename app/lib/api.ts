import type {
	AppSettings,
	BatchExportOrganization,
	BatchSessionExportResult,
	CustomModelPriceRule,
	ExploreBucket,
	ExploreDimension,
	ExploreMetric,
	ExploreMode,
	ExplorePayload,
	HarnessReportPayload,
	HeatmapPayload,
	ModelReportPayload,
	OverviewPayload,
	PricingCatalogSearchItem,
	PricingFetchAttempt,
	PricingPayload,
	ProjectReportPayload,
	SearchPayload,
	SessionDetailLevel,
	SessionDetailPayload,
	SessionsPayload,
	SessionsSearchPayload,
	StatusPayload,
} from "@shared/types";
import type { ResolvedRange } from "./time-range";

export class ApiError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

function queryString(
	values: Record<string, string | number | null | undefined>,
): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value === null || value === undefined || value === "") continue;
		params.set(key, String(value));
	}
	const text = params.toString();
	return text ? `?${text}` : "";
}

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path, {
		headers: { Accept: "application/json" },
	});
	return readJsonResponse<T>(response);
}

async function sendJson<T>(
	path: string,
	method: "POST" | "PUT",
	body: unknown,
	fallbackMessage?: string,
): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return readJsonResponse<T>(response, fallbackMessage);
}

async function readJsonResponse<T>(
	response: Response,
	fallbackMessage?: string,
): Promise<T> {
	if (!response.ok) {
		let message = fallbackMessage ?? response.statusText;
		try {
			const body = (await response.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {}
		throw new ApiError(message, response.status);
	}
	return (await response.json()) as T;
}

function rangeQuery(range: { from: number | null; until: number | null }) {
	return {
		from: range.from,
		until: range.until,
	};
}

export const api = {
	status: () => getJson<StatusPayload>("/api/status"),
	settings: () => getJson<AppSettings>("/api/settings"),
	updateSettings: async (partial: Partial<AppSettings>): Promise<AppSettings> =>
		sendJson<AppSettings>(
			"/api/settings",
			"PUT",
			partial,
			"Could not save settings",
		),
	refresh: async (): Promise<void> => {
		const response = await fetch("/api/refresh", { method: "POST" });
		if (!response.ok) throw new ApiError("Refresh failed", response.status);
	},
	pricing: () => getJson<PricingPayload>("/api/pricing"),
	searchPricingCatalog: (q: string, limit = 25) =>
		getJson<{ items: PricingCatalogSearchItem[] }>(
			`/api/pricing/catalog${queryString({ q, limit })}`,
		),
	updatePricingSettings: (partial: {
		autoFetch?: boolean;
		endpoint?: string;
		cacheTtlHours?: number;
	}): Promise<PricingPayload> =>
		sendJson<PricingPayload>(
			"/api/pricing/settings",
			"PUT",
			partial,
			"Could not save pricing settings",
		),
	refreshPricing: (): Promise<
		PricingPayload & { attempt: PricingFetchAttempt }
	> =>
		sendJson<PricingPayload & { attempt: PricingFetchAttempt }>(
			"/api/pricing/refresh",
			"POST",
			{},
			"Could not refresh pricing catalog",
		),
	upsertPricingRule: (
		rule: Omit<CustomModelPriceRule, "updatedAt">,
	): Promise<PricingPayload> =>
		sendJson<PricingPayload>(
			"/api/pricing/rules",
			"PUT",
			{ rule },
			"Could not save model price rule",
		),
	importPricingRules: (
		rules: Record<string, CustomModelPriceRule>,
		replace = false,
	): Promise<PricingPayload> =>
		sendJson<PricingPayload>(
			"/api/pricing/rules",
			"PUT",
			{ rules, replace },
			"Could not import model price rules",
		),
	deletePricingRule: async (modelKey: string): Promise<PricingPayload> => {
		const response = await fetch(
			`/api/pricing/rules/${encodeURIComponent(modelKey)}`,
			{ method: "DELETE" },
		);
		return readJsonResponse<PricingPayload>(
			response,
			"Could not delete model price rule",
		);
	},
	overview: (range: ResolvedRange) =>
		getJson<OverviewPayload>(`/api/overview${queryString(rangeQuery(range))}`),
	sessions: (range: ResolvedRange) =>
		getJson<SessionsPayload>(`/api/sessions${queryString(rangeQuery(range))}`),
	projects: (range: ResolvedRange) =>
		getJson<ProjectReportPayload>(
			`/api/projects${queryString(rangeQuery(range))}`,
		),
	models: (range: ResolvedRange) =>
		getJson<ModelReportPayload>(`/api/models${queryString(rangeQuery(range))}`),
	heatmap: (weeks = 53) =>
		getJson<HeatmapPayload>(`/api/heatmap${queryString({ weeks })}`),
	explore: (options: {
		from: number | null;
		until: number | null;
		mode: ExploreMode;
		metric: ExploreMetric;
		dimension: ExploreDimension;
		bucket: ExploreBucket;
		breakdown: ExploreDimension | "none";
		harnesses?: string[];
		projects?: string[];
		models?: string[];
	}) => {
		const params = new URLSearchParams();
		params.set("mode", options.mode);
		params.set("metric", options.metric);
		params.set("dimension", options.dimension);
		params.set("bucket", options.bucket);
		params.set("breakdown", options.breakdown);
		if (options.from !== null) params.set("from", String(options.from));
		if (options.until !== null) params.set("until", String(options.until));
		for (const harness of options.harnesses ?? [])
			params.append("harness", harness);
		for (const project of options.projects ?? [])
			params.append("project", project);
		for (const model of options.models ?? []) params.append("model", model);
		return getJson<ExplorePayload>(`/api/explore?${params.toString()}`);
	},
	harnesses: (range: ResolvedRange) =>
		getJson<HarnessReportPayload>(
			`/api/harnesses${queryString(rangeQuery(range))}`,
		),
	sessionDetail: (
		harness: string,
		sessionId: string,
		level: SessionDetailLevel,
	) =>
		getJson<SessionDetailPayload>(
			`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(
				sessionId,
			)}${queryString({ level })}`,
		),
	chooseExportDirectory: (): Promise<{
		supported: boolean;
		path: string | null;
		cancelled: boolean;
	}> => sendJson("/api/dialog/directory", "POST", {}),
	revealPath: (targetPath: string): Promise<{ ok: boolean }> =>
		sendJson("/api/dialog/reveal", "POST", { path: targetPath }),
	exportSession: (
		harness: string,
		sessionId: string,
		level: SessionDetailLevel,
		directory?: string,
	): Promise<{ path: string; filename: string; bytes: number }> =>
		sendJson(
			`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(
				sessionId,
			)}/export`,
			"POST",
			{ level, ...(directory ? { directory } : {}) },
		),
	downloadSessionMarkdown: async (
		harness: string,
		sessionId: string,
		level: SessionDetailLevel,
	): Promise<string> => {
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(
				sessionId,
			)}/export`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ level, download: true }),
			},
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const disposition = response.headers.get("Content-Disposition") ?? "";
		const match = disposition.match(/filename="([^"]+)"/u);
		const filename = match?.[1] ?? "session.md";
		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
		URL.revokeObjectURL(url);
		return filename;
	},
	exportSessionsBatch: (options: {
		keys: string[];
		level: SessionDetailLevel;
		includeTimestamps?: boolean;
		includeTokenStats?: boolean;
		directory?: string;
	}): Promise<BatchSessionExportResult> =>
		sendJson("/api/sessions/export", "POST", options),
	exportSessionsBatchStream: async (options: {
		keys: string[];
		level: SessionDetailLevel;
		includeTimestamps?: boolean;
		includeTokenStats?: boolean;
		directory?: string;
		asZip?: boolean;
		organization?: BatchExportOrganization;
		pathTemplate?: string;
		download?: boolean;
		signal?: AbortSignal;
		onProgress?: (progress: {
			completed: number;
			total: number;
			currentTitle?: string;
		}) => void;
	}): Promise<BatchSessionExportResult> => {
		const response = await fetch("/api/sessions/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: options.signal,
			body: JSON.stringify({
				keys: options.keys,
				level: options.level,
				includeTimestamps: options.includeTimestamps,
				includeTokenStats: options.includeTokenStats,
				directory: options.directory,
				asZip: options.asZip,
				organization: options.organization,
				pathTemplate: options.pathTemplate,
				download: options.download,
				stream: true,
			}),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(text || `HTTP ${response.status}`);
		}
		if (response.headers.get("Content-Type")?.includes("application/json")) {
			return (await response.json()) as BatchSessionExportResult;
		}
		const reader = response.body?.getReader();
		if (!reader) {
			return sendJson("/api/sessions/export", "POST", {
				keys: options.keys,
				level: options.level,
				includeTimestamps: options.includeTimestamps,
				includeTokenStats: options.includeTokenStats,
				directory: options.directory,
			});
		}
		const decoder = new TextDecoder();
		let buffer = "";
		let finalResult: BatchSessionExportResult | null = null;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const event = JSON.parse(trimmed) as
					| {
							type: "progress";
							completed: number;
							total: number;
							currentTitle?: string;
					  }
					| {
							type: "done";
							result: BatchSessionExportResult;
							zipBase64?: string;
					  }
					| { type: "error"; error: string };
				if (event.type === "progress") {
					options.onProgress?.({
						completed: event.completed,
						total: event.total,
						currentTitle: event.currentTitle,
					});
				} else if (event.type === "error") {
					throw new Error(event.error);
				} else if (event.type === "done") {
					if (event.zipBase64) {
						const binary = atob(event.zipBase64);
						const bytes = new Uint8Array(binary.length);
						for (let i = 0; i < binary.length; i += 1) {
							bytes[i] = binary.charCodeAt(i);
						}
						const blob = new Blob([bytes], { type: "application/zip" });
						const url = URL.createObjectURL(blob);
						const anchor = document.createElement("a");
						anchor.href = url;
						anchor.download = event.result.filename;
						anchor.click();
						URL.revokeObjectURL(url);
					}
					finalResult = event.result;
				}
			}
		}
		if (!finalResult) {
			throw new Error("Export stream ended unexpectedly");
		}
		return finalResult;
	},
	search: (query: string, limit = 8) =>
		getJson<SearchPayload>(`/api/search${queryString({ q: query, limit })}`),
	sessionsSearch: (range: ResolvedRange, query: string) =>
		getJson<SessionsSearchPayload>(
			`/api/sessions/search${queryString({ ...rangeQuery(range), q: query })}`,
		),
};
