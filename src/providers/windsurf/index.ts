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
import {
	discoverWindsurfSessions,
	getAllWindsurfFiles,
	getWindsurfRoots,
} from "./discovery";
import { readWindsurfTranscript, readWindsurfTranscripts } from "./transcripts";
import { readWindsurfUsage } from "./usage";

export class WindsurfProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const baseMeta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "windsurf");
		this.metadata = {
			...baseMeta,
			id: "windsurf",
			displayName: "Windsurf",
			shortLabel: "Wind",
			color: "#06B6D4",
			description: "Windsurf / Codeium Cascade agent",
			defaultEnabled: true,
		};
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		return getAllWindsurfFiles(paths).length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverWindsurfSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readWindsurfUsage(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readWindsurfTranscript(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const files = getAllWindsurfFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const { codeiumDir, windsurfDir, workspaceStorage } =
			getWindsurfRoots(paths);
		return [codeiumDir, windsurfDir, workspaceStorage];
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readWindsurfTranscripts(paths, targetFiles);
	}
}
