import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { HarnessName, UsageRecord } from "@shared/types";
import { runMigrations } from "../../src/services/storage";

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
				timestamp: number | null;
				input_tokens: number;
				output_tokens: number;
				cache_read_tokens: number;
				cache_write_tokens: number;
				reasoning_tokens: number;
				cost_usd: number | null;
				cost_estimated: number;
			},
			[HarnessName]
		>(
			`SELECT harness, session_id, message_id, turn_id, is_subagent, cwd, model,
				timestamp, input_tokens, output_tokens, cache_read_tokens,
				cache_write_tokens, reasoning_tokens, cost_usd, cost_estimated
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
		timestamp: row.timestamp,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheWriteTokens: row.cache_write_tokens,
		reasoningTokens: row.reasoning_tokens,
		costUsd: row.cost_usd,
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
			timestamp, input_tokens, output_tokens, cache_read_tokens,
			cache_write_tokens, reasoning_tokens, cost_usd, cost_estimated
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			insert.run(
				record.harness,
				record.sessionId,
				record.messageId,
				record.turnId ?? null,
				record.isSubagent ? 1 : 0,
				record.cwd,
				record.model,
				record.timestamp,
				record.inputTokens,
				record.outputTokens,
				record.cacheReadTokens,
				record.cacheWriteTokens,
				record.reasoningTokens,
				record.costUsd,
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
