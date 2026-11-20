import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase, tablesIn } from "../../platform/sqlite";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	uniqueBy,
	usageRecord,
	walkFiles,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import {
	existingAntigravityRoots,
	loadSummaries,
	loadT3AntigravityMeta,
	readAntigravityBlobMeta,
	readAntigravitySidecarCwd,
	readAntigravityStepTimestamp,
	type T3AntigravityMeta,
} from "./discovery";
import { decodeProto, protoSub, protoText } from "./proto";

function readAntigravityDbRecords(options: {
	filePath: string;
	sessionId: string;
	preferredCwd: string | null;
	t3Meta: T3AntigravityMeta;
	records: UsageRecord[];
	messages: Map<string, number>;
	warnings: string[];
}): void {
	const {
		filePath,
		sessionId,
		preferredCwd,
		t3Meta,
		records,
		messages,
		warnings,
	} = options;

	try {
		const handle = openSafeReadonlyDatabase(filePath);
		try {
			const db = handle.db;
			const tables = tablesIn(db);
			const blobMeta = readAntigravityBlobMeta(db, sessionId);
			const cwd =
				preferredCwd ?? blobMeta.cwd ?? readAntigravitySidecarCwd(filePath);
			let sessionTimestamp: number | null = blobMeta.startedAt;
			const sessionIsSubagent =
				blobMeta.isSubagent || t3Meta.subagents.has(sessionId);

			const stepTimestamps = new Map<number, number>();
			let earliestStepTs: number | null = null;
			if (tables.has("steps")) {
				try {
					const stepRows = db
						.query<{ idx: number; metadata: Uint8Array | null }, []>(
							"SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx",
						)
						.all();
					for (const step of stepRows) {
						const ts = readAntigravityStepTimestamp(step.metadata);
						if (ts !== null) {
							stepTimestamps.set(step.idx, ts);
							if (earliestStepTs === null || ts < earliestStepTs) {
								earliestStepTs = ts;
							}
						}
					}
				} catch (error) {
					warnings.push(
						`Antigravity: failed reading step timestamps in ${filePath} (${String(error)})`,
					);
				}
			}
			sessionTimestamp ??= earliestStepTs;

			if (!sessionIsSubagent && tables.has("steps")) {
				try {
					const userSteps = db
						.query<{ count: number }, []>(
							"SELECT COUNT(*) AS count FROM steps WHERE step_type = 14",
						)
						.get();
					if (userSteps?.count) messages.set(sessionId, userSteps.count);
				} catch (error) {
					warnings.push(
						`Antigravity: failed counting user steps in ${filePath} (${String(error)})`,
					);
				}
			}

			let hasGenMetadata = false;
			if (tables.has("gen_metadata")) {
				try {
					const genRows = db
						.query<{ idx: number; data: Uint8Array }, []>(
							"SELECT idx, data FROM gen_metadata ORDER BY idx",
						)
						.all();
					for (const row of genRows) {
						hasGenMetadata = true;
						const genFields = decodeProto(row.data);
						const f1 = protoSub(
							genFields.find((f) => f.field === 1 && f.wire === 2),
						);
						const rawModel =
							protoText(f1.find((f) => f.field === 19 && f.wire === 2)) ??
							"Unknown model";
						const f4 = protoSub(f1.find((f) => f.field === 4 && f.wire === 2));
						const inputTokens =
							f4.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
						const rawOutputTokens =
							f4.find((f) => f.field === 3 && f.wire === 0)?.val ?? 0;
						const cacheReadTokens =
							f4.find((f) => f.field === 5 && f.wire === 0)?.val ?? 0;
						const reasoningTokens =
							f4.find((f) => f.field === 9 && f.wire === 0)?.val ?? 0;

						const metaPairs = f1.filter((f) => f.field === 20 && f.wire === 2);
						let lastStepIndex: number | undefined;
						let boundCascadeId = sessionId;
						let kvRequestId: string | null = null;
						let hasSubagentKv = false;
						for (const pair of metaPairs) {
							const kv = protoSub(pair);
							const k = protoText(kv.find((f) => f.field === 1));
							const v = protoText(kv.find((f) => f.field === 2));
							if (k === "last_step_index" && v) {
								lastStepIndex = Number(v);
							} else if (k === "cascade_id" && v) {
								boundCascadeId = v;
							} else if (k === "request_id" && v) {
								kvRequestId = v;
							} else if (
								(k === "subagent_type" || k === "parent_cascade_id") &&
								v
							) {
								hasSubagentKv = true;
							}
						}
						const requestId =
							protoText(f4.find((f) => f.field === 11 && f.wire === 2)) ??
							kvRequestId ??
							`${sessionId}:${row.idx}`;

						const timestamp =
							(lastStepIndex !== undefined
								? (stepTimestamps.get(lastStepIndex + 1) ??
									stepTimestamps.get(lastStepIndex))
								: undefined) ??
							sessionTimestamp ??
							null;
						const isSubagent = sessionIsSubagent || hasSubagentKv;

						records.push(
							usageRecord(
								{
									harness: "antigravity",
									sessionId: boundCascadeId,
									messageId: requestId,
									turnId:
										lastStepIndex !== undefined
											? String(lastStepIndex)
											: String(row.idx),
									cwd,
									model: modelName(rawModel),
									timestamp,
									...(isSubagent ? { isSubagent: true } : {}),
								},
								{
									input: inputTokens,
									// Proto field 3 is candidate output excluding thoughts (field 9).
									output: rawOutputTokens + reasoningTokens,
									cacheRead: cacheReadTokens,
									reasoning: reasoningTokens,
								},
							),
						);
					}
				} catch (error) {
					warnings.push(
						`Antigravity: failed reading gen_metadata in ${filePath} (${String(error)})`,
					);
				}
			}

			if (!hasGenMetadata && tables.has("steps")) {
				try {
					const assistantSteps = db
						.query<
							{
								idx: number;
								metadata: Uint8Array | null;
								step_payload: Uint8Array;
							},
							[]
						>(
							"SELECT idx, metadata, step_payload FROM steps WHERE step_type = 15 ORDER BY idx",
						)
						.all();
					for (const step of assistantSteps) {
						const payloadFields = decodeProto(step.step_payload);
						const f5 = protoSub(
							payloadFields.find((f) => f.field === 5 && f.wire === 2),
						);
						const f9 = protoSub(f5.find((f) => f.field === 9 && f.wire === 2));
						if (f9.length === 0) continue;
						const inputTokens =
							f9.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
						const rawOutputTokens =
							f9.find((f) => f.field === 3 && f.wire === 0)?.val ?? 0;
						const cacheReadTokens =
							f9.find((f) => f.field === 5 && f.wire === 0)?.val ?? 0;
						const reasoningTokens =
							f9.find((f) => f.field === 9 && f.wire === 0)?.val ?? 0;
						const requestId =
							protoText(f9.find((f) => f.field === 11 && f.wire === 2)) ??
							`${sessionId}:step-${step.idx}`;

						const stepTs = stepTimestamps.get(step.idx) ?? sessionTimestamp;
						records.push(
							usageRecord(
								{
									harness: "antigravity",
									sessionId,
									messageId: requestId,
									turnId: String(step.idx),
									cwd,
									model: "Unknown model",
									timestamp: stepTs,
									...(sessionIsSubagent ? { isSubagent: true } : {}),
								},
								{
									input: inputTokens,
									output: rawOutputTokens + reasoningTokens,
									cacheRead: cacheReadTokens,
									reasoning: reasoningTokens,
								},
							),
						);
					}
				} catch (error) {
					warnings.push(
						`Antigravity: failed reading steps fallback in ${filePath} (${String(error)})`,
					);
				}
			}
		} finally {
			handle.close();
		}
	} catch (error) {
		warnings.push(`Antigravity: failed reading ${filePath} (${String(error)})`);
	}
}

export function readAntigravityUsageSync(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const existingRoots = existingAntigravityRoots(paths);
	const available = existingRoots.length > 0;
	const result = blankSourceResult("antigravity", available);
	if (!result.available) return result;

	const t3Meta = loadT3AntigravityMeta(paths);
	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	const seenFiles = new Set<string>();

	if (item) {
		seenFiles.add(item.sessionId);
		readAntigravityDbRecords({
			filePath: item.filePath,
			sessionId: item.sessionId,
			preferredCwd: item.cwd ?? null,
			t3Meta,
			records,
			messages,
			warnings: result.warnings,
		});
	} else {
		for (const root of existingRoots) {
			const summaries = loadSummaries(root);
			const convFiles = walkFiles(
				path.join(root, "conversations"),
				(_filePath, name) => name.endsWith(".db"),
			);

			for (const filePath of convFiles) {
				const sessionId = path.basename(filePath, ".db");
				if (seenFiles.has(sessionId)) continue;
				seenFiles.add(sessionId);
				readAntigravityDbRecords({
					filePath,
					sessionId,
					preferredCwd: summaries.get(sessionId)?.cwd ?? null,
					t3Meta,
					records,
					messages,
					warnings: result.warnings,
				});
			}
		}
	}

	result.records = uniqueBy(
		records,
		(record) => `${record.sessionId}:${record.messageId}`,
	).filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
