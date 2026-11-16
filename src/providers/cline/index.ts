import { BUILTIN_HARNESS_METADATA } from "../../../shared/colors";
import type { HarnessMetadata } from "../../../shared/types";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import type {
	SourceResult,
	TranscriptReadResult,
	TranscriptSession,
} from "../../types";
import type { HarnessProvider, SessionDiscoveryItem } from "../types";
import { computeFilesFingerprint } from "../utils";
import {
	discoverClineSessions,
	findClineTaskHistoryFiles,
	findClineTasksDirs,
	getClineRoots,
	getClineSessionFiles,
} from "./discovery";
import {
	readClineSingleTranscriptSync,
	readClineTranscriptsSync,
} from "./transcripts";
import { readClineUsageSync } from "./usage";

export class ClineProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const builtin = BUILTIN_HARNESS_METADATA.find((m) => m.id === "cline");
		this.metadata = builtin ?? {
			id: "cline",
			displayName: "Cline",
			shortLabel: "Cline",
			color: "#2563EB",
			description: "Cline VS Code autonomous coding agent",
			defaultEnabled: true,
		};
	}

	async isAvailable(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<boolean> {
		const roots = getClineRoots(paths);
		const historyFiles = findClineTaskHistoryFiles(roots);
		const tasksDirs = findClineTasksDirs(roots);
		return historyFiles.length > 0 || tasksDirs.length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverClineSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService = defaultPlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readClineUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService = defaultPlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readClineSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<string> {
		const files = getClineSessionFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(
		paths: PlatformPathService = defaultPlatformPathService,
	): string[] {
		const roots = getClineRoots(paths);
		const watch = new Set<string>();
		for (const historyFile of findClineTaskHistoryFiles(roots)) {
			watch.add(historyFile);
		}
		for (const td of findClineTasksDirs(roots)) {
			watch.add(td);
		}
		return Array.from(watch);
	}

	async readTranscripts(
		paths: PlatformPathService = defaultPlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readClineTranscriptsSync(paths, targetFiles);
	}
}
