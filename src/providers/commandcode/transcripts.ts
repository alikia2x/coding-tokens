import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { readCommandCodeTranscripts } from "../../transcripts/commandcode";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { getCommandCodeSessionFiles } from "./discovery";

export function readCommandCodeTranscriptsSync(
	_paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readCommandCodeTranscripts(targetFiles);
}

export function readCommandCodeSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const files = getCommandCodeSessionFiles(paths);
	const target = files.find((f) => f.includes(sessionId));
	if (!target) return null;
	const result = readCommandCodeTranscriptsSync(paths, new Set([target]));
	return result.sessions.find((s) => s.sessionId === sessionId) ?? null;
}
