import type { HarnessName } from "@shared/types";
import { create } from "zustand";
import type {
	UsageBucketUnit,
	UsageMetric,
} from "~/components/charts/usage-chart";

export type SessionSortKey =
	| "recent"
	| "cost"
	| "tokens"
	| "requests"
	| "title";
export type ExploreMetric = "tokens" | "cost" | "requests" | "sessions";
export type ExploreDimension = "harness" | "project" | "model";
export type ExploreMode = "time" | "dimension";
export type ExploreBucket = "hour" | "day" | "week" | "month";
export type ExploreChart = "bar" | "line" | "area";
export type ProjectSortKey =
	| "name"
	| "sessions"
	| "requests"
	| "tokens"
	| "cost";
export type ModelSortKey =
	| "model"
	| "requests"
	| "tokens"
	| "cacheShare"
	| "cost"
	| "efficiency"
	| "recent";
export type SortDirection = "asc" | "desc";

export interface SessionsSlice {
	harness: HarnessName | null;
	projects: string[];
	models: string[];
	query: string;
	includeInternal: boolean | null;
	showEmpty: boolean;
	grouped: boolean;
	sort: SessionSortKey;
	expandedGroups: string[];
	expandedSignature: string | null;
	groupLimit: number;
	ungroupedLimit: number;
	expandedGroupLimits: Record<string, number>;
}

export interface ExploreSlice {
	mode: ExploreMode | null;
	metric: ExploreMetric | null;
	dimension: ExploreDimension | null;
	bucket: ExploreBucket | null;
	breakdown: (ExploreDimension | "none") | null;
	chart: ExploreChart | null;
	harnesses: string[];
	projects: string[];
	models: string[];
}

export interface OverviewSlice {
	metric: UsageMetric;
	bucketSelection: {
		signature: string;
		unit: UsageBucketUnit;
	} | null;
}

export interface ProjectsSlice {
	query: string;
	sort: { key: ProjectSortKey; direction: SortDirection };
}

export interface ModelsSlice {
	query: string;
	unpricedOnly: boolean;
	sort: { key: ModelSortKey; direction: SortDirection };
}

export interface HarnessesSlice {
	query: string;
	open: string[];
}

export interface SessionDetailSlice {
	turnLimits: Record<string, number>;
}

export interface AppState {
	scrollOffsets: Record<string, number>;
	overview: OverviewSlice;
	explore: ExploreSlice;
	sessions: SessionsSlice;
	projectsPage: ProjectsSlice;
	modelsPage: ModelsSlice;
	harnessesPage: HarnessesSlice;
	sessionDetail: SessionDetailSlice;
	setScrollOffset: (path: string, offset: number) => void;
	setOverviewMetric: (metric: UsageMetric) => void;
	setOverviewBucketSelection: (
		selection: { signature: string; unit: UsageBucketUnit } | null,
	) => void;
	setExploreField: <K extends keyof ExploreSlice>(
		key: K,
		value: ExploreSlice[K],
	) => void;
	applyExploreUrlState: (patch: Partial<ExploreSlice>) => void;
	resetExploreState: () => void;
	setSessionsPatch: (patch: Partial<SessionsSlice>) => void;
	applySessionsUrlFilters: (patch: {
		harness: HarnessName | null;
		projects: string[];
		models: string[];
		query: string;
		includeInternal: boolean | null;
		showEmpty: boolean;
	}) => void;
	clearSessionsFilters: () => void;
	setSessionsExpanded: (groups: string[], signature?: string | null) => void;
	toggleSessionGroup: (key: string) => void;
	setSessionGroupLimit: (limit: number) => void;
	setSessionUngroupedLimit: (limit: number) => void;
	setExpandedGroupRowLimit: (cwd: string, limit: number) => void;
	setProjectsQuery: (query: string) => void;
	setProjectsSort: (sort: {
		key: ProjectSortKey;
		direction: SortDirection;
	}) => void;
	setModelsQuery: (query: string) => void;
	setModelsUnpricedOnly: (value: boolean) => void;
	setModelsSort: (sort: {
		key: ModelSortKey;
		direction: SortDirection;
	}) => void;
	setHarnessesQuery: (query: string) => void;
	toggleHarnessOpen: (harness: string) => void;
	setSessionTurnLimit: (sessionKey: string, limit: number) => void;
	resetAll: () => void;
}

const DEFAULT_SESSIONS: SessionsSlice = {
	harness: null,
	projects: [],
	models: [],
	query: "",
	includeInternal: null,
	showEmpty: false,
	grouped: true,
	sort: "recent",
	expandedGroups: [],
	expandedSignature: null,
	groupLimit: 30,
	ungroupedLimit: 80,
	expandedGroupLimits: {},
};

const DEFAULT_EXPLORE: ExploreSlice = {
	mode: null,
	metric: null,
	dimension: null,
	bucket: null,
	breakdown: null,
	chart: null,
	harnesses: [],
	projects: [],
	models: [],
};

const DEFAULT_OVERVIEW: OverviewSlice = {
	metric: "cost",
	bucketSelection: null,
};

const DEFAULT_PROJECTS: ProjectsSlice = {
	query: "",
	sort: { key: "cost", direction: "desc" },
};

const DEFAULT_MODELS: ModelsSlice = {
	query: "",
	unpricedOnly: false,
	sort: { key: "cost", direction: "desc" },
};

const DEFAULT_HARNESSES: HarnessesSlice = {
	query: "",
	open: [],
};

const DEFAULT_SESSION_DETAIL: SessionDetailSlice = {
	turnLimits: {},
};

export const useAppStore = create<AppState>((set) => ({
	scrollOffsets: {},
	overview: { ...DEFAULT_OVERVIEW },
	explore: { ...DEFAULT_EXPLORE },
	sessions: { ...DEFAULT_SESSIONS },
	projectsPage: { ...DEFAULT_PROJECTS },
	modelsPage: { ...DEFAULT_MODELS },
	harnessesPage: { ...DEFAULT_HARNESSES },
	sessionDetail: { ...DEFAULT_SESSION_DETAIL },

	setScrollOffset: (path, offset) =>
		set((state) => {
			const normalized = Math.max(0, Math.round(offset));
			if (state.scrollOffsets[path] === normalized) return state;
			return {
				scrollOffsets: { ...state.scrollOffsets, [path]: normalized },
			};
		}),

	setOverviewMetric: (metric) =>
		set((state) => ({
			overview: { ...state.overview, metric },
		})),

	setOverviewBucketSelection: (bucketSelection) =>
		set((state) => ({
			overview: { ...state.overview, bucketSelection },
		})),

	setExploreField: (key, value) =>
		set((state) => ({
			explore: { ...state.explore, [key]: value },
		})),

	applyExploreUrlState: (patch) =>
		set((state) => ({
			explore: { ...state.explore, ...patch },
		})),

	resetExploreState: () =>
		set({
			explore: { ...DEFAULT_EXPLORE },
		}),

	setSessionsPatch: (patch) =>
		set((state) => ({
			sessions: { ...state.sessions, ...patch },
		})),

	applySessionsUrlFilters: (patch) =>
		set((state) => ({
			sessions: {
				...state.sessions,
				harness: patch.harness,
				projects: patch.projects,
				models: patch.models,
				query: patch.query,
				includeInternal: patch.includeInternal,
				showEmpty: patch.showEmpty,
				groupLimit: DEFAULT_SESSIONS.groupLimit,
				ungroupedLimit: DEFAULT_SESSIONS.ungroupedLimit,
				expandedGroupLimits: {},
			},
		})),

	clearSessionsFilters: () =>
		set((state) => ({
			sessions: {
				...state.sessions,
				harness: null,
				projects: [],
				models: [],
				query: "",
				includeInternal: false,
				showEmpty: false,
				groupLimit: DEFAULT_SESSIONS.groupLimit,
				ungroupedLimit: DEFAULT_SESSIONS.ungroupedLimit,
				expandedGroupLimits: {},
			},
		})),

	setSessionsExpanded: (expandedGroups, expandedSignature) =>
		set((state) => ({
			sessions: {
				...state.sessions,
				expandedGroups,
				...(expandedSignature !== undefined ? { expandedSignature } : {}),
			},
		})),

	toggleSessionGroup: (key) =>
		set((state) => {
			const exists = state.sessions.expandedGroups.includes(key);
			const next = exists
				? state.sessions.expandedGroups.filter((item) => item !== key)
				: [...state.sessions.expandedGroups, key];
			return {
				sessions: { ...state.sessions, expandedGroups: next },
			};
		}),

	setSessionGroupLimit: (groupLimit) =>
		set((state) => ({
			sessions: { ...state.sessions, groupLimit },
		})),

	setSessionUngroupedLimit: (ungroupedLimit) =>
		set((state) => ({
			sessions: { ...state.sessions, ungroupedLimit },
		})),

	setExpandedGroupRowLimit: (cwd, limit) =>
		set((state) => ({
			sessions: {
				...state.sessions,
				expandedGroupLimits: {
					...state.sessions.expandedGroupLimits,
					[cwd]: limit,
				},
			},
		})),

	setProjectsQuery: (query) =>
		set((state) => ({
			projectsPage: { ...state.projectsPage, query },
		})),

	setProjectsSort: (sort) =>
		set((state) => ({
			projectsPage: { ...state.projectsPage, sort },
		})),

	setModelsQuery: (query) =>
		set((state) => ({
			modelsPage: { ...state.modelsPage, query },
		})),

	setModelsUnpricedOnly: (unpricedOnly) =>
		set((state) => ({
			modelsPage: { ...state.modelsPage, unpricedOnly },
		})),

	setModelsSort: (sort) =>
		set((state) => ({
			modelsPage: { ...state.modelsPage, sort },
		})),

	setHarnessesQuery: (query) =>
		set((state) => ({
			harnessesPage: { ...state.harnessesPage, query },
		})),

	toggleHarnessOpen: (harness) =>
		set((state) => {
			const exists = state.harnessesPage.open.includes(harness);
			const next = exists
				? state.harnessesPage.open.filter((item) => item !== harness)
				: [...state.harnessesPage.open, harness];
			return {
				harnessesPage: { ...state.harnessesPage, open: next },
			};
		}),

	setSessionTurnLimit: (sessionKey, limit) =>
		set((state) => ({
			sessionDetail: {
				...state.sessionDetail,
				turnLimits: {
					...state.sessionDetail.turnLimits,
					[sessionKey]: limit,
				},
			},
		})),

	resetAll: () =>
		set({
			scrollOffsets: {},
			overview: { ...DEFAULT_OVERVIEW },
			explore: { ...DEFAULT_EXPLORE },
			sessions: { ...DEFAULT_SESSIONS },
			projectsPage: { ...DEFAULT_PROJECTS },
			modelsPage: { ...DEFAULT_MODELS },
			harnessesPage: { ...DEFAULT_HARNESSES },
			sessionDetail: { ...DEFAULT_SESSION_DETAIL },
		}),
}));
