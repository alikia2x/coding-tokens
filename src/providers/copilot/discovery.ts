import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { uriToPath } from "../../platform/normalizer";
import type { PlatformPathService } from "../../platform/paths";
import { walkFiles } from "../../util";
import type { SessionDiscoveryItem } from "../types";
import type { CopilotChatSessionData } from "./types";

export interface CopilotRoots {
	workspaceStorageDirs: string[];
	copilotHomeDirs: string[];
}

export function getCopilotRoots(paths: PlatformPathService): CopilotRoots {
	const resolved = paths.resolveHarnessPaths("copilot");
	const home = paths.getHomeDir();

	const wsDirs: string[] = [];
	for (const r of resolved) {
		if (existsSync(r)) wsDirs.push(r);
	}

	// Also check fallback / Insiders locations
	const fallbackWsDirs = [
		path.join(
			home,
			"Library",
			"Application Support",
			"Code",
			"User",
			"workspaceStorage",
		),
		path.join(
			home,
			"Library",
			"Application Support",
			"Code - Insiders",
			"User",
			"workspaceStorage",
		),
		path.join(home, ".config", "Code", "User", "workspaceStorage"),
		path.join(home, ".config", "Code - Insiders", "User", "workspaceStorage"),
		path.join(home, "AppData", "Roaming", "Code", "User", "workspaceStorage"),
	];

	for (const fb of fallbackWsDirs) {
		if (existsSync(fb) && !wsDirs.includes(fb)) {
			wsDirs.push(fb);
		}
	}

	const copilotHomeDirs = [path.join(home, ".copilot")];

	return {
		workspaceStorageDirs:
			wsDirs.length > 0
				? wsDirs
				: [
						resolved[0] ??
							path.join(home, ".config", "Code", "User", "workspaceStorage"),
					],
		copilotHomeDirs,
	};
}

export function buildCopilotWorkspaceCwdMap(
	workspaceStorageDir: string,
): Map<string, string> {
	const cwdMap = new Map<string, string>();
	if (!existsSync(workspaceStorageDir)) return cwdMap;

	let entries: string[] = [];
	try {
		entries = readdirSync(workspaceStorageDir);
	} catch {
		return cwdMap;
	}

	for (const entry of entries) {
		const wsJsonPath = path.join(workspaceStorageDir, entry, "workspace.json");
		if (existsSync(wsJsonPath)) {
			try {
				const content = JSON.parse(readFileSync(wsJsonPath, "utf-8"));
				const folderUri = content.folder ?? content.workspace;
				if (typeof folderUri === "string") {
					cwdMap.set(entry, uriToPath(folderUri));
				}
			} catch {}
		}
	}

	return cwdMap;
}

export function getAllCopilotFiles(paths: PlatformPathService): string[] {
	const { workspaceStorageDirs, copilotHomeDirs } = getCopilotRoots(paths);
	const files: string[] = [];

	// 1. Scan workspaceStorage chatSessions
	for (const wsDir of workspaceStorageDirs) {
		if (!existsSync(wsDir)) continue;

		// Check if wsDir directly contains chatSessions (e.g. fixture structure)
		const directChatDir = path.join(wsDir, "chatSessions");
		if (existsSync(directChatDir)) {
			try {
				files.push(
					...walkFiles(
						directChatDir,
						(_p, name) => name.endsWith(".json") || name.endsWith(".jsonl"),
					),
				);
			} catch {}
		}

		// Check nested workspace hash folders
		try {
			for (const entry of readdirSync(wsDir)) {
				const chatDir = path.join(wsDir, entry, "chatSessions");
				if (existsSync(chatDir)) {
					try {
						files.push(
							...walkFiles(
								chatDir,
								(_p, name) => name.endsWith(".json") || name.endsWith(".jsonl"),
							),
						);
					} catch {}
				}
			}
		} catch {}
	}

	// 2. Scan standalone logs in copilotHomeDirs and workspaceStorageDirs
	const allLogSearchDirs = [
		...copilotHomeDirs.map((d) => path.join(d, "logs")),
		...workspaceStorageDirs.map((d) => path.join(d, "logs")),
	];

	for (const logsDir of allLogSearchDirs) {
		if (existsSync(logsDir)) {
			try {
				files.push(...walkFiles(logsDir, (_p, name) => name.endsWith(".log")));
			} catch {}
		}
	}

	return Array.from(new Set(files)).sort();
}

export async function discoverCopilotSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const { workspaceStorageDirs, copilotHomeDirs } = getCopilotRoots(paths);
	const sessionMap = new Map<string, SessionDiscoveryItem>();

	for (const wsDir of workspaceStorageDirs) {
		if (!existsSync(wsDir)) continue;

		const cwdMap = buildCopilotWorkspaceCwdMap(wsDir);

		// A. Direct chatSessions folder (e.g. tests/fixtures/harnesses/copilot/chatSessions)
		const directChatDir = path.join(wsDir, "chatSessions");
		if (existsSync(directChatDir)) {
			try {
				for (const f of readdirSync(directChatDir)) {
					if (!f.endsWith(".json") && !f.endsWith(".jsonl")) continue;
					const filePath = path.join(directChatDir, f);
					try {
						const stat = statSync(filePath);
						const fileBase = f.replace(/\.(json|jsonl)$/, "");
						let sessionId = fileBase;
						let mtime = stat.mtimeMs;

						try {
							const content = JSON.parse(
								readFileSync(filePath, "utf-8"),
							) as CopilotChatSessionData;
							sessionId = content.sessionId ?? content.id ?? fileBase;
							mtime =
								content.lastMessageDate ?? content.creationDate ?? stat.mtimeMs;
						} catch {}

						sessionMap.set(sessionId, {
							sessionId,
							harness: "copilot",
							filePath,
							mtimeMs: mtime,
							sizeBytes: stat.size,
							cwd: null,
						});
					} catch {}
				}
			} catch {}
		}

		// B. Nested <hash>/chatSessions/
		try {
			for (const hash of readdirSync(wsDir)) {
				const chatDir = path.join(wsDir, hash, "chatSessions");
				if (!existsSync(chatDir)) continue;

				const cwd = cwdMap.get(hash) ?? null;

				for (const f of readdirSync(chatDir)) {
					if (!f.endsWith(".json") && !f.endsWith(".jsonl")) continue;
					const filePath = path.join(chatDir, f);
					try {
						const stat = statSync(filePath);
						const fileBase = f.replace(/\.(json|jsonl)$/, "");
						let sessionId = fileBase;
						let mtime = stat.mtimeMs;

						try {
							const content = JSON.parse(
								readFileSync(filePath, "utf-8"),
							) as CopilotChatSessionData;
							sessionId = content.sessionId ?? content.id ?? fileBase;
							mtime =
								content.lastMessageDate ?? content.creationDate ?? stat.mtimeMs;
						} catch {}

						sessionMap.set(sessionId, {
							sessionId,
							harness: "copilot",
							filePath,
							mtimeMs: mtime,
							sizeBytes: stat.size,
							cwd,
						});
					} catch {}
				}
			}
		} catch {}
	}

	// C. Scan standalone Copilot CLI logs
	const allLogSearchDirs = [
		...copilotHomeDirs.map((d) => path.join(d, "logs")),
		...workspaceStorageDirs.map((d) => path.join(d, "logs")),
	];

	for (const logsDir of allLogSearchDirs) {
		if (existsSync(logsDir)) {
			try {
				for (const f of readdirSync(logsDir)) {
					if (!f.startsWith("process-") || !f.endsWith(".log")) continue;
					const filePath = path.join(logsDir, f);
					try {
						const stat = statSync(filePath);
						if (stat.size === 0) continue;
						const sessionId = f.replace(/\.log$/, "");
						if (!sessionMap.has(sessionId)) {
							sessionMap.set(sessionId, {
								sessionId,
								harness: "copilot",
								filePath,
								mtimeMs: stat.mtimeMs,
								sizeBytes: stat.size,
								cwd: null,
							});
						}
					} catch {}
				}
			} catch {}
		}
	}

	return Array.from(sessionMap.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
}
