import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase as openSafeReadonlyDatabaseHelper } from "../../platform/sqlite";
import {
	expandHome,
	homeDir,
	normalizedCwd,
	textOrNull,
	walkFiles,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { decodeProto, protoSub, protoText } from "./proto";

export function openSafeReadonlyDatabase(dbPath: string): {
	db: Database;
	cleanup: () => void;
} {
	const handle = openSafeReadonlyDatabaseHelper(dbPath);
	return {
		db: handle.db,
		cleanup: () => handle.close(),
	};
}

function safeDirents(directory: string) {
	try {
		return readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

export function t3UserDataDirs(): string[] {
	if (process.env.T3_USER_DATA_DIR) {
		return [path.resolve(expandHome(process.env.T3_USER_DATA_DIR))];
	}
	return [path.join(homeDir, ".t3/userdata")];
}

export function antigravityRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const resolved = paths.resolveHarnessPaths("antigravity");
	if (resolved.length === 1) {
		return resolved;
	}
	const roots: string[] = [];
	for (const entry of resolved) {
		if (
			entry.endsWith("/.gemini/antigravity") ||
			entry.endsWith("\\.gemini\\antigravity") ||
			entry.endsWith("/.antigravity") ||
			entry.endsWith("\\.antigravity")
		) {
			roots.push(entry);
		} else {
			const providersDir = path.join(entry, "providers", "antigravity");
			for (const accountEntry of safeDirents(providersDir)) {
				if (!accountEntry.isDirectory()) continue;
				const accountDir = path.join(providersDir, accountEntry.name);
				for (const modeEntry of safeDirents(accountDir)) {
					if (!modeEntry.isDirectory()) continue;
					const modeDir = path.join(accountDir, modeEntry.name);
					if (existsSync(path.join(modeDir, "conversations"))) {
						roots.push(modeDir);
					}
				}
			}
		}
	}
	return [...new Set(roots)];
}

export function existingAntigravityRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	return antigravityRoots(paths).filter((root) =>
		existsSync(path.join(root, "conversations")),
	);
}

export function getAntigravityDbFiles(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const existingRoots = existingAntigravityRoots(paths);
	const files: string[] = [];
	for (const root of existingRoots) {
		files.push(
			...walkFiles(path.join(root, "conversations"), (_filePath, name) =>
				name.endsWith(".db"),
			),
		);
	}
	return [...new Set(files)];
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

export function readAntigravitySidecarCwd(dbFilePath: string): string | null {
	const metaPath = dbFilePath.replace(/\.db$/u, ".meta");
	if (!existsSync(metaPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(metaPath, "utf8")) as {
			cwd?: unknown;
		};
		return normalizedCwd(raw?.cwd);
	} catch {
		return null;
	}
}

export interface AntigravityBlobMeta {
	cwd: string | null;
	startedAt: number | null;
	isSubagent: boolean;
	subagentType: string | null;
	subagentRole: string | null;
}

export function readAntigravityBlobMeta(
	db: Database,
	sessionId: string,
): AntigravityBlobMeta {
	let cwd: string | null = null;
	let startedAt: number | null = null;
	let isSubagent = false;
	let subagentType: string | null = null;
	let subagentRole: string | null = null;
	try {
		const metaBlobRow = db
			.query<{ data: Uint8Array }, []>(
				"SELECT data FROM trajectory_metadata_blob LIMIT 1",
			)
			.get();
		if (metaBlobRow?.data) {
			const trajFields = decodeProto(metaBlobRow.data);
			const rawUri =
				protoText(trajFields.find((f) => f.field === 7)) ??
				protoText(
					protoSub(trajFields.find((f) => f.field === 1)).find(
						(f) => f.field === 1,
					),
				);
			cwd = parseWorkspaceUri(rawUri);
			const tsFields = protoSub(trajFields.find((f) => f.field === 2));
			const sec = tsFields.find((f) => f.field === 1 && f.wire === 0)?.val;
			const nano =
				tsFields.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
			if (sec) startedAt = sec * 1000 + Math.floor(nano / 1e6);

			const parentCascadeId = protoText(
				trajFields.find((f) => f.field === 5 && f.wire === 2),
			);
			const rootCascadeId = protoText(
				trajFields.find((f) => f.field === 6 && f.wire === 2),
			);
			const delegationDepth =
				trajFields.find((f) => f.field === 17 && f.wire === 0)?.val ?? 0;
			const subagentFields = protoSub(
				trajFields.find((f) => f.field === 8 && f.wire === 2),
			);
			subagentType = textOrNull(
				protoText(subagentFields.find((f) => f.field === 1 && f.wire === 2)),
			);
			subagentRole = textOrNull(
				protoText(subagentFields.find((f) => f.field === 2 && f.wire === 2)),
			);
			isSubagent = Boolean(
				parentCascadeId ||
					(rootCascadeId && rootCascadeId !== sessionId) ||
					delegationDepth > 0 ||
					subagentType ||
					subagentRole,
			);
		}
	} catch {}
	return { cwd, startedAt, isSubagent, subagentType, subagentRole };
}

export function readAntigravityStepTimestamp(
	metadataBlob: Uint8Array | null,
): number | null {
	if (!metadataBlob) return null;
	const stepMeta = decodeProto(metadataBlob);
	const tsFields = protoSub(stepMeta.find((f) => f.field === 1));
	const sec = tsFields.find((f) => f.field === 1 && f.wire === 0)?.val;
	const nano = tsFields.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0;
	return sec ? sec * 1000 + Math.floor(nano / 1e6) : null;
}

export interface T3AntigravityMeta {
	titles: Map<string, string>;
	subagents: Set<string>;
}

export function loadT3AntigravityMeta(): T3AntigravityMeta {
	const titles = new Map<string, string>();
	const subagents = new Set<string>();
	if (process.env.ANTIGRAVITY_HOME && !process.env.T3_USER_DATA_DIR) {
		return { titles, subagents };
	}
	for (const userDataDir of t3UserDataDirs()) {
		const stateDbPath = path.join(userDataDir, "statev2.sqlite");
		if (!existsSync(stateDbPath)) continue;
		try {
			const { db, cleanup } = openSafeReadonlyDatabase(stateDbPath);
			try {
				const tables = new Set(
					db
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type = 'table'",
						)
						.all()
						.map((row) => row.name),
				);
				if (
					tables.has("orchestration_v2_projection_provider_threads") &&
					tables.has("orchestration_v2_projection_threads")
				) {
					const rows = db
						.query<{ title: string | null; payload_json: string | null }, []>(
							"SELECT t.title, pt.payload_json " +
								"FROM orchestration_v2_projection_provider_threads pt " +
								"LEFT JOIN orchestration_v2_projection_threads t " +
								"ON t.thread_id = pt.thread_id " +
								"WHERE pt.driver = 'antigravity'",
						)
						.all();
					for (const row of rows) {
						if (!row.payload_json) continue;
						try {
							const payload = JSON.parse(row.payload_json) as {
								nativeThreadRef?: { nativeId?: unknown };
							};
							const nativeId = textOrNull(payload.nativeThreadRef?.nativeId);
							const title = textOrNull(row.title);
							if (nativeId && title && !titles.has(nativeId)) {
								titles.set(nativeId, title);
							}
						} catch {}
					}
				}
				if (
					tables.has("orchestration_v2_projection_subagents") &&
					tables.has("orchestration_v2_projection_provider_threads")
				) {
					const subRows = db
						.query<{ payload_json: string | null }, []>(
							"SELECT pt.payload_json " +
								"FROM orchestration_v2_projection_subagents s " +
								"JOIN orchestration_v2_projection_provider_threads pt " +
								"ON pt.thread_id = s.child_thread_id " +
								"WHERE s.driver = 'antigravity' OR s.provider = 'antigravity'",
						)
						.all();
					for (const row of subRows) {
						if (!row.payload_json) continue;
						try {
							const payload = JSON.parse(row.payload_json) as {
								nativeThreadRef?: { nativeId?: unknown };
							};
							const nativeId = textOrNull(payload.nativeThreadRef?.nativeId);
							if (nativeId) subagents.add(nativeId);
						} catch {}
					}
				}
			} finally {
				cleanup();
			}
		} catch {}
	}
	return { titles, subagents };
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
	} catch {}
	return summaries;
}

export async function discoverAntigravitySessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const files = getAntigravityDbFiles(paths);
	const items: SessionDiscoveryItem[] = [];

	for (const filePath of files) {
		try {
			const stat = statSync(filePath);
			const sessionId = path.basename(filePath, ".db");
			let cwd: string | null = readAntigravitySidecarCwd(filePath);

			try {
				const { db, cleanup } = openSafeReadonlyDatabase(filePath);
				try {
					const blobMeta = readAntigravityBlobMeta(db, sessionId);
					cwd = cwd ?? blobMeta.cwd;
				} finally {
					cleanup();
				}
			} catch {}

			items.push({
				sessionId,
				harness: "antigravity",
				filePath,
				mtimeMs: stat.mtimeMs,
				sizeBytes: stat.size,
				cwd,
			});
		} catch {
			// skip
		}
	}

	return items;
}
