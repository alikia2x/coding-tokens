import { existsSync } from "node:fs";
import path from "node:path";
import type {
	CustomModelPriceRule,
	HarnessInfo,
	HarnessName,
	ModelPricingMeta,
	PricingCatalogSearchItem,
	PricingCatalogSummary,
	PricingFetchAttempt,
	PricingPayload,
	SessionSummary,
	SourceResult,
	StatusPayload,
	UsageRecord,
	UsageTotals,
} from "@shared/types";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	HARNESS_NAMES,
} from "@shared/types";
import { defaultPlatformPathService } from "../../src/platform/paths";
import {
	applyPricingToRecords,
	buildModelPricingMeta,
	isValidHttpUrl,
	normalizeRuleKey,
	PricingCatalogManager,
	sanitizeCustomRule,
	searchCatalogEntries,
	summarizeActiveModelsPricing,
} from "../../src/pricing/engine";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import { resolveDatabasePath } from "../../src/services/storage";
import type { SessionMeta } from "./catalog";
import {
	openStoreDatabase,
	readAllSourceStates,
	readCatalogMap,
	readHarnessRecords,
	readSessionMessages,
	readSessionTexts,
	readSessionTextsByKeys,
	readSettingRows,
	type StoreDatabase,
	searchSessionTextKeysFts,
	searchSessionTextsBySubstring,
	updateRecordPricingBatch,
	writeSetting,
} from "./database";
import {
	type IndexSyncResult,
	syncHarnessesToDatabase,
	yieldTick,
} from "./index-sync";
import type { IndexWorkerEvent } from "./index-worker";
import { harnessPaths } from "./paths";
import {
	appendAll,
	projectName,
	recordMatches,
	sessionKey,
	summarizeRecords,
	summarizeSessionRecords,
	timestampBounds,
} from "./totals";
import { resolveWorkerCommand } from "./worker-command";

export interface SessionEntry {
	meta: SessionMeta;
	records: UsageRecord[];
}

function groupRecordsBySession(
	records: readonly UsageRecord[],
): Map<string, UsageRecord[]> {
	const map = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = sessionKey(record);
		const list = map.get(key) ?? [];
		list.push(record);
		map.set(key, list);
	}
	return map;
}

export class DataStore {
	private records: UsageRecord[] = [];
	private recordsBySession = new Map<string, UsageRecord[]>();
	private messagesBySession = new Map<string, number>();
	private textsBySession = new Map<string, string>();
	private textsLoaded = false;
	private catalog = new Map<string, SessionMeta>();
	private sources = new Map<HarnessName, SourceResult>();
	private fingerprints = new Map<HarnessName, string>();
	private paths: Record<string, string[]> | null = null;
	private warnings: string[] = [];
	private indexedAt: number | null = null;
	private durationMs: number | null = null;
	private error: string | null = null;
	private indexing = false;
	private ready = false;
	private started = false;
	private phase = "Starting";
	private progress: { completed: number; total: number } = {
		completed: 0,
		total: HARNESS_NAMES.length,
	};
	private refreshPromise: Promise<void> | null = null;
	private refreshQueued = false;
	private generation = 0;
	private db: StoreDatabase | null = null;
	private dbOpenedPath: string | null = null;
	private pricingRefreshInFlight: Promise<{
		payload: PricingPayload;
		attempt: PricingFetchAttempt;
	}> | null = null;
	private dbPath: string = resolveDatabasePath({});
	private desktopPlatform?: string;
	private useIndexWorker = false;
	private skipAutoPricingRefresh = false;
	private pickDirectory?: () => Promise<string | null>;
	private revealPath?: (targetPath: string) => void | Promise<void>;
	private pricingManager = new PricingCatalogManager();
	private pricingLoaded = false;
	private pricingVersion = 0;
	private pricingSummaryCache: {
		version: number;
		indexedAt: number | null;
		recordCount: number;
		summary: PricingCatalogSummary;
	} | null = null;

	private closeDb(): void {
		if (this.db) {
			try {
				this.db.close();
			} catch {}
			this.db = null;
			this.dbOpenedPath = null;
		}
	}

	private getDb(): StoreDatabase {
		if (this.db && this.dbOpenedPath === this.dbPath) {
			return this.db;
		}
		this.closeDb();
		const opened = openStoreDatabase(this.dbPath);
		this.db = opened;
		this.dbOpenedPath = this.dbPath;
		return opened;
	}

	close(): void {
		this.generation += 1;
		this.indexing = false;
		this.refreshPromise = null;
		this.refreshQueued = false;
		this.pricingRefreshInFlight = null;
		this.closeDb();
	}

	configure(
		options: {
			dbPath?: string;
			desktopPlatform?: string;
			useIndexWorker?: boolean;
			skipAutoPricingRefresh?: boolean;
			pickDirectory?: () => Promise<string | null>;
			revealPath?: (targetPath: string) => void | Promise<void>;
		} = {},
	): void {
		if (options.dbPath && options.dbPath !== this.dbPath) {
			this.generation += 1;
			this.closeDb();
			this.dbPath = options.dbPath;
			this.indexing = false;
			this.refreshPromise = null;
			this.refreshQueued = false;
			this.pricingRefreshInFlight = null;
			this.ready = false;
			this.started = false;
			this.error = null;
			this.phase = "Starting";
			this.indexedAt = null;
			this.durationMs = null;
			this.warnings = [];
			this.textsLoaded = false;
			this.pricingLoaded = false;
			this.pricingVersion = 0;
			this.pricingSummaryCache = null;
			this.pricingManager = new PricingCatalogManager();
			this.fingerprints.clear();
			this.sources.clear();
			this.catalog.clear();
			this.records = [];
			this.recordsBySession.clear();
			this.messagesBySession.clear();
			this.textsBySession.clear();
			this.paths = null;
		}
		if (options.desktopPlatform !== undefined) {
			this.desktopPlatform = options.desktopPlatform;
		}
		if (options.useIndexWorker !== undefined) {
			this.useIndexWorker = options.useIndexWorker;
		}
		if (options.skipAutoPricingRefresh !== undefined) {
			this.skipAutoPricingRefresh = options.skipAutoPricingRefresh;
		}
		if (options.pickDirectory !== undefined) {
			this.pickDirectory = options.pickDirectory;
		}
		if (options.revealPath !== undefined) {
			this.revealPath = options.revealPath;
		}
	}

	hasStarted(): boolean {
		return this.started;
	}

	canPickDirectory(): boolean {
		return Boolean(this.pickDirectory);
	}

	async chooseDirectory(): Promise<string | null> {
		if (!this.pickDirectory) return null;
		return this.pickDirectory();
	}

	async revealInFileManager(targetPath: string): Promise<void> {
		if (this.revealPath) {
			await this.revealPath(targetPath);
			return;
		}
		if (
			!targetPath ||
			targetPath.includes("\0") ||
			!path.isAbsolute(targetPath) ||
			!existsSync(targetPath)
		) {
			throw new Error("Target path must be an existing local file or folder");
		}
		if (process.platform === "darwin") {
			Bun.spawn(["open", "-R", targetPath], {
				stdout: "ignore",
				stderr: "ignore",
			});
			return;
		}
		if (process.platform === "win32") {
			Bun.spawn(["explorer.exe", `/select,${targetPath}`], {
				stdout: "ignore",
				stderr: "ignore",
			});
			return;
		}
		Bun.spawn(["xdg-open", targetPath], {
			stdout: "ignore",
			stderr: "ignore",
		});
	}

	databasePath(): string {
		return this.dbPath;
	}

	private ensurePricingLoaded(existingDb?: StoreDatabase): void {
		if (this.pricingLoaded) return;
		const db = existingDb ?? this.getDb();
		this.pricingManager.loadLocalState(db);
		this.pricingLoaded = true;
	}

	private readSettingsFromDb(db: StoreDatabase): AppSettings {
		try {
			const row = readSettingRows(db).app_settings;
			if (!row) return { ...DEFAULT_SETTINGS };
			const parsed = JSON.parse(row) as Partial<AppSettings>;
			return { ...DEFAULT_SETTINGS, ...parsed };
		} catch {
			return { ...DEFAULT_SETTINGS };
		}
	}

	readSettings(): AppSettings {
		return this.readSettingsFromDb(this.getDb());
	}

	writeSettings(partial: Partial<AppSettings>): AppSettings {
		const db = this.getDb();
		const current = this.readSettingsFromDb(db);
		const next = { ...current, ...partial };
		writeSetting(db, "app_settings", JSON.stringify(next));
		return next;
	}

	start(): Promise<void> {
		this.started = true;
		return this.runRefreshLoop();
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

	private getPricingSummary(): PricingCatalogSummary {
		if (
			this.pricingSummaryCache &&
			this.pricingSummaryCache.version === this.pricingVersion &&
			this.pricingSummaryCache.indexedAt === this.indexedAt &&
			this.pricingSummaryCache.recordCount === this.records.length
		) {
			return this.pricingSummaryCache.summary;
		}
		const summary = summarizeActiveModelsPricing(this.records, {
			catalog: this.pricingManager.getCatalog(),
			rules: this.pricingManager.getSettings().customRules,
		});
		this.pricingSummaryCache = {
			version: this.pricingVersion,
			indexedAt: this.indexedAt,
			recordCount: this.records.length,
			summary,
		};
		return summary;
	}

	status(): StatusPayload {
		const summary = this.getPricingSummary();
		const pricingStatus = this.pricingManager.buildStatus(summary);
		const customRuleCount = Object.keys(
			this.pricingManager.getSettings().customRules,
		).length;
		return {
			ready: this.ready,
			indexing: this.indexing,
			phase: this.phase,
			progress: this.progress,
			indexedAt: this.indexedAt,
			durationMs: this.durationMs,
			error: this.error,
			...(this.desktopPlatform
				? { desktopPlatform: this.desktopPlatform }
				: {}),
			canPickDirectory: Boolean(this.pickDirectory),
			totals: {
				sessions: this.recordsBySession.size,
				records: this.records.length,
			},
			harnesses: this.harnessInfo(),
			warnings: this.warnings,
			pricingVersion: this.pricingVersion,
			pricing: {
				state: pricingStatus.state,
				fetchedAt: pricingStatus.fetchedAt,
				modelCount: pricingStatus.modelCount,
				lastError: pricingStatus.lastError,
				fetching: pricingStatus.fetching,
				unpricedModels: summary.unpricedModels,
				customRuleCount,
			},
		};
	}

	private harnessInfo(): HarnessInfo[] {
		const providers = defaultHarnessRegistry.getAll();
		const pathsMap = this.paths ?? {};
		const sessionCounts = new Map<string, number>();
		for (const key of this.recordsBySession.keys()) {
			const sep = key.indexOf(":");
			if (sep <= 0) continue;
			const harness = key.slice(0, sep);
			sessionCounts.set(harness, (sessionCounts.get(harness) ?? 0) + 1);
		}
		return providers.map((provider) => {
			const harness = provider.metadata.id;
			const source = this.sources.get(harness);
			return {
				harness,
				label: provider.metadata.displayName,
				color: provider.metadata.color,
				available: source?.available ?? false,
				records: source?.records.length ?? 0,
				sessions: sessionCounts.get(harness) ?? 0,
				paths:
					pathsMap[harness] ??
					provider.getWatchPaths(defaultPlatformPathService),
				warnings: source?.warnings ?? [],
			};
		});
	}

	private async runIndexWorker(
		targetDbPath: string,
		myGen: number,
	): Promise<IndexSyncResult | null> {
		this.closeDb();
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(resolveWorkerCommand("index-worker.ts"), {
				env: {
					...process.env,
					CODING_TOKENS_WORKER: "index-sync",
				},
				stdin: new TextEncoder().encode(
					JSON.stringify({ dbPath: targetDbPath }),
				),
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch {
			return null;
		}

		const stdout = proc.stdout;
		if (!stdout || typeof stdout === "number") {
			return null;
		}
		const stderrPromise =
			proc.stderr && typeof proc.stderr !== "number"
				? new Response(proc.stderr).text().catch(() => "")
				: Promise.resolve("");

		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let result: IndexSyncResult | null = null;
		let workerFailed = false;

		const handleLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const event = JSON.parse(trimmed) as IndexWorkerEvent;
				if (event.type === "progress") {
					if (this.generation === myGen) {
						this.phase = event.phase;
						this.progress = {
							completed: event.completed,
							total: event.total,
						};
					}
				} else if (event.type === "done") {
					result = {
						fingerprints: event.fingerprints,
						updatedHarnesses: event.updatedHarnesses,
						catalogRebuiltHarnesses: event.catalogRebuiltHarnesses,
						warnings: event.warnings,
					};
				} else if (event.type === "error") {
					workerFailed = true;
				}
			} catch {}
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					handleLine(line);
				}
			}
			const tail = buffer + decoder.decode();
			if (tail.trim()) handleLine(tail);
		} catch {
			workerFailed = true;
		}

		const [exitCode] = await Promise.all([proc.exited, stderrPromise]);
		if (exitCode !== 0 || workerFailed || !result) {
			return null;
		}
		return result;
	}

	private applyAndPersistInMemoryPricing(db: StoreDatabase): void {
		const { changed } = applyPricingToRecords(this.records, {
			catalog: this.pricingManager.getCatalog(),
			rules: this.pricingManager.getSettings().customRules,
		});
		if (changed.length > 0) {
			updateRecordPricingBatch(
				db,
				changed.map((record) => ({
					harness: record.harness,
					sessionId: record.sessionId,
					messageId: record.messageId,
					model: record.model,
					costUsd: record.costUsd,
					costEstimated: record.costEstimated,
				})),
			);
		}
	}

	private runRefreshLoop(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise;
		const myGen = this.generation;
		const loop = (async () => {
			do {
				this.refreshQueued = false;
				await this.executeRefresh(myGen);
			} while (this.refreshQueued && this.generation === myGen);
		})().finally(() => {
			if (this.generation === myGen) {
				this.refreshPromise = null;
			}
		});
		this.refreshPromise = loop;
		return loop;
	}

	refresh(): Promise<void> {
		this.started = true;
		if (this.indexing) {
			this.refreshQueued = true;
		}
		return this.runRefreshLoop();
	}

	private async executeRefresh(myGen: number): Promise<void> {
		if (this.generation !== myGen) return;
		const targetDbPath = this.dbPath;
		this.indexing = true;
		this.started = true;
		this.error = null;
		this.phase = "Opening local index";
		const providers = defaultHarnessRegistry.getAll();
		this.progress = { completed: 0, total: providers.length };
		const startedAt = Date.now();
		const wasReadyBeforeRefresh = this.ready;

		try {
			// Phase 1: Fast cache-first hydration on cold start so cached UI loads immediately.
			if (!wasReadyBeforeRefresh) {
				const phase1Db = this.getDb();
				this.ensurePricingLoaded(phase1Db);
				const states = readAllSourceStates(phase1Db);
				if (states.size > 0) {
					const cachedCatalog = readCatalogMap(phase1Db);
					const cachedMessages = readSessionMessages(phase1Db);
					const catalogHarnesses = new Set<HarnessName>();
					for (const meta of cachedCatalog.values()) {
						catalogHarnesses.add(meta.harness);
					}
					const hydratedSources = new Map<HarnessName, SourceResult>();
					const hydratedFingerprints = new Map<HarnessName, string>();
					const hydratedRecords: UsageRecord[] = [];
					let latestIndexedAt: number | null = null;
					const recordHarnesses = new Set<HarnessName>();

					for (const [index, provider] of providers.entries()) {
						if (this.generation !== myGen) return;
						const harness = provider.metadata.id;
						const st = states.get(harness);
						if (!st) continue;
						this.phase = `Loading ${provider.metadata.displayName}`;
						this.progress = { completed: index + 1, total: providers.length };
						const recs = readHarnessRecords(phase1Db, harness);
						if (recs.length > 0) recordHarnesses.add(harness);
						appendAll(hydratedRecords, recs);
						hydratedSources.set(harness, {
							harness,
							records: recs,
							warnings: parseWarnings(st.warnings),
							available: st.available === 1,
							messages: new Map(),
						});
						hydratedFingerprints.set(harness, st.fingerprint);
						if (latestIndexedAt === null || st.indexedAt > latestIndexedAt) {
							latestIndexedAt = st.indexedAt;
						}
						await yieldTick();
					}

					if (this.generation !== myGen) return;

					const catalogCoversRecords = [...recordHarnesses].every((h) =>
						catalogHarnesses.has(h),
					);

					if (catalogCoversRecords) {
						applyPricingToRecords(hydratedRecords, {
							catalog: this.pricingManager.getCatalog(),
							rules: this.pricingManager.getSettings().customRules,
						});
						this.catalog = cachedCatalog;
						this.messagesBySession = cachedMessages;
						this.sources = hydratedSources;
						this.fingerprints = hydratedFingerprints;
						this.records = hydratedRecords;
						this.recordsBySession = groupRecordsBySession(hydratedRecords);
						this.indexedAt = latestIndexedAt;
						this.warnings = [...hydratedSources.values()].flatMap(
							(source) => source.warnings,
						);
						this.pricingSummaryCache = null;
						this.ready = true;
					}
				}
			}

			if (this.generation !== myGen) return;

			// Phase 2: Sync harnesses (isolated worker when enabled, yielded in-process fallback).
			let syncResult: IndexSyncResult | null = null;
			if (this.useIndexWorker) {
				syncResult = await this.runIndexWorker(targetDbPath, myGen);
			}
			if (this.generation !== myGen) return;
			if (!syncResult) {
				const syncDb = this.getDb();
				this.ensurePricingLoaded(syncDb);
				syncResult = await syncHarnessesToDatabase({
					db: syncDb,
					catalog: this.pricingManager.getCatalog(),
					rules: this.pricingManager.getSettings().customRules,
					yieldBetweenSteps: true,
					onProgress: (event) => {
						if (this.generation !== myGen) return;
						this.phase = event.phase;
						this.progress = {
							completed: event.completed,
							total: event.total,
						};
					},
				});
			}

			if (this.generation !== myGen) return;

			const updatedSet = new Set<HarnessName>(syncResult.updatedHarnesses);
			const rebuiltSet = new Set<HarnessName>(
				syncResult.catalogRebuiltHarnesses,
			);
			const noSourceChanges =
				this.ready && updatedSet.size === 0 && rebuiltSet.size === 0;

			if (noSourceChanges) {
				const nextFingerprints = new Map<HarnessName, string>();
				for (const [harness, fp] of Object.entries(syncResult.fingerprints)) {
					nextFingerprints.set(harness as HarnessName, fp);
				}
				this.fingerprints = nextFingerprints;
				this.paths = harnessPaths();
				const pricingError = this.pricingManager.getLastError();
				this.warnings = [
					...[...this.sources.values()].flatMap((source) => source.warnings),
					...syncResult.warnings,
					...(pricingError ? [pricingError] : []),
				];
				if (wasReadyBeforeRefresh || this.indexedAt === null) {
					this.indexedAt = Date.now();
				}
				this.durationMs = Date.now() - startedAt;
				this.phase = "Ready";
			} else {
				const loadDb = this.getDb();
				const states = readAllSourceStates(loadDb);
				const nextCatalog = readCatalogMap(loadDb);
				const nextMessages = readSessionMessages(loadDb);
				const nextSources = new Map<HarnessName, SourceResult>();
				const nextFingerprints = new Map<HarnessName, string>();
				const nextRecords: UsageRecord[] = [];

				for (const [index, provider] of providers.entries()) {
					if (this.generation !== myGen) return;
					const harness = provider.metadata.id;
					const nextFp = syncResult.fingerprints[harness];
					if (nextFp) nextFingerprints.set(harness, nextFp);
					const existing = this.sources.get(harness);
					const existingFp = this.fingerprints.get(harness);
					if (
						existing &&
						existingFp === nextFp &&
						!updatedSet.has(harness) &&
						!rebuiltSet.has(harness)
					) {
						nextSources.set(harness, existing);
						appendAll(nextRecords, existing.records);
						continue;
					}
					this.phase = `Loading ${provider.metadata.displayName}`;
					this.progress = { completed: index + 1, total: providers.length };
					const st = states.get(harness);
					const recs = readHarnessRecords(loadDb, harness);
					const source: SourceResult = {
						harness,
						records: recs,
						warnings: st ? parseWarnings(st.warnings) : [],
						available: st?.available === 1 || recs.length > 0,
						messages: new Map(),
					};
					nextSources.set(harness, source);
					appendAll(nextRecords, recs);
					await yieldTick();
				}

				if (this.generation !== myGen) return;

				// Reload pricing state synchronously right before applying pricing to nextRecords
				// so concurrent custom rule edits made while indexing aren't overwritten.
				this.pricingManager.loadLocalState(loadDb);
				this.pricingLoaded = true;

				if (updatedSet.size > 0) {
					this.textsLoaded = false;
					this.textsBySession.clear();
				}

				this.records = nextRecords;
				this.applyAndPersistInMemoryPricing(loadDb);
				this.recordsBySession = groupRecordsBySession(this.records);
				this.catalog = nextCatalog;
				this.messagesBySession = nextMessages;
				this.sources = nextSources;
				this.fingerprints = nextFingerprints;

				this.paths = harnessPaths();
				const pricingError = this.pricingManager.getLastError();
				this.warnings = [
					...[...this.sources.values()].flatMap((source) => source.warnings),
					...syncResult.warnings,
					...(pricingError ? [pricingError] : []),
				];
				this.indexedAt = Date.now();
				this.durationMs = this.indexedAt - startedAt;
				this.pricingSummaryCache = null;
				this.ready = true;
				this.phase = "Ready";
			}
		} catch (error) {
			if (this.generation !== myGen) return;
			this.error = String(error);
			this.phase = "Failed";
			if (!this.ready) this.ready = false;
		} finally {
			if (this.generation === myGen) {
				this.indexing = false;
				this.progress = {
					completed: providers.length,
					total: providers.length,
				};
			}
		}

		if (this.generation !== myGen) return;

		// Phase 3: Non-blocking background models.dev refresh if cache is missing/stale.
		if (
			!this.error &&
			!this.skipAutoPricingRefresh &&
			this.pricingManager.needsAutoRefresh()
		) {
			void this.refreshPricingCatalog("auto");
		}
	}

	private repriceAllInMemoryAndDb(existingDb?: StoreDatabase): void {
		const db = existingDb ?? this.getDb();
		this.applyAndPersistInMemoryPricing(db);
		this.pricingVersion += 1;
		this.pricingSummaryCache = null;
		this.indexedAt = Date.now();
	}

	pricingPayload(): PricingPayload {
		this.ensurePricingLoaded();
		const summary = this.getPricingSummary();
		return {
			status: this.pricingManager.buildStatus(summary),
			settings: this.pricingManager.getSettings(),
		};
	}

	searchPricingCatalog(query: string, limit = 25): PricingCatalogSearchItem[] {
		this.ensurePricingLoaded();
		return searchCatalogEntries(this.pricingManager.getCatalog(), query, limit);
	}

	updatePricingSettings(partial: {
		autoFetch?: boolean;
		endpoint?: string;
		cacheTtlHours?: number;
	}): PricingPayload {
		const db = this.getDb();
		this.ensurePricingLoaded(db);
		const current = this.pricingManager.getSettings();
		if (partial.endpoint !== undefined && !isValidHttpUrl(partial.endpoint)) {
			throw new Error("Catalog URL must start with http:// or https://");
		}
		const next = {
			...current,
			...(partial.autoFetch !== undefined
				? { autoFetch: Boolean(partial.autoFetch) }
				: {}),
			...(partial.endpoint !== undefined
				? { endpoint: partial.endpoint.trim() }
				: {}),
			...(partial.cacheTtlHours !== undefined
				? { cacheTtlHours: Number(partial.cacheTtlHours) }
				: {}),
		};
		this.pricingManager.saveSettings(db, next);
		this.pricingVersion += 1;
		this.pricingSummaryCache = null;
		return {
			status: this.pricingManager.buildStatus(this.getPricingSummary()),
			settings: this.pricingManager.getSettings(),
		};
	}

	upsertCustomPriceRule(
		input: Omit<CustomModelPriceRule, "updatedAt">,
	): PricingPayload {
		const clean = sanitizeCustomRule(input.model, {
			...input,
			updatedAt: Date.now(),
		});
		if (!clean) {
			throw new Error("Invalid custom model pricing rule");
		}
		const db = this.getDb();
		this.ensurePricingLoaded(db);
		const current = this.pricingManager.getSettings();
		const nextRules = {
			...current.customRules,
			[normalizeRuleKey(clean.model)]: clean,
		};
		this.pricingManager.saveSettings(db, {
			...current,
			customRules: nextRules,
		});
		this.repriceAllInMemoryAndDb(db);
		return {
			status: this.pricingManager.buildStatus(this.getPricingSummary()),
			settings: this.pricingManager.getSettings(),
		};
	}

	importCustomPriceRules(
		rules: Record<string, unknown>,
		replace = false,
	): PricingPayload {
		const db = this.getDb();
		this.ensurePricingLoaded(db);
		const current = this.pricingManager.getSettings();
		const nextRules: Record<string, CustomModelPriceRule> = replace
			? {}
			: { ...current.customRules };
		for (const [key, rawRule] of Object.entries(rules)) {
			const clean = sanitizeCustomRule(key, rawRule);
			if (!clean) {
				throw new Error(`Invalid pricing rule for "${key}"`);
			}
			nextRules[normalizeRuleKey(clean.model)] = clean;
		}
		this.pricingManager.saveSettings(db, {
			...current,
			customRules: nextRules,
		});
		this.repriceAllInMemoryAndDb(db);
		return {
			status: this.pricingManager.buildStatus(this.getPricingSummary()),
			settings: this.pricingManager.getSettings(),
		};
	}

	deleteCustomPriceRule(modelKey: string): PricingPayload {
		const db = this.getDb();
		this.ensurePricingLoaded(db);
		const current = this.pricingManager.getSettings();
		const normalizedKey = normalizeRuleKey(modelKey);
		const nextRules = { ...current.customRules };
		delete nextRules[normalizedKey];
		this.pricingManager.saveSettings(db, {
			...current,
			customRules: nextRules,
		});
		this.repriceAllInMemoryAndDb(db);
		return {
			status: this.pricingManager.buildStatus(this.getPricingSummary()),
			settings: this.pricingManager.getSettings(),
		};
	}

	async refreshPricingCatalog(
		trigger: "auto" | "manual",
	): Promise<{ payload: PricingPayload; attempt: PricingFetchAttempt }> {
		if (this.pricingRefreshInFlight) {
			return this.pricingRefreshInFlight;
		}
		const myGen = this.generation;
		const task = (async () => {
			this.ensurePricingLoaded();
			const { attempt, updated } = await this.pricingManager.refreshCatalog({
				trigger,
				persistHistory: (history) => {
					if (this.generation !== myGen) return;
					try {
						this.pricingManager.writeHistory(this.getDb(), history);
					} catch {}
				},
			});
			if (this.generation === myGen) {
				if (updated) {
					this.warnings = this.warnings.filter(
						(w) => !w.toLowerCase().includes("models.dev"),
					);
					this.repriceAllInMemoryAndDb();
				} else {
					this.pricingVersion += 1;
					this.pricingSummaryCache = null;
				}
			}
			return {
				attempt,
				payload: {
					status: this.pricingManager.buildStatus(this.getPricingSummary()),
					settings: this.pricingManager.getSettings(),
				},
			};
		})().finally(() => {
			if (this.pricingRefreshInFlight === task) {
				this.pricingRefreshInFlight = null;
			}
		});
		this.pricingRefreshInFlight = task;
		return task;
	}

	modelPricingMeta(
		model: string,
		records: readonly UsageRecord[],
	): ModelPricingMeta {
		return buildModelPricingMeta(model, records, {
			catalog: this.pricingManager.getCatalog(),
			rules: this.pricingManager.getSettings().customRules,
		});
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

	sourcePaths(): Record<string, string[]> {
		if (!this.paths) {
			this.paths = harnessPaths();
		}
		const result = { ...this.paths };
		for (const provider of defaultHarnessRegistry.getAll()) {
			if (!result[provider.metadata.id]) {
				result[provider.metadata.id] = provider.getWatchPaths(
					defaultPlatformPathService,
				);
			}
		}
		return result;
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
		if (entry.meta.source) return entry.meta;
		const provider = defaultHarnessRegistry.get(entry.meta.harness);
		if (provider) {
			const resolvedFiles = provider.resolveSessionFiles?.(
				defaultPlatformPathService,
				entry.meta.sessionId,
			);
			const fallbackPath = resolvedFiles?.at(-1);
			if (fallbackPath) {
				const meta = {
					...entry.meta,
					source: { kind: "file" as const, path: fallbackPath },
					hasTranscript: true,
				};
				entry.meta = meta;
				this.catalog.set(entry.meta.key, meta);
				return meta;
			}
			const watchPaths = provider.getWatchPaths(defaultPlatformPathService);
			const firstWatchPath = watchPaths[0];
			if (firstWatchPath) {
				const meta = {
					...entry.meta,
					source: { kind: "file" as const, path: firstWatchPath },
					hasTranscript: true,
				};
				entry.meta = meta;
				this.catalog.set(entry.meta.key, meta);
				return meta;
			}
		}
		return entry.meta;
	}

	summarize(
		meta: SessionMeta,
		records: UsageRecord[],
		_range: { from: number | null; until: number | null },
	): SessionSummary {
		const totals = summarizeSessionRecords(records);
		totals.messages = this.messagesBySession.get(meta.key) ?? 0;
		const bounds = timestampBounds(records);
		const lastActivityAt = bounds?.max ?? null;
		const recordedStart = bounds?.min ?? null;
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

	sessionText(key: string): string | undefined {
		if (!this.textsLoaded) {
			this.textsBySession = readSessionTexts(this.getDb());
			this.textsLoaded = true;
		}
		return this.textsBySession.get(key);
	}

	searchTextKeysFts(ftsQuery: string, limit?: number): Set<string> | null {
		return searchSessionTextKeysFts(this.getDb(), ftsQuery, limit);
	}

	sessionTextsByKeys(keys: readonly string[]): Map<string, string> {
		if (this.textsLoaded) {
			const result = new Map<string, string>();
			for (const key of keys) {
				const text = this.textsBySession.get(key);
				if (text !== undefined) result.set(key, text);
			}
			return result;
		}
		return readSessionTextsByKeys(this.getDb(), keys);
	}

	searchTextsBySubstring(terms: readonly string[]): Map<string, string> {
		return searchSessionTextsBySubstring(this.getDb(), terms);
	}

	sessionSummaries(range: {
		from: number | null;
		until: number | null;
	}): SessionSummary[] {
		const summaries: SessionSummary[] = [];
		for (const meta of this.catalog.values()) {
			const records = this.recordsBySession.get(meta.key) ?? [];
			const ranged = records.filter((record) => recordMatches(record, range));
			// A catalog entry only proves that a session exists. Without a usage
			// record it would show up with zero tokens, requests and cost, which is
			// noise in every report. Transcript-only sessions stay reachable from
			// the source metadata, but the usage views only list real usage.
			if (!ranged.length) continue;
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
		return summarizeRecords(records);
	}
}

export function projectNameFor(cwd: string | null): string {
	return projectName(cwd);
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
