import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

export function getCommandCodeProjectsRoot(
	paths: PlatformPathService = defaultPlatformPathService,
): string {
	const resolved = paths.resolveHarnessPaths("commandcode");
	const root = resolved[0] ?? path.join(paths.getHomeDir(), ".commandcode");
	return path.join(root, "projects");
}

export function getCommandCodeSessionFiles(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const projectsRoot = getCommandCodeProjectsRoot(paths);
	if (!existsSync(projectsRoot)) return [];

	let projectDirs: string[] = [];
	try {
		projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(projectsRoot, entry.name));
	} catch {
		return [];
	}

	return projectDirs.flatMap((projectDir) =>
		walkFiles(
			projectDir,
			(_filePath, name) =>
				name.endsWith(".jsonl") &&
				!name.endsWith(".checkpoints.jsonl") &&
				!name.endsWith(".prompts.jsonl"),
		),
	);
}

export async function discoverCommandCodeSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const files = getCommandCodeSessionFiles(paths);
	const items: SessionDiscoveryItem[] = [];

	for (const filePath of files) {
		try {
			const stat = statSync(filePath);
			let sessionId = path.basename(filePath, ".jsonl");
			let cwd: string | null = null;

			try {
				const content = readFileSync(filePath, "utf8");
				const rows = parseJsonl(content);
				const header = rows
					.map(objectOrEmpty)
					.find((row) => row.type === "session");
				if (header) {
					sessionId = textOrNull(header.id) ?? sessionId;
					cwd = normalizedCwd(header.cwd) ?? null;
				}
			} catch {
				// fallback
			}

			items.push({
				sessionId,
				harness: "commandcode",
				filePath,
				mtimeMs: stat.mtimeMs,
				sizeBytes: stat.size,
				cwd,
			});
		} catch {
			// skip unreadable
		}
	}

	return items;
}
