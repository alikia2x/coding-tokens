import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	normalizedCwd,
	objectOrEmpty,
	textOrNull,
	walkFiles,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface DshSessionLog {
	filePath: string;
	generation: number;
}

export function generationOf(name: string): number {
	const match = name.match(/^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u);
	return match?.[1] ? Number(match[1]) : 0;
}

export function getDshRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const resolved = paths.resolveHarnessPaths("dsh");
	return resolved.filter((root) => existsSync(path.join(root, "sessions")));
}

export function collectDshLogs(paths: PlatformPathService): DshSessionLog[] {
	const existingRoots = getDshRoots(paths);
	const logs: DshSessionLog[] = [];

	for (const root of existingRoots) {
		const candidates = walkFiles(
			path.join(root, "sessions"),
			(_filePath, name) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(name),
		);
		const bySessionDirectory = new Map<string, DshSessionLog>();
		for (const filePath of candidates) {
			const candidate: DshSessionLog = {
				filePath,
				generation: generationOf(path.basename(filePath)),
			};
			const key = path.dirname(filePath);
			const current = bySessionDirectory.get(key);
			if (
				!current ||
				candidate.generation > current.generation ||
				(candidate.generation === current.generation &&
					filePath.endsWith(".zstd"))
			) {
				bySessionDirectory.set(key, candidate);
			}
		}
		logs.push(...bySessionDirectory.values());
	}

	return logs;
}

export async function discoverDshSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const logs = collectDshLogs(paths);
	const items: SessionDiscoveryItem[] = [];

	for (const log of logs) {
		try {
			const stat = statSync(log.filePath);
			let sessionId = path.basename(path.dirname(log.filePath));
			let cwd: string | null = null;

			try {
				const { readLogSync } = await import("./usage");
				const events = readLogSync(log.filePath).map(objectOrEmpty);
				const header = events.find((event) => event.type === "session");
				if (header) {
					const id = textOrNull(header.id);
					if (id) sessionId = id;
					cwd = normalizedCwd(header.cwd) ?? null;
				}
			} catch {
				// fallback to folder name
			}

			items.push({
				sessionId,
				harness: "dsh",
				filePath: log.filePath,
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
