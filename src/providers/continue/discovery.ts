import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	normalizedCwd,
	objectOrEmpty,
	textOrNull,
	timestampMs,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface ContinueSessionMeta {
	sessionId: string;
	title?: string;
	dateCreated?: string | number;
	workspaceDirectory?: string;
	messageCount?: number;
}

export function decodeWorkspaceUri(uri?: string | null): string | null {
	if (!uri) return null;
	try {
		let clean = uri;
		if (clean.startsWith("file://")) {
			clean = clean.replace(/^file:\/\//, "");
		}
		if (/^\/[a-zA-Z]:/i.test(clean)) {
			clean = clean.slice(1);
		}
		return decodeURIComponent(clean);
	} catch {
		let clean = uri.replace(/^file:\/\//, "");
		if (/^\/[a-zA-Z]:/i.test(clean)) {
			clean = clean.slice(1);
		}
		return clean;
	}
}

export function getContinueRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const resolved = paths.resolveHarnessPaths("continue");
	const candidates = [...resolved];
	if (candidates.length === 0) {
		const home = paths.getHomeDir();
		candidates.push(path.join(home, ".continue"));
	}

	const uniqueDirs = new Set<string>();
	for (const candidate of candidates) {
		const normalized = paths.normalize(candidate);
		if (existsSync(normalized)) {
			uniqueDirs.add(normalized);
		}
	}

	return Array.from(uniqueDirs);
}

export function findContinueSessionsFiles(roots: string[]): {
	catalogs: string[];
	sessionFiles: string[];
} {
	const catalogs: string[] = [];
	const sessionFiles: string[] = [];

	for (const root of roots) {
		const sessionsDir = path.join(root, "sessions");
		if (!existsSync(sessionsDir)) continue;

		const catalogPath = path.join(sessionsDir, "sessions.json");
		if (existsSync(catalogPath)) {
			catalogs.push(catalogPath);
		}

		try {
			const entries = readdirSync(sessionsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (
					entry.isFile() &&
					entry.name.endsWith(".json") &&
					entry.name !== "sessions.json"
				) {
					sessionFiles.push(path.join(sessionsDir, entry.name));
				}
			}
		} catch {
			// ignore directory read errors
		}
	}

	return {
		catalogs: Array.from(new Set(catalogs)),
		sessionFiles: Array.from(new Set(sessionFiles)),
	};
}

export function findContinueDevDataFiles(roots: string[]): {
	sqliteDbs: string[];
	tokensJsonl: string[];
	chatJsonl: string[];
} {
	const sqliteDbs: string[] = [];
	const tokensJsonl: string[] = [];
	const chatJsonl: string[] = [];

	for (const root of roots) {
		const devDataDir = path.join(root, "dev_data");
		if (!existsSync(devDataDir)) continue;

		const directSqlite = path.join(devDataDir, "devdata.sqlite");
		if (existsSync(directSqlite)) sqliteDbs.push(directSqlite);

		const directTokens = path.join(devDataDir, "tokensGenerated.jsonl");
		if (existsSync(directTokens)) tokensJsonl.push(directTokens);

		const directChat = path.join(devDataDir, "chatInteraction.jsonl");
		if (existsSync(directChat)) chatJsonl.push(directChat);

		// Also check versioned subdirectories like dev_data/0.2.0/
		try {
			const subEntries = readdirSync(devDataDir, { withFileTypes: true });
			for (const sub of subEntries) {
				if (!sub.isDirectory()) continue;
				const subDir = path.join(devDataDir, sub.name);

				const subSqlite = path.join(subDir, "devdata.sqlite");
				if (existsSync(subSqlite)) sqliteDbs.push(subSqlite);

				const subTokens = path.join(subDir, "tokensGenerated.jsonl");
				if (existsSync(subTokens)) tokensJsonl.push(subTokens);

				const subChat = path.join(subDir, "chatInteraction.jsonl");
				if (existsSync(subChat)) chatJsonl.push(subChat);
			}
		} catch {
			// ignore
		}
	}

	return {
		sqliteDbs: Array.from(new Set(sqliteDbs)),
		tokensJsonl: Array.from(new Set(tokensJsonl)),
		chatJsonl: Array.from(new Set(chatJsonl)),
	};
}

export function getContinueSessionFiles(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const roots = getContinueRoots(paths);
	const files = new Set<string>();

	const { catalogs, sessionFiles } = findContinueSessionsFiles(roots);
	for (const f of catalogs) files.add(f);
	for (const f of sessionFiles) files.add(f);

	const { sqliteDbs, tokensJsonl, chatJsonl } = findContinueDevDataFiles(roots);
	for (const f of sqliteDbs) files.add(f);
	for (const f of tokensJsonl) files.add(f);
	for (const f of chatJsonl) files.add(f);

	return Array.from(files);
}

export async function discoverContinueSessions(
	paths: PlatformPathService = defaultPlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const roots = getContinueRoots(paths);
	const { catalogs, sessionFiles } = findContinueSessionsFiles(roots);
	const itemsMap = new Map<string, SessionDiscoveryItem>();
	const catalogMap = new Map<string, ContinueSessionMeta>();

	// 1. Read sessions.json catalogs
	for (const catPath of catalogs) {
		try {
			const content = readFileSync(catPath, "utf8");
			const list = JSON.parse(content);
			if (Array.isArray(list)) {
				for (const raw of list) {
					const entry = objectOrEmpty(raw);
					const id = textOrNull(entry.sessionId);
					if (!id) continue;
					const meta: ContinueSessionMeta = {
						sessionId: id,
						title: textOrNull(entry.title) ?? undefined,
						dateCreated:
							typeof entry.dateCreated === "number" ||
							typeof entry.dateCreated === "string"
								? entry.dateCreated
								: undefined,
						workspaceDirectory:
							textOrNull(entry.workspaceDirectory) ?? undefined,
						messageCount:
							typeof entry.messageCount === "number"
								? entry.messageCount
								: undefined,
					};
					catalogMap.set(id, meta);

					// Pre-seed item in case individual json file is not present
					try {
						const stat = statSync(catPath);
						itemsMap.set(id, {
							sessionId: id,
							harness: "continue",
							filePath: catPath,
							mtimeMs: timestampMs(meta.dateCreated) ?? stat.mtimeMs,
							sizeBytes: stat.size,
							cwd: normalizedCwd(decodeWorkspaceUri(meta.workspaceDirectory)),
						});
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// ignore
		}
	}

	// 2. Discover individual session files
	for (const sessionPath of sessionFiles) {
		try {
			const stat = statSync(sessionPath);
			const baseName = path.basename(sessionPath, ".json");
			let sessionId = baseName;
			let cwd: string | null = null;
			let createdAt: number | null = null;

			try {
				const content = readFileSync(sessionPath, "utf8");
				const parsed = JSON.parse(content);
				if (typeof parsed === "object" && parsed !== null) {
					sessionId = textOrNull(parsed.sessionId) ?? baseName;
					cwd = normalizedCwd(
						decodeWorkspaceUri(textOrNull(parsed.workspaceDirectory)),
					);
					createdAt = timestampMs(parsed.dateCreated);
				}
			} catch {
				// ignore
			}

			const catMeta = catalogMap.get(sessionId);
			if (!cwd && catMeta?.workspaceDirectory) {
				cwd = normalizedCwd(decodeWorkspaceUri(catMeta.workspaceDirectory));
			}

			itemsMap.set(sessionId, {
				sessionId,
				harness: "continue",
				filePath: sessionPath,
				mtimeMs: createdAt ?? timestampMs(catMeta?.dateCreated) ?? stat.mtimeMs,
				sizeBytes: stat.size,
				cwd,
			});
		} catch {
			// ignore
		}
	}

	// 3. If no sessions were found from sessions/ but dev_data exists
	if (itemsMap.size === 0) {
		const devData = findContinueDevDataFiles(roots);
		if (devData.sqliteDbs.length > 0 || devData.tokensJsonl.length > 0) {
			const primaryFile = devData.sqliteDbs[0] ?? devData.tokensJsonl[0];
			if (primaryFile) {
				try {
					const stat = statSync(primaryFile);
					itemsMap.set("continue-dev-data", {
						sessionId: "continue-dev-data",
						harness: "continue",
						filePath: primaryFile,
						mtimeMs: stat.mtimeMs,
						sizeBytes: stat.size,
						cwd: null,
					});
				} catch {
					// ignore
				}
			}
		}
	}

	return Array.from(itemsMap.values());
}
