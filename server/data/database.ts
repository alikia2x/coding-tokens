import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { HarnessName, UsageRecord } from "@shared/types";
import type { SessionDiscoveryItem } from "../../src/providers/types";
import { runMigrations } from "../../src/services/storage";
import type { SessionMeta, SessionSource } from "./catalog";
import { sessionKey } from "./totals";

export interface SourceStateRow {
	fingerprint: string;
	indexedAt: number;
	available: number;
	warnings: string;
}

export type StoreDatabase = Database;

export function openStoreDatabase(dbPath: string): StoreDatabase {
	mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");

	runMigrations(db);

	return db;
}

export function readSourceState(
	db: StoreDatabase,
	harness: HarnessName,
): SourceStateRow | null {
	const row = db
		.query<SourceStateRow, [string]>(
			"SELECT fingerprint, indexed_at, available, warnings FROM source_state WHERE harness = ?",
		)
		.get(harness);
	return row ?? null;
}

export function readAllSourceStates(
	db: StoreDatabase,
): Map<HarnessName, SourceStateRow> {
	const rows = db
		.query<
			{
				harness: HarnessName;
				fingerprint: string;
				indexed_at: number;
				available: number;
				warnings: string;
			},
			[]
		>(
			"SELECT harness, fingerprint, indexed_at, available, warnings FROM source_state",
		)
		.all();
	const map = new Map<HarnessName, SourceStateRow>();
	for (const row of rows) {
		map.set(row.harness, {
			fingerprint: row.fingerprint,
			indexedAt: row.indexed_at,
			available: row.available,
			warnings: row.warnings,
		});
	}
	return map;
}

export function readHarnessRecords(
	db: StoreDatabase,
	harness: HarnessName,
): UsageRecord[] {
	const rows = db
		.query<
			{
				harness: HarnessName;
				session_id: string;
				message_id: string;
				turn_id: string | null;
				is_subagent: number;
				cwd: string | null;
				model: string;
				raw_model: string | null;
				timestamp: number | null;
				input_tokens: number;
				output_tokens: number;
				cache_read_tokens: number;
				cache_write_tokens: number;
				reasoning_tokens: number;
				cost_usd: number | null;
				raw_cost_usd: number | null;
				cost_estimated: number;
			},
			[HarnessName]
		>(
			`SELECT harness, session_id, message_id, turn_id, is_subagent, cwd, model,
				raw_model, timestamp, input_tokens, output_tokens, cache_read_tokens,
				cache_write_tokens, reasoning_tokens, cost_usd, raw_cost_usd, cost_estimated
			FROM usage_records WHERE harness = ?`,
		)
		.all(harness);
	return rows.map((row) => ({
		harness: row.harness,
		sessionId: row.session_id,
		messageId: row.message_id,
		turnId: row.turn_id ?? undefined,
		isSubagent: row.is_subagent === 1 || undefined,
		cwd: row.cwd,
		model: row.model,
		rawModel: row.raw_model ?? row.model,
		timestamp: row.timestamp,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheWriteTokens: row.cache_write_tokens,
		reasoningTokens: row.reasoning_tokens,
		costUsd: row.cost_usd,
		rawCostUsd: row.raw_cost_usd,
		costEstimated: row.cost_estimated === 1,
	}));
}

export function readSessionMessages(db: StoreDatabase): Map<string, number> {
	const rows = db
		.query<{ harness: HarnessName; session_id: string; messages: number }, []>(
			"SELECT harness, session_id, messages FROM session_messages",
		)
		.all();
	return new Map(
		rows.map((row) => [`${row.harness}:${row.session_id}`, row.messages]),
	);
}

export function replaceHarnessMessages(
	db: StoreDatabase,
	harness: HarnessName,
	messages: ReadonlyMap<string, number>,
): void {
	const remove = db.prepare("DELETE FROM session_messages WHERE harness = ?");
	const insert = db.prepare(
		"INSERT OR REPLACE INTO session_messages (harness, session_id, messages) VALUES (?, ?, ?)",
	);
	db.transaction(() => {
		remove.run(harness);
		for (const [sessionId, count] of messages)
			insert.run(harness, sessionId, count);
	})();
}

export function readSessionTexts(db: StoreDatabase): Map<string, string> {
	const rows = db
		.query<{ harness: HarnessName; session_id: string; body: string }, []>(
			"SELECT harness, session_id, body FROM session_texts",
		)
		.all();
	return new Map(
		rows.map((row) => [`${row.harness}:${row.session_id}`, row.body]),
	);
}

export function replaceHarnessTexts(
	db: StoreDatabase,
	harness: HarnessName,
	texts: ReadonlyMap<string, string>,
): void {
	const remove = db.prepare("DELETE FROM session_texts WHERE harness = ?");
	const insert = db.prepare(
		"INSERT OR REPLACE INTO session_texts (harness, session_id, body) VALUES (?, ?, ?)",
	);
	let removeFts = null;
	let insertFts = null;
	try {
		removeFts = db.prepare("DELETE FROM fts_session_text WHERE harness = ?");
		insertFts = db.prepare(
			"INSERT INTO fts_session_text (harness, session_id, body) VALUES (?, ?, ?)",
		);
	} catch {}

	db.transaction(() => {
		remove.run(harness);
		if (removeFts) removeFts.run(harness);
		for (const [sessionId, body] of texts) {
			insert.run(harness, sessionId, body);
			if (insertFts) insertFts.run(harness, sessionId, body);
		}
	})();
}

export function replaceHarnessRecords(
	db: StoreDatabase,
	harness: HarnessName,
	records: UsageRecord[],
	state: SourceStateRow,
): void {
	const insert = db.prepare(
		`INSERT OR REPLACE INTO usage_records (
			harness, session_id, message_id, turn_id, is_subagent, cwd, model,
			raw_model, timestamp, input_tokens, output_tokens, cache_read_tokens,
			cache_write_tokens, reasoning_tokens, cost_usd, raw_cost_usd, cost_estimated
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const remove = db.prepare("DELETE FROM usage_records WHERE harness = ?");
	const upsertState = db.prepare(
		`INSERT OR REPLACE INTO source_state
			(harness, fingerprint, indexed_at, available, warnings)
		VALUES (?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		remove.run(harness);
		for (const record of records) {
			const rawModel = record.rawModel ?? record.pricingModel ?? record.model;
			const rawCostUsd =
				record.rawCostUsd !== undefined
					? record.rawCostUsd
					: record.costEstimated
						? null
						: record.costUsd;
			insert.run(
				record.harness,
				record.sessionId,
				record.messageId,
				record.turnId ?? null,
				record.isSubagent ? 1 : 0,
				record.cwd,
				record.model,
				rawModel,
				record.timestamp,
				record.inputTokens,
				record.outputTokens,
				record.cacheReadTokens,
				record.cacheWriteTokens,
				record.reasoningTokens,
				record.costUsd,
				rawCostUsd,
				record.costEstimated ? 1 : 0,
			);
		}
		upsertState.run(
			harness,
			state.fingerprint,
			state.indexedAt,
			state.available,
			state.warnings,
		);
	})();
}

export function readSetting(db: StoreDatabase, key: string): string | null {
	const row = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(key);
	return row?.value ?? null;
}

export function writeSetting(
	db: StoreDatabase,
	key: string,
	value: string,
): void {
	db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
		key,
		value,
	);
}

export function readSettingRows(db: StoreDatabase): Record<string, string> {
	const rows = db
		.query<{ key: string; value: string }, []>(
			"SELECT key, value FROM settings",
		)
		.all();
	return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export interface FileStampRow {
	sessionId: string;
	filePath: string;
	mtimeMs: number;
	sizeBytes: number;
}

export function readSessionFileStamps(
	db: StoreDatabase,
	harness: HarnessName,
): FileStampRow[] {
	return db
		.query<
			{
				session_id: string;
				file_path: string;
				mtime_ms: number;
				size_bytes: number;
			},
			[HarnessName]
		>(
			"SELECT session_id, file_path, mtime_ms, size_bytes FROM session_file_stamps WHERE harness = ?",
		)
		.all(harness)
		.map((row) => ({
			sessionId: row.session_id,
			filePath: row.file_path,
			mtimeMs: row.mtime_ms,
			sizeBytes: row.size_bytes,
		}));
}

export function replaceSessionFileStamps(
	db: StoreDatabase,
	harness: HarnessName,
	items: readonly SessionDiscoveryItem[],
): void {
	const remove = db.prepare(
		"DELETE FROM session_file_stamps WHERE harness = ?",
	);
	const insert = db.prepare(
		`INSERT OR REPLACE INTO session_file_stamps
			(harness, session_id, file_path, mtime_ms, size_bytes)
		VALUES (?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		remove.run(harness);
		for (const item of items) {
			insert.run(
				harness,
				item.sessionId,
				item.filePath,
				item.mtimeMs,
				item.sizeBytes,
			);
		}
	})();
}

export function readCatalogMap(db: StoreDatabase): Map<string, SessionMeta> {
	const rows = db
		.query<
			{
				harness: HarnessName;
				session_id: string;
				title: string;
				cwd: string | null;
				started_at: number | null;
				is_subagent: number;
				is_review: number;
				has_transcript: number;
				source_kind: string | null;
				source_path: string | null;
			},
			[]
		>(
			`SELECT harness, session_id, title, cwd, started_at, is_subagent,
				is_review, has_transcript, source_kind, source_path
			FROM session_catalog`,
		)
		.all();
	const entries = new Map<string, SessionMeta>();
	for (const row of rows) {
		const source: SessionSource | null =
			row.source_kind && row.source_path
				? {
						kind: row.source_kind as SessionSource["kind"],
						path: row.source_path,
					}
				: null;
		const key = sessionKey({ harness: row.harness, sessionId: row.session_id });
		entries.set(key, {
			key,
			harness: row.harness,
			sessionId: row.session_id,
			title: row.title,
			cwd: row.cwd,
			startedAt: row.started_at,
			isSubagent: row.is_subagent === 1,
			isReview: row.is_review === 1,
			hasTranscript: row.has_transcript === 1,
			source,
		});
	}
	return entries;
}

export function replaceHarnessCatalog(
	db: StoreDatabase,
	harness: HarnessName,
	entries: ReadonlyMap<string, SessionMeta>,
): void {
	const remove = db.prepare("DELETE FROM session_catalog WHERE harness = ?");
	const insert = db.prepare(
		`INSERT OR REPLACE INTO session_catalog (
			harness, session_id, title, cwd, started_at, is_subagent,
			is_review, has_transcript, source_kind, source_path
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		remove.run(harness);
		for (const meta of entries.values()) {
			if (meta.harness !== harness) continue;
			insert.run(
				meta.harness,
				meta.sessionId,
				meta.title,
				meta.cwd,
				meta.startedAt,
				meta.isSubagent ? 1 : 0,
				meta.isReview ? 1 : 0,
				meta.hasTranscript ? 1 : 0,
				meta.source?.kind ?? null,
				meta.source?.path ?? null,
			);
		}
	})();
}

export function upsertHarnessSessionDelta(
	db: StoreDatabase,
	harness: HarnessName,
	options: {
		changedSessionIds: ReadonlySet<string>;
		removedSessionIds: ReadonlySet<string>;
		records: readonly UsageRecord[];
		messages: ReadonlyMap<string, number>;
		texts: ReadonlyMap<string, string>;
		discoveredItems: readonly SessionDiscoveryItem[];
		catalogEntries: ReadonlyMap<string, SessionMeta>;
		state: SourceStateRow;
	},
): void {
	const affected = new Set([
		...options.changedSessionIds,
		...options.removedSessionIds,
	]);
	const deleteRecords = db.prepare(
		"DELETE FROM usage_records WHERE harness = ? AND session_id = ?",
	);
	const insertRecord = db.prepare(
		`INSERT OR REPLACE INTO usage_records (
			harness, session_id, message_id, turn_id, is_subagent, cwd, model,
			raw_model, timestamp, input_tokens, output_tokens, cache_read_tokens,
			cache_write_tokens, reasoning_tokens, cost_usd, raw_cost_usd, cost_estimated
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const deleteMsg = db.prepare(
		"DELETE FROM session_messages WHERE harness = ? AND session_id = ?",
	);
	const insertMsg = db.prepare(
		"INSERT OR REPLACE INTO session_messages (harness, session_id, messages) VALUES (?, ?, ?)",
	);
	const deleteText = db.prepare(
		"DELETE FROM session_texts WHERE harness = ? AND session_id = ?",
	);
	const insertText = db.prepare(
		"INSERT OR REPLACE INTO session_texts (harness, session_id, body) VALUES (?, ?, ?)",
	);
	let deleteFts = null;
	let insertFts = null;
	try {
		deleteFts = db.prepare(
			"DELETE FROM fts_session_text WHERE harness = ? AND session_id = ?",
		);
		insertFts = db.prepare(
			"INSERT INTO fts_session_text (harness, session_id, body) VALUES (?, ?, ?)",
		);
	} catch {}
	const deleteCatalog = db.prepare(
		"DELETE FROM session_catalog WHERE harness = ? AND session_id = ?",
	);
	const insertCatalog = db.prepare(
		`INSERT OR REPLACE INTO session_catalog (
			harness, session_id, title, cwd, started_at, is_subagent,
			is_review, has_transcript, source_kind, source_path
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const deleteStamp = db.prepare(
		"DELETE FROM session_file_stamps WHERE harness = ? AND session_id = ?",
	);
	const insertStamp = db.prepare(
		`INSERT OR REPLACE INTO session_file_stamps
			(harness, session_id, file_path, mtime_ms, size_bytes)
		VALUES (?, ?, ?, ?, ?)`,
	);
	const upsertState = db.prepare(
		`INSERT OR REPLACE INTO source_state
			(harness, fingerprint, indexed_at, available, warnings)
		VALUES (?, ?, ?, ?, ?)`,
	);

	db.transaction(() => {
		for (const sessionId of affected) {
			deleteRecords.run(harness, sessionId);
			deleteMsg.run(harness, sessionId);
			deleteText.run(harness, sessionId);
			if (deleteFts) deleteFts.run(harness, sessionId);
			deleteCatalog.run(harness, sessionId);
			deleteStamp.run(harness, sessionId);
		}
		for (const record of options.records) {
			if (!options.changedSessionIds.has(record.sessionId)) continue;
			const rawModel = record.rawModel ?? record.pricingModel ?? record.model;
			const rawCostUsd =
				record.rawCostUsd !== undefined
					? record.rawCostUsd
					: record.costEstimated
						? null
						: record.costUsd;
			insertRecord.run(
				record.harness,
				record.sessionId,
				record.messageId,
				record.turnId ?? null,
				record.isSubagent ? 1 : 0,
				record.cwd,
				record.model,
				rawModel,
				record.timestamp,
				record.inputTokens,
				record.outputTokens,
				record.cacheReadTokens,
				record.cacheWriteTokens,
				record.reasoningTokens,
				record.costUsd,
				rawCostUsd,
				record.costEstimated ? 1 : 0,
			);
		}
		for (const sessionId of options.changedSessionIds) {
			const msgCount = options.messages.get(sessionId);
			if (msgCount !== undefined) {
				insertMsg.run(harness, sessionId, msgCount);
			}
			const text = options.texts.get(sessionId);
			if (text) {
				insertText.run(harness, sessionId, text);
				if (insertFts) insertFts.run(harness, sessionId, text);
			}
			const key = sessionKey({ harness, sessionId });
			const meta = options.catalogEntries.get(key);
			if (meta) {
				insertCatalog.run(
					meta.harness,
					meta.sessionId,
					meta.title,
					meta.cwd,
					meta.startedAt,
					meta.isSubagent ? 1 : 0,
					meta.isReview ? 1 : 0,
					meta.hasTranscript ? 1 : 0,
					meta.source?.kind ?? null,
					meta.source?.path ?? null,
				);
			}
		}
		for (const item of options.discoveredItems) {
			if (!options.changedSessionIds.has(item.sessionId)) continue;
			insertStamp.run(
				harness,
				item.sessionId,
				item.filePath,
				item.mtimeMs,
				item.sizeBytes,
			);
		}
		upsertState.run(
			harness,
			options.state.fingerprint,
			options.state.indexedAt,
			options.state.available,
			options.state.warnings,
		);
	})();
}

export interface RecordPricingUpdate {
	harness: HarnessName;
	sessionId: string;
	messageId: string;
	model: string;
	costUsd: number | null;
	costEstimated: boolean;
}

export function updateRecordPricingBatch(
	db: StoreDatabase,
	updates: readonly RecordPricingUpdate[],
): void {
	if (!updates.length) return;
	const stmt = db.prepare(
		`UPDATE usage_records
		SET model = ?, cost_usd = ?, cost_estimated = ?
		WHERE harness = ? AND session_id = ? AND message_id = ?`,
	);
	db.transaction(() => {
		for (const item of updates) {
			stmt.run(
				item.model,
				item.costUsd,
				item.costEstimated ? 1 : 0,
				item.harness,
				item.sessionId,
				item.messageId,
			);
		}
	})();
}
