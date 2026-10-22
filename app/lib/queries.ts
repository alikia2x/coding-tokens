import type {
	AppSettings,
	ExploreBucket,
	ExploreDimension,
	ExploreMetric,
	ExploreMode,
	SessionDetailLevel,
} from "@shared/types";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api";
import type { ResolvedRange } from "./time-range";

export const queryKeys = {
	status: ["status"] as const,
	settings: ["settings"] as const,
	overview: (from: number | null, until: number | null) =>
		["overview", from, until] as const,
	sessions: (from: number | null, until: number | null) =>
		["sessions", from, until] as const,
	projects: (from: number | null, until: number | null) =>
		["projects", from, until] as const,
	models: (from: number | null, until: number | null) =>
		["models", from, until] as const,
	harnesses: (from: number | null, until: number | null) =>
		["harnesses", from, until] as const,
	heatmap: ["heatmap"] as const,
	session: (harness: string, sessionId: string, level: SessionDetailLevel) =>
		["session", harness, sessionId, level] as const,
	search: (query: string) => ["search", query] as const,
	explore: (key: string) => ["explore", key] as const,
};

export function useStatus() {
	return useQuery({
		queryKey: queryKeys.status,
		queryFn: api.status,
		refetchInterval: (query) =>
			query.state.data?.indexing || !query.state.data?.ready ? 1200 : 60_000,
		refetchOnWindowFocus: true,
		staleTime: 0,
	});
}

export function useOverview(range: ResolvedRange) {
	return useQuery({
		queryKey: queryKeys.overview(range.from, range.until),
		queryFn: () => api.overview(range),
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
}

export function useSessions(range: ResolvedRange) {
	return useQuery({
		queryKey: queryKeys.sessions(range.from, range.until),
		queryFn: () => api.sessions(range),
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
}

export function useProjects(range: ResolvedRange) {
	return useQuery({
		queryKey: queryKeys.projects(range.from, range.until),
		queryFn: () => api.projects(range),
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
}

export function useModels(range: ResolvedRange) {
	return useQuery({
		queryKey: queryKeys.models(range.from, range.until),
		queryFn: () => api.models(range),
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
}

export function useHarnesses(range: ResolvedRange) {
	return useQuery({
		queryKey: queryKeys.harnesses(range.from, range.until),
		queryFn: () => api.harnesses(range),
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
}

export function useHeatmap() {
	return useQuery({
		queryKey: queryKeys.heatmap,
		queryFn: () => api.heatmap(53),
		staleTime: 5 * 60_000,
	});
}

export function useSessionDetail(
	harness: string,
	sessionId: string,
	level: SessionDetailLevel,
) {
	return useQuery({
		queryKey: queryKeys.session(harness, sessionId, level),
		queryFn: () => api.sessionDetail(harness, sessionId, level),
		staleTime: 5 * 60_000,
		retry: 1,
	});
}

export function useSearch(query: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.search(query),
		queryFn: () => api.search(query, 8),
		enabled,
		staleTime: 30_000,
		placeholderData: keepPreviousData,
	});
}

export function useRefreshData() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: api.refresh,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.status });
		},
	});
}

export function usePrefetchTabs(range: ResolvedRange, enabled: boolean): void {
	const queryClient = useQueryClient();
	const from = range.from;
	const until = range.until;
	useEffect(() => {
		if (!enabled) return;
		const key = { from, until };
		const options = { staleTime: 5 * 60_000 };
		void queryClient.prefetchQuery({
			queryKey: queryKeys.overview(from, until),
			queryFn: () => api.overview({ ...range, ...key }),
			...options,
		});
		void queryClient.prefetchQuery({
			queryKey: queryKeys.sessions(from, until),
			queryFn: () => api.sessions({ ...range, ...key }),
			...options,
		});
		void queryClient.prefetchQuery({
			queryKey: queryKeys.projects(from, until),
			queryFn: () => api.projects({ ...range, ...key }),
			...options,
		});
		void queryClient.prefetchQuery({
			queryKey: queryKeys.models(from, until),
			queryFn: () => api.models({ ...range, ...key }),
			...options,
		});
		void queryClient.prefetchQuery({
			queryKey: queryKeys.harnesses(from, until),
			queryFn: () => api.harnesses({ ...range, ...key }),
			...options,
		});
		void queryClient.prefetchQuery({
			queryKey: queryKeys.heatmap,
			queryFn: () => api.heatmap(53),
			...options,
		});
	}, [enabled, from, until, queryClient, range]);
}

export function useExplore(options: {
	from: number | null;
	until: number | null;
	mode: ExploreMode;
	metric: ExploreMetric;
	dimension: ExploreDimension;
	bucket: ExploreBucket;
	breakdown: ExploreDimension | "none";
	harnesses: string[];
	projects: string[];
	models: string[];
}) {
	const key = JSON.stringify(options);
	return useQuery({
		queryKey: queryKeys.explore(key),
		queryFn: () => api.explore(options),
		placeholderData: keepPreviousData,
		staleTime: 60_000,
	});
}

export function useAppSettings() {
	return useQuery({
		queryKey: queryKeys.settings,
		queryFn: api.settings,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function useUpdateAppSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: api.updateSettings,
		onMutate: async (partial) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.settings });
			const previous = queryClient.getQueryData<AppSettings>(
				queryKeys.settings,
			);
			if (previous)
				queryClient.setQueryData<AppSettings>(queryKeys.settings, {
					...previous,
					...partial,
				});
			return { previous };
		},
		onError: (_error, _partial, context) => {
			if (context?.previous)
				queryClient.setQueryData(queryKeys.settings, context.previous);
		},
		onSuccess: (next) => queryClient.setQueryData(queryKeys.settings, next),
	});
}
