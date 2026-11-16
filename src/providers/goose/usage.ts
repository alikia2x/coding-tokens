import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { openReadonlyDatabase, tablesIn } from "../../transcripts/shared";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	numberOrZero,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { getGooseLocations } from "./discovery";

interface GooseSessionRow {
	id: string;
	description: string | null;
	working_dir: string | null;
	created_at: number | null;
}

interface GooseMessageRow {
	id: number | string;
	session_id: string;
	role: string;
	content: string | null;
	accumulated_input_tokens: number | null;
	accumulated_output_tokens: number | null;
	model_config_json: string | null;
	created_at: number | null;
}

export function readGooseUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const { dbFiles, legacyFiles } = getGooseLocations(paths);
	const available = dbFiles.length > 0 || legacyFiles.length > 0;
	const result = blankSourceResult("goose", available);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	const processedSessionIds = new Set<string>();

	// 1. Read from SQLite databases
	for (const dbPath of dbFiles) {
		if (item && item.filePath !== dbPath) continue;

		try {
			const db = openReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(db);
				if (!tables.has("sessions") || !tables.has("messages")) continue;

				let sessions: GooseSessionRow[] = [];
				if (item) {
					sessions = db
						.query<GooseSessionRow, [string]>(
							"SELECT id, description, working_dir, created_at FROM sessions WHERE id = ?",
						)
						.all(item.sessionId);
				} else {
					sessions = db
						.query<GooseSessionRow, []>(
							"SELECT id, description, working_dir, created_at FROM sessions",
						)
						.all();
				}

				for (const sess of sessions) {
					if (!sess.id) continue;
					processedSessionIds.add(sess.id);

					const msgRows = db
						.query<GooseMessageRow, [string]>(
							"SELECT id, session_id, role, content, accumulated_input_tokens, accumulated_output_tokens, model_config_json, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
						)
						.all(sess.id);

					let prevInput = 0;
					let prevOutput = 0;
					const sessionCwd = normalizedCwd(sess.working_dir);

					for (let i = 0; i < msgRows.length; i++) {
						const msg = msgRows[i];
						if (!msg) continue;

						if (msg.role === "user") {
							messages.set(sess.id, (messages.get(sess.id) ?? 0) + 1);
							continue;
						}

						if (msg.role === "assistant") {
							const accInput = numberOrZero(msg.accumulated_input_tokens);
							const accOutput = numberOrZero(msg.accumulated_output_tokens);

							// In Goose, accumulated tokens increase monotonically per session
							let deltaInput =
								accInput >= prevInput ? accInput - prevInput : accInput;
							let deltaOutput =
								accOutput >= prevOutput ? accOutput - prevOutput : accOutput;

							if (
								deltaInput === 0 &&
								deltaOutput === 0 &&
								(accInput > 0 || accOutput > 0)
							) {
								deltaInput = accInput;
								deltaOutput = accOutput;
							}

							prevInput = Math.max(prevInput, accInput);
							prevOutput = Math.max(prevOutput, accOutput);

							let model = "claude-3-5-sonnet";
							let provider: string | undefined;

							if (msg.model_config_json) {
								try {
									const conf = JSON.parse(msg.model_config_json);
									model = conf.model ?? model;
									provider = conf.provider ?? undefined;
								} catch {
									// ignore JSON parse error
								}
							}

							const timestamp = msg.created_at ?? sess.created_at ?? Date.now();

							records.push(
								usageRecord(
									{
										harness: "goose",
										sessionId: sess.id,
										messageId: `goose-msg-${msg.id}`,
										turnId: `turn-${msg.id}`,
										cwd: sessionCwd,
										model: modelName(model),
										pricingModel: provider ? `${provider}/${model}` : undefined,
										timestamp,
									},
									{
										input: deltaInput,
										output: deltaOutput,
									},
								),
							);
						}
					}
				}
			} finally {
				db.close();
			}
		} catch (err) {
			result.warnings.push(`Goose: failed to read ${dbPath} (${String(err)})`);
		}
	}

	// 2. Read legacy sessions from JSONL files
	for (const jsonlPath of legacyFiles) {
		if (item && item.filePath !== jsonlPath) continue;

		try {
			const text = readFileSync(jsonlPath, "utf8");
			const rows = parseJsonl(text);
			const defaultSessionId = path.basename(jsonlPath, ".jsonl");

			for (let i = 0; i < rows.length; i++) {
				const row = objectOrEmpty(rows[i]);
				const sessionId =
					textOrNull(row.sessionId) ?? textOrNull(row.id) ?? defaultSessionId;

				// Skip if session was already ingested from SQLite database
				if (processedSessionIds.has(sessionId)) continue;

				if (row.role === "user" || row.type === "user") {
					messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
					continue;
				}

				const usage = objectOrEmpty(row.usage);
				const inputTokens = numberOrZero(
					row.input_tokens ??
						usage.input_tokens ??
						row.accumulated_input_tokens,
				);
				const outputTokens = numberOrZero(
					row.output_tokens ??
						usage.output_tokens ??
						row.accumulated_output_tokens,
				);

				if (inputTokens > 0 || outputTokens > 0) {
					records.push(
						usageRecord(
							{
								harness: "goose",
								sessionId,
								messageId: `goose-legacy-${sessionId}-${i}`,
								cwd: normalizedCwd(row.working_dir ?? row.cwd),
								model: modelName(row.model ?? "claude-3-5-sonnet"),
								timestamp:
									timestampMs(row.created_at ?? row.timestamp) ?? Date.now(),
							},
							{
								input: inputTokens,
								output: outputTokens,
							},
						),
					);
				}
			}
		} catch (err) {
			result.warnings.push(
				`Goose: failed to read legacy ${jsonlPath} (${String(err)})`,
			);
		}
	}

	result.records = records.filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
