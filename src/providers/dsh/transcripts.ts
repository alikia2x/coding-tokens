import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { readDshTranscripts } from "../../transcripts/dsh";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { collectDshLogs, readDshSessionHeader } from "./discovery";

export function readDshTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readDshTranscripts(targetFiles, paths);
}

export function readDshSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const logs = collectDshLogs(paths);
	let targetLog = logs.find(
		(l) => path.basename(path.dirname(l.filePath)) === sessionId,
	);
	if (!targetLog) {
		targetLog = logs.find(
			(l) => readDshSessionHeader(l.filePath)?.id === sessionId,
		);
	}
	if (!targetLog) return null;
	const result = readDshTranscriptsSync(paths, new Set([targetLog.filePath]));
	return result.sessions.find((s) => s.sessionId === sessionId) ?? null;
}
