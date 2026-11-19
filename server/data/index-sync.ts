import { normalizeModelName } from "@shared/models";
import type {
	CustomModelPriceRule,
	HarnessName,
	SourceResult,
	UsageRecord,
} from "@shared/types";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { applyPricingToRecords } from "../../src/pricing/engine";
import type { Catalog } from "../../src/pricing/modelsdev";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import type {
	HarnessProvider,
	SessionDiscoveryItem,
} from "../../src/providers/types";
import { extractSearchText } from "../../src/services/transcripts";
import { extractHarnessSearchTexts } from "../../src/transcripts";
import { buildSessionCatalog } from "./catalog";
import {
	readAllSourceStates,
	readCatalogMap,
	readHarnessRecords,
	readSessionFileStamps,
	replaceHarnessCatalog,
	replaceHarnessMessages,
	replaceHarnessRecords,
	replaceHarnessTexts,
	replaceSessionFileStamps,
	type StoreDatabase,
	upsertHarnessSessionDelta,
} from "./database";

export interface IndexProgressEvent {
	phase: string;
	completed: number;
	total: number;
}

export interface IndexSyncResult {
	fingerprints: Record<string, string>;
	updatedHarnesses: HarnessName[];
	catalogRebuiltHarnesses: HarnessName[];
	warnings: string[];
}

export function yieldTick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function runBounded<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
	yieldAfterEach = true,
): Promise<R[]> {
	if (!items.length) return [];
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const runners = Array.from(
		{ length: Math.min(Math.max(1, concurrency), items.length) },
		async () => {
			while (cursor < items.length) {
				const index = cursor;
				cursor += 1;
				const item = items[index] as T;
				results[index] = await worker(item, index);
				if (yieldAfterEach) await yieldTick();
			}
		},
	);
	await Promise.all(runners);
	return results;
}

export async function syncHarnessesToDatabase(options: {
	db: StoreDatabase;
	catalog: Catalog | null;
	rules: Record<string, CustomModelPriceRule>;
	yieldBetweenSteps?: boolean;
	onProgress?: (event: IndexProgressEvent) => void;
}): Promise<IndexSyncResult> {
	const { db, catalog, rules, yieldBetweenSteps = true, onProgress } = options;
	const providers = defaultHarnessRegistry.getAll();
	const total = providers.length;
	const emit = (phase: string, completed: number) => {
		onProgress?.({ phase, completed, total });
	};

	emit("Opening local index", 0);

	const fingerprintEntries = await runBounded(
		providers,
		6,
		async (provider) => {
			const harness = provider.metadata.id;
			let fingerprint = `v12:0:${harness}`;
			try {
				fingerprint = await provider.computeFingerprint(
					defaultPlatformPathService,
				);
			} catch {}
			return { provider, harness, fingerprint };
		},
		yieldBetweenSteps,
	);

	const fingerprints: Record<string, string> = {};
	for (const entry of fingerprintEntries) {
		fingerprints[entry.harness] = entry.fingerprint;
	}

	const states = readAllSourceStates(db);
	const changedEntries: Array<{
		provider: HarnessProvider;
		harness: HarnessName;
		fingerprint: string;
		hasExistingState: boolean;
	}> = [];

	for (const [index, entry] of fingerprintEntries.entries()) {
		const { provider, harness, fingerprint } = entry;
		const state = states.get(harness);
		if (state && state.fingerprint === fingerprint) {
			emit(`Loading ${provider.metadata.displayName}`, index + 1);
		} else {
			changedEntries.push({
				provider,
				harness,
				fingerprint,
				hasExistingState: Boolean(state),
			});
		}
	}

	const updatedHarnesses = new Set<HarnessName>();
	const catalogRebuiltHarnesses = new Set<HarnessName>();
	const warnings: string[] = [];

	if (changedEntries.length) {
		emit(
			`Reading ${changedEntries
				.map((item) => item.provider.metadata.displayName)
				.slice(0, 2)
				.join(", ")}`,
			total - changedEntries.length,
		);

		const cachedCatalog = readCatalogMap(db);
		const fullSaves: Array<{
			harness: HarnessName;
			fingerprint: string;
			result: SourceResult;
			texts: Map<string, string>;
			discovered: SessionDiscoveryItem[];
		}> = [];

		await runBounded(
			changedEntries,
			4,
			async (entry) => {
				const { provider, harness, fingerprint, hasExistingState } = entry;
				const label = provider.metadata.displayName;
				const cachedRecords = hasExistingState
					? readHarnessRecords(db, harness)
					: null;
				const existingStamps = hasExistingState
					? readSessionFileStamps(db, harness)
					: [];
				const knownStamps = new Map<string, SessionDiscoveryItem>();
				for (const stamp of existingStamps) {
					knownStamps.set(stamp.filePath, {
						sessionId: stamp.sessionId,
						harness,
						filePath: stamp.filePath,
						mtimeMs: stamp.mtimeMs,
						sizeBytes: stamp.sizeBytes,
						cwd:
							cachedCatalog.get(`${harness}:${stamp.sessionId}`)?.cwd ?? null,
					});
				}
				let discovered: SessionDiscoveryItem[] = [];
				try {
					discovered = await provider.discoverSessions(
						defaultPlatformPathService,
						knownStamps.size > 0 ? knownStamps : undefined,
					);
				} catch {}

				const distinctPaths = new Set(discovered.map((item) => item.filePath));
				const canUseIncremental =
					Boolean(cachedRecords) &&
					existingStamps.length > 0 &&
					discovered.length > 0 &&
					distinctPaths.size === discovered.length;

				if (canUseIncremental && cachedRecords) {
					const stampBySession = new Map<
						string,
						{ filePath: string; mtimeMs: number; sizeBytes: number }
					>();
					for (const stamp of existingStamps) {
						stampBySession.set(stamp.sessionId, stamp);
					}
					const discoveredIds = new Set<string>();
					const changedItems: SessionDiscoveryItem[] = [];
					for (const item of discovered) {
						discoveredIds.add(item.sessionId);
						const prev = stampBySession.get(item.sessionId);
						if (
							!prev ||
							prev.filePath !== item.filePath ||
							prev.mtimeMs !== item.mtimeMs ||
							prev.sizeBytes !== item.sizeBytes
						) {
							changedItems.push(item);
						}
					}
					const removedIds = new Set<string>();
					for (const prevId of stampBySession.keys()) {
						if (!discoveredIds.has(prevId)) removedIds.add(prevId);
					}

					if (changedItems.length <= 20) {
						const changedIds = new Set(
							changedItems.map((item) => item.sessionId),
						);
						const deltaRecords: UsageRecord[] = [];
						const deltaMessages = new Map<string, number>();
						const deltaWarnings: string[] = [];

						for (const item of changedItems) {
							try {
								const single = await provider.readUsage(
									defaultPlatformPathService,
									item,
								);
								deltaRecords.push(...single.records);
								deltaWarnings.push(...single.warnings);
								for (const [sid, cnt] of single.messages) {
									deltaMessages.set(sid, cnt);
								}
							} catch (err) {
								deltaWarnings.push(
									`Failed reading ${label} (${item.sessionId}): ${String(err)}`,
								);
							}
						}

						if (deltaRecords.length) {
							applyPricingToRecords(deltaRecords, { catalog, rules });
						}

						const deltaTexts = new Map<string, string>();
						const targetFiles = new Set<string>();
						if (changedIds.size && provider.resolveSessionFilesBatch) {
							const batched = provider.resolveSessionFilesBatch(
								defaultPlatformPathService,
								changedIds,
							);
							for (const files of batched.values()) {
								for (const fp of files) targetFiles.add(fp);
							}
						}
						for (const item of changedItems) {
							if (
								!provider.resolveSessionFilesBatch &&
								provider.resolveSessionFiles
							) {
								for (const fp of provider.resolveSessionFiles(
									defaultPlatformPathService,
									item.sessionId,
								)) {
									targetFiles.add(fp);
								}
							}
							targetFiles.add(item.filePath);
						}
						if (changedItems.length && provider.readTranscripts) {
							try {
								const tRes = await provider.readTranscripts(
									defaultPlatformPathService,
									targetFiles,
								);
								for (const sess of tRes.sessions) {
									if (!changedIds.has(sess.sessionId)) continue;
									const text = extractSearchText(sess);
									if (text) deltaTexts.set(sess.sessionId, text);
								}
							} catch {}
						}

						const changedFiles = new Set(
							changedItems.map((item) => item.filePath),
						);
						const harnessCat = changedIds.size
							? buildSessionCatalog(deltaRecords, new Set([harness]), {
									targetSessionIds: changedIds,
									targetFiles: changedFiles,
								})
							: { entries: new Map(), warnings: [] };
						warnings.push(...harnessCat.warnings);

						upsertHarnessSessionDelta(db, harness, {
							changedSessionIds: changedIds,
							removedSessionIds: removedIds,
							records: deltaRecords,
							messages: deltaMessages,
							texts: deltaTexts,
							discoveredItems: discovered,
							catalogEntries: harnessCat.entries,
							state: {
								fingerprint,
								indexedAt: Date.now(),
								available: discovered.length > 0 ? 1 : 0,
								warnings: JSON.stringify(deltaWarnings),
							},
						});

						updatedHarnesses.add(harness);
						return;
					}
				}

				// Full harness scan path
				let result: SourceResult;
				try {
					result = await provider.readUsage(defaultPlatformPathService);
				} catch (err) {
					result = {
						harness,
						available: false,
						records: [],
						warnings: [`Failed reading usage for ${label}: ${String(err)}`],
						messages: new Map(),
					};
				}
				if (result.records.length) {
					applyPricingToRecords(result.records, { catalog, rules });
				} else {
					for (const record of result.records) {
						record.model = normalizeModelName(record.model);
					}
				}
				let texts = new Map<string, string>();
				if (provider.readTranscripts) {
					try {
						const tRes = await provider.readTranscripts(
							defaultPlatformPathService,
						);
						for (const sess of tRes.sessions) {
							const text = extractSearchText(sess);
							if (text) texts.set(sess.sessionId, text);
						}
					} catch {}
				} else {
					try {
						texts = extractHarnessSearchTexts(harness);
					} catch {}
				}
				fullSaves.push({
					harness,
					fingerprint,
					result,
					texts,
					discovered,
				});
			},
			yieldBetweenSteps,
		);

		if (fullSaves.length) {
			emit("Saving local index", total);
			for (const save of fullSaves) {
				replaceHarnessRecords(db, save.harness, save.result.records, {
					fingerprint: save.fingerprint,
					indexedAt: Date.now(),
					available: save.result.available ? 1 : 0,
					warnings: JSON.stringify(save.result.warnings),
				});
				replaceHarnessMessages(db, save.harness, save.result.messages);
				replaceHarnessTexts(db, save.harness, save.texts);
				if (save.discovered.length) {
					replaceSessionFileStamps(db, save.harness, save.discovered);
				}
				const harnessCat = buildSessionCatalog(
					save.result.records,
					new Set([save.harness]),
				);
				warnings.push(...harnessCat.warnings);
				replaceHarnessCatalog(db, save.harness, harnessCat.entries);
				updatedHarnesses.add(save.harness);
				if (yieldBetweenSteps) await yieldTick();
			}
		}
	}

	// Recover missing session_catalog entries for unchanged harnesses (e.g., pre-v4 DB upgrade).
	const recordHarnesses = new Set(
		db
			.query<{ harness: HarnessName }, []>(
				"SELECT DISTINCT harness FROM usage_records",
			)
			.all()
			.map((row) => row.harness),
	);
	const catalogHarnesses = new Set(
		db
			.query<{ harness: HarnessName }, []>(
				"SELECT DISTINCT harness FROM session_catalog",
			)
			.all()
			.map((row) => row.harness),
	);
	const missingCatalogHarnesses = new Set<HarnessName>();
	for (const harness of recordHarnesses) {
		if (!catalogHarnesses.has(harness) && !updatedHarnesses.has(harness)) {
			missingCatalogHarnesses.add(harness);
		}
	}
	if (missingCatalogHarnesses.size > 0) {
		emit("Building session index", total);
		const missingRecords: UsageRecord[] = [];
		for (const harness of missingCatalogHarnesses) {
			missingRecords.push(...readHarnessRecords(db, harness));
		}
		const built = buildSessionCatalog(missingRecords, missingCatalogHarnesses);
		warnings.push(...built.warnings);
		for (const harness of missingCatalogHarnesses) {
			replaceHarnessCatalog(db, harness, built.entries);
			catalogRebuiltHarnesses.add(harness);
		}
	}

	return {
		fingerprints,
		updatedHarnesses: [...updatedHarnesses],
		catalogRebuiltHarnesses: [...catalogRebuiltHarnesses],
		warnings,
	};
}
