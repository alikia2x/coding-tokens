import type {
	GenerationMetrics,
	TurnSummary,
	UsageRecord,
} from "../../shared/types";
import { pairToolItems } from "../tools/normalize";
import type { TranscriptItem, TranscriptSession } from "../transcripts/shared";

export const MAX_STEP_GAP_MS = 10 * 60 * 1000;
export const MAX_TOOL_DURATION_MS = 30 * 60 * 1000;
export const MAX_TTFT_MS = 5 * 60 * 1000;
export const MIN_RELIABLE_TTFT_MS = 150;
export const MIN_MODEL_DURATION_FOR_TPS_MS = 500;

// Only harnesses whose transcript items record real streaming/output timestamps
// (rather than pre-LLM message-row creation times) can yield meaningful TTFT.
const RELIABLE_TTFT_HARNESSES = new Set(["codex", "claude", "dsh"]);

interface TimedTurnEntry {
	timestamp: number;
	turnId: string;
}

function buildSortedUserTurns(
	users: readonly TranscriptItem[],
): TimedTurnEntry[] {
	const entries: TimedTurnEntry[] = [];
	for (const user of users) {
		if (user.timestamp !== null && Number.isFinite(user.timestamp)) {
			entries.push({ timestamp: user.timestamp, turnId: user.turnId });
		}
	}
	entries.sort((a, b) => a.timestamp - b.timestamp);
	return entries;
}

function latestUserTurnAtOrBefore(
	sortedUsers: readonly TimedTurnEntry[],
	timestamp: number,
): string | null {
	let lo = 0;
	let hi = sortedUsers.length - 1;
	let best = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const entry = sortedUsers[mid];
		if (!entry) break;
		if (entry.timestamp <= timestamp) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best >= 0 ? (sortedUsers[best]?.turnId ?? null) : null;
}

function firstItemAfterOrder(
	sortedTurnItems: readonly TranscriptItem[],
	order: number,
): TranscriptItem | undefined {
	let lo = 0;
	let hi = sortedTurnItems.length - 1;
	let best = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const item = sortedTurnItems[mid];
		if (!item) break;
		if (item.order > order) {
			best = mid;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	return best >= 0 ? sortedTurnItems[best] : undefined;
}

export function turnForRecord(
	record: UsageRecord,
	users: TranscriptItem[],
	knownTurns: ReadonlySet<string>,
): string {
	if (record.turnId && knownTurns.has(record.turnId)) return record.turnId;
	if (record.timestamp !== null) {
		let latest: TranscriptItem | undefined;
		for (const user of users) {
			if (user.timestamp !== null && user.timestamp <= record.timestamp)
				latest = user;
		}
		if (latest) return latest.turnId;
	}
	if (record.turnId) return record.turnId;
	return users.at(-1)?.turnId ?? "untracked";
}

export function mergeIntervals(intervals: Array<[number, number]>): number {
	const valid = intervals
		.filter(
			([start, end]) =>
				Number.isFinite(start) && Number.isFinite(end) && end > start,
		)
		.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	if (!valid.length) return 0;

	let total = 0;
	let [curStart, curEnd] = valid[0] as [number, number];
	for (let i = 1; i < valid.length; i += 1) {
		const [start, end] = valid[i] as [number, number];
		if (start <= curEnd) {
			curEnd = Math.max(curEnd, end);
		} else {
			total += curEnd - curStart;
			curStart = start;
			curEnd = end;
		}
	}
	total += curEnd - curStart;
	return total;
}

export function computeToolCallDurations(
	items: readonly TranscriptItem[],
): Map<TranscriptItem, number> {
	const durations = new Map<TranscriptItem, number>();
	const sortedItems = [...items].sort(
		(left, right) => left.order - right.order,
	);
	const timedItemsByTurn = new Map<string, TranscriptItem[]>();
	for (const item of sortedItems) {
		if (item.timestamp !== null && Number.isFinite(item.timestamp)) {
			const list = timedItemsByTurn.get(item.turnId) ?? [];
			list.push(item);
			timedItemsByTurn.set(item.turnId, list);
		}
	}

	for (const pair of pairToolItems(sortedItems)) {
		if (pair.call.kind !== "tool_call") continue;
		const start = pair.call.timestamp;
		if (start === null || !Number.isFinite(start)) continue;

		let end: number | null = null;
		for (const result of pair.results) {
			const ts = result.timestamp;
			if (ts !== null && Number.isFinite(ts) && ts >= start) {
				if (end === null || ts > end) end = ts;
			}
		}

		if (end !== null && end > start) {
			if (end - start <= MAX_TOOL_DURATION_MS) {
				durations.set(pair.call, end - start);
			}
			continue;
		}

		// Fallback when tool_result shares the exact start timestamp or lacks one:
		// measure until the immediately following assistant/tool item in the same turn.
		const canFallback =
			end === start ||
			(end === null &&
				pair.results.every((result) => result.timestamp === null));
		if (!canFallback) continue;

		const lastOrder = pair.results.at(-1)?.order ?? pair.call.order;
		const turnTimedItems = timedItemsByTurn.get(pair.call.turnId);
		const nextItem = turnTimedItems
			? firstItemAfterOrder(turnTimedItems, lastOrder)
			: undefined;
		if (
			nextItem &&
			(nextItem.role === "assistant" || nextItem.role === "tool") &&
			nextItem.timestamp !== null &&
			nextItem.timestamp > start &&
			nextItem.timestamp - start <= MAX_TOOL_DURATION_MS
		) {
			durations.set(pair.call, nextItem.timestamp - start);
		}
	}

	return durations;
}

function median(sorted: readonly number[]): number | null {
	if (!sorted.length) return null;
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return Math.round(sorted[mid] ?? 0);
	}
	const left = sorted[mid - 1] ?? 0;
	const right = sorted[mid] ?? 0;
	return Math.round((left + right) / 2);
}

function computeTurnActiveDuration(timestamps: readonly number[]): number {
	if (timestamps.length < 2) return 0;
	let active = 0;
	for (let i = 1; i < timestamps.length; i += 1) {
		const gap = (timestamps[i] as number) - (timestamps[i - 1] as number);
		if (gap > 0 && gap <= MAX_STEP_GAP_MS) {
			active += gap;
		}
	}
	return active;
}

function computeTurnTtft(
	harness: string,
	turnItems: readonly TranscriptItem[],
): number | null {
	if (!RELIABLE_TTFT_HARNESSES.has(harness)) return null;
	const firstUser = turnItems.find(
		(item) =>
			item.role === "user" &&
			item.kind === "message" &&
			item.timestamp !== null &&
			Number.isFinite(item.timestamp),
	);
	if (!firstUser || firstUser.timestamp === null) return null;
	const userTs = firstUser.timestamp;

	let earliest: number | null = null;
	for (const item of turnItems) {
		if (
			item.role !== "user" &&
			item.order > firstUser.order &&
			item.timestamp !== null &&
			Number.isFinite(item.timestamp) &&
			item.timestamp - userTs >= MIN_RELIABLE_TTFT_MS &&
			item.timestamp - userTs <= MAX_TTFT_MS
		) {
			if (earliest === null || item.timestamp < earliest) {
				earliest = item.timestamp;
			}
		}
	}

	return earliest === null ? null : earliest - userTs;
}

export function computeSessionGenerationMetrics(
	session: TranscriptSession,
	records: readonly UsageRecord[],
	turns: readonly TurnSummary[],
): {
	turns: TurnSummary[];
	toolDurations: Map<TranscriptItem, number>;
	metrics: GenerationMetrics;
} {
	const toolDurations = computeToolCallDurations(session.items);
	const knownTurns = new Set(session.items.map((item) => item.turnId));
	const users = session.items.filter(
		(item) => item.role === "user" && item.kind === "message",
	);
	const sortedUserTurns = buildSortedUserTurns(users);
	const fallbackTurnId = users.at(-1)?.turnId ?? "untracked";

	const itemsByTurn = new Map<string, TranscriptItem[]>();
	for (const item of session.items) {
		const list = itemsByTurn.get(item.turnId) ?? [];
		list.push(item);
		itemsByTurn.set(item.turnId, list);
	}

	const recordsByTurn = new Map<string, UsageRecord[]>();
	for (const record of records) {
		let turnId: string;
		if (record.turnId && knownTurns.has(record.turnId)) {
			turnId = record.turnId;
		} else if (record.timestamp !== null && sortedUserTurns.length > 0) {
			turnId =
				latestUserTurnAtOrBefore(sortedUserTurns, record.timestamp) ??
				record.turnId ??
				fallbackTurnId;
		} else {
			turnId = record.turnId ?? fallbackTurnId;
		}
		const list = recordsByTurn.get(turnId) ?? [];
		list.push(record);
		recordsByTurn.set(turnId, list);
	}

	const updatedTurns: TurnSummary[] = turns.map((turn) => {
		const turnItems = (itemsByTurn.get(turn.id) ?? []).sort(
			(left, right) => left.order - right.order,
		);
		const turnRecords = recordsByTurn.get(turn.id) ?? [];

		const timestamps = [
			...turnItems
				.map((item) => item.timestamp)
				.filter(
					(value): value is number => value !== null && Number.isFinite(value),
				),
			...turnRecords
				.map((record) => record.timestamp)
				.filter(
					(value): value is number => value !== null && Number.isFinite(value),
				),
		].sort((left, right) => left - right);

		const activeTurnDurationMs = computeTurnActiveDuration(timestamps);
		const durationMs = activeTurnDurationMs > 0 ? activeTurnDurationMs : null;

		const toolIntervals: Array<[number, number]> = [];
		for (const item of turnItems) {
			if (item.kind !== "tool_call") continue;
			const toolMs = toolDurations.get(item);
			if (
				toolMs !== undefined &&
				toolMs > 0 &&
				item.timestamp !== null &&
				Number.isFinite(item.timestamp)
			) {
				toolIntervals.push([item.timestamp, item.timestamp + toolMs]);
			}
		}

		const rawToolDuration = toolIntervals.length
			? mergeIntervals(toolIntervals)
			: null;
		const toolDurationMs =
			rawToolDuration !== null
				? durationMs !== null
					? Math.min(rawToolDuration, durationMs)
					: rawToolDuration
				: null;

		const modelDurationMs =
			durationMs !== null
				? Math.max(0, durationMs - (toolDurationMs ?? 0))
				: null;

		const ttftMs = computeTurnTtft(session.harness, turnItems);

		const tokensPerSecond =
			modelDurationMs !== null &&
			modelDurationMs >= MIN_MODEL_DURATION_FOR_TPS_MS &&
			turn.totals.outputTokens > 0
				? Number(
						(turn.totals.outputTokens / (modelDurationMs / 1000)).toFixed(1),
					)
				: null;

		return {
			...turn,
			durationMs,
			ttftMs,
			modelDurationMs,
			toolDurationMs,
			tokensPerSecond,
		};
	});

	const ttftValues = updatedTurns
		.map((turn) => turn.ttftMs)
		.filter((value): value is number => value !== null && value !== undefined)
		.sort((left, right) => left - right);

	const avgTtftMs = ttftValues.length
		? Math.round(
				ttftValues.reduce((sum, value) => sum + value, 0) / ttftValues.length,
			)
		: null;
	const p50TtftMs = median(ttftValues);

	const modelDurations = updatedTurns
		.map((turn) => turn.modelDurationMs)
		.filter((value): value is number => value !== null && value !== undefined);
	const modelDurationMs = modelDurations.length
		? modelDurations.reduce((sum, value) => sum + value, 0)
		: null;

	const turnToolDurations = updatedTurns
		.map((turn) => turn.toolDurationMs)
		.filter((value): value is number => value !== null && value !== undefined);
	const toolDurationMs = turnToolDurations.length
		? turnToolDurations.reduce((sum, value) => sum + value, 0)
		: null;

	const measuredToolValues = [...toolDurations.values()].filter(
		(value) => value > 0,
	);
	const measuredToolCalls = measuredToolValues.length;
	const avgToolDurationMs =
		measuredToolCalls > 0
			? Math.round(
					measuredToolValues.reduce((sum, value) => sum + value, 0) /
						measuredToolCalls,
				)
			: null;

	const qualifyingTurns = updatedTurns.filter(
		(turn) =>
			turn.modelDurationMs !== null &&
			turn.modelDurationMs !== undefined &&
			turn.modelDurationMs >= MIN_MODEL_DURATION_FOR_TPS_MS &&
			turn.totals.outputTokens > 0,
	);
	let tokensPerSecond: number | null = null;
	if (qualifyingTurns.length) {
		const totalOutput = qualifyingTurns.reduce(
			(sum, turn) => sum + turn.totals.outputTokens,
			0,
		);
		const totalModelMs = qualifyingTurns.reduce(
			(sum, turn) => sum + (turn.modelDurationMs ?? 0),
			0,
		);
		if (totalModelMs >= MIN_MODEL_DURATION_FOR_TPS_MS && totalOutput > 0) {
			tokensPerSecond = Number(
				(totalOutput / (totalModelMs / 1000)).toFixed(1),
			);
		}
	}

	const measuredTurns = updatedTurns.filter(
		(turn) =>
			(turn.ttftMs !== null && turn.ttftMs !== undefined) ||
			(turn.modelDurationMs !== null && turn.modelDurationMs !== undefined),
	).length;

	return {
		turns: updatedTurns,
		toolDurations,
		metrics: {
			avgTtftMs,
			p50TtftMs,
			tokensPerSecond,
			modelDurationMs,
			toolDurationMs,
			measuredToolCalls,
			avgToolDurationMs,
			measuredTurns,
		},
	};
}
