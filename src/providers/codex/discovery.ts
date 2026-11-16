import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../../platform/paths";
import { walkFiles } from "../../util";
import type { SessionDiscoveryItem } from "../types";

export function isRollout(name: string): boolean {
	return name.startsWith("rollout-") && /\.jsonl(?:\.zst)?$/u.test(name);
}

export function getCodexRoots(paths: PlatformPathService): {
	codexHome: string;
	sessionsRoot: string;
	archivedRoot: string;
} {
	const resolved = paths.resolveHarnessPaths("codex");
	const codexHome = resolved[0] ?? path.join(paths.getHomeDir(), ".codex");
	const sessionsRoot = resolved[1] ?? path.join(codexHome, "sessions");
	const archivedRoot = resolved[2] ?? path.join(codexHome, "archived_sessions");
	return { codexHome, sessionsRoot, archivedRoot };
}

export function getCodexRolloutFiles(paths: PlatformPathService): string[] {
	const { sessionsRoot, archivedRoot } = getCodexRoots(paths);
	const files: string[] = [];
	if (existsSync(sessionsRoot)) {
		files.push(...walkFiles(sessionsRoot, (_p, name) => isRollout(name)));
	}
	if (existsSync(archivedRoot)) {
		files.push(...walkFiles(archivedRoot, (_p, name) => isRollout(name)));
	}
	return files.sort(
		(left, right) =>
			path.basename(left).localeCompare(path.basename(right)) ||
			left.localeCompare(right),
	);
}

export function codexSessionFiles(
	sessionId: string,
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const needle = sessionId.toLowerCase();
	return getCodexRolloutFiles(paths).filter((filePath) =>
		path.basename(filePath).toLowerCase().includes(needle),
	);
}

export async function discoverCodexSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const files = getCodexRolloutFiles(paths);
	const sessionMap = new Map<string, SessionDiscoveryItem>();

	for (const filePath of files) {
		try {
			const stat = statSync(filePath);
			// Session ID is derived from filename rollout-<timestamp>-<sessionId>...
			// or read from session_meta
			const base = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/u, "");
			// standard pattern: rollout-YYYYMMDD-HHMMSS-<guid> or similar
			const fallbackId = base;

			let sessionId = fallbackId;
			let cwd: string | null = null;

			// Quick scan of first few lines for session_meta if file is small or readable
			try {
				const { readRolloutSync } = await import("./usage");
				const events = readRolloutSync(filePath);
				const meta = events.find(
					(e) =>
						typeof e === "object" &&
						e !== null &&
						(e as Record<string, unknown>).type === "session_meta",
				) as Record<string, unknown> | undefined;
				if (meta) {
					const payload = (meta.payload ?? {}) as Record<string, unknown>;
					const metaId = (payload.id ?? payload.session_id) as
						| string
						| undefined;
					if (metaId) sessionId = metaId;
					if (typeof payload.cwd === "string") cwd = payload.cwd;
				}
			} catch {
				// Fallback to filename
			}

			const existing = sessionMap.get(sessionId);
			if (!existing || stat.mtimeMs > existing.mtimeMs) {
				sessionMap.set(sessionId, {
					sessionId,
					harness: "codex",
					filePath,
					mtimeMs: stat.mtimeMs,
					sizeBytes: stat.size,
					cwd,
				});
			}
		} catch {
			// skip unreadable file
		}
	}

	return Array.from(sessionMap.values());
}
