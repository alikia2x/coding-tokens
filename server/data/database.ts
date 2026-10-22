import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { HarnessName, UsageRecord } from "@shared/types";

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
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS usage_records (
			harness TEXT NOT NULL,
			session_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			turn_id TEXT,
			is_subagent INTEGER NOT NULL DEFAULT 0,
			cwd TEXT,
			model TEXT NOT NULL,
			timestamp INTEGER,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL,
			cost_estimated INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (harness, session_id, message_id)
		);
		CREATE INDEX IF NOT EXISTS usage_records_harness_timestamp
			ON usage_records (harness, timestamp);
		CREATE TABLE IF NOT EXISTS session_messages (
			harness TEXT NOT NULL,
			session_id TEXT NOT NULL,
			messages INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (harness, session_id)
		);
		CREATE TABLE IF NOT EXISTS source_state (
			harness TEXT PRIMARY KEY,
			fingerprint TEXT NOT NULL,
			indexed_at INTEGER NOT NULL,
			available INTEGER NOT NULL,
			warnings TEXT NOT NULL DEFAULT '[]'
		);
		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		PRAGMA user_version = 1;
	`);
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
