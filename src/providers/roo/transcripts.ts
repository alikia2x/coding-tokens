import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import {
	buildClineFamilySessionTranscript,
	ROO_FAMILY_CONFIG,
	readClineFamilySingleTranscriptSync,
	readClineFamilyTranscriptsSync,
} from "../shared/cline-family";

export function buildRooSessionTranscript(
	taskId: string,
	taskFolder?: string,
	summaryData?: {
		cwd?: string | null;
		startedAt?: number | null;
		title?: string;
		mode?: string;
	},
): TranscriptSession | null {
	return buildClineFamilySessionTranscript(
		ROO_FAMILY_CONFIG,
		taskId,
		taskFolder,
		summaryData,
	);
}

export function readRooSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	return readClineFamilySingleTranscriptSync(
		ROO_FAMILY_CONFIG,
		paths,
		sessionId,
	);
}

export function readRooTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readClineFamilyTranscriptsSync(ROO_FAMILY_CONFIG, paths, targetFiles);
}
