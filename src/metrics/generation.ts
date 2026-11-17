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
export const MIN_MODEL_DURATION_FOR_TPS_MS = 100;

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

	for (const pair of pairToolItems(sortedItems)) {
		if (pair.call.kind !== "tool_call") continue;
		const start = pair.call.timestamp;
		if (start === null || !Number.isFinite(start)) continue;

		const resTimes = pair.results
			.map((result) => result.timestamp)
			.filter(
				(timestamp): timestamp is number =>
					timestamp !== null &&
					Number.isFinite(timestamp) &&
					timestamp >= start,
			);
		const end = resTimes.length ? Math.max(...resTimes) : null;

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
		const nextItem = sortedItems.find(
			(item) =>
				item.turnId === pair.call.turnId &&
				item.order > lastOrder &&
				item.timestamp !== null &&
				Number.isFinite(item.timestamp),
		);
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
	turnItems: readonly TranscriptItem[],
	turnRecords: readonly UsageRecord[],
): number | null {
	const firstUser = turnItems.find(
		(item) =>
			item.role === "user" &&
			item.kind === "message" &&
			item.timestamp !== null &&
			Number.isFinite(item.timestamp),
	);
	if (!firstUser || firstUser.timestamp === null) return null;
	const userTs = firstUser.timestamp;

	const candidateTimestamps: number[] = [];
	for (const item of turnItems) {
		if (
			item.role !== "user" &&
			item.order > firstUser.order &&
			item.timestamp !== null &&
			Number.isFinite(item.timestamp) &&
			item.timestamp > userTs &&
			item.timestamp - userTs <= MAX_TTFT_MS
		) {
			candidateTimestamps.push(item.timestamp);
		}
	}
	for (const record of turnRecords) {
		if (
			record.timestamp !== null &&
			Number.isFinite(record.timestamp) &&
			record.timestamp > userTs &&
			record.timestamp - userTs <= MAX_TTFT_MS
		) {
			candidateTimestamps.push(record.timestamp);
		}
	}

	if (!candidateTimestamps.length) return null;
	return Math.min(...candidateTimestamps) - userTs;
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

	const itemsByTurn = new Map<string, TranscriptItem[]>();
	for (const item of session.items) {
		const list = itemsByTurn.get(item.turnId) ?? [];
		list.push(item);
		itemsByTurn.set(item.turnId, list);
	}

	const recordsByTurn = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const turnId = turnForRecord(record, users, knownTurns);
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

		const ttftMs = computeTurnTtft(turnItems, turnRecords);

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
