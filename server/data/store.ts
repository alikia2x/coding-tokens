import { homedir } from "node:os";
import path from "node:path";
import { normalizeModelName } from "@shared/models";
import type {
	HarnessInfo,
	HarnessName,
	SessionSummary,
	SourceResult,
	StatusPayload,
	UsageRecord,
	UsageTotals,
} from "@shared/types";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	HARNESS_LABELS,
	HARNESS_NAMES,
} from "@shared/types";
import { enrichWithModelsDev } from "../../src/pricing/modelsdev";
import { readAntigravity } from "../../src/sources/antigravity";
import { readCodex } from "../../src/sources/codex";
import { readCommandCode } from "../../src/sources/commandcode";
import { readDsh } from "../../src/sources/dsh";
import { readOpenCode } from "../../src/sources/opencode";
import {
	buildSessionCatalog,
	codexFallbackSource,
	type SessionMeta,
} from "./catalog";
import {
	openStoreDatabase,
	readHarnessRecords,
	readSessionMessages,
	readSettingRows,
	readSourceState,
	replaceHarnessMessages,
	replaceHarnessRecords,
	writeSetting,
} from "./database";
import { sourceFingerprint } from "./fingerprints";
import { harnessPaths } from "./paths";
import {
	emptyTotals,
	recordMatches,
	sessionKey,
	summarizeSessionRecords,
} from "./totals";

const readers: Record<HarnessName, () => SourceResult> = {
	codex: readCodex,
	dsh: readDsh,
	opencode: readOpenCode,
	commandcode: readCommandCode,
	antigravity: readAntigravity,
};

export interface SessionEntry {
	meta: SessionMeta;
	records: UsageRecord[];
}

export class DataStore {
	private records: UsageRecord[] = [];
	private recordsBySession = new Map<string, UsageRecord[]>();
	private messagesBySession = new Map<string, number>();
	private catalog = new Map<string, SessionMeta>();
	private sources = new Map<HarnessName, SourceResult>();
	private paths = harnessPaths();
	private warnings: string[] = [];
	private indexedAt: number | null = null;
	private durationMs: number | null = null;
	private error: string | null = null;
	private indexing = false;
	private ready = false;
	private phase = "Starting";
	private progress = { completed: 0, total: HARNESS_NAMES.length };
	private refreshPromise: Promise<void> | null = null;
	private dbPath: string =
		process.env.CODING_TOKENS_DB ??
		path.join(homedir(), ".cache", "coding-tokens", "coding-tokens.sqlite");

	configure(options: { dbPath?: string } = {}): void {
		if (options.dbPath) this.dbPath = options.dbPath;
	}

	databasePath(): string {
		return this.dbPath;
	}

	readSettings(): AppSettings {
		const db = openStoreDatabase(this.dbPath);
		this.messagesBySession = readSessionMessages(db);
		try {
			const row = readSettingRows(db).app_settings;
			if (!row) return { ...DEFAULT_SETTINGS };
			const parsed = JSON.parse(row) as Partial<AppSettings>;
			return { ...DEFAULT_SETTINGS, ...parsed };
		} catch {
			return { ...DEFAULT_SETTINGS };
		} finally {
			db.close();
		}
	}

	writeSettings(partial: Partial<AppSettings>): AppSettings {
		const db = openStoreDatabase(this.dbPath);
		this.messagesBySession = readSessionMessages(db);
		try {
			const current = this.readSettings();
			const next = { ...current, ...partial };
			writeSetting(db, "app_settings", JSON.stringify(next));
			return next;
		} finally {
			db.close();
		}
	}

	start(): Promise<void> {
		if (!this.refreshPromise) this.refreshPromise = this.refresh();
		return this.refreshPromise;
	}

	get isReady(): boolean {
		return this.ready;
	}

	async ensureReady(): Promise<void> {
		if (this.ready) return;
		await this.start();
		if (!this.ready)
			throw new Error(this.error ?? "Usage data has not been indexed yet");
	}

	status(): StatusPayload {
		return {
			ready: this.ready,
			indexing: this.indexing,
			phase: this.phase,
			progress: this.progress,
			indexedAt: this.indexedAt,
			durationMs: this.durationMs,
			error: this.error,
			totals: {
				sessions: this.recordsBySession.size,
				records: this.records.length,
			},
			harnesses: this.harnessInfo(),
			warnings: this.warnings,
		};
	}

	private harnessInfo(): HarnessInfo[] {
		return HARNESS_NAMES.map((harness) => {
			const source = this.sources.get(harness);
			const sessionCount = this.recordsBySession.size
				? [...this.recordsBySession.keys()].filter((key) =>
						key.startsWith(`${harness}:`),
					).length
				: 0;
			return {
				harness,
				label: HARNESS_LABELS[harness],
				available: source?.available ?? false,
				records: source?.records.length ?? 0,
				sessions: sessionCount,
				paths: this.paths[harness],
				warnings: source?.warnings ?? [],
			};
		});
	}

	async refresh(): Promise<void> {
		if (this.indexing) return this.refreshPromise ?? Promise.resolve();
		this.indexing = true;
		this.error = null;
		this.phase = "Opening local index";
		this.progress = { completed: 0, total: HARNESS_NAMES.length };
		const startedAt = Date.now();
		const collected: SourceResult[] = [];
		const nextSources = new Map<HarnessName, SourceResult>();
		const changed: Array<{
			harness: HarnessName;
			result: SourceResult;
			fingerprint: string;
		}> = [];
		const db = openStoreDatabase(this.dbPath);
		this.messagesBySession = readSessionMessages(db);
		try {
			for (const [index, harness] of HARNESS_NAMES.entries()) {
				this.progress = {
					completed: index,
					total: HARNESS_NAMES.length,
				};
				const fingerprint = sourceFingerprint(harness);
				const state = readSourceState(db, harness);
				if (state && state.fingerprint === fingerprint) {
					this.phase = `Loading ${HARNESS_LABELS[harness]}`;
					const result: SourceResult = {
						harness,
						records: readHarnessRecords(db, harness),
						warnings: parseWarnings(state.warnings),
						available: state.available === 1,
						messages: new Map(),
					};
					collected.push(result);
					nextSources.set(harness, result);
					continue;
				}
				this.phase = `Reading ${HARNESS_LABELS[harness]}`;
				const result = readers[harness]();
				collected.push(result);
				nextSources.set(harness, result);
				changed.push({ harness, result, fingerprint });
			}
			this.progress = {
				completed: HARNESS_NAMES.length,
				total: HARNESS_NAMES.length,
			};
			const records = collected.flatMap((source) => source.records);
			const changedRecords = changed.flatMap((item) => item.result.records);
			let pricingWarning: string | null = null;
			if (changedRecords.length) {
				this.phase = "Matching model prices";
				pricingWarning = await enrichWithModelsDev(changedRecords);
			}
			for (const record of records) {
				record.model = normalizeModelName(record.model);
			}
			if (changed.length) {
				this.phase = "Saving local index";
				for (const item of changed) {
					replaceHarnessRecords(db, item.harness, item.result.records, {
						fingerprint: item.fingerprint,
						indexedAt: Date.now(),
						available: item.result.available ? 1 : 0,
						warnings: JSON.stringify(item.result.warnings),
					});
					replaceHarnessMessages(db, item.harness, item.result.messages);
				}
				this.messagesBySession = readSessionMessages(db);
			}
			this.phase = "Building session index";
			const catalog = buildSessionCatalog(records);
			const recordsBySession = new Map<string, UsageRecord[]>();
			for (const record of records) {
				const key = sessionKey(record);
				const list = recordsBySession.get(key) ?? [];
				list.push(record);
				recordsBySession.set(key, list);
			}
			this.records = records;
			this.recordsBySession = recordsBySession;
			this.catalog = catalog.entries;
			this.sources = nextSources;
			this.paths = harnessPaths();
			this.warnings = [
				...collected.flatMap((source) => source.warnings),
				...(pricingWarning ? [pricingWarning] : []),
				...catalog.warnings,
			];
			this.indexedAt = Date.now();
			this.durationMs = this.indexedAt - startedAt;
			this.ready = true;
			this.phase = "Ready";
		} catch (error) {
			this.error = String(error);
			this.phase = "Failed";
			if (!this.ready) this.ready = false;
		} finally {
			db.close();
			this.indexing = false;
			this.refreshPromise = null;
			this.progress = {
				completed: HARNESS_NAMES.length,
				total: HARNESS_NAMES.length,
			};
		}
	}

	allRecords(): readonly UsageRecord[] {
		return this.records;
	}

	allSessions(): ReadonlyMap<string, UsageRecord[]> {
		return this.recordsBySession;
	}

	catalogEntries(): ReadonlyMap<string, SessionMeta> {
		return this.catalog;
	}

	source(harness: HarnessName): SourceResult | undefined {
		return this.sources.get(harness);
	}

	sourcePaths(): Record<HarnessName, string[]> {
		return this.paths;
	}

	warningList(): string[] {
		return this.warnings;
	}

	lastIndexedAt(): number | null {
		return this.indexedAt;
	}

	sessionEntry(key: string): SessionEntry | null {
		const meta = this.catalog.get(key);
		if (!meta) return null;
		return {
			meta,
			records: this.recordsBySession.get(key) ?? [],
		};
	}

	ensureSessionSource(entry: SessionEntry): SessionMeta {
		if (entry.meta.source || entry.meta.harness !== "codex") return entry.meta;
		const fallback = codexFallbackSource(entry.meta.sessionId);
		if (!fallback) return entry.meta;
		const meta = {
			...entry.meta,
			source: fallback,
			hasTranscript: true,
		};
		entry.meta = meta;
		this.catalog.set(entry.meta.key, meta);
		return meta;
	}

	summarize(
		meta: SessionMeta,
		records: UsageRecord[],
		_range: { from: number | null; until: number | null },
	): SessionSummary {
		const totals = summarizeSessionRecords(records);
		totals.messages = this.messagesBySession.get(meta.key) ?? 0;
		const timestamps = records
			.map((record) => record.timestamp)
			.filter((value): value is number => value !== null);
		const lastActivityAt = timestamps.length ? Math.max(...timestamps) : null;
		const recordedStart = timestamps.length ? Math.min(...timestamps) : null;
		const startedAt =
			meta.startedAt === null || meta.startedAt === undefined
				? recordedStart
				: recordedStart === null
					? meta.startedAt
					: Math.min(meta.startedAt, recordedStart);
		const models = [...new Set(records.map((record) => record.model))];
		return {
			key: meta.key,
			harness: meta.harness,
			sessionId: meta.sessionId,
			title: meta.title,
			cwd: meta.cwd,
			projectName: projectNameFor(meta.cwd),
			models,
			startedAt,
			lastActivityAt,
			durationMs:
				startedAt !== null && lastActivityAt !== null
					? Math.max(0, lastActivityAt - startedAt)
					: null,
			totals,
			isSubagent: meta.isSubagent,
			isReview: meta.isReview,
			hasTranscript: meta.hasTranscript,
		};
	}

	messagesFor(records: readonly UsageRecord[]): number {
		const keys = new Set(records.map((record) => sessionKey(record)));
		let total = 0;
		for (const key of keys) total += this.messagesBySession.get(key) ?? 0;
		return total;
	}

	sessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): SessionSummary[] {
		const summaries: SessionSummary[] = [];
		for (const meta of this.catalog.values()) {
			const records = this.recordsBySession.get(meta.key) ?? [];
			const ranged = records.filter((record) => recordMatches(record, range));
			const inRange =
				ranged.length > 0 ||
				(meta.startedAt !== null &&
					meta.startedAt !== undefined &&
					(range.from === null || meta.startedAt >= range.from) &&
					(range.until === null || meta.startedAt < range.until));
			if (!inRange) continue;
			summaries.push(this.summarize(meta, ranged, range));
		}
		summaries.sort(
			(left, right) =>
				(right.lastActivityAt ?? right.startedAt ?? 0) -
				(left.lastActivityAt ?? left.startedAt ?? 0),
		);
		return summaries;
	}

	totalsFor(records: readonly UsageRecord[]): UsageTotals {
		const totals = emptyTotals();
		for (const record of records) {
			totals.requests += 1;
			totals.inputTokens += record.inputTokens;
			totals.outputTokens += record.outputTokens;
			totals.cacheReadTokens += record.cacheReadTokens;
			totals.cacheWriteTokens += record.cacheWriteTokens;
			totals.reasoningTokens += record.reasoningTokens;
			if (record.costUsd === null) totals.unpricedRequests += 1;
			else {
				totals.costUsd += record.costUsd;
				if (record.costEstimated) totals.estimatedRequests += 1;
			}
		}
		totals.costUsd = Number(totals.costUsd.toFixed(8));
		return totals;
	}
}

export function projectNameFor(cwd: string | null): string {
	if (!cwd) return "Unknown project";
	const normalized = cwd.replace(/\/+$/u, "");
	const name = normalized.split("/").at(-1);
	return name || normalized;
}

export const store = new DataStore();

function parseWarnings(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}
