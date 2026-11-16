import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { openSafeReadonlyDatabase } from "../../platform/sqlite";
import { normalizedCwd } from "../../util";
import type { SessionDiscoveryItem } from "../types";

export function getOpenCodeDbPaths(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const resolved = paths.resolveHarnessPaths("opencode");
	const dbPaths: string[] = [];

	for (const item of resolved) {
		if (item.endsWith(".db") && existsSync(item)) {
			dbPaths.push(item);
		} else if (existsSync(item)) {
			try {
				const entries = readdirSync(item)
					.filter((name) => /^opencode(?:-[^/]*)?\.db$/u.test(name))
					.map((name) => path.join(item, name));
				dbPaths.push(...entries.filter((p) => existsSync(p)));
			} catch {}
		}
	}
	return Array.from(new Set(dbPaths));
}

export async function discoverOpenCodeSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const dbPaths = getOpenCodeDbPaths(paths);
	const sessionMap = new Map<string, SessionDiscoveryItem>();

	for (const dbPath of dbPaths) {
		try {
			const stat = statSync(dbPath);
			const handle = openSafeReadonlyDatabase(dbPath);
			try {
				const tables = new Set(
					handle.db
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type = 'table'",
						)
						.all()
						.map((r) => r.name),
				);

				if (tables.has("session_v2")) {
					const rows = handle.db
						.query<
							{ id: string; directory?: string; time_created: number },
							[]
						>("SELECT id, directory, time_created FROM session_v2")
						.all();
					for (const row of rows) {
						sessionMap.set(row.id, {
							sessionId: row.id,
							harness: "opencode",
							filePath: dbPath,
							mtimeMs: row.time_created || stat.mtimeMs,
							sizeBytes: stat.size,
							cwd: normalizedCwd(row.directory),
						});
					}
				}

				if (tables.has("session")) {
					const rows = handle.db
						.query<
							{ id: string; directory?: string; time_created: number },
							[]
						>("SELECT id, directory, time_created FROM session")
						.all();
					for (const row of rows) {
						if (!sessionMap.has(row.id)) {
							sessionMap.set(row.id, {
								sessionId: row.id,
								harness: "opencode",
								filePath: dbPath,
								mtimeMs: row.time_created || stat.mtimeMs,
								sizeBytes: stat.size,
								cwd: normalizedCwd(row.directory),
							});
						}
					}
				}
			} finally {
				handle.close();
			}
		} catch {
			// skip unreadable db
		}
	}

	return Array.from(sessionMap.values());
}
