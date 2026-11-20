import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../../platform/paths";
import {
	objectOrEmpty,
	readJsonlFileSync,
	textOrNull,
	walkFiles,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";

export function isRollout(name: string): boolean {
	return name.startsWith("rollout-") && /\.jsonl(?:\.zst)?$/u.test(name);
}

function codexFileMatchesSession(
	filePath: string,
	lowerNeedle: string,
): boolean {
	const stem = path
		.basename(filePath)
		.replace(/\.jsonl(?:\.zst)?$/iu, "")
		.toLowerCase();
	return (
		stem === lowerNeedle ||
		stem === `rollout-${lowerNeedle}` ||
		stem.endsWith(`-${lowerNeedle}`) ||
		stem.endsWith(`_${lowerNeedle}`) ||
		stem.includes(`-${lowerNeedle}_`) ||
		stem.startsWith(`rollout-${lowerNeedle}_`)
	);
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
	if (!needle) return [];
	return getCodexRolloutFiles(paths).filter((filePath) =>
		codexFileMatchesSession(filePath, needle),
	);
}

export function codexSessionFilesBatch(
	sessionIds: ReadonlySet<string>,
	paths: PlatformPathService = defaultPlatformPathService,
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	if (!sessionIds.size) return result;
	const needles: Array<{ id: string; lower: string }> = [];
	for (const id of sessionIds) {
		if (id) needles.push({ id, lower: id.toLowerCase() });
	}
	for (const filePath of getCodexRolloutFiles(paths)) {
		for (const needle of needles) {
			if (!codexFileMatchesSession(filePath, needle.lower)) continue;
			const list = result.get(needle.id) ?? [];
			list.push(filePath);
			result.set(needle.id, list);
		}
	}
	return result;
}

function readCodexSessionMetaHeader(filePath: string): {
	sessionId?: string;
	cwd?: string;
} | null {
	try {
		let headText = "";
		if (filePath.endsWith(".zst")) {
			headText = zstdDecompressSync(readFileSync(filePath)).toString("utf8");
		} else {
			const fd = openSync(filePath, "r");
			try {
				const buf = Buffer.alloc(65536);
				const bytesRead = readSync(fd, buf, 0, buf.length, 0);
				headText = buf.subarray(0, bytesRead).toString("utf8");
			} finally {
				closeSync(fd);
			}
		}
		let start = 0;
		for (let lineIdx = 0; lineIdx < 25 && start < headText.length; lineIdx++) {
			const nl = headText.indexOf("\n", start);
			const rawLine =
				nl === -1 ? headText.slice(start) : headText.slice(start, nl);
			start = nl === -1 ? headText.length : nl + 1;
			const trimmed = rawLine.trim();
			if (!trimmed?.includes("session_meta")) continue;
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (parsed.type !== "session_meta") continue;
			const payload = (parsed.payload ?? {}) as Record<string, unknown>;
			const metaId = (payload.id ?? payload.session_id) as string | undefined;
			const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
			return { sessionId: metaId, cwd };
		}
	} catch {}
	return null;
}

export async function discoverCodexSessions(
	paths: PlatformPathService,
	knownStamps?: ReadonlyMap<string, SessionDiscoveryItem>,
): Promise<SessionDiscoveryItem[]> {
	const files = getCodexRolloutFiles(paths);
	const sessionMap = new Map<string, SessionDiscoveryItem>();

	for (const filePath of files) {
		try {
			const stat = statSync(filePath);
			const known = knownStamps?.get(filePath);
			if (
				known &&
				known.mtimeMs === stat.mtimeMs &&
				known.sizeBytes === stat.size
			) {
				const existing = sessionMap.get(known.sessionId);
				if (!existing || stat.mtimeMs > existing.mtimeMs) {
					sessionMap.set(known.sessionId, {
						sessionId: known.sessionId,
						harness: "codex",
						filePath,
						mtimeMs: stat.mtimeMs,
						sizeBytes: stat.size,
						cwd: known.cwd ?? null,
					});
				}
				continue;
			}

			// Session ID is derived from filename rollout-<timestamp>-<sessionId>...
			// or read from session_meta
			const base = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/u, "");
			const fallbackId = base;

			let sessionId = fallbackId;
			let cwd: string | null = null;

			const headerMeta = readCodexSessionMetaHeader(filePath);
			if (headerMeta) {
				if (headerMeta.sessionId) sessionId = headerMeta.sessionId;
				if (headerMeta.cwd) cwd = headerMeta.cwd;
			} else {
				try {
					const events = readJsonlFileSync(filePath);
					const meta = events
						.map(objectOrEmpty)
						.find((e) => e.type === "session_meta");
					if (meta) {
						const payload = objectOrEmpty(meta.payload);
						const metaId =
							textOrNull(payload.id) ?? textOrNull(payload.session_id);
						if (metaId) sessionId = metaId;
						if (typeof payload.cwd === "string") cwd = payload.cwd;
					}
				} catch {
					// Fallback to filename
				}
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
