import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Ensures parent directory exists and enables WAL mode on an SQLite database.
 */
export function createDatabase(
	dbPath: string,
	options?: { wal?: boolean },
): Database {
	mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	if (options?.wal !== false) {
		db.run("PRAGMA journal_mode = WAL;");
		db.run("PRAGMA synchronous = NORMAL;");
	}
	return db;
}

/**
 * Opens an SQLite database in strictly readonly mode.
 */
export function openReadonlyDb(dbPath: string): Database {
	return new Database(dbPath, { readonly: true });
}

/**
 * Safely checkpoints and closes an SQLite database, preventing lingering WAL/SHM lock files.
 */
export function closeDatabase(db: Database): void {
	try {
		db.run("PRAGMA wal_checkpoint(TRUNCATE);");
	} catch {
		// Ignore checkpoint errors if db is already closed or readonly
	}
	db.close();
}

export interface OpenCodeSessionInput {
	id: string;
	directory: string;
	model?: string;
	messages?: Array<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		time?: number;
	}>;
}

/**
 * Seeds an OpenCode SQLite database (supports both v2 schema and legacy v1 schema).
 */
export function seedOpenCodeDb(
	dbPath: string,
	options?: {
		version?: "v1" | "v2" | "both";
		sessions?: OpenCodeSessionInput[];
	},
): Database {
	const db = createDatabase(dbPath);
	const version = options?.version ?? "v2";

	if (version === "v2" || version === "both") {
		db.run("DROP TABLE IF EXISTS session_message;");
		db.run("DROP TABLE IF EXISTS session_v2;");
		db.run(`
			CREATE TABLE session_v2 (
				id TEXT PRIMARY KEY,
				directory TEXT NOT NULL,
				model TEXT
			);
		`);
		db.run(`
			CREATE TABLE session_message (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				data TEXT NOT NULL,
				time_created INTEGER NOT NULL
			);
		`);
	}

	if (version === "v1" || version === "both") {
		db.run("DROP TABLE IF EXISTS message;");
		db.run("DROP TABLE IF EXISTS session;");
		db.run(`
			CREATE TABLE session (
				id TEXT PRIMARY KEY,
				directory TEXT NOT NULL,
				time_created INTEGER NOT NULL
			);
		`);
		db.run(`
			CREATE TABLE message (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				time_created INTEGER NOT NULL,
				data TEXT NOT NULL
			);
		`);
	}

	const sessions = options?.sessions ?? [
		{
			id: "oc-sess-default",
			directory: "/workspace/opencode-demo",
			model: "claude-3-5-sonnet",
			messages: [
				{
					id: "msg-user-1",
					type: "user",
					data: { role: "user", text: "Create API test suite" },
					time: 1773500000000,
				},
				{
					id: "msg-asst-1",
					type: "assistant",
					data: {
						model: { id: "claude-3-5-sonnet", providerID: "anthropic" },
						tokens: {
							input: 2400,
							output: 580,
							reasoning: 0,
							cache: { read: 1200, write: 300 },
						},
						cost: 0.0125,
						time: { created: 1773500010000 },
					},
					time: 1773500010000,
				},
			],
		},
	];

	for (const sess of sessions) {
		if (version === "v2" || version === "both") {
			db.run(
				"INSERT OR REPLACE INTO session_v2 (id, directory, model) VALUES (?, ?, ?);",
				[sess.id, sess.directory, sess.model ?? "claude-3-5-sonnet"],
			);
			if (sess.messages) {
				for (const msg of sess.messages) {
					db.run(
						"INSERT OR REPLACE INTO session_message (id, session_id, type, data, time_created) VALUES (?, ?, ?, ?, ?);",
						[
							msg.id,
							sess.id,
							msg.type,
							JSON.stringify(msg.data),
							msg.time ?? Date.now(),
						],
					);
				}
			}
		}

		if (version === "v1" || version === "both") {
			const now = Date.now();
			db.run(
				"INSERT OR REPLACE INTO session (id, directory, time_created) VALUES (?, ?, ?);",
				[sess.id, sess.directory, now],
			);
			if (sess.messages) {
				for (const msg of sess.messages) {
					db.run(
						"INSERT OR REPLACE INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?);",
						[msg.id, sess.id, msg.time ?? now, JSON.stringify(msg.data)],
					);
				}
			}
		}
	}

	return db;
}

export interface CursorComposerInput {
	composerId: string;
	createdAt?: number;
	unifiedMode?: string;
	modelName?: string;
	text?: string;
	conversationMap?: Record<string, unknown>;
}

/**
 * Seeds a Cursor global or workspace state.vscdb database.
 */
export function seedCursorDb(
	dbPath: string,
	options?: {
		composers?: CursorComposerInput[];
		itemTableEntries?: Record<string, string>;
	},
): Database {
	const db = createDatabase(dbPath);

	db.run("DROP TABLE IF EXISTS ItemTable;");
	db.run("DROP TABLE IF EXISTS cursorDiskKV;");
	db.run(`
		CREATE TABLE ItemTable (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	db.run(`
		CREATE TABLE cursorDiskKV (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	const composers = options?.composers ?? [
		{
			composerId: "cursor-comp-default-1",
			createdAt: 1773500000000,
			unifiedMode: "agent",
			modelName: "claude-3-5-sonnet",
			text: "Implement cursor parser",
			conversationMap: {
				"bubble-1": { type: "user", text: "Implement cursor parser" },
				"bubble-2": {
					type: "ai",
					text: "Implementing...",
					tokenUsage: { inputTokens: 2500, outputTokens: 420 },
				},
			},
		},
	];

	for (const comp of composers) {
		const payload = {
			composerId: comp.composerId,
			createdAt: comp.createdAt ?? Date.now(),
			unifiedMode: comp.unifiedMode ?? "agent",
			modelConfig: {
				modelName: comp.modelName ?? "claude-3-5-sonnet",
				maxMode: false,
			},
			text: comp.text ?? "Sample user request",
			conversationMap: comp.conversationMap ?? {},
		};
		db.run("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?);", [
			`composerData:${comp.composerId}`,
			JSON.stringify(payload),
		]);
	}

	// Workspace list in ItemTable
	const composerList = composers.map((c) => ({
		composerId: c.composerId,
		createdAt: c.createdAt ?? Date.now(),
		unifiedMode: c.unifiedMode ?? "agent",
	}));
	db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?);", [
		"composer.composerData",
		JSON.stringify({ allComposers: composerList }),
	]);

	if (options?.itemTableEntries) {
		for (const [k, v] of Object.entries(options.itemTableEntries)) {
			db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?);", [
				k,
				v,
			]);
		}
	}

	return db;
}

export interface ContinueTokenRecordInput {
	model: string;
	provider: string;
	tokensGenerated: number;
	tokensPrompt: number;
	timestamp?: string;
}

/**
 * Seeds a Continue devdata.sqlite database with tokens_generated records.
 */
export function seedContinueDb(
	dbPath: string,
	options?: {
		records?: ContinueTokenRecordInput[];
	},
): Database {
	const db = createDatabase(dbPath);

	db.run("DROP TABLE IF EXISTS tokens_generated;");
	db.run(`
		CREATE TABLE tokens_generated (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			tokens_generated INTEGER NOT NULL,
			tokens_prompt INTEGER NOT NULL,
			timestamp DATETIME NOT NULL
		);
	`);

	const records = options?.records ?? [
		{
			model: "gpt-4o",
			provider: "openai",
			tokensGenerated: 450,
			tokensPrompt: 2100,
			timestamp: "2026-03-15T10:00:00.000Z",
		},
		{
			model: "minimax/minimax-m2.5",
			provider: "openrouter",
			tokensGenerated: 1200,
			tokensPrompt: 4800,
			timestamp: "2026-03-15T10:30:00.000Z",
		},
	];

	for (const r of records) {
		db.run(
			"INSERT INTO tokens_generated (model, provider, tokens_generated, tokens_prompt, timestamp) VALUES (?, ?, ?, ?, ?);",
			[
				r.model,
				r.provider,
				r.tokensGenerated,
				r.tokensPrompt,
				r.timestamp ?? new Date().toISOString(),
			],
		);
	}

	return db;
}

export interface GooseSessionInput {
	id: string;
	description?: string;
	workingDir?: string;
	createdAt?: number;
	updatedAt?: number;
	messages?: Array<{
		role: string;
		content?: string;
		accumulatedInputTokens?: number;
		accumulatedOutputTokens?: number;
		modelConfig?: Record<string, unknown>;
		createdAt?: number;
	}>;
}

/**
 * Seeds a Goose sessions.db database.
 */
export function seedGooseDb(
	dbPath: string,
	options?: {
		sessions?: GooseSessionInput[];
	},
): Database {
	const db = createDatabase(dbPath);

	db.run("DROP TABLE IF EXISTS messages;");
	db.run("DROP TABLE IF EXISTS sessions;");
	db.run(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			description TEXT,
			working_dir TEXT,
			created_at INTEGER,
			updated_at INTEGER
		);
	`);
	db.run(`
		CREATE TABLE messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL,
			content TEXT,
			accumulated_input_tokens INTEGER,
			accumulated_output_tokens INTEGER,
			model_config_json TEXT,
			created_at INTEGER
		);
	`);

	const sessions = options?.sessions ?? [
		{
			id: "goose-sess-default-1",
			description: "Scaffold CLI application",
			workingDir: "/workspace/goose-demo",
			createdAt: 1773500000000,
			updatedAt: 1773500060000,
			messages: [
				{
					role: "user",
					content: "Scaffold CLI application",
					accumulatedInputTokens: 0,
					accumulatedOutputTokens: 0,
					modelConfig: { model: "claude-3-5-sonnet", provider: "anthropic" },
					createdAt: 1773500000000,
				},
				{
					role: "assistant",
					content: "CLI scaffolded.",
					accumulatedInputTokens: 2100,
					accumulatedOutputTokens: 380,
					modelConfig: { model: "claude-3-5-sonnet", provider: "anthropic" },
					createdAt: 1773500060000,
				},
			],
		},
	];

	for (const sess of sessions) {
		db.run(
			"INSERT OR REPLACE INTO sessions (id, description, working_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?);",
			[
				sess.id,
				sess.description ?? "Session description",
				sess.workingDir ?? "/workspace",
				sess.createdAt ?? Date.now(),
				sess.updatedAt ?? Date.now(),
			],
		);

		if (sess.messages) {
			for (const msg of sess.messages) {
				db.run(
					"INSERT INTO messages (session_id, role, content, accumulated_input_tokens, accumulated_output_tokens, model_config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);",
					[
						sess.id,
						msg.role,
						msg.content ?? "",
						msg.accumulatedInputTokens ?? 0,
						msg.accumulatedOutputTokens ?? 0,
						JSON.stringify(msg.modelConfig ?? {}),
						msg.createdAt ?? Date.now(),
					],
				);
			}
		}
	}

	return db;
}

/**
 * Seeds an Antigravity conversation database (`conversations/<id>.db`).
 */
export function seedAntigravityDb(
	dbPath: string,
	options: {
		trajectoryBlob?: Uint8Array;
		steps?: Array<{
			idx: number;
			stepType: number;
			status?: number;
			metadata?: Uint8Array;
			payload?: Uint8Array;
		}>;
		genMetadata?: Array<{
			idx: number;
			data: Uint8Array;
		}>;
	},
): Database {
	const db = createDatabase(dbPath);

	db.run("DROP TABLE IF EXISTS trajectory_metadata_blob;");
	db.run("DROP TABLE IF EXISTS steps;");
	db.run("DROP TABLE IF EXISTS gen_metadata;");
	db.run(`
		CREATE TABLE trajectory_metadata_blob (
			data BLOB
		);
	`);
	db.run(`
		CREATE TABLE steps (
			idx INTEGER,
			step_type INTEGER,
			status INTEGER,
			metadata BLOB,
			step_payload BLOB
		);
	`);
	db.run(`
		CREATE TABLE gen_metadata (
			idx INTEGER,
			data BLOB
		);
	`);

	if (options.trajectoryBlob) {
		db.run("INSERT INTO trajectory_metadata_blob VALUES (?);", [
			options.trajectoryBlob,
		]);
	}

	if (options.steps) {
		for (const step of options.steps) {
			db.run(
				"INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?);",
				[
					step.idx,
					step.stepType,
					step.status ?? 1,
					step.metadata ?? new Uint8Array(),
					step.payload ?? new Uint8Array(),
				],
			);
		}
	}

	if (options.genMetadata) {
		for (const gm of options.genMetadata) {
			db.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?);", [
				gm.idx,
				gm.data,
			]);
		}
	}

	return db;
}

/**
 * Seeds an Antigravity conversation_summaries.db database.
 */
export function seedAntigravitySummariesDb(
	dbPath: string,
	options?: {
		summaries?: Array<{
			conversationId: string;
			title: string;
			workspaceUris?: string[];
			lastModifiedTime?: string;
		}>;
	},
): Database {
	const db = createDatabase(dbPath);

	db.run("DROP TABLE IF EXISTS conversation_summaries;");
	db.run(`
		CREATE TABLE conversation_summaries (
			conversation_id TEXT PRIMARY KEY,
			title TEXT,
			workspace_uris TEXT,
			last_modified_time TEXT
		);
	`);

	const summaries = options?.summaries ?? [
		{
			conversationId: "ag-sess-default-1",
			title: "Antigravity default conversation",
			workspaceUris: ["file:///workspace/antigravity-demo"],
			lastModifiedTime: "2026-03-15T10:00:00Z",
		},
	];

	for (const s of summaries) {
		db.run(
			"INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?);",
			[
				s.conversationId,
				s.title,
				JSON.stringify(s.workspaceUris ?? []),
				s.lastModifiedTime ?? new Date().toISOString(),
			],
		);
	}

	return db;
}
