import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { normalizedCwd, objectOrEmpty, textOrNull } from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface RooTaskHistoryItem {
	id: string;
	ulid?: string;
	ts?: number;
	task?: string;
	tokensIn?: number;
	tokensOut?: number;
	cacheWrites?: number;
	cacheReads?: number;
	totalCost?: number;
	cwdOnTaskInitialization?: string;
	modelId?: string;
	mode?: string;
}

export function getRooRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const resolved = paths.resolveHarnessPaths("roo");
	const candidates = [...resolved];

	// Also add potential Kilo Code paths in same parent of resolved globalStorage
	for (const r of resolved) {
		const parent = path.dirname(r);
		candidates.push(path.join(parent, "kilo-code.kilo-code"));
		candidates.push(path.join(parent, "rooveterinaryinc.kilo-code"));
	}

	if (candidates.length === 0) {
		const home = paths.getHomeDir();
		candidates.push(path.join(home, ".roo"), path.join(home, ".kilo"));
	}

	const uniqueDirs = new Set<string>();
	for (const candidate of candidates) {
		const normalized = paths.normalize(candidate);
		if (existsSync(normalized)) {
			uniqueDirs.add(normalized);
			const subData = path.join(normalized, "data");
			if (existsSync(subData)) {
				uniqueDirs.add(paths.normalize(subData));
			}
		}
	}

	return Array.from(uniqueDirs);
}

export function findRooTaskHistoryFiles(roots: string[]): string[] {
	const files: string[] = [];
	for (const root of roots) {
		const possible = [
			path.join(root, "taskHistory.json"),
			path.join(root, "state", "taskHistory.json"),
		];
		for (const p of possible) {
			if (existsSync(p)) {
				files.push(p);
			}
		}
	}
	return Array.from(new Set(files));
}

export function findRooTasksDirs(roots: string[]): string[] {
	const dirs: string[] = [];
	for (const root of roots) {
		const directTasks = path.join(root, "tasks");
		if (existsSync(directTasks)) {
			dirs.push(directTasks);
		}
	}
	return Array.from(new Set(dirs));
}

export function getRooSessionFiles(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const roots = getRooRoots(paths);
	const files = new Set<string>();

	for (const historyPath of findRooTaskHistoryFiles(roots)) {
		files.add(historyPath);
	}

	for (const tasksDir of findRooTasksDirs(roots)) {
		try {
			const entries = readdirSync(tasksDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const taskFolder = path.join(tasksDir, entry.name);
				for (const jsonName of [
					"ui_messages.json",
					"api_conversation_history.json",
					"task_metadata.json",
				]) {
					const jsonPath = path.join(taskFolder, jsonName);
					if (existsSync(jsonPath)) {
						files.add(jsonPath);
					}
				}
			}
		} catch {
			// ignore directory read errors
		}
	}

	return Array.from(files);
}

export async function discoverRooSessions(
	paths: PlatformPathService = defaultPlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const roots = getRooRoots(paths);
	const itemsMap = new Map<string, SessionDiscoveryItem>();
	const historyMetadataMap = new Map<string, RooTaskHistoryItem>();

	// 1. Read taskHistory.json for known task metadata & modes
	for (const historyFile of findRooTaskHistoryFiles(roots)) {
		try {
			const content = readFileSync(historyFile, "utf8");
			const historyArray = JSON.parse(content);
			if (Array.isArray(historyArray)) {
				for (const raw of historyArray) {
					const entry = objectOrEmpty(raw);
					const id = textOrNull(entry.id);
					if (!id) continue;
					const item: RooTaskHistoryItem = {
						id,
						ulid: textOrNull(entry.ulid) ?? undefined,
						ts: typeof entry.ts === "number" ? entry.ts : undefined,
						task: textOrNull(entry.task) ?? undefined,
						tokensIn: typeof entry.tokensIn === "number" ? entry.tokensIn : 0,
						tokensOut:
							typeof entry.tokensOut === "number" ? entry.tokensOut : 0,
						cacheWrites:
							typeof entry.cacheWrites === "number" ? entry.cacheWrites : 0,
						cacheReads:
							typeof entry.cacheReads === "number" ? entry.cacheReads : 0,
						totalCost:
							typeof entry.totalCost === "number" ? entry.totalCost : 0,
						cwdOnTaskInitialization:
							normalizedCwd(entry.cwdOnTaskInitialization) ?? undefined,
						modelId: textOrNull(entry.modelId) ?? undefined,
						mode: textOrNull(entry.mode) ?? undefined,
					};
					historyMetadataMap.set(id, item);

					try {
						const stat = statSync(historyFile);
						itemsMap.set(id, {
							sessionId: id,
							harness: "roo",
							filePath: historyFile,
							mtimeMs: item.ts ?? stat.mtimeMs,
							sizeBytes: stat.size,
							cwd: item.cwdOnTaskInitialization ?? null,
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

	// 2. Discover task folders on disk
	for (const tasksDir of findRooTasksDirs(roots)) {
		try {
			const entries = readdirSync(tasksDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const taskId = entry.name;
				const taskFolder = path.join(tasksDir, taskId);
				const uiMessagesPath = path.join(taskFolder, "ui_messages.json");
				const metaPath = path.join(taskFolder, "task_metadata.json");

				let primaryFile = taskFolder;
				let mtimeMs = Date.now();
				let sizeBytes = 0;

				if (existsSync(uiMessagesPath)) {
					primaryFile = uiMessagesPath;
					try {
						const stat = statSync(uiMessagesPath);
						mtimeMs = stat.mtimeMs;
						sizeBytes = stat.size;
					} catch {
						// ignore
					}
				} else {
					try {
						const stat = statSync(taskFolder);
						mtimeMs = stat.mtimeMs;
						sizeBytes = stat.size;
					} catch {
						// ignore
					}
				}

				let cwd: string | null =
					historyMetadataMap.get(taskId)?.cwdOnTaskInitialization ?? null;

				if (!cwd && existsSync(metaPath)) {
					try {
						const metaContent = JSON.parse(readFileSync(metaPath, "utf8"));
						cwd = normalizedCwd(metaContent.cwd) ?? null;
					} catch {
						// ignore
					}
				}

				itemsMap.set(taskId, {
					sessionId: taskId,
					harness: "roo",
					filePath: primaryFile,
					mtimeMs,
					sizeBytes,
					cwd,
				});
			}
		} catch {
			// ignore directory errors
		}
	}

	return Array.from(itemsMap.values());
}
