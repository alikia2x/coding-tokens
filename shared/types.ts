/**
 * Currently active built-in harness names for backward compatibility and enumeration.
 */
export const BUILTIN_HARNESS_NAMES = [
	"codex",
	"dsh",
	"opencode",
	"commandcode",
	"antigravity",
] as const;

export type BuiltinHarnessName = (typeof BUILTIN_HARNESS_NAMES)[number];

/**
 * Union of all known built-in and planned mainstream harnesses.
 * Provides IDE autocompletion while allowing open string extension.
 */
export type KnownHarnessName =
	| BuiltinHarnessName
	| "claude"
	| "cline"
	| "roo"
	| "continue"
	| "cursor"
	| "copilot"
	| "aider"
	| "windsurf"
	| "goose"
	| "openhands";

/**
 * Open harness identifier allowing dynamic plugins and future harnesses
 * while retaining IDE autocompletion for known harnesses.
 */
export type HarnessId = KnownHarnessName | (string & {});

/**
 * Backward-compatible harness name type, widened to open HarnessId.
 */
export type HarnessName = HarnessId;

/**
 * Currently active built-in harness names for backward compatibility.
 */
export const HARNESS_NAMES = BUILTIN_HARNESS_NAMES;

/**
 * Core harness metadata model conforming to HarnessProvider plugin interface.
 */
export interface HarnessMetadata {
	id: HarnessId;
	displayName: string;
	shortLabel: string;
	color: string;
	description?: string;
	defaultEnabled?: boolean;
}

export {
	getHarnessLabel,
	getHarnessShortLabel,
	HARNESS_LABELS,
	HARNESS_SHORT_LABELS,
} from "./colors";

export interface UsageRecord {
	harness: HarnessName;
	sessionId: string;
	messageId: string;
	turnId?: string;
	/** Marks usage recorded by a subagent. */
	isSubagent?: boolean;
	/** Marks internal review traffic such as Codex guardian reviews. */
	isReview?: boolean;
	cwd: string | null;
	model: string;
	/** Provider-qualified model id kept for price matching. Not persisted. */
	pricingModel?: string | null;
	timestamp: number | null;
	inputTokens: number;
	/** Includes reasoning tokens. */
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** A breakdown of outputTokens, not an additional token count. */
	reasoningTokens: number;
	costUsd: number | null;
	costEstimated: boolean;
}

export interface SourceResult {
	harness: HarnessName;
	records: UsageRecord[];
	warnings: string[];
	available: boolean;
	/** User messages per session id, for top-level sessions only. */
	messages: Map<string, number>;
}

export interface UsageTotals {
	sessions: number;
	messages: number;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
	estimatedRequests: number;
	unpricedRequests: number;
}

export type SessionDetailLevel =
	| "user_only"
	| "chat_compact"
	| "chat"
	| "chat_tools"
	| "agent"
	| "agent_full";

export const SESSION_DETAIL_LEVELS: Array<{
	value: SessionDetailLevel;
	label: string;
	description: string;
}> = [
	{
		value: "user_only",
		label: "detail.user.label",
		description: "detail.user.description",
	},
	{
		value: "chat_compact",
		label: "detail.replies.label",
		description: "detail.replies.description",
	},
	{
		value: "chat",
		label: "detail.chat.label",
		description: "detail.chat.description",
	},
	{
		value: "chat_tools",
		label: "detail.tools.label",
		description: "detail.tools.description",
	},
	{
		value: "agent",
		label: "detail.agent.label",
		description: "detail.agent.description",
	},
	{
		value: "agent_full",
		label: "detail.full.label",
		description: "detail.full.description",
	},
];

export interface SessionSummary {
	key: string;
	harness: HarnessName;
	sessionId: string;
	title: string;
	cwd: string | null;
	projectName: string;
	models: string[];
	startedAt: number | null;
	lastActivityAt: number | null;
	durationMs: number | null;
	totals: UsageTotals;
	isSubagent: boolean;
	isReview: boolean;
	hasTranscript: boolean;
}

export interface UsageBucket {
	key: string;
	label: string;
	start: number;
	end: number;
	totals: UsageTotals;
}

export interface BreakdownRow {
	key: string;
	label: string;
	harness?: HarnessName;
	totals: UsageTotals;
}

export interface ProjectSummary {
	cwd: string | null;
	name: string;
	totals: UsageTotals;
	lastActivityAt: number | null;
	harnesses: HarnessName[];
}

export interface OverviewPayload {
	range: { from: number | null; until: number | null };
	totals: UsageTotals;
	previous: UsageTotals | null;
	bucketUnit: "hour" | "day" | "week";
	buckets: UsageBucket[];
	harnesses: BreakdownRow[];
	models: BreakdownRow[];
	projects: ProjectSummary[];
	recentSessions: SessionSummary[];
	warnings: string[];
	indexedAt: number | null;
}

export interface SessionsPayload {
	sessions: SessionSummary[];
	indexedAt: number | null;
	warnings: string[];
}

export interface HeatmapDay {
	date: string;
	start: number;
	requests: number;
	tokens: number;
	costUsd: number;
	sessions: number;
}

export interface HeatmapPayload {
	from: number;
	until: number;
	days: HeatmapDay[];
	totals: {
		requests: number;
		tokens: number;
		costUsd: number;
		sessions: number;
	};
	maxTokens: number;
}

export interface ProjectReportRow extends ProjectSummary {
	sparkline: number[];
	models: string[];
}

export interface ProjectReportPayload {
	rows: ProjectReportRow[];
	totals: UsageTotals;
	warnings: string[];
}

export interface ModelReportRow {
	model: string;
	provider: string | null;
	harnesses: HarnessName[];
	totals: UsageTotals;
	lastActivityAt: number | null;
	costPerMillionTokens: number | null;
	cacheReadShare: number | null;
	sparkline: number[];
}

export interface ModelReportPayload {
	rows: ModelReportRow[];
	totals: UsageTotals;
	warnings: string[];
}

export interface HarnessReportRow {
	harness: HarnessName;
	label: string;
	color?: string;
	available: boolean;
	paths: string[];
	warnings: string[];
	totals: UsageTotals;
	costShare: number;
	tokenShare: number;
	topModels: Array<{ model: string; costUsd: number; tokens: number }>;
	sparkline: number[];
}

export interface HarnessReportPayload {
	rows: HarnessReportRow[];
	totals: UsageTotals;
	warnings: string[];
	indexedAt: number | null;
}

export interface HarnessInfo {
	harness: HarnessName;
	label: string;
	color?: string;
	available: boolean;
	records: number;
	sessions: number;
	paths: string[];
	warnings: string[];
}

export interface StatusPayload {
	ready: boolean;
	indexing: boolean;
	phase: string;
	progress: { completed: number; total: number };
	indexedAt: number | null;
	durationMs: number | null;
	error: string | null;
	totals: { sessions: number; records: number };
	harnesses: HarnessInfo[];
	warnings: string[];
}

export type ToolVerb =
	| "read"
	| "search"
	| "find"
	| "list"
	| "edit"
	| "write"
	| "command"
	| "webSearch"
	| "fetchUrl"
	| "openPage"
	| "subagent"
	| "mcp"
	| "todo"
	| "question"
	| "plan"
	| "skill"
	| "other";

export interface ToolOperation {
	verb: ToolVerb;
	rawName: string;
	target: string;
	fullTarget?: string;
	meta?: string;
	errorBadge?: string;
}

export interface DetailItem {
	id: string;
	order: number;
	turnId: string;
	role: "user" | "assistant" | "tool" | "system" | "developer" | "other";
	kind: "message" | "tool_call" | "tool_result" | "other";
	phase: "final" | "intermediate" | "unknown";
	text: string | null;
	name: string | null;
	inputText: string | null;
	outputText: string | null;
	toolCallId: string | null;
	category: "command" | "read" | "write" | "other" | null;
	status: string | null;
	operations?: ToolOperation[];
	timestamp: number | null;
	truncated: boolean;
}

export interface TurnSummary {
	id: string;
	index: number;
	startedAt: number | null;
	endedAt: number | null;
	requests: number;
	totals: UsageTotals;
	models: string[];
}

export interface SessionDetailPayload {
	summary: SessionSummary;
	stats: SessionStats;
	level: SessionDetailLevel;
	items: DetailItem[];
	turns: TurnSummary[];
	totalItems: number;
	truncated: boolean;
	warnings: string[];
}

export interface SearchSessionResult {
	key: string;
	harness: HarnessName;
	sessionId: string;
	title: string;
	projectName: string;
	cwd: string | null;
	models: string[];
	lastActivityAt: number | null;
	costUsd: number;
	score: number;
	snippet?: string | null;
}

export interface SessionsSearchPayload {
	query: string;
	keys: string[];
	snippets: Record<string, string>;
}

export interface SearchPayload {
	query: string;
	sessions: SearchSessionResult[];
	projects: Array<{
		cwd: string | null;
		name: string;
		sessions: number;
		costUsd: number;
	}>;
	models: Array<{ model: string; costUsd: number; requests: number }>;
	harnesses: Array<{ harness: HarnessName; sessions: number; costUsd: number }>;
}

export interface ApiError {
	error: string;
}

export type ExploreMetric = "tokens" | "cost" | "requests" | "sessions";
export type ExploreDimension = "harness" | "project" | "model";
export type ExploreBreakdown = ExploreDimension | "none";
export type ExploreBucket = "hour" | "day" | "week" | "month";
export type ExploreMode = "time" | "dimension";

export interface ExplorePoint {
	label: string;
	value: number;
}

export interface ExploreSeries {
	key: string;
	label: string;
	points: ExplorePoint[];
	totals: UsageTotals;
}

export interface ExploreRow {
	key: string;
	label: string;
	totals: UsageTotals;
}

export interface ExplorePayload {
	from: number | null;
	until: number | null;
	mode: ExploreMode;
	metric: ExploreMetric;
	dimension: ExploreDimension;
	bucket: ExploreBucket;
	breakdown: ExploreBreakdown;
	series: ExploreSeries[];
	rows: ExploreRow[];
	totals: UsageTotals;
	xLabels: string[];
	starts: number[];
}

export interface SessionModelUsage {
	model: string;
	totals: UsageTotals;
}

export interface SessionStats {
	turns: number;
	toolCalls: number;
	commandCalls: number;
	readCalls: number;
	writeCalls: number;
	otherCalls: number;
	models: SessionModelUsage[];
}

export type AppLocale = "en" | "zh-CN";

export interface AppSettings {
	theme: "light" | "dark" | "system";
	locale: AppLocale;
	defaultRange: string;
	defaultDetailLevel: SessionDetailLevel;
	includeInternal: boolean;
	exploreMode: ExploreMode;
	exploreMetric: ExploreMetric;
	exploreDimension: ExploreDimension;
	exploreBucket: ExploreBucket;
	exploreBreakdown: ExploreBreakdown;
	exploreChart: "bar" | "line" | "area";
	autoRefreshMinutes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
	theme: "system",
	locale: "en",
	defaultRange: "30d",
	defaultDetailLevel: "chat",
	includeInternal: false,
	exploreMode: "time",
	exploreMetric: "cost",
	exploreDimension: "model",
	exploreBucket: "day",
	exploreBreakdown: "harness",
	exploreChart: "line",
	autoRefreshMinutes: 0,
};
