import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SourceResult, UsageRecord } from "../types";
import {
	blankSourceResult,
	expandHome,
	homeDir,
	modelName,
	normalizedCwd,
	uniqueBy,
	usageRecord,
	walkFiles,
} from "../util";

export interface ProtoField {
	field: number;
	wire: number;
	val?: number;
	raw?: Uint8Array;
}

const textDecoder = new TextDecoder("utf-8");

export function decodeProto(buffer: Uint8Array): ProtoField[] {
	let pos = 0;
	const fields: ProtoField[] = [];
	while (pos < buffer.length) {
		let tagByte = buffer[pos++];
		if (tagByte === undefined) break;
		const wireType = tagByte & 7;
		let fieldNumber = tagByte >> 3;
		let shift = 4;
		while (tagByte & 128) {
			tagByte = buffer[pos++];
			if (tagByte === undefined) break;
			fieldNumber |= (tagByte & 127) << shift;
			shift += 7;
		}
		if (wireType === 0) {
			let val = 0n;
			let s = 0n;
			let b = 0;
			do {
				const nextByte = buffer[pos++];
				if (nextByte === undefined) break;
				b = nextByte;
				val |= BigInt(b & 127) << s;
				s += 7n;
			} while (b & 128);
			fields.push({ field: fieldNumber, wire: 0, val: Number(val) });
		} else if (wireType === 1) {
			pos += 8;
			fields.push({ field: fieldNumber, wire: 1 });
		} else if (wireType === 2) {
			let len = 0;
			let s = 0;
			let b = 0;
			do {
				const nextByte = buffer[pos++];
				if (nextByte === undefined) break;
				b = nextByte;
				len |= (b & 127) << s;
				s += 7;
			} while (b & 128);
			const sub = buffer.subarray(pos, pos + len);
			pos += len;
			fields.push({ field: fieldNumber, wire: 2, raw: sub });
		} else if (wireType === 5) {
			pos += 4;
			fields.push({ field: fieldNumber, wire: 5 });
		} else {
			break;
		}
	}
	return fields;
}

export function protoText(field: ProtoField | undefined): string | null {
	if (!field?.raw) return null;
	try {
		return textDecoder.decode(field.raw);
	} catch {
		return null;
	}
}

export function protoSub(field: ProtoField | undefined): ProtoField[] {
	if (!field?.raw) return [];
	return decodeProto(field.raw);
}

function hasNonEmptySidecar(filePath: string): boolean {
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

export function openSafeReadonlyDatabase(dbPath: string): {
	db: Database;
	cleanup: () => void;
} {
	const hasPendingSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);
	if (!hasPendingSidecar) {
		const immutableUrl = `${pathToFileURL(dbPath).href}?immutable=1`;
		return {
			db: new Database(immutableUrl, { readonly: true, create: false }),
			cleanup: () => {},
		};
	}
	try {
		return {
			db: new Database(dbPath, { readonly: true, create: false }),
			cleanup: () => {},
		};
	} catch {
		try {
			const tmpDir = path.join(
				os.tmpdir(),
				`ct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(tmpDir, { recursive: true });
			const baseName = path.basename(dbPath);
			const tmpDb = path.join(tmpDir, baseName);
			copyFileSync(dbPath, tmpDb);
			for (const ext of ["-wal", "-shm", "-journal"]) {
				const sidecar = `${dbPath}${ext}`;
				if (existsSync(sidecar)) copyFileSync(sidecar, `${tmpDb}${ext}`);
			}
			const db = new Database(tmpDb, { readonly: true, create: false });
			return {
				db,
				cleanup: () => {
					try {
						db.close();
					} catch {}
					try {
						rmSync(tmpDir, { recursive: true, force: true });
					} catch {}
				},
			};
		} catch {
			const immutableUrl = `${pathToFileURL(dbPath).href}?immutable=1`;
			return {
				db: new Database(immutableUrl, { readonly: true, create: false }),
				cleanup: () => {},
			};
		}
	}
}

export function parseWorkspaceUri(raw: string | null): string | null {
	if (!raw) return null;
	if (raw.startsWith("file://")) {
		try {
			return normalizedCwd(fileURLToPath(raw));
		} catch {
			return normalizedCwd(raw.slice("file://".length));
		}
	}
	return normalizedCwd(raw);
}

interface SummaryRow {
	conversation_id: string;
	title: string;
	workspace_uris: string;
	last_modified_time: string;
}

export function loadSummaries(
	root: string,
): Map<string, { title: string; cwd: string | null }> {
	const summaries = new Map<string, { title: string; cwd: string | null }>();
	const summaryDbPath = path.join(root, "conversation_summaries.db");
	if (!existsSync(summaryDbPath)) return summaries;
	try {
		const { db, cleanup } = openSafeReadonlyDatabase(summaryDbPath);
		try {
			const rows = db
				.query<SummaryRow, []>(
					"SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries",
				)
				.all();
			for (const row of rows) {
				let cwd: string | null = null;
				try {
					const uris = JSON.parse(row.workspace_uris);
					if (Array.isArray(uris) && typeof uris[0] === "string") {
						cwd = parseWorkspaceUri(uris[0]);
					}
				} catch {}
				summaries.set(row.conversation_id, {
					title: row.title,
					cwd,
				});
			}
		} finally {
			cleanup();
		}
	} catch {
		// Non-fatal if summaries database cannot be read.
	}
	return summaries;
}

export function readAntigravity(): SourceResult {
	const roots = process.env.ANTIGRAVITY_HOME
		? [path.resolve(expandHome(process.env.ANTIGRAVITY_HOME))]
		: [
				path.join(homeDir, ".gemini/antigravity"),
				path.join(homeDir, ".antigravity"),
			];
	const existingRoots = roots.filter((root) =>
		existsSync(path.join(root, "conversations")),
	);
	const result = blankSourceResult("antigravity", existingRoots.length > 0);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	for (const root of existingRoots) {
		const summaries = loadSummaries(root);
		const convFiles = walkFiles(
			path.join(root, "conversations"),
			(_filePath, name) => name.endsWith(".db"),
		);

		for (const filePath of convFiles) {
			const sessionId = path.basename(filePath, ".db");
			try {
				const { db, cleanup } = openSafeReadonlyDatabase(filePath);
				try {
					let cwd: string | null = summaries.get(sessionId)?.cwd ?? null;
					let sessionTimestamp: number | null = null;
					try {
						const userSteps = db
							.query<{ count: number }, []>(
								"SELECT COUNT(*) AS count FROM steps WHERE step_type = 14",
							)
							.get();
						if (userSteps?.count) messages.set(sessionId, userSteps.count);
					} catch {}

					// Read trajectory_metadata_blob if available
					try {
						const metaBlobRow = db
							.query<{ data: Uint8Array }, []>(
								"SELECT data FROM trajectory_metadata_blob LIMIT 1",
							)
							.get();
						if (metaBlobRow?.data) {
							const trajFields = decodeProto(metaBlobRow.data);
							if (!cwd) {
								const rawUri =
									protoText(trajFields.find((f) => f.field === 7)) ??
									protoText(
										protoSub(trajFields.find((f) => f.field === 1)).find(
											(f) => f.field === 1,
										),
									);
								cwd = parseWorkspaceUri(rawUri) ?? cwd;
							}
							const tsFields = protoSub(trajFields.find((f) => f.field === 2));
							const sec = tsFields.find(
								(f) => f.field === 1 && f.wire === 0,
							)?.val;
							const nano =
								tsFields.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
							if (sec) {
								sessionTimestamp = sec * 1000 + Math.floor(nano / 1e6);
							}
						}
					} catch {}

					// Read step timestamps to associate with generations
					const stepTimestamps = new Map<number, number>();
					try {
						const stepRows = db
							.query<{ idx: number; metadata: Uint8Array | null }, []>(
								"SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL",
							)
							.all();
						for (const step of stepRows) {
							if (!step.metadata) continue;
							const stepMeta = decodeProto(step.metadata);
							const tsFields = protoSub(stepMeta.find((f) => f.field === 1));
							const sec = tsFields.find(
								(f) => f.field === 1 && f.wire === 0,
							)?.val;
							const nano =
								tsFields.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
							if (sec) {
								stepTimestamps.set(
									step.idx,
									sec * 1000 + Math.floor(nano / 1e6),
								);
							}
						}
					} catch {}

					// Read model generations from gen_metadata
					let hasGenMetadata = false;
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
							const f4 = protoSub(
								f1.find((f) => f.field === 4 && f.wire === 2),
							);
							const inputTokens =
								f4.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
							const outputTokens =
								f4.find((f) => f.field === 3 && f.wire === 0)?.val ?? 0;
							const cacheReadTokens =
								f4.find((f) => f.field === 5 && f.wire === 0)?.val ?? 0;
							const cacheWriteTokens =
								f4.find((f) => f.field === 6 && f.wire === 0)?.val ?? 0;
							const requestId =
								protoText(f4.find((f) => f.field === 11 && f.wire === 2)) ??
								`${sessionId}:${row.idx}`;

							const metaPairs = f1.filter(
								(f) => f.field === 20 && f.wire === 2,
							);
							let lastStepIndex: number | undefined;
							let boundCascadeId = sessionId;
							for (const pair of metaPairs) {
								const kv = protoSub(pair);
								const k = protoText(kv.find((f) => f.field === 1));
								const v = protoText(kv.find((f) => f.field === 2));
								if (k === "last_step_index" && v) {
									lastStepIndex = Number(v);
								} else if (k === "cascade_id" && v) {
									boundCascadeId = v;
								}
							}

							const timestamp =
								(lastStepIndex !== undefined
									? (stepTimestamps.get(lastStepIndex + 1) ??
										stepTimestamps.get(lastStepIndex))
									: undefined) ??
								sessionTimestamp ??
								null;

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
									},
									{
										input: inputTokens,
										output: outputTokens,
										cacheRead: cacheReadTokens,
										cacheWrite: cacheWriteTokens,
									},
								),
							);
						}
					} catch (error) {
						result.warnings.push(
							`Antigravity: failed reading gen_metadata in ${filePath} (${String(error)})`,
						);
					}

					// Fallback to step_type 15 in steps table if gen_metadata was empty
					if (!hasGenMetadata) {
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
								const f9 = protoSub(
									f5.find((f) => f.field === 9 && f.wire === 2),
								);
								if (f9.length === 0) continue;
								const inputTokens =
									f9.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
								const outputTokens =
									f9.find((f) => f.field === 3 && f.wire === 0)?.val ?? 0;
								const cacheReadTokens =
									f9.find((f) => f.field === 5 && f.wire === 0)?.val ?? 0;
								const cacheWriteTokens =
									f9.find((f) => f.field === 6 && f.wire === 0)?.val ?? 0;
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
										},
										{
											input: inputTokens,
											output: outputTokens,
											cacheRead: cacheReadTokens,
											cacheWrite: cacheWriteTokens,
										},
									),
								);
							}
						} catch {}
					}
				} finally {
					cleanup();
				}
			} catch (error) {
				result.warnings.push(
					`Antigravity: failed reading ${filePath} (${String(error)})`,
				);
			}
		}
	}

	result.records = uniqueBy(
		records,
		(record) => `${record.sessionId}:${record.messageId}`,
	);
	result.messages = messages;
	return result;
}
