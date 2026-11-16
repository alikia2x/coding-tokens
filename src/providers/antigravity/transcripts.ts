import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { readAntigravityTranscripts } from "../../transcripts/antigravity";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { getAntigravityDbFiles } from "./discovery";

export function readAntigravityTranscriptsSync(
	_paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readAntigravityTranscripts(targetFiles);
}

export function readAntigravitySingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const files = getAntigravityDbFiles(paths);
	const target = files.find((f) => f.includes(sessionId));
	if (!target) return null;
	const result = readAntigravityTranscriptsSync(paths, new Set([target]));
	return result.sessions.find((s) => s.sessionId === sessionId) ?? null;
}
