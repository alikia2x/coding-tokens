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
import { discoverGooseSessions, getGooseLocations } from "./discovery";
import {
	readGooseSingleTranscriptSync,
	readGooseTranscriptsSync,
} from "./transcripts";
import { readGooseUsageSync } from "./usage";

export class GooseProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const baseMeta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "goose");
		this.metadata = {
			id: "goose",
			displayName: "Goose",
			shortLabel: "Goose",
			color: "light-dark(oklch(0.64 0.17 65), oklch(0.74 0.16 65))",
			description: "Block Goose open source agent",
			defaultEnabled: true,
			...baseMeta,
		};
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		const { dbFiles, legacyFiles } = getGooseLocations(paths);
		return dbFiles.length > 0 || legacyFiles.length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverGooseSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readGooseUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readGooseSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const { dbFiles, legacyFiles } = getGooseLocations(paths);
		const filesToHash = [...dbFiles, ...legacyFiles];
		return computeFilesFingerprint(filesToHash);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const { dbFiles, legacyFiles } = getGooseLocations(paths);
		return [...dbFiles, ...legacyFiles];
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readGooseTranscriptsSync(paths, targetFiles);
	}
}
