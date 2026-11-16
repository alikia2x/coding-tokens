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
	discoverCopilotSessions,
	getAllCopilotFiles,
	getCopilotRoots,
} from "./discovery";
import { readCopilotTranscript, readCopilotTranscripts } from "./transcripts";
import { readCopilotUsage } from "./usage";

export class CopilotProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const baseMeta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "copilot");
		this.metadata = {
			...baseMeta,
			id: "copilot",
			displayName: "GitHub Copilot",
			shortLabel: "GH",
			color: "#6366F1",
			description: "GitHub Copilot chat and CLI",
			defaultEnabled: true,
		};
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		return getAllCopilotFiles(paths).length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverCopilotSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readCopilotUsage(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readCopilotTranscript(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const files = getAllCopilotFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const { workspaceStorageDirs, copilotHomeDirs } = getCopilotRoots(paths);
		return [...workspaceStorageDirs, ...copilotHomeDirs];
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readCopilotTranscripts(paths, targetFiles);
	}
}
