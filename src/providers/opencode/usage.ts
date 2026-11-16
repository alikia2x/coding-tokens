import type { Database } from "bun:sqlite";
import type { PlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase } from "../../platform/sqlite";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	numberOrZero,
	objectOrEmpty,
	textOrNull,
	timestampMs,
	uniqueBy,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { getOpenCodeDbPaths } from "./discovery";

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

function pricingModelOf(
	data: Record<string, unknown>,
	fallbackModel?: string | null,
): string | null {
	const provider =
		textOrNull(data.providerID) ?? textOrNull(data.provider) ?? null;
	const id =
		textOrNull(data.modelID) ??
		textOrNull(data.model) ??
		textOrNull(fallbackModel);
	if (!id) return null;
	return provider ? `${provider}/${id}` : id;
}

function addV2Rows(
	db: Database,
	sessionIds: Set<string>,
	records: UsageRecord[],
	messages: Map<string, number>,
	targetSessionId?: string,
): void {
	let query =
		"SELECT sm.id, sm.data, sm.session_id, sm.time_created, s.directory, s.model " +
		"FROM session_message AS sm " +
		"JOIN session_v2 AS s ON s.id = sm.session_id " +
		"WHERE sm.type = 'assistant'";
	if (targetSessionId) {
		query += ` AND sm.session_id = '${targetSessionId.replaceAll("'", "''")}'`;
	}
	const rows = db.query<SqliteRow, []>(query).all();
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

	const userMsgQuery =
		"SELECT sm.session_id, count(*) AS count " +
		"FROM session_message AS sm " +
		"WHERE sm.type = 'user' " +
		(targetSessionId
			? `AND sm.session_id = '${targetSessionId.replaceAll("'", "''")}' `
			: "") +
		"GROUP BY sm.session_id";
	for (const row of db
		.query<{ session_id: string; count: number }, []>(userMsgQuery)
		.all()) {
		messages.set(row.session_id, row.count);
	}
}

function addLegacyRows(
	db: Database,
	sessionIds: Set<string>,
	records: UsageRecord[],
	messages: Map<string, number>,
	targetSessionId?: string,
): void {
	let query =
		"SELECT m.id, m.data, m.session_id, m.time_created, s.directory " +
		"FROM message AS m " +
		"JOIN session AS s ON s.id = m.session_id";
	if (targetSessionId) {
		query += ` WHERE m.session_id = '${targetSessionId.replaceAll("'", "''")}'`;
	}
	const rows = db.query<SqliteRow, []>(query).all();
	for (const row of rows) {
		if (sessionIds.has(row.session_id)) continue;
		const data = objectOrEmpty(JSON.parse(row.data));
		if (data.role === "user") {
			messages.set(row.session_id, (messages.get(row.session_id) ?? 0) + 1);
		}
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
					),
					pricingModel: pricingModelOf(data),
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

export function readOpenCodeUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const dbPaths = item ? [item.filePath] : getOpenCodeDbPaths(paths);
	const available = dbPaths.length > 0;
	const result = blankSourceResult("opencode", available);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	for (const dbPath of dbPaths) {
		try {
			const handle = openSafeReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(handle.db);
				const sessionIds = new Set<string>();
				if (tables.has("session_v2") && tables.has("session_message")) {
					addV2Rows(handle.db, sessionIds, records, messages, item?.sessionId);
				}
				if (tables.has("session") && tables.has("message")) {
					addLegacyRows(
						handle.db,
						sessionIds,
						records,
						messages,
						item?.sessionId,
					);
				}
			} finally {
				handle.close();
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
	).filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
