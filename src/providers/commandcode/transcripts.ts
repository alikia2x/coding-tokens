import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { readCommandCodeTranscripts } from "../../transcripts/commandcode";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { objectOrEmpty, parseJsonl, textOrNull } from "../../util";
import { getCommandCodeSessionFiles } from "./discovery";

export function readCommandCodeTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readCommandCodeTranscripts(targetFiles, paths);
}

export function readCommandCodeSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const files = getCommandCodeSessionFiles(paths);
	let target = files.find((f) => path.basename(f, ".jsonl") === sessionId);
	if (!target) {
		target = files.find((f) => {
			try {
				const rows = parseJsonl(readFileSync(f, "utf8"));
				const header = rows
					.map(objectOrEmpty)
					.find((row) => row.type === "session");
				return header ? textOrNull(header.id) === sessionId : false;
			} catch {
				return false;
			}
		});
	}
	if (!target) return null;
	const result = readCommandCodeTranscriptsSync(paths, new Set([target]));
	return result.sessions.find((s) => s.sessionId === sessionId) ?? null;
}
