import type {
	AppSettings,
	ExploreBucket,
	ExploreDimension,
	ExploreMetric,
	ExploreMode,
	ExplorePayload,
	HarnessReportPayload,
	HeatmapPayload,
	ModelReportPayload,
	OverviewPayload,
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
	if (!response.ok) {
		let message = response.statusText;
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
	updateSettings: async (
		partial: Partial<AppSettings>,
	): Promise<AppSettings> => {
		const response = await fetch("/api/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(partial),
		});
		if (!response.ok)
			throw new ApiError("Could not save settings", response.status);
		return (await response.json()) as AppSettings;
	},
	refresh: async (): Promise<void> => {
		const response = await fetch("/api/refresh", { method: "POST" });
		if (!response.ok) throw new ApiError("Refresh failed", response.status);
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
	exportSession: async (
		harness: string,
		sessionId: string,
		level: SessionDetailLevel,
	): Promise<{ path: string; filename: string; bytes: number }> => {
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(
				sessionId,
			)}/export`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ level }),
			},
		);
		if (!response.ok) {
			let message = response.statusText;
			try {
				const body = (await response.json()) as { error?: string };
				if (body.error) message = body.error;
			} catch {}
			throw new ApiError(message, response.status);
		}
		return (await response.json()) as {
			path: string;
			filename: string;
			bytes: number;
		};
	},
	search: (query: string, limit = 8) =>
		getJson<SearchPayload>(`/api/search${queryString({ q: query, limit })}`),
	sessionsSearch: (range: ResolvedRange, query: string) =>
		getJson<SessionsSearchPayload>(
			`/api/sessions/search${queryString({ ...rangeQuery(range), q: query })}`,
		),
};
