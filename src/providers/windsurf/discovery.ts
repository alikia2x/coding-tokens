import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "../../platform/normalizer";
import type { PlatformPathService } from "../../platform/paths";
import { walkFiles } from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { decodeProto, protoText } from "./proto";

export interface WindsurfRoots {
	codeiumDir: string;
	windsurfDir: string;
	globalStorage: string;
	workspaceStorage: string;
}

export function getWindsurfRoots(paths: PlatformPathService): WindsurfRoots {
	const resolved = paths.resolveHarnessPaths("windsurf");
	const home = paths.getHomeDir();

	const codeiumDir = resolved[0] ?? path.join(home, ".codeium");
	const windsurfDir = resolved[1] ?? path.join(home, ".windsurf");
	const globalStorage =
		resolved[2] ??
		path.join(home, ".config", "Windsurf", "User", "globalStorage");
	const workspaceStorage =
		resolved[3] ??
		path.join(home, ".config", "Windsurf", "User", "workspaceStorage");

	return { codeiumDir, windsurfDir, globalStorage, workspaceStorage };
}

export function decodeEscapedPath(escaped: string): string {
	// Strip known prefixes and extensions
	const clean = escaped
		.replace(/^codeium_chat_state_file_/, "")
		.replace(/\.pb$/, "");

	// Check for Windows drive letter: e.g. "C_Users_..."
	if (/^[a-zA-Z]_[a-zA-Z0-9]/.test(clean)) {
		const drive = clean[0]?.toUpperCase();
		const rest = clean.slice(2).replace(/_/g, "/");
		return normalizePath(`${drive}:/${rest}`);
	}

	// POSIX path: "workspace_windsurf_project" -> "/workspace/windsurf_project"
	// or "Users_alice_code" -> "/Users/alice/code"
	return normalizePath(`/${clean.replace(/_/g, "/")}`);
}

export function getWindsurfPbFiles(paths: PlatformPathService): string[] {
	const { codeiumDir, windsurfDir, workspaceStorage } = getWindsurfRoots(paths);
	const searchDirs = [
		path.join(codeiumDir, "chat_state"),
		path.join(codeiumDir, "cascade"),
		path.join(windsurfDir, "chat_state"),
		path.join(windsurfDir, "cascade"),
		codeiumDir,
		windsurfDir,
		workspaceStorage,
	];

	const files: string[] = [];
	for (const dir of searchDirs) {
		if (existsSync(dir)) {
			try {
				files.push(...walkFiles(dir, (_p, name) => name.endsWith(".pb")));
			} catch {}
		}
	}

	return Array.from(new Set(files)).sort();
}

export function getAllWindsurfFiles(paths: PlatformPathService): string[] {
	const { codeiumDir, windsurfDir, globalStorage, workspaceStorage } =
		getWindsurfRoots(paths);
	const files: string[] = [];

	const dirsToScan = [codeiumDir, windsurfDir, globalStorage, workspaceStorage];

	for (const dir of dirsToScan) {
		if (existsSync(dir)) {
			try {
				files.push(
					...walkFiles(
						dir,
						(_p, name) =>
							name.endsWith(".pb") ||
							name.endsWith(".json") ||
							name.endsWith(".jsonl") ||
							name.endsWith(".md") ||
							name === "state.vscdb",
					),
				);
			} catch {}
		}
	}

	return Array.from(new Set(files)).sort();
}

export async function discoverWindsurfSessions(
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const pbFiles = getWindsurfPbFiles(paths);
	const sessionMap = new Map<string, SessionDiscoveryItem>();

	for (const filePath of pbFiles) {
		try {
			const stat = statSync(filePath);
			if (stat.size === 0) continue;

			const fileName = path.basename(filePath);
			const defaultSessionId = fileName.replace(/\.pb$/, "");
			let sessionId = defaultSessionId;
			let cwd: string | null = null;

			// Extract cwd from filename if it has the codeium_chat_state_file_ prefix
			if (fileName.startsWith("codeium_chat_state_file_")) {
				cwd = decodeEscapedPath(fileName);
			}

			// Read protobuf wire header to extract sessionId if available
			try {
				const buf = readFileSync(filePath);
				const fields = decodeProto(buf);
				const idField = fields.find((f) => f.field === 1 && f.wire === 2);
				const textId = protoText(idField);
				if (textId && textId.trim().length > 0) {
					sessionId = textId.trim();
				}
			} catch {}

			const existing = sessionMap.get(sessionId);
			if (!existing || stat.mtimeMs > existing.mtimeMs) {
				sessionMap.set(sessionId, {
					sessionId,
					harness: "windsurf",
					filePath,
					mtimeMs: stat.mtimeMs,
					sizeBytes: stat.size,
					cwd,
				});
			}
		} catch {}
	}

	return Array.from(sessionMap.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
}
