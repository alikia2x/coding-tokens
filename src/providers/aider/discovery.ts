import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { normalizedCwd } from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface AiderSessionLocation {
	historyFile: string;
	analyticsFile?: string;
	directory: string;
}

export function getAiderLocations(
	paths: PlatformPathService = defaultPlatformPathService,
): AiderSessionLocation[] {
	const locations: AiderSessionLocation[] = [];
	const checkedDirs = new Set<string>();

	const checkDirectory = (dir: string): void => {
		const normalized = paths.normalize(dir);
		if (checkedDirs.has(normalized) || !existsSync(normalized)) return;
		checkedDirs.add(normalized);

		const historyFile = path.join(normalized, ".aider.chat.history.md");
		const altHistoryFile = path.join(normalized, "chat.history.md");
		const targetHistory = existsSync(historyFile)
			? historyFile
			: existsSync(altHistoryFile)
				? altHistoryFile
				: null;

		let analyticsFile: string | undefined;
		const possibleAnalytics = [
			path.join(normalized, "analytics.jsonl"),
			path.join(normalized, ".aider.analytics.jsonl"),
			path.join(normalized, "analytics.log"),
		];
		for (const p of possibleAnalytics) {
			if (existsSync(p)) {
				analyticsFile = p;
				break;
			}
		}

		if (targetHistory || analyticsFile) {
			locations.push({
				historyFile:
					targetHistory ?? path.join(normalized, ".aider.chat.history.md"),
				analyticsFile,
				directory: normalized,
			});
		}
	};

	// 1. Environment variable override
	const envHome =
		(
			paths as unknown as { env?: { get: (k: string) => string | undefined } }
		).env?.get("AIDER_HOME") ?? process.env.AIDER_HOME;
	if (envHome) {
		checkDirectory(paths.expandPath(envHome));
	}

	// 2. Check paths configured in PlatformPathService
	const harnessPaths = paths.resolveHarnessPaths("aider");
	for (const p of harnessPaths) {
		const dir = path.extname(p) ? path.dirname(p) : p;
		checkDirectory(dir);
	}

	// 3. Search home .aider
	const homeAider = path.join(paths.getHomeDir(), ".aider");
	if (existsSync(homeAider)) {
		checkDirectory(homeAider);
	}

	// 4. If no locations found yet, check process.cwd()
	if (locations.length === 0) {
		checkDirectory(process.cwd());
	}

	return locations;
}

export function parseAiderSessionStarts(
	content: string,
): Array<{ sessionId: string; timestampMs: number }> {
	const sessions: Array<{ sessionId: string; timestampMs: number }> = [];
	const regex =
		/#\s+aider\s+chat\s+started\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/giu;
	let match = regex.exec(content);
	while (match !== null) {
		const rawDate = match[1];
		if (rawDate) {
			const parsed = Date.parse(rawDate.replace(" ", "T"));
			const timestampMs = Number.isNaN(parsed) ? Date.now() : parsed;
			const sessionId = `aider-${rawDate.replace(/[\s:]/gu, "-")}`;
			sessions.push({ sessionId, timestampMs });
		}
		match = regex.exec(content);
	}

	return sessions;
}

export async function discoverAiderSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const locations = getAiderLocations(paths);
	const items: SessionDiscoveryItem[] = [];

	for (const loc of locations) {
		try {
			let stat = { mtimeMs: Date.now(), size: 0 };
			if (existsSync(loc.historyFile)) {
				const s = statSync(loc.historyFile);
				stat = { mtimeMs: s.mtimeMs, size: s.size };
			} else if (loc.analyticsFile && existsSync(loc.analyticsFile)) {
				const s = statSync(loc.analyticsFile);
				stat = { mtimeMs: s.mtimeMs, size: s.size };
			}

			// Read history file to extract distinct session timestamps
			let sessions: Array<{ sessionId: string; timestampMs: number }> = [];
			if (existsSync(loc.historyFile)) {
				const content = readFileSync(loc.historyFile, "utf8");
				sessions = parseAiderSessionStarts(content);
			}

			if (sessions.length > 0) {
				for (const sess of sessions) {
					items.push({
						sessionId: sess.sessionId,
						harness: "aider",
						filePath: loc.historyFile,
						mtimeMs: sess.timestampMs,
						sizeBytes: stat.size,
						cwd: normalizedCwd(loc.directory),
					});
				}
			} else {
				// Fallback single session for this directory
				const defaultId = `aider-${path.basename(loc.directory)}`;
				items.push({
					sessionId: defaultId,
					harness: "aider",
					filePath: loc.historyFile,
					mtimeMs: stat.mtimeMs,
					sizeBytes: stat.size,
					cwd: normalizedCwd(loc.directory),
				});
			}
		} catch {
			// skip
		}
	}

	return items;
}
