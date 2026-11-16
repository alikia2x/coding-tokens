import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { readCodexTranscripts } from "../../transcripts/codex";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { codexSessionFiles } from "./discovery";

export { codexSessionFiles } from "./discovery";

export function readCodexTranscriptsSync(
	_paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readCodexTranscripts(targetFiles);
}

export function readCodexSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const files = codexSessionFiles(sessionId, paths);
	if (!files.length) return null;
	const result = readCodexTranscriptsSync(paths, new Set(files));
	return result.sessions.find((s) => s.sessionId === sessionId) ?? null;
}
