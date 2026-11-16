import { BUILTIN_HARNESS_METADATA } from "../../../shared/colors";
import type { HarnessMetadata } from "../../../shared/types";
import type { PlatformPathService } from "../../platform/paths";
import type {
	SourceResult,
	TranscriptReadResult,
	TranscriptSession,
} from "../../types";
import type { HarnessProvider, SessionDiscoveryItem } from "../types";
import { computeFilesFingerprint } from "../utils";
import { discoverOpenCodeSessions, getOpenCodeDbPaths } from "./discovery";
import {
	readOpenCodeSingleTranscriptSync,
	readOpenCodeTranscriptsSync,
} from "./transcripts";
import { readOpenCodeUsageSync } from "./usage";

export class OpenCodeProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const meta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "opencode");
		if (!meta) {
			throw new Error("Missing built-in metadata for opencode");
		}
		this.metadata = meta;
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		return getOpenCodeDbPaths(paths).length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverOpenCodeSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readOpenCodeUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readOpenCodeSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const dbPaths = getOpenCodeDbPaths(paths);
		return computeFilesFingerprint(dbPaths);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		return getOpenCodeDbPaths(paths);
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readOpenCodeTranscriptsSync(paths, targetFiles);
	}
}
