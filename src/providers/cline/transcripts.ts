import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import {
	buildClineFamilySessionTranscript,
	CLINE_FAMILY_CONFIG,
	readClineFamilySingleTranscriptSync,
	readClineFamilyTranscriptsSync,
} from "../shared/cline-family";

export function buildClineSessionTranscript(
	taskId: string,
	taskFolder?: string,
	summaryData?: {
		cwd?: string | null;
		startedAt?: number | null;
		title?: string;
	},
): TranscriptSession | null {
	return buildClineFamilySessionTranscript(
		CLINE_FAMILY_CONFIG,
		taskId,
		taskFolder,
		summaryData,
	);
}

export function readClineSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	return readClineFamilySingleTranscriptSync(
		CLINE_FAMILY_CONFIG,
		paths,
		sessionId,
	);
}

export function readClineTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	return readClineFamilyTranscriptsSync(
		CLINE_FAMILY_CONFIG,
		paths,
		targetFiles,
	);
}
