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
} from "../../src/types";
import { buildSessionCatalog, cleanSessionTitle } from "../data/catalog";
import { searchPayload, sessionSearchMatches } from "../data/search";
import { store } from "../data/store";

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
		const records = await this.storage.getUsageRecords();
		const fallbackCatalog = buildSessionCatalog(records);
		warnings.push(...fallbackCatalog.warnings);

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

	async getSessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): Promise<SessionSummary[]> {
		await store.ensureReady();
		return store.sessionSummaries(range);
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

	async search(query: string, limit = 8): Promise<SearchPayload> {
		return searchPayload(query, limit);
	}

	async searchSessions(
		query: string,
		range: { from: number | null; until: number | null } = {
			from: null,
			until: null,
		},
	): Promise<SessionsSearchPayload> {
		return sessionSearchMatches(query, range);
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
