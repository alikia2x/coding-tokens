import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceResult, UsageRecord } from "../types";
import {
	blankSourceResult,
	expandHome,
	homeDir,
	modelName,
	normalizedCwd,
	numberOrZero,
	objectOrEmpty,
	textOrNull,
	timestampMs,
	uniqueBy,
	usageRecord,
} from "../util";

interface SqliteRow {
	id: string;
	data: string;
	session_id: string;
	time_created: number;
	directory?: string;
	model?: string | null;
}

function tablesIn(db: Database): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((row) => row.name),
	);
}

function timestampFromData(
	value: Record<string, unknown>,
	fallback: number,
): number {
	const time = objectOrEmpty(value.time);
	return timestampMs(time.created) ?? fallback;
}

function hasNonEmptySidecar(filePath: string): boolean {
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

function openReadonlyDatabase(dbPath: string): Database {
	const hasPendingSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);
	if (hasPendingSidecar) {
		return new Database(dbPath, { readonly: true, create: false });
	}
	const immutableUrl = `${pathToFileURL(dbPath).href}?immutable=1`;
	return new Database(immutableUrl, { readonly: true, create: false });
}

function addV2Rows(
	db: Database,
	sessionIds: Set<string>,
	records: UsageRecord[],
	messages: Map<string, number>,
): void {
	const rows = db
		.query<SqliteRow, []>(
			"SELECT sm.id, sm.data, sm.session_id, sm.time_created, s.directory, s.model " +
				"FROM session_message AS sm " +
				"JOIN session_v2 AS s ON s.id = sm.session_id " +
				"WHERE sm.type = 'assistant'",
		)
		.all();
	for (const row of rows) {
		const data = objectOrEmpty(JSON.parse(row.data));
		const tokens = objectOrEmpty(data.tokens);
		const cache = objectOrEmpty(tokens.cache);
		if (Object.keys(tokens).length === 0) continue;
		sessionIds.add(row.session_id);
		records.push(
			usageRecord(
				{
					harness: "opencode",
					sessionId: row.session_id,
					messageId: row.id,
					cwd: normalizedCwd(row.directory),
					model: modelName(data.model, modelName(row.model)),
					pricingModel: pricingModelOf(data, row.model),
					timestamp: timestampFromData(data, row.time_created),
				},
				{
					input: tokens.input,
					output: numberOrZero(tokens.output) + numberOrZero(tokens.reasoning),
					cacheRead: cache.read,
					cacheWrite: cache.write,
					reasoning: tokens.reasoning,
					cost: data.cost,
				},
			),
		);
	}
	for (const row of db
		.query<{ id: string }, []>("SELECT id FROM session_v2")
		.all()) {
		sessionIds.add(row.id);
	}
	for (const row of db
		.query<{ session_id: string; count: number }, []>(
			"SELECT session_id, COUNT(*) AS count FROM session_message WHERE type = 'user' GROUP BY session_id",
		)
		.all()) {
		messages.set(row.session_id, row.count);
	}
}

function pricingModelOf(
	data: Record<string, unknown>,
	fallback: string | null | undefined,
): string | null {
	const model = objectOrEmpty(data.model);
	const provider =
		textOrNull(model.providerID) ?? textOrNull(data.providerID) ?? null;
	const id =
		textOrNull(model.id) ??
		textOrNull(data.modelID) ??
		textOrNull(fallback) ??
		null;
	if (!id) return null;
	return provider ? `${provider}/${id}` : id;
}

function addLegacyRows(
	db: Database,
	sessionIds: Set<string>,
	records: UsageRecord[],
	messages: Map<string, number>,
): void {
	const rows = db
		.query<SqliteRow, []>(
			"SELECT m.id, m.data, m.session_id, m.time_created, s.directory " +
				"FROM message AS m JOIN session AS s ON s.id = m.session_id",
		)
		.all();
	for (const row of rows) {
		if (sessionIds.has(row.session_id)) continue;
		const data = objectOrEmpty(JSON.parse(row.data));
		if (data.role === "user")
			messages.set(row.session_id, (messages.get(row.session_id) ?? 0) + 1);
		if (data.role !== "assistant") continue;
		const tokens = objectOrEmpty(data.tokens);
		const cache = objectOrEmpty(tokens.cache);
		if (Object.keys(tokens).length === 0) continue;
		records.push(
			usageRecord(
				{
					harness: "opencode",
					sessionId: row.session_id,
					messageId: row.id,
					cwd: normalizedCwd(row.directory),
					model: modelName(
						data.model ?? {
							providerID: data.providerID,
							id: data.modelID,
						},
						modelName(row.model),
					),
					pricingModel: pricingModelOf(data, row.model),
					timestamp: timestampFromData(data, row.time_created),
				},
				{
					input: tokens.input,
					output: numberOrZero(tokens.output) + numberOrZero(tokens.reasoning),
					cacheRead: cache.read,
					cacheWrite: cache.write,
					reasoning: tokens.reasoning,
					cost: data.cost,
				},
			),
		);
	}
}

export function readOpenCode(): SourceResult {
	const explicitDb = process.env.OPENCODE_DB
		? path.resolve(expandHome(process.env.OPENCODE_DB))
		: null;
	const dataDir = process.env.OPENCODE_DATA_DIR
		? path.resolve(expandHome(process.env.OPENCODE_DATA_DIR))
		: path.join(homeDir, ".local/share/opencode");
	let dbPaths = explicitDb ? [explicitDb] : [];
	if (!explicitDb) {
		try {
			dbPaths = readdirSync(dataDir)
				.filter((name) => /^opencode(?:-[^/]*)?\.db$/u.test(name))
				.map((name) => path.join(dataDir, name));
		} catch {
			// The source may not be installed.
		}
	}
	dbPaths = dbPaths.filter((dbPath) => existsSync(dbPath));
	const result = blankSourceResult("opencode", dbPaths.length > 0);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	for (const dbPath of dbPaths) {
		try {
			const db = openReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(db);
				const sessionIds = new Set<string>();
				if (tables.has("session_v2") && tables.has("session_message")) {
					addV2Rows(db, sessionIds, records, messages);
				}
				if (tables.has("session") && tables.has("message")) {
					addLegacyRows(db, sessionIds, records, messages);
				}
			} finally {
				db.close();
			}
		} catch (error) {
			result.warnings.push(
				`OpenCode: failed to read ${dbPath} (${String(error)})`,
			);
		}
	}
	result.records = uniqueBy(
		records,
		(record) => `${record.sessionId}:${record.messageId}`,
	);
	result.messages = messages;
	return result;
}
