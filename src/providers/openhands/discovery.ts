import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { normalizedCwd, textOrNull } from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface OpenHandsConversation {
	conversationId: string;
	baseStatePath: string;
	eventsDir?: string;
	directory: string;
	cwd: string | null;
	mtimeMs: number;
	sizeBytes: number;
}

export function getOpenHandsConversationDirs(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	const dirs = new Set<string>();
	const home = paths.getHomeDir();

	const checkCandidate = (dir: string): void => {
		const normalized = paths.normalize(dir);
		if (existsSync(normalized)) {
			dirs.add(normalized);
		}
	};

	// 1. Environment variables
	const envConv =
		(
			paths as unknown as { env?: { get: (k: string) => string | undefined } }
		).env?.get("OPENHANDS_CONVERSATIONS_DIR") ??
		process.env.OPENHANDS_CONVERSATIONS_DIR;
	if (envConv) checkCandidate(paths.expandPath(envConv));

	const envRoot =
		(
			paths as unknown as { env?: { get: (k: string) => string | undefined } }
		).env?.get("OPENHANDS_DIR") ?? process.env.OPENHANDS_DIR;
	if (envRoot) {
		checkCandidate(path.join(paths.expandPath(envRoot), "conversations"));
		checkCandidate(paths.expandPath(envRoot));
	}

	// 2. PlatformPathService resolveHarnessPaths
	const resolved = paths.resolveHarnessPaths("openhands");
	for (const p of resolved) {
		checkCandidate(path.join(p, "conversations"));
		checkCandidate(p);
	}

	// 3. Standard Cross-Platform Locations
	checkCandidate(path.join(home, ".openhands", "conversations"));
	checkCandidate(path.join(home, ".openhands"));
	checkCandidate(path.join(home, ".openhands-state", "conversations"));
	checkCandidate(path.join(home, ".openhands-state"));
	checkCandidate(
		path.join(home, "AppData", "Roaming", "OpenHands", "conversations"),
	);

	return Array.from(dirs);
}

export function findOpenHandsConversations(
	paths: PlatformPathService = defaultPlatformPathService,
): OpenHandsConversation[] {
	const roots = getOpenHandsConversationDirs(paths);
	const conversations: OpenHandsConversation[] = [];
	const seenIds = new Set<string>();

	for (const root of roots) {
		try {
			// Either root itself contains conversation subfolders, or root contains base_state.json directly
			const directBaseState = path.join(root, "base_state.json");
			if (existsSync(directBaseState)) {
				const convId = path.basename(root);
				if (!seenIds.has(convId)) {
					seenIds.add(convId);
					const stat = statSync(directBaseState);
					conversations.push({
						conversationId: convId,
						baseStatePath: directBaseState,
						eventsDir: path.join(root, "events"),
						directory: root,
						cwd: null,
						mtimeMs: stat.mtimeMs,
						sizeBytes: stat.size,
					});
				}
				continue;
			}

			const entries = readdirSync(root, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const convDir = path.join(root, entry.name);
				const baseStateFile = path.join(convDir, "base_state.json");
				if (existsSync(baseStateFile) && !seenIds.has(entry.name)) {
					seenIds.add(entry.name);
					const stat = statSync(baseStateFile);
					conversations.push({
						conversationId: entry.name,
						baseStatePath: baseStateFile,
						eventsDir: path.join(convDir, "events"),
						directory: convDir,
						cwd: null,
						mtimeMs: stat.mtimeMs,
						sizeBytes: stat.size,
					});
				}
			}
		} catch {
			// skip
		}
	}

	return conversations;
}

export async function discoverOpenHandsSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const conversations = findOpenHandsConversations(paths);
	const items: SessionDiscoveryItem[] = [];

	for (const conv of conversations) {
		let cwd: string | null = null;
		let sessionId = conv.conversationId;

		try {
			const file = Bun.file(conv.baseStatePath);
			const text = await file.text();
			const json = JSON.parse(text);
			sessionId = textOrNull(json.conversation_id) ?? sessionId;
			cwd = normalizedCwd(json.workspace_path ?? json.cwd);
		} catch {
			// fallback
		}

		items.push({
			sessionId,
			harness: "openhands",
			filePath: conv.baseStatePath,
			mtimeMs: conv.mtimeMs,
			sizeBytes: conv.sizeBytes,
			cwd,
		});
	}

	return items;
}
