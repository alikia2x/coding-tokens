import type {
	DetailItem,
	HarnessName,
	SessionDetailLevel,
	SessionDetailPayload,
	SessionStats,
	TurnSummary,
	UsageRecord,
} from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import {
	codexSessionFiles,
	isInjectedUserMessage,
	readTranscriptSources,
	type TranscriptItem,
	type TranscriptSession,
} from "../../src/transcripts";
import { projectNameFor, store } from "./store";
import { summarizeSessionRecords } from "./totals";

const MAX_MESSAGE = 100_000;
const MAX_TOOL_INPUT = 50_000;
const MAX_TOOL_OUTPUT = 50_000;

function limit(
	value: string | null | undefined,
	max: number,
): {
	text: string | null;
	truncated: boolean;
} {
	if (value === null || value === undefined || value === "") {
		return { text: null, truncated: false };
	}
	if (value.length <= max) return { text: value, truncated: false };
	return {
		text: `${value.slice(0, max)}\n\n[truncated ${value.length - max} characters]`,
		truncated: true,
	};
}

function payloadText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function includeItem(
	harness: HarnessName,
	item: TranscriptItem,
	level: SessionDetailLevel,
): boolean {
	if (item.role === "user" && isInjectedUserMessage(harness, item.text ?? ""))
		return false;
	if (level === "agent_full") return true;
	if (item.kind === "tool_call" || item.kind === "tool_result")
		return level === "chat_tools" || level === "agent";
	if (level === "user_only")
		return item.kind === "message" && item.role === "user";
	if (level === "chat_compact")
		return (
			item.kind === "message" &&
			(item.role === "user" ||
				(item.role === "assistant" && item.phase === "final"))
		);
	return (
		item.kind === "message" &&
		(item.role === "user" || item.role === "assistant")
	);
}

function detailItem(
	item: TranscriptItem,
	level: SessionDetailLevel,
): DetailItem {
	const messageLimit = level === "agent_full" ? MAX_MESSAGE : 50_000;
	const inputLimit =
		level === "agent_full"
			? MAX_TOOL_INPUT
			: level === "agent"
				? 8_000
				: level === "chat_tools"
					? 2_000
					: 0;
	const outputLimit =
		level === "agent_full"
			? MAX_TOOL_OUTPUT
			: level === "agent"
				? 4_000
				: level === "chat_tools"
					? 800
					: 0;
	const text = limit(item.text ?? payloadText(item.output), messageLimit);
	const input =
		inputLimit > 0
			? limit(payloadText(item.input), inputLimit)
			: { text: null, truncated: false };
	const output =
		outputLimit > 0
			? limit(payloadText(item.output) ?? item.text ?? null, outputLimit)
			: { text: null, truncated: false };
	return {
		id: item.id,
		order: item.order,
		turnId: item.turnId,
		role: item.role,
		kind: item.kind,
		phase: item.phase,
		text: text.text,
		name: item.name ?? null,
		inputText: input.text,
		outputText: output.text,
		toolCallId: item.toolCallId ?? null,
		category: item.category ?? null,
		status: item.status ?? null,
		timestamp: item.timestamp,
		truncated: text.truncated || input.truncated || output.truncated,
	};
}

function turnForRecord(
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

function buildTurns(
	session: TranscriptSession,
	records: UsageRecord[],
): TurnSummary[] {
	const knownTurns = new Set(session.items.map((item) => item.turnId));
	const users = session.items.filter(
		(item) => item.role === "user" && item.kind === "message",
	);
	const grouped = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const turnId = turnForRecord(record, users, knownTurns);
		const list = grouped.get(turnId) ?? [];
		list.push(record);
		grouped.set(turnId, list);
	}
	const order = new Map<string, number>();
	for (const item of session.items) {
		if (!order.has(item.turnId)) order.set(item.turnId, item.order);
	}
	const turnIds = [...new Set([...order.keys(), ...grouped.keys()])].sort(
		(left, right) => (order.get(left) ?? 1e9) - (order.get(right) ?? 1e9),
	);
	return turnIds.map((turnId, index) => {
		const turnRecords = grouped.get(turnId) ?? [];
		const items = session.items.filter((item) => item.turnId === turnId);
		const timestamps = [
			...turnRecords
				.map((record) => record.timestamp)
				.filter((value): value is number => value !== null),
			...items
				.map((item) => item.timestamp)
				.filter((value): value is number => value !== null),
		];
		return {
			id: turnId,
			index,
			startedAt: timestamps.length ? Math.min(...timestamps) : null,
			endedAt: timestamps.length ? Math.max(...timestamps) : null,
			requests: turnRecords.length,
			totals: summarizeSessionRecords(turnRecords),
			models: [...new Set(turnRecords.map((record) => record.model))],
		};
	});
}

function emptyStats(): SessionStats {
	return {
		turns: 0,
		toolCalls: 0,
		commandCalls: 0,
		readCalls: 0,
		writeCalls: 0,
		otherCalls: 0,
		models: [],
	};
}

function sessionStats(
	session: TranscriptSession,
	records: UsageRecord[],
	turns: TurnSummary[],
): SessionStats {
	const calls = session.items.filter((item) => item.kind === "tool_call");
	const byModel = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const list = byModel.get(record.model) ?? [];
		list.push(record);
		byModel.set(record.model, list);
	}
	return {
		turns: turns.length,
		toolCalls: calls.length,
		commandCalls: calls.filter((item) => item.category === "command").length,
		readCalls: calls.filter((item) => item.category === "read").length,
		writeCalls: calls.filter((item) => item.category === "write").length,
		otherCalls: calls.filter((item) => item.category === "other").length,
		models: [...byModel.entries()]
			.map(([model, modelRecords]) => ({
				model,
				totals: summarizeSessionRecords(modelRecords),
			}))
			.sort((left, right) => right.totals.costUsd - left.totals.costUsd),
	};
}

function emptyPayload(
	key: string,
	level: SessionDetailLevel,
	warnings: string[],
): SessionDetailPayload {
	const entry = store.sessionEntry(key);
	const records = entry?.records ?? [];
	const summary = entry
		? store.summarize(entry.meta, records, { from: null, until: null })
		: {
				key,
				harness: (key.split(":")[0] ?? "codex") as HarnessName,
				sessionId: key.split(":").slice(1).join(":"),
				title: "Session not found",
				cwd: null,
				projectName: "Unknown project",
				models: [],
				startedAt: null,
				lastActivityAt: null,
				durationMs: null,
				totals: summarizeSessionRecords([]),
				isSubagent: false,
				isReview: false,
				hasTranscript: false,
			};
	return {
		summary,
		stats: emptyStats(),
		level,
		items: [],
		turns: [],
		totalItems: 0,
		truncated: false,
		warnings,
	};
}

export interface SessionTranscript {
	meta: NonNullable<ReturnType<typeof store.sessionEntry>>["meta"];
	records: UsageRecord[];
	session: TranscriptSession;
	warnings: string[];
}

export type SessionTranscriptResult =
	| { ok: true; value: SessionTranscript }
	| { ok: false; warnings: string[] };

export async function loadSessionTranscript(
	key: string,
): Promise<SessionTranscriptResult> {
	await store.ensureReady();
	const entry = store.sessionEntry(key);
	if (!entry) return { ok: false, warnings: ["Session not found"] };
	const meta = store.ensureSessionSource(entry);
	// Codex stores one conversation in multiple rollout segments. The thread's
	// recorded source is only its latest segment, so resolve every segment.
	const paths = new Set<string>();
	if (meta.harness === "codex") {
		for (const filePath of codexSessionFiles(meta.sessionId))
			paths.add(filePath);
	}
	if (meta.source) paths.add(meta.source.path);
	if (!paths.size)
		return {
			ok: false,
			warnings: [
				`${HARNESS_LABELS[meta.harness]}: no transcript file was found`,
			],
		};
	const results = readTranscriptSources([meta.harness], {
		[meta.harness]: paths,
	});
	const result = results[0];
	const warnings = [...(result?.warnings ?? [])];
	const session = result?.sessions.find(
		(candidate) => candidate.sessionId === meta.sessionId,
	);
	if (!session) {
		return {
			ok: false,
			warnings: [
				...warnings,
				`${HARNESS_LABELS[meta.harness]}: transcript could not be read`,
			],
		};
	}
	session.usageRecords = entry.records;
	return {
		ok: true,
		value: { meta, records: entry.records, session, warnings },
	};
}

export async function sessionDetailPayload(
	key: string,
	level: SessionDetailLevel,
): Promise<SessionDetailPayload> {
	const loaded = await loadSessionTranscript(key);
	if (!loaded.ok) return emptyPayload(key, level, loaded.warnings);
	const { meta, records, session, warnings } = loaded.value;
	const turns = buildTurns(session, records);
	const selected = session.items.filter((item) =>
		includeItem(session.harness, item, level),
	);
	const items = selected
		.map((item) => detailItem(item, level))
		.sort((left, right) => left.order - right.order);
	return {
		summary: {
			...store.summarize(meta, records, { from: null, until: null }),
			projectName: projectNameFor(meta.cwd),
			title:
				meta.title !== "Untitled session"
					? meta.title
					: (session.title ?? meta.title),
		},
		stats: sessionStats(session, records, turns),
		level,
		items,
		turns,
		totalItems: session.items.length,
		truncated: items.some((item) => item.truncated),
		warnings,
	};
}
