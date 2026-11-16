import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { openReadonlyDatabase, tablesIn } from "../../transcripts/shared";
import {
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	walkFiles,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface GooseLocations {
	dbFiles: string[];
	legacyFiles: string[];
}

export function getGooseLocations(
	paths: PlatformPathService = defaultPlatformPathService,
): GooseLocations {
	const dbFiles = new Set<string>();
	const legacyFiles = new Set<string>();
	const home = paths.getHomeDir();

	const checkDbCandidate = (candidate: string): void => {
		const normalized = paths.normalize(candidate);
		if (existsSync(normalized)) {
			dbFiles.add(normalized);
		}
	};

	const checkLegacyDirectory = (dir: string): void => {
		const normalized = paths.normalize(dir);
		if (!existsSync(normalized)) return;
		try {
			const files = walkFiles(normalized, (_p, name) =>
				name.endsWith(".jsonl"),
			);
			for (const f of files) {
				legacyFiles.add(f);
			}
		} catch {
			// skip
		}
	};

	// 1. Environment variable override
	const envRoot =
		(
			paths as unknown as { env?: { get: (k: string) => string | undefined } }
		).env?.get("GOOSE_PATH_ROOT") ?? process.env.GOOSE_PATH_ROOT;
	if (envRoot) {
		const expanded = paths.expandPath(envRoot);
		checkDbCandidate(path.join(expanded, "sessions.db"));
		checkDbCandidate(path.join(expanded, "sessions", "sessions.db"));
		checkLegacyDirectory(path.join(expanded, "sessions"));
		checkLegacyDirectory(path.join(expanded, "legacy-sessions"));
		checkLegacyDirectory(expanded);
	}

	// 2. PlatformPathService resolveHarnessPaths
	const resolved = paths.resolveHarnessPaths("goose");
	for (const p of resolved) {
		checkDbCandidate(path.join(p, "sessions.db"));
		checkDbCandidate(path.join(p, "sessions", "sessions.db"));
		checkLegacyDirectory(path.join(p, "sessions"));
		checkLegacyDirectory(path.join(p, "legacy-sessions"));
		checkLegacyDirectory(p);
	}

	// 3. Standard Cross-Platform Locations
	// macOS
	checkDbCandidate(
		path.join(
			home,
			"Library",
			"Application Support",
			"Block",
			"goose",
			"sessions",
			"sessions.db",
		),
	);
	checkDbCandidate(
		path.join(
			home,
			"Library",
			"Application Support",
			"Block",
			"goose",
			"sessions.db",
		),
	);
	// Linux / XDG
	checkDbCandidate(
		path.join(home, ".local", "share", "goose", "sessions", "sessions.db"),
	);
	checkDbCandidate(path.join(home, ".local", "share", "goose", "sessions.db"));
	checkLegacyDirectory(path.join(home, ".local", "share", "goose", "sessions"));
	// Windows
	checkDbCandidate(
		path.join(
			home,
			"AppData",
			"Roaming",
			"Block",
			"goose",
			"data",
			"sessions",
			"sessions.db",
		),
	);
	checkDbCandidate(
		path.join(
			home,
			"AppData",
			"Roaming",
			"Block",
			"goose",
			"data",
			"sessions.db",
		),
	);

	return {
		dbFiles: Array.from(dbFiles),
		legacyFiles: Array.from(legacyFiles),
	};
}

export async function discoverGooseSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const { dbFiles, legacyFiles } = getGooseLocations(paths);
	const items: SessionDiscoveryItem[] = [];
	const discoveredSessionIds = new Set<string>();

	// 1. Discover sessions from SQLite databases
	for (const dbPath of dbFiles) {
		try {
			const dbStat = statSync(dbPath);
			const db = openReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(db);
				if (tables.has("sessions")) {
					const rows = db
						.query<
							{
								id: string;
								description: string | null;
								working_dir: string | null;
								created_at: number | null;
								updated_at: number | null;
							},
							[]
						>(
							"SELECT id, description, working_dir, created_at, updated_at FROM sessions ORDER BY created_at DESC",
						)
						.all();

					for (const row of rows) {
						if (!row.id || discoveredSessionIds.has(row.id)) continue;
						discoveredSessionIds.add(row.id);
						items.push({
							sessionId: row.id,
							harness: "goose",
							filePath: dbPath,
							mtimeMs: row.updated_at ?? row.created_at ?? dbStat.mtimeMs,
							sizeBytes: dbStat.size,
							cwd: normalizedCwd(row.working_dir),
						});
					}
				}
			} finally {
				db.close();
			}
		} catch {
			// skip corrupt or unreadable DB
		}
	}

	// 2. Discover legacy sessions from JSONL files
	for (const jsonlPath of legacyFiles) {
		try {
			const stat = statSync(jsonlPath);
			const content = Bun.file(jsonlPath);
			const text = await content.text();
			const rows = parseJsonl(text);

			for (const raw of rows) {
				const row = objectOrEmpty(raw);
				const id = textOrNull(row.id) ?? textOrNull(row.sessionId);
				if (id && !discoveredSessionIds.has(id)) {
					discoveredSessionIds.add(id);
					items.push({
						sessionId: id,
						harness: "goose",
						filePath: jsonlPath,
						mtimeMs: stat.mtimeMs,
						sizeBytes: stat.size,
						cwd: normalizedCwd(row.working_dir ?? row.cwd),
					});
				}
			}

			// If no row had explicit id, use the filename
			const fileSessionId = path.basename(jsonlPath, ".jsonl");
			if (!discoveredSessionIds.has(fileSessionId)) {
				discoveredSessionIds.add(fileSessionId);
				items.push({
					sessionId: fileSessionId,
					harness: "goose",
					filePath: jsonlPath,
					mtimeMs: stat.mtimeMs,
					sizeBytes: stat.size,
					cwd: null,
				});
			}
		} catch {
			// skip
		}
	}

	return items;
}
