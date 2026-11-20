import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { HarnessId, UsageRecord } from "../../shared/types";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../platform/paths";
import {
	openSafeReadonlyDatabase,
	type SafeDatabaseHandle,
} from "../platform/sqlite";

export interface UsageFilter {
	harness?: HarnessId | HarnessId[];
	sessionId?: string;
	from?: number | null;
	until?: number | null;
	model?: string;
	limit?: number;
	offset?: number;
}

export interface SourceState {
	harness: HarnessId;
	fingerprint: string;
	indexedAt: number;
	available: boolean;
	warnings: string[];
}

export interface SessionSearchResult {
	harness: HarnessId;
	sessionId: string;
	snippet: string | null;
	rank: number;
}

export interface HarnessBatchData {
	harness: HarnessId;
	records: UsageRecord[];
	state: SourceState;
	messages?: ReadonlyMap<string, number> | Record<string, number>;
	texts?: ReadonlyMap<string, string> | Record<string, string>;
}

export interface StorageServiceOptions {
	dbPath?: string;
	pathService?: PlatformPathService;
	busyTimeoutMs?: number;
}

export interface StorageService {
	readonly dbPath: string;
	readonly isInitialized: boolean;

	init(): Promise<void>;
	close(): Promise<void>;

	// Usage records
	getUsageRecords(filter?: UsageFilter): Promise<UsageRecord[]>;
	saveUsageRecords(records: UsageRecord[]): Promise<void>;
	deleteHarnessRecords(harnessId: HarnessId): Promise<void>;

	// Source state
	getSourceState(harnessId: HarnessId): Promise<SourceState | null>;
	saveSourceState(state: SourceState): Promise<void>;
	getAllSourceStates(): Promise<SourceState[]>;

	// Session texts & FTS
	getSessionText(
		harnessId: HarnessId,
		sessionId: string,
	): Promise<string | null>;
	saveSessionText(
		harnessId: HarnessId,
		sessionId: string,
		text: string,
	): Promise<void>;
	getAllSessionTexts(harnessId?: HarnessId): Promise<Map<string, string>>;
	searchSessionText(
		query: string,
		options?: { harnessId?: HarnessId; limit?: number },
	): Promise<SessionSearchResult[]>;

	// Session messages
	getSessionMessages(harnessId?: HarnessId): Promise<Map<string, number>>;
	saveSessionMessages(
		harnessId: HarnessId,
		messages: ReadonlyMap<string, number>,
	): Promise<void>;

	// Settings
	getSetting<T = string>(key: string): Promise<T | null>;
	saveSetting(key: string, value: string): Promise<void>;
	setSetting(key: string, value: unknown): Promise<void>;
	getAllSettings(): Promise<Record<string, string>>;

	// Batch atomic operations
	saveHarnessBatch(batch: HarnessBatchData): Promise<void>;
	saveHarnessBatches(batches: HarnessBatchData[]): Promise<void>;

	// Readonly handle integration
	getReadonlyHandle(): SafeDatabaseHandle;
}

export function sanitizeFts5Query(raw: string): string {
	const cleaned = raw.replaceAll(/"/gu, '""');
	const tokens = cleaned
		.split(/\s+/u)
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));

	if (!tokens.length) return "";
	return tokens.map((token) => `"${token}"*`).join(" ");
}

export function resolveDatabasePath(
	options: StorageServiceOptions,
	pathService: PlatformPathService = defaultPlatformPathService,
): string {
	if (options.dbPath) {
		return pathService.normalize(options.dbPath);
	}

	const envPath =
		process.env.CODING_TOKENS_DB_PATH ?? process.env.CODING_TOKENS_DB;
	if (envPath) {
		return pathService.normalize(pathService.expandPath(envPath));
	}

	const standardDir = pathService.getDataDir("coding-tokens");
	const standardDbPath = path.join(standardDir, "coding-tokens.sqlite");

	// Legacy migration check: ~/.cache/coding-tokens/coding-tokens.sqlite
	const legacyDbPath = path.join(
		pathService.getHomeDir(),
		".cache",
		"coding-tokens",
		"coding-tokens.sqlite",
	);

	if (!existsSync(standardDbPath) && existsSync(legacyDbPath)) {
		try {
			mkdirSync(standardDir, { recursive: true });
			copyFileSync(legacyDbPath, standardDbPath);
			for (const ext of ["-wal", "-shm"]) {
				const sidecar = `${legacyDbPath}${ext}`;
				if (existsSync(sidecar)) {
					try {
						copyFileSync(sidecar, `${standardDbPath}${ext}`);
					} catch {}
				}
			}
		} catch {
			return legacyDbPath;
		}
	}

	return pathService.normalize(standardDbPath);
}

interface Migration {
	version: number;
	name: string;
	up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "initial_schema",
		up: (db) => {
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
				CREATE TABLE IF NOT EXISTS session_texts (
					harness TEXT NOT NULL,
					session_id TEXT NOT NULL,
					body TEXT NOT NULL,
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
			`);
		},
	},
	{
		version: 2,
		name: "fts5_and_performance_indexes",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS session_texts (
					harness TEXT NOT NULL,
					session_id TEXT NOT NULL,
					body TEXT NOT NULL,
					PRIMARY KEY (harness, session_id)
				);
				CREATE INDEX IF NOT EXISTS usage_records_timestamp
					ON usage_records (timestamp);
				CREATE INDEX IF NOT EXISTS usage_records_session
					ON usage_records (harness, session_id);
				CREATE INDEX IF NOT EXISTS usage_records_model
					ON usage_records (model);
				CREATE VIRTUAL TABLE IF NOT EXISTS fts_session_text USING fts5(
					harness UNINDEXED,
					session_id UNINDEXED,
					body,
					tokenize = 'unicode61'
				);
				DELETE FROM fts_session_text;
				INSERT INTO fts_session_text (harness, session_id, body)
				SELECT harness, session_id, body FROM session_texts;
			`);
		},
	},
	{
		version: 3,
		name: "ensure_session_texts_table",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS session_texts (
					harness TEXT NOT NULL,
					session_id TEXT NOT NULL,
					body TEXT NOT NULL,
					PRIMARY KEY (harness, session_id)
				);
			`);
		},
	},
	{
		version: 4,
		name: "session_catalog_and_file_stamps",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS session_catalog (
					harness TEXT NOT NULL,
					session_id TEXT NOT NULL,
					title TEXT NOT NULL,
					cwd TEXT,
					started_at INTEGER,
					is_subagent INTEGER NOT NULL DEFAULT 0,
					is_review INTEGER NOT NULL DEFAULT 0,
					has_transcript INTEGER NOT NULL DEFAULT 0,
					source_kind TEXT,
					source_path TEXT,
					PRIMARY KEY (harness, session_id)
				);
				CREATE TABLE IF NOT EXISTS session_file_stamps (
					harness TEXT NOT NULL,
					session_id TEXT NOT NULL,
					file_path TEXT NOT NULL,
					mtime_ms REAL NOT NULL,
					size_bytes INTEGER NOT NULL,
					PRIMARY KEY (harness, session_id, file_path)
				);
			`);
		},
	},
	{
		version: 5,
		name: "preserve_raw_pricing_fields",
		up: (db) => {
			const cols = new Set(
				db
					.query<{ name: string }, []>("PRAGMA table_info(usage_records)")
					.all()
					.map((row) => row.name),
			);
			if (!cols.has("raw_model")) {
				db.exec("ALTER TABLE usage_records ADD COLUMN raw_model TEXT;");
			}
			if (!cols.has("raw_cost_usd")) {
				db.exec("ALTER TABLE usage_records ADD COLUMN raw_cost_usd REAL;");
			}
			db.exec(`
				UPDATE usage_records
				SET raw_model = model,
					raw_cost_usd = CASE WHEN cost_estimated = 0 THEN cost_usd ELSE NULL END
				WHERE raw_model IS NULL;
			`);
		},
	},
	{
		version: 6,
		name: "add_is_review_and_pricing_model",
		up: (db) => {
			const cols = new Set(
				db
					.query<{ name: string }, []>("PRAGMA table_info(usage_records)")
					.all()
					.map((row) => row.name),
			);
			if (!cols.has("is_review")) {
				db.exec(
					"ALTER TABLE usage_records ADD COLUMN is_review INTEGER NOT NULL DEFAULT 0;",
				);
			}
			if (!cols.has("pricing_model")) {
				db.exec("ALTER TABLE usage_records ADD COLUMN pricing_model TEXT;");
			}
		},
	},
];

export function runMigrations(db: Database): void {
	const currentVersion =
		db.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version ?? 0;

	for (const migration of MIGRATIONS) {
		if (migration.version > currentVersion) {
			db.transaction(() => {
				migration.up(db);
				db.exec(`PRAGMA user_version = ${migration.version};`);
			})();
		}
	}
}

function parseWarningsJson(raw: string, harness: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch (err) {
		console.warn(
			`StorageService: failed to parse stored warnings for ${harness}: ${String(err)}`,
		);
		return [];
	}
}

export class DefaultStorageService implements StorageService {
	readonly dbPath: string;
	private db: Database | null = null;
	private initialized = false;
	private readonly busyTimeoutMs: number;

	constructor(
		options: StorageServiceOptions = {},
		private readonly pathService: PlatformPathService = options.pathService ??
			defaultPlatformPathService,
	) {
		this.dbPath = resolveDatabasePath(options, this.pathService);
		const busyTimeout = options.busyTimeoutMs ?? 5000;
		if (!Number.isInteger(busyTimeout) || busyTimeout < 0) {
			throw new RangeError(`Invalid busyTimeoutMs: ${String(busyTimeout)}`);
		}
		this.busyTimeoutMs = busyTimeout;
	}

	get isInitialized(): boolean {
		return this.initialized && this.db !== null;
	}

	async init(): Promise<void> {
		if (this.initialized && this.db) return;
		mkdirSync(path.dirname(this.dbPath), { recursive: true });
		const db = new Database(this.dbPath, { create: true });
		try {
			db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
			db.exec("PRAGMA journal_mode = WAL;");
			db.exec("PRAGMA synchronous = NORMAL;");

			runMigrations(db);

			this.db = db;
			this.initialized = true;
		} catch (err) {
			try {
				db.close();
			} catch {
				// preserve initialization error
			}
			throw err;
		}
	}

	async close(): Promise<void> {
		const db = this.db;
		this.db = null;
		this.initialized = false;
		if (db) {
			db.close();
		}
	}

	private getDb(): Database {
		if (!this.db) {
			throw new Error("StorageService is not initialized. Call init() first.");
		}
		return this.db;
	}

	getDatabase(): Database {
		return this.getDb();
	}

	async getUsageRecords(filter?: UsageFilter): Promise<UsageRecord[]> {
		const db = this.getDb();
		const clauses: string[] = [];
		const params: (string | number)[] = [];

		if (filter?.harness) {
			if (Array.isArray(filter.harness)) {
				if (filter.harness.length > 0) {
					const placeholders = filter.harness.map(() => "?").join(", ");
					clauses.push(`harness IN (${placeholders})`);
					params.push(...filter.harness);
				}
			} else {
				clauses.push("harness = ?");
				params.push(filter.harness);
			}
		}

		if (filter?.sessionId) {
			clauses.push("session_id = ?");
			params.push(filter.sessionId);
		}

		if (filter?.model) {
			clauses.push("model = ?");
			params.push(filter.model);
		}

		if (filter?.from !== undefined && filter?.from !== null) {
			clauses.push("timestamp >= ?");
			params.push(filter.from);
		}

		if (filter?.until !== undefined && filter?.until !== null) {
			clauses.push("timestamp <= ?");
			params.push(filter.until);
		}

		let sql = `
			SELECT harness, session_id, message_id, turn_id, is_subagent, is_review,
				cwd, model, pricing_model, raw_model, timestamp, input_tokens,
				output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
				cost_usd, raw_cost_usd, cost_estimated
			FROM usage_records
		`;

		if (clauses.length > 0) {
			sql += ` WHERE ${clauses.join(" AND ")}`;
		}

		sql += " ORDER BY timestamp ASC";

		if (filter?.limit !== undefined) {
			const limit = Number(filter.limit);
			if (!Number.isInteger(limit) || limit < 0) {
				throw new RangeError(`Invalid limit: ${String(filter.limit)}`);
			}
			sql += " LIMIT ?";
			params.push(limit);
			if (filter?.offset !== undefined) {
				const offset = Number(filter.offset);
				if (!Number.isInteger(offset) || offset < 0) {
					throw new RangeError(`Invalid offset: ${String(filter.offset)}`);
				}
				sql += " OFFSET ?";
				params.push(offset);
			}
		}

		const rows = db
			.query<
				{
					harness: HarnessId;
					session_id: string;
					message_id: string;
					turn_id: string | null;
					is_subagent: number;
					is_review: number;
					cwd: string | null;
					model: string;
					pricing_model: string | null;
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
				(string | number)[]
			>(sql)
			.all(...params);

		return rows.map((row) => ({
			harness: row.harness,
			sessionId: row.session_id,
			messageId: row.message_id,
			turnId: row.turn_id ?? undefined,
			isSubagent: row.is_subagent === 1 || undefined,
			isReview: row.is_review === 1 || undefined,
			cwd: row.cwd,
			model: row.model,
			pricingModel: row.pricing_model ?? undefined,
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

	async saveUsageRecords(records: UsageRecord[]): Promise<void> {
		const db = this.getDb();
		const insert = db.prepare(
			`INSERT OR REPLACE INTO usage_records (
				harness, session_id, message_id, turn_id, is_subagent, is_review,
				cwd, model, pricing_model, raw_model, timestamp, input_tokens,
				output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
				cost_usd, raw_cost_usd, cost_estimated
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		db.transaction(() => {
			for (const r of records) {
				const rawModel = r.rawModel ?? r.pricingModel ?? r.model;
				const rawCostUsd =
					r.rawCostUsd !== undefined
						? r.rawCostUsd
						: r.costEstimated
							? null
							: r.costUsd;
				insert.run(
					r.harness,
					r.sessionId,
					r.messageId,
					r.turnId ?? null,
					r.isSubagent ? 1 : 0,
					r.isReview ? 1 : 0,
					r.cwd,
					r.model,
					r.pricingModel ?? null,
					rawModel,
					r.timestamp,
					r.inputTokens,
					r.outputTokens,
					r.cacheReadTokens,
					r.cacheWriteTokens,
					r.reasoningTokens,
					r.costUsd,
					rawCostUsd,
					r.costEstimated ? 1 : 0,
				);
			}
		})();
	}

	async deleteHarnessRecords(harnessId: HarnessId): Promise<void> {
		const db = this.getDb();
		db.transaction(() => {
			db.prepare("DELETE FROM usage_records WHERE harness = ?").run(harnessId);
			db.prepare("DELETE FROM session_messages WHERE harness = ?").run(
				harnessId,
			);
			db.prepare("DELETE FROM session_texts WHERE harness = ?").run(harnessId);
			db.prepare("DELETE FROM fts_session_text WHERE harness = ?").run(
				harnessId,
			);
			db.prepare("DELETE FROM session_catalog WHERE harness = ?").run(
				harnessId,
			);
			db.prepare("DELETE FROM session_file_stamps WHERE harness = ?").run(
				harnessId,
			);
			db.prepare("DELETE FROM source_state WHERE harness = ?").run(harnessId);
		})();
	}

	async getSourceState(harnessId: HarnessId): Promise<SourceState | null> {
		const db = this.getDb();
		const row = db
			.query<
				{
					fingerprint: string;
					indexed_at: number;
					available: number;
					warnings: string;
				},
				[string]
			>(
				"SELECT fingerprint, indexed_at, available, warnings FROM source_state WHERE harness = ?",
			)
			.get(harnessId);

		if (!row) return null;
		const warnings = parseWarningsJson(row.warnings, harnessId);

		return {
			harness: harnessId,
			fingerprint: row.fingerprint,
			indexedAt: row.indexed_at,
			available: row.available === 1,
			warnings,
		};
	}

	async saveSourceState(state: SourceState): Promise<void> {
		const db = this.getDb();
		db.prepare(
			`INSERT OR REPLACE INTO source_state
				(harness, fingerprint, indexed_at, available, warnings)
			VALUES (?, ?, ?, ?, ?)`,
		).run(
			state.harness,
			state.fingerprint,
			state.indexedAt,
			state.available ? 1 : 0,
			JSON.stringify(state.warnings),
		);
	}

	async getAllSourceStates(): Promise<SourceState[]> {
		const db = this.getDb();
		const rows = db
			.query<
				{
					harness: HarnessId;
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

		return rows.map((row) => ({
			harness: row.harness,
			fingerprint: row.fingerprint,
			indexedAt: row.indexed_at,
			available: row.available === 1,
			warnings: parseWarningsJson(row.warnings, row.harness),
		}));
	}

	async getSessionText(
		harnessId: HarnessId,
		sessionId: string,
	): Promise<string | null> {
		const db = this.getDb();
		const row = db
			.query<{ body: string }, [string, string]>(
				"SELECT body FROM session_texts WHERE harness = ? AND session_id = ?",
			)
			.get(harnessId, sessionId);
		return row?.body ?? null;
	}

	async saveSessionText(
		harnessId: HarnessId,
		sessionId: string,
		text: string,
	): Promise<void> {
		const db = this.getDb();
		db.transaction(() => {
			db.prepare(
				"INSERT OR REPLACE INTO session_texts (harness, session_id, body) VALUES (?, ?, ?)",
			).run(harnessId, sessionId, text);
			db.prepare(
				"DELETE FROM fts_session_text WHERE harness = ? AND session_id = ?",
			).run(harnessId, sessionId);
			db.prepare(
				"INSERT INTO fts_session_text (harness, session_id, body) VALUES (?, ?, ?)",
			).run(harnessId, sessionId, text);
		})();
	}

	async getAllSessionTexts(
		harnessId?: HarnessId,
	): Promise<Map<string, string>> {
		const db = this.getDb();
		let sql = "SELECT harness, session_id, body FROM session_texts";
		const params: string[] = [];
		if (harnessId) {
			sql += " WHERE harness = ?";
			params.push(harnessId);
		}
		const rows = db
			.query<
				{ harness: HarnessId; session_id: string; body: string },
				string[]
			>(sql)
			.all(...params);
		return new Map(
			rows.map((row) => [`${row.harness}:${row.session_id}`, row.body]),
		);
	}

	async searchSessionText(
		query: string,
		options: { harnessId?: HarnessId; limit?: number } = {},
	): Promise<SessionSearchResult[]> {
		const db = this.getDb();
		const sanitized = sanitizeFts5Query(query);
		if (!sanitized) return [];

		const limit = options.limit ?? 20;
		let sql = `
			SELECT harness, session_id, snippet(fts_session_text, 2, '<b>', '</b>', '…', 32) AS snippet, bm25(fts_session_text) AS rank
			FROM fts_session_text
			WHERE fts_session_text MATCH ?
		`;
		const params: (string | number)[] = [sanitized];

		if (options.harnessId) {
			sql += " AND harness = ?";
			params.push(options.harnessId);
		}

		sql += " ORDER BY rank ASC LIMIT ?";
		params.push(limit);

		const rows = db
			.query<
				{
					harness: HarnessId;
					session_id: string;
					snippet: string;
					rank: number;
				},
				(string | number)[]
			>(sql)
			.all(...params);

		return rows.map((r) => ({
			harness: r.harness,
			sessionId: r.session_id,
			snippet: r.snippet,
			rank: r.rank,
		}));
	}

	async getSessionMessages(
		harnessId?: HarnessId,
	): Promise<Map<string, number>> {
		const db = this.getDb();
		let sql = "SELECT harness, session_id, messages FROM session_messages";
		const params: string[] = [];
		if (harnessId) {
			sql += " WHERE harness = ?";
			params.push(harnessId);
		}
		const rows = db
			.query<
				{ harness: HarnessId; session_id: string; messages: number },
				string[]
			>(sql)
			.all(...params);
		return new Map(
			rows.map((row) => [`${row.harness}:${row.session_id}`, row.messages]),
		);
	}

	async saveSessionMessages(
		harnessId: HarnessId,
		messages: ReadonlyMap<string, number>,
	): Promise<void> {
		const db = this.getDb();
		const remove = db.prepare("DELETE FROM session_messages WHERE harness = ?");
		const insert = db.prepare(
			"INSERT OR REPLACE INTO session_messages (harness, session_id, messages) VALUES (?, ?, ?)",
		);
		db.transaction(() => {
			remove.run(harnessId);
			for (const [sessionId, count] of messages) {
				insert.run(harnessId, sessionId, count);
			}
		})();
	}

	async getSetting<T = string>(key: string): Promise<T | null> {
		const db = this.getDb();
		const row = db
			.query<{ value: string }, [string]>(
				"SELECT value FROM settings WHERE key = ?",
			)
			.get(key);
		if (!row) return null;
		try {
			return JSON.parse(row.value) as T;
		} catch {
			return row.value as unknown as T;
		}
	}

	async saveSetting(key: string, value: string): Promise<void> {
		const db = this.getDb();
		db.prepare(
			"INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
		).run(key, value);
	}

	async setSetting(key: string, value: unknown): Promise<void> {
		const str = typeof value === "string" ? value : JSON.stringify(value);
		await this.saveSetting(key, str);
	}

	async getAllSettings(): Promise<Record<string, string>> {
		const db = this.getDb();
		const rows = db
			.query<{ key: string; value: string }, []>(
				"SELECT key, value FROM settings",
			)
			.all();
		return Object.fromEntries(rows.map((r) => [r.key, r.value]));
	}

	async saveHarnessBatch(batch: HarnessBatchData): Promise<void> {
		const db = this.getDb();
		const insertRecord = db.prepare(
			`INSERT OR REPLACE INTO usage_records (
				harness, session_id, message_id, turn_id, is_subagent, is_review,
				cwd, model, pricing_model, raw_model, timestamp, input_tokens,
				output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
				cost_usd, raw_cost_usd, cost_estimated
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const removeRecords = db.prepare(
			"DELETE FROM usage_records WHERE harness = ?",
		);
		const upsertState = db.prepare(
			`INSERT OR REPLACE INTO source_state
				(harness, fingerprint, indexed_at, available, warnings)
			VALUES (?, ?, ?, ?, ?)`,
		);

		const removeMessages = db.prepare(
			"DELETE FROM session_messages WHERE harness = ?",
		);
		const insertMessage = db.prepare(
			"INSERT OR REPLACE INTO session_messages (harness, session_id, messages) VALUES (?, ?, ?)",
		);

		const removeTexts = db.prepare(
			"DELETE FROM session_texts WHERE harness = ?",
		);
		const insertText = db.prepare(
			"INSERT OR REPLACE INTO session_texts (harness, session_id, body) VALUES (?, ?, ?)",
		);

		const removeFts = db.prepare(
			"DELETE FROM fts_session_text WHERE harness = ?",
		);
		const insertFts = db.prepare(
			"INSERT INTO fts_session_text (harness, session_id, body) VALUES (?, ?, ?)",
		);

		db.transaction(() => {
			// Records
			removeRecords.run(batch.harness);
			for (const r of batch.records) {
				const rawModel = r.rawModel ?? r.pricingModel ?? r.model;
				const rawCostUsd =
					r.rawCostUsd !== undefined
						? r.rawCostUsd
						: r.costEstimated
							? null
							: r.costUsd;
				insertRecord.run(
					r.harness,
					r.sessionId,
					r.messageId,
					r.turnId ?? null,
					r.isSubagent ? 1 : 0,
					r.isReview ? 1 : 0,
					r.cwd,
					r.model,
					r.pricingModel ?? null,
					rawModel,
					r.timestamp,
					r.inputTokens,
					r.outputTokens,
					r.cacheReadTokens,
					r.cacheWriteTokens,
					r.reasoningTokens,
					r.costUsd,
					rawCostUsd,
					r.costEstimated ? 1 : 0,
				);
			}

			// State
			upsertState.run(
				batch.harness,
				batch.state.fingerprint,
				batch.state.indexedAt,
				batch.state.available ? 1 : 0,
				JSON.stringify(batch.state.warnings),
			);

			// Messages
			if (batch.messages) {
				removeMessages.run(batch.harness);
				const msgEntries =
					batch.messages instanceof Map
						? batch.messages.entries()
						: Object.entries(batch.messages);
				for (const [sessionId, count] of msgEntries) {
					insertMessage.run(batch.harness, sessionId, count);
				}
			}

			// Texts
			if (batch.texts) {
				removeTexts.run(batch.harness);
				removeFts.run(batch.harness);
				const textEntries =
					batch.texts instanceof Map
						? batch.texts.entries()
						: Object.entries(batch.texts);
				for (const [sessionId, body] of textEntries) {
					insertText.run(batch.harness, sessionId, body);
					insertFts.run(batch.harness, sessionId, body);
				}
			}
		})();
	}

	async saveHarnessBatches(batches: HarnessBatchData[]): Promise<void> {
		for (const batch of batches) {
			await this.saveHarnessBatch(batch);
		}
	}

	getReadonlyHandle(): SafeDatabaseHandle {
		return openSafeReadonlyDatabase(this.dbPath);
	}
}

export function createStorageService(
	options?: StorageServiceOptions,
): StorageService {
	return new DefaultStorageService(options);
}

export const defaultStorageService = new DefaultStorageService();
