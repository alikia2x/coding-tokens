import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../../src/platform/paths";
import {
	defaultHarnessRegistry,
	type HarnessRegistry,
} from "../../src/providers/registry";
import {
	defaultStorageService,
	type StorageService,
} from "../../src/services/storage";
import {
	defaultTranscriptService,
	type TranscriptService,
} from "../../src/services/transcripts";
import type {
	HarnessId,
	SearchPayload,
	SessionDetailLevel,
	SessionDetailPayload,
	SessionMeta,
	SessionSummary,
	SessionsSearchPayload,
	UsageRecord,
} from "../../src/types";
import { buildSessionCatalog, cleanSessionTitle } from "../data/catalog";
import {
	type SearchDataSource,
	searchPayload,
	sessionSearchMatches,
} from "../data/search";
import {
	appendAll,
	projectName,
	recordMatches,
	sessionKey,
	summarizeSessionRecords,
	timestampBounds,
} from "../data/totals";

export interface CatalogRefreshResult {
	refreshedCount: number;
	totalSessions: number;
	durationMs: number;
	warnings: string[];
}

export interface SessionCatalogService {
	init(): Promise<void>;
	refresh(
		harnessId?: HarnessId,
		force?: boolean,
	): Promise<CatalogRefreshResult>;
	getCatalog(): Promise<SessionMeta[]>;
	getSessionEntry(key: string): Promise<SessionMeta | null>;
	getSessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): Promise<SessionSummary[]>;
	getSessionDetail(
		harness: HarnessId,
		sessionId: string,
		level?: SessionDetailLevel,
	): Promise<SessionDetailPayload | null>;
	search(query: string, limit?: number): Promise<SearchPayload>;
	searchSessions(
		query: string,
		range?: { from: number | null; until: number | null },
	): Promise<SessionsSearchPayload>;
}

export class DefaultSessionCatalogService implements SessionCatalogService {
	private catalog = new Map<string, SessionMeta>();
	private warnings: string[] = [];
	private initialized = false;

	constructor(
		private readonly storage: StorageService = defaultStorageService,
		private readonly registry: HarnessRegistry = defaultHarnessRegistry,
		private readonly transcripts: TranscriptService = defaultTranscriptService,
		private readonly paths: PlatformPathService = defaultPlatformPathService,
	) {}

	async init(): Promise<void> {
		if (this.initialized) return;
		if (!this.storage.isInitialized) {
			await this.storage.init();
		}
		await this.refresh();
		this.initialized = true;
	}

	async refresh(
		harnessId?: HarnessId,
		_force = false,
	): Promise<CatalogRefreshResult> {
		if (!this.storage.isInitialized) {
			await this.storage.init();
		}
		const startedAt = Date.now();
		const warnings: string[] = [];
		const entries = new Map<string, SessionMeta>();

		// 1. Discover sessions from HarnessProviders
		const providers = harnessId
			? [this.registry.get(harnessId)].filter(
					(p): p is NonNullable<typeof p> => p !== undefined,
				)
			: this.registry.getAll();

		for (const provider of providers) {
			try {
				const items = await provider.discoverSessions(this.paths);
				for (const item of items) {
					const key = `${item.harness}:${item.sessionId}`;
					entries.set(key, {
						key,
						harness: item.harness,
						sessionId: item.sessionId,
						title: cleanSessionTitle(null, item.harness),
						cwd: item.cwd ?? null,
						startedAt: item.mtimeMs,
						isSubagent: false,
						isReview: false,
						hasTranscript: true,
						source: { kind: "file", path: item.filePath },
					});
				}
			} catch (error) {
				warnings.push(
					`${provider.metadata.displayName}: discovery failed (${String(error)})`,
				);
			}
		}

		// 2. Correlate with usage records from storage
		const targetHarnesses = new Set(providers.map((p) => p.metadata.id));
		const records = await this.storage.getUsageRecords();
		const fallbackCatalog = buildSessionCatalog(records, targetHarnesses);
		appendAll(warnings, fallbackCatalog.warnings);

		for (const [key, fallbackMeta] of fallbackCatalog.entries) {
			const existing = entries.get(key);
			if (existing) {
				existing.title = fallbackMeta.title || existing.title;
				existing.cwd ??= fallbackMeta.cwd;
				existing.startedAt ??= fallbackMeta.startedAt;
				existing.isSubagent = fallbackMeta.isSubagent || existing.isSubagent;
				existing.isReview = fallbackMeta.isReview || existing.isReview;
			} else {
				entries.set(key, fallbackMeta);
			}
		}

		this.catalog = entries;
		this.warnings = warnings;

		return {
			refreshedCount: entries.size,
			totalSessions: entries.size,
			durationMs: Date.now() - startedAt,
			warnings,
		};
	}

	async getCatalog(): Promise<SessionMeta[]> {
		if (!this.initialized) await this.init();
		return Array.from(this.catalog.values());
	}

	async getSessionEntry(key: string): Promise<SessionMeta | null> {
		if (!this.initialized) await this.init();
		return this.catalog.get(key) ?? null;
	}

	private buildSummaries(
		records: readonly UsageRecord[],
		messages: ReadonlyMap<string, number>,
		range: { from: number | null; until: number | null },
	): SessionSummary[] {
		const bySession = new Map<string, UsageRecord[]>();
		for (const record of records) {
			if (!recordMatches(record, range)) continue;
			const key = sessionKey(record);
			const list = bySession.get(key) ?? [];
			list.push(record);
			bySession.set(key, list);
		}
		const summaries: SessionSummary[] = [];
		for (const meta of this.catalog.values()) {
			const ranged = bySession.get(meta.key);
			if (!ranged?.length) continue;
			const totals = summarizeSessionRecords(ranged);
			totals.messages = messages.get(meta.key) ?? 0;
			const bounds = timestampBounds(ranged);
			const lastActivityAt = bounds?.max ?? null;
			const recordedStart = bounds?.min ?? null;
			const startedAt =
				meta.startedAt === null || meta.startedAt === undefined
					? recordedStart
					: recordedStart === null
						? meta.startedAt
						: Math.min(meta.startedAt, recordedStart);
			summaries.push({
				key: meta.key,
				harness: meta.harness,
				sessionId: meta.sessionId,
				title: meta.title,
				cwd: meta.cwd,
				projectName: projectName(meta.cwd),
				models: [...new Set(ranged.map((record) => record.model))],
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
			});
		}
		summaries.sort(
			(left, right) =>
				(right.lastActivityAt ?? right.startedAt ?? 0) -
				(left.lastActivityAt ?? left.startedAt ?? 0),
		);
		return summaries;
	}

	async getSessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): Promise<SessionSummary[]> {
		if (!this.initialized) await this.init();
		const [records, messages] = await Promise.all([
			this.storage.getUsageRecords(),
			this.storage.getSessionMessages(),
		]);
		return this.buildSummaries(records, messages, range);
	}

	async getSessionDetail(
		harness: HarnessId,
		sessionId: string,
		level: SessionDetailLevel = "chat",
	): Promise<SessionDetailPayload | null> {
		const key = `${harness}:${sessionId}`;
		const meta = await this.getSessionEntry(key);
		if (!meta) return null;
		const records = await this.storage.getUsageRecords({
			harness,
			sessionId,
		});
		return this.transcripts.getSessionDetail(meta, records, level);
	}

	private async buildSearchSource(query: string): Promise<SearchDataSource> {
		if (!this.initialized) await this.init();
		const [records, messages, allTexts] = await Promise.all([
			this.storage.getUsageRecords(),
			this.storage.getSessionMessages(),
			query.trim()
				? this.storage.getAllSessionTexts()
				: Promise.resolve(new Map<string, string>()),
		]);
		return {
			allRecords: () => records,
			sessionSummaries: (range) =>
				this.buildSummaries(records, messages, range),
			searchTextKeysFts: () => null,
			sessionTextsByKeys: (keys) => {
				const hits = new Map<string, string>();
				for (const key of keys) {
					const body = allTexts.get(key);
					if (body !== undefined) hits.set(key, body);
				}
				return hits;
			},
			searchTextsBySubstring: (terms) => {
				const cleanTerms = terms
					.map((t) => t.trim().toLowerCase())
					.filter(Boolean);
				const hits = new Map<string, string>();
				if (!cleanTerms.length) return hits;
				for (const [key, body] of allTexts) {
					const lower = body.toLowerCase();
					if (cleanTerms.some((term) => lower.includes(term))) {
						hits.set(key, body);
					}
				}
				return hits;
			},
			harnessIds: () => this.registry.getAll().map((p) => p.metadata.id),
			harnessLabel: (harness) =>
				this.registry.get(harness)?.metadata.displayName ?? harness,
		};
	}

	async search(query: string, limit = 8): Promise<SearchPayload> {
		const source = await this.buildSearchSource(query);
		return searchPayload(query, limit, source);
	}

	async searchSessions(
		query: string,
		range: { from: number | null; until: number | null } = {
			from: null,
			until: null,
		},
	): Promise<SessionsSearchPayload> {
		const source = await this.buildSearchSource(query);
		return sessionSearchMatches(query, range, source);
	}
}

export function createSessionCatalogService(
	storage?: StorageService,
	registry?: HarnessRegistry,
	transcripts?: TranscriptService,
	paths?: PlatformPathService,
): SessionCatalogService {
	return new DefaultSessionCatalogService(
		storage,
		registry,
		transcripts,
		paths,
	);
}

export const createCatalogService = createSessionCatalogService;

export const defaultSessionCatalogService = new DefaultSessionCatalogService();
