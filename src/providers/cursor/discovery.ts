import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { uriToPath } from "../../platform/normalizer";
import type { PlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase } from "../../platform/sqlite";
import type { SessionDiscoveryItem } from "../types";
import type { CursorComposerData } from "./types";

export interface CursorRoots {
	globalStorage: string;
	workspaceStorage: string;
}

export function getCursorRoots(paths: PlatformPathService): CursorRoots {
	const resolved = paths.resolveHarnessPaths("cursor");
	const home = paths.getHomeDir();

	const globalStorage =
		resolved[0] ??
		path.join(home, ".config", "Cursor", "User", "globalStorage");
	const workspaceStorage =
		resolved[1] ??
		path.join(home, ".config", "Cursor", "User", "workspaceStorage");

	return { globalStorage, workspaceStorage };
}

export function getCursorGlobalDbPath(
	paths: PlatformPathService,
): string | null {
	const { globalStorage } = getCursorRoots(paths);
	const dbPath = path.join(globalStorage, "state.vscdb");
	return existsSync(dbPath) ? dbPath : null;
}

export interface WorkspaceMapping {
	cwd: string | null;
	workspaceHash: string;
}

export function buildCursorWorkspaceMap(
	workspaceStorageDir: string,
): Map<string, WorkspaceMapping> {
	const composerMap = new Map<string, WorkspaceMapping>();
	if (!existsSync(workspaceStorageDir)) return composerMap;

	let entries: string[] = [];
	try {
		entries = readdirSync(workspaceStorageDir);
	} catch {
		return composerMap;
	}

	for (const entry of entries) {
		const wsDir = path.join(workspaceStorageDir, entry);
		let isDir = false;
		try {
			isDir = statSync(wsDir).isDirectory();
		} catch {
			continue;
		}
		if (!isDir) continue;

		// 1. Resolve CWD from workspace.json
		let cwd: string | null = null;
		const wsJsonPath = path.join(wsDir, "workspace.json");
		if (existsSync(wsJsonPath)) {
			try {
				const content = JSON.parse(
					new TextDecoder().decode(
						new Uint8Array(
							// Synchronous read
							require("node:fs").readFileSync(wsJsonPath),
						),
					),
				);
				const folderUri = content.folder ?? content.workspace;
				if (typeof folderUri === "string") {
					cwd = uriToPath(folderUri);
				}
			} catch {}
		}

		// 2. Query workspace state.vscdb for composer IDs
		const wsDbPath = path.join(wsDir, "state.vscdb");
		if (existsSync(wsDbPath)) {
			try {
				const handle = openSafeReadonlyDatabase(wsDbPath, { maxRetries: 2 });
				try {
					const row = handle.db
						.query<{ value: string }, [string]>(
							"SELECT value FROM ItemTable WHERE key = ?",
						)
						.get("composer.composerData");

					if (row?.value) {
						const parsed = JSON.parse(row.value) as {
							allComposers?: Array<{ composerId?: string }>;
						};
						if (Array.isArray(parsed.allComposers)) {
							for (const comp of parsed.allComposers) {
								if (typeof comp.composerId === "string" && comp.composerId) {
									composerMap.set(comp.composerId, {
										cwd,
										workspaceHash: entry,
									});
								}
							}
						}
					}
				} finally {
					handle.close();
				}
			} catch {}
		}
	}

	return composerMap;
}

export function getAllCursorFiles(paths: PlatformPathService): string[] {
	const { globalStorage, workspaceStorage } = getCursorRoots(paths);
	const files: string[] = [];

	const globalDb = path.join(globalStorage, "state.vscdb");
	if (existsSync(globalDb)) {
		files.push(globalDb);
	}

	if (existsSync(workspaceStorage)) {
		try {
			for (const entry of readdirSync(workspaceStorage)) {
				const wsDir = path.join(workspaceStorage, entry);
				const wsDb = path.join(wsDir, "state.vscdb");
				if (existsSync(wsDb)) files.push(wsDb);

				const wsJson = path.join(wsDir, "workspace.json");
				if (existsSync(wsJson)) files.push(wsJson);

				const chatDir = path.join(wsDir, "chatSessions");
				if (existsSync(chatDir)) {
					try {
						for (const chatFile of readdirSync(chatDir)) {
							if (chatFile.endsWith(".json") || chatFile.endsWith(".jsonl")) {
								files.push(path.join(chatDir, chatFile));
							}
						}
					} catch {}
				}
			}
		} catch {}
	}

	return files.sort();
}

export async function discoverCursorSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const { globalStorage, workspaceStorage } = getCursorRoots(paths);
	const globalDbPath = path.join(globalStorage, "state.vscdb");
	const sessionMap = new Map<string, SessionDiscoveryItem>();

	const wsMap = buildCursorWorkspaceMap(workspaceStorage);

	// 1. Scan globalStorage state.vscdb
	if (existsSync(globalDbPath)) {
		try {
			const stat = statSync(globalDbPath);
			const handle = openSafeReadonlyDatabase(globalDbPath);
			try {
				// Query cursorDiskKV for composerData
				const rows = handle.db
					.query<{ key: string; value: string }, []>(
						"SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
					)
					.all();

				for (const row of rows) {
					const composerId = row.key.replace(/^composerData:/, "");
					let mtime = stat.mtimeMs;
					const cwd = wsMap.get(composerId)?.cwd ?? null;

					try {
						const data = JSON.parse(row.value) as CursorComposerData;
						if (data.createdAt && typeof data.createdAt === "number") {
							mtime = data.createdAt;
						}
					} catch {}

					sessionMap.set(composerId, {
						sessionId: composerId,
						harness: "cursor",
						filePath: globalDbPath,
						mtimeMs: mtime,
						sizeBytes: stat.size,
						cwd,
					});
				}
			} finally {
				handle.close();
			}
		} catch {}
	}

	// 2. Discover composers present in workspaceStorage but missing from globalStorage
	for (const [composerId, info] of wsMap.entries()) {
		if (!sessionMap.has(composerId)) {
			const wsDbPath = path.join(
				workspaceStorage,
				info.workspaceHash,
				"state.vscdb",
			);
			const stat = existsSync(wsDbPath) ? statSync(wsDbPath) : null;
			sessionMap.set(composerId, {
				sessionId: composerId,
				harness: "cursor",
				filePath: existsSync(wsDbPath) ? wsDbPath : globalDbPath,
				mtimeMs: stat ? stat.mtimeMs : Date.now(),
				sizeBytes: stat ? stat.size : 0,
				cwd: info.cwd,
			});
		}
	}

	// 3. Scan workspaceStorage chatSessions/*.json
	if (existsSync(workspaceStorage)) {
		try {
			for (const entry of readdirSync(workspaceStorage)) {
				const chatDir = path.join(workspaceStorage, entry, "chatSessions");
				if (!existsSync(chatDir)) continue;

				const wsJsonPath = path.join(workspaceStorage, entry, "workspace.json");
				let cwd: string | null = null;
				if (existsSync(wsJsonPath)) {
					try {
						const content = JSON.parse(
							require("node:fs").readFileSync(wsJsonPath, "utf-8"),
						);
						if (content.folder) cwd = uriToPath(content.folder);
					} catch {}
				}

				for (const chatFile of readdirSync(chatDir)) {
					if (!chatFile.endsWith(".json") && !chatFile.endsWith(".jsonl"))
						continue;
					const filePath = path.join(chatDir, chatFile);
					try {
						const stat = statSync(filePath);
						const fileBase = chatFile.replace(/\.(json|jsonl)$/, "");
						if (!sessionMap.has(fileBase)) {
							sessionMap.set(fileBase, {
								sessionId: fileBase,
								harness: "cursor",
								filePath,
								mtimeMs: stat.mtimeMs,
								sizeBytes: stat.size,
								cwd,
							});
						}
					} catch {}
				}
			}
		} catch {}
	}

	return Array.from(sessionMap.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
}
