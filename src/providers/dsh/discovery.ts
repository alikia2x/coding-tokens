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

function readDshSessionHeader(filePath: string): {
	id?: string;
	cwd?: string | null;
} | null {
	try {
		let headText = "";
		if (filePath.endsWith(".zstd")) {
			headText = zstdDecompressSync(readFileSync(filePath)).toString("utf8");
		} else {
			const fd = openSync(filePath, "r");
			try {
				const buf = Buffer.alloc(32768);
				const bytesRead = readSync(fd, buf, 0, buf.length, 0);
				headText = buf.subarray(0, bytesRead).toString("utf8");
			} finally {
				closeSync(fd);
			}
		}
		let start = 0;
		for (let lineIdx = 0; lineIdx < 20 && start < headText.length; lineIdx++) {
			const nl = headText.indexOf("\n", start);
			const rawLine =
				nl === -1 ? headText.slice(start) : headText.slice(start, nl);
			start = nl === -1 ? headText.length : nl + 1;
			const trimmed = rawLine.trim();
			if (!trimmed) continue;
			const parsed = objectOrEmpty(JSON.parse(trimmed));
			if (parsed.type !== "session") continue;
			return {
				id: textOrNull(parsed.id) ?? undefined,
				cwd: normalizedCwd(parsed.cwd) ?? null,
			};
		}
	} catch {}
	return null;
}

export async function discoverDshSessions(
	paths: PlatformPathService,
	knownStamps?: ReadonlyMap<string, SessionDiscoveryItem>,
): Promise<SessionDiscoveryItem[]> {
	const logs = collectDshLogs(paths);
	const items: SessionDiscoveryItem[] = [];

	for (const log of logs) {
		try {
			const stat = statSync(log.filePath);
			const known = knownStamps?.get(log.filePath);
			if (
				known &&
				known.mtimeMs === stat.mtimeMs &&
				known.sizeBytes === stat.size
			) {
				items.push({
					sessionId: known.sessionId,
					harness: "dsh",
					filePath: log.filePath,
					mtimeMs: stat.mtimeMs,
					sizeBytes: stat.size,
					cwd: known.cwd ?? null,
				});
				continue;
			}

			let sessionId = path.basename(path.dirname(log.filePath));
			let cwd: string | null = null;

			const header = readDshSessionHeader(log.filePath);
			if (header) {
				if (header.id) sessionId = header.id;
				cwd = header.cwd ?? null;
			} else {
				try {
					const { readLogSync } = await import("./usage");
					const events = readLogSync(log.filePath).map(objectOrEmpty);
					const evHeader = events.find((event) => event.type === "session");
					if (evHeader) {
						const id = textOrNull(evHeader.id);
						if (id) sessionId = id;
						cwd = normalizedCwd(evHeader.cwd) ?? null;
					}
				} catch {
					// fallback to folder name
				}
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
