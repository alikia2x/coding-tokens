import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	walkFiles,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface ClaudeRoots {
	root: string;
	projectsRoot: string;
	statsCachePath: string;
}

export function getClaudeRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): ClaudeRoots {
	const resolved = paths.resolveHarnessPaths("claude");
	const root = resolved[0] ?? path.join(paths.getHomeDir(), ".claude");
	return {
		root,
		projectsRoot: path.join(root, "projects"),
		statsCachePath: path.join(root, "stats-cache.json"),
	};
}

export function decodeClaudeProjectPath(encodedName: string): string {
	if (!encodedName) return "/";
	// On Windows, drive letters might be encoded as C-Users-...
	if (/^[A-Za-z]-/u.test(encodedName)) {
		return `${encodedName[0]}:${encodedName.slice(1).replaceAll("-", "/")}`;
	}
	// POSIX absolute paths start with - (replacing leading /)
	if (encodedName.startsWith("-")) {
		return `/${encodedName.slice(1).replaceAll("-", "/")}`;
	}
	return encodedName.replaceAll("-", "/");
}

export interface ClaudeFiles {
	mainFiles: string[];
	subagentFiles: string[];
	allFiles: string[];
}

export function getClaudeSessionFiles(
	paths: PlatformPathService = defaultPlatformPathService,
): ClaudeFiles {
	const { projectsRoot } = getClaudeRoots(paths);
	if (!existsSync(projectsRoot)) {
		return { mainFiles: [], subagentFiles: [], allFiles: [] };
	}

	let projectDirs: string[] = [];
	try {
		projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(projectsRoot, entry.name));
	} catch {
		return { mainFiles: [], subagentFiles: [], allFiles: [] };
	}

	const mainFiles: string[] = [];
	const subagentFiles: string[] = [];

	for (const projectDir of projectDirs) {
		const files = walkFiles(
			projectDir,
			(_filePath, name) =>
				name.endsWith(".jsonl") &&
				!name.endsWith(".prompts.jsonl") &&
				!name.endsWith(".checkpoints.jsonl"),
		);
		for (const file of files) {
			if (file.includes("/subagents/") || file.includes("\\subagents\\")) {
				subagentFiles.push(file);
			} else {
				mainFiles.push(file);
			}
		}
	}

	return {
		mainFiles,
		subagentFiles,
		allFiles: [...mainFiles, ...subagentFiles],
	};
}

export async function discoverClaudeSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const { allFiles } = getClaudeSessionFiles(paths);
	const items: SessionDiscoveryItem[] = [];

	for (const filePath of allFiles) {
		try {
			const stat = statSync(filePath);
			let sessionId = path.basename(filePath, ".jsonl");
			let cwd: string | null = null;

			// Peek first few lines to extract exact session ID and cwd
			try {
				const file = Bun.file(filePath);
				const text = await file.text();
				const lines = parseJsonl(text);
				for (const rawLine of lines) {
					const line = objectOrEmpty(rawLine);
					if (!sessionId || sessionId === path.basename(filePath, ".jsonl")) {
						sessionId = textOrNull(line.sessionId) ?? sessionId;
					}
					if (line.cwd) {
						cwd = normalizedCwd(line.cwd);
						break;
					}
				}
			} catch {
				// fallback
			}

			if (!cwd) {
				const projectDirName = path.basename(path.dirname(filePath));
				cwd = decodeClaudeProjectPath(projectDirName);
			}

			items.push({
				sessionId,
				harness: "claude",
				filePath,
				mtimeMs: stat.mtimeMs,
				sizeBytes: stat.size,
				cwd,
			});
		} catch {
			// Skip unreadable files
		}
	}

	return items;
}
