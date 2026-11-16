import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { readDshTranscripts } from "../../transcripts/dsh";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { collectDshLogs } from "./discovery";

export function readDshTranscriptsSync(
	_paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readDshTranscripts(targetFiles);
}

export function readDshSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const logs = collectDshLogs(paths);
	const targetLog = logs.find((l) => l.filePath.includes(sessionId));
	if (!targetLog) return null;
	const result = readDshTranscriptsSync(paths, new Set([targetLog.filePath]));
	return result.sessions.find((s) => s.sessionId === sessionId) ?? null;
}
