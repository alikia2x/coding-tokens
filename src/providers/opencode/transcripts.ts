import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { readOpenCodeTranscripts } from "../../transcripts/opencode";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { getOpenCodeDbPaths } from "./discovery";

export function readOpenCodeTranscriptsSync(
	_paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readOpenCodeTranscripts(targetFiles);
}

export function readOpenCodeSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const dbPaths = getOpenCodeDbPaths(paths);
	if (!dbPaths.length) return null;
	const result = readOpenCodeTranscriptsSync(paths, new Set(dbPaths));
	return result.sessions.find((s) => s.sessionId === sessionId) ?? null;
}
