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
	discoverRooSessions,
	findRooTaskHistoryFiles,
	findRooTasksDirs,
	getRooRoots,
	getRooSessionFiles,
} from "./discovery";
import {
	readRooSingleTranscriptSync,
	readRooTranscriptsSync,
} from "./transcripts";
import { readRooUsageSync } from "./usage";

export class RooProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const builtin = BUILTIN_HARNESS_METADATA.find((m) => m.id === "roo");
		this.metadata = builtin ?? {
			id: "roo",
			displayName: "Roo Code",
			shortLabel: "Roo",
			color: "#7C3AED",
			description: "Roo Code mode-aware AI coding agent",
			defaultEnabled: true,
		};
	}

	async isAvailable(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<boolean> {
		const roots = getRooRoots(paths);
		const historyFiles = findRooTaskHistoryFiles(roots);
		const tasksDirs = findRooTasksDirs(roots);
		return historyFiles.length > 0 || tasksDirs.length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverRooSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService = defaultPlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readRooUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService = defaultPlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readRooSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<string> {
		const files = getRooSessionFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(
		paths: PlatformPathService = defaultPlatformPathService,
	): string[] {
		const roots = getRooRoots(paths);
		const watch = new Set<string>();
		for (const historyFile of findRooTaskHistoryFiles(roots)) {
			watch.add(historyFile);
		}
		for (const td of findRooTasksDirs(roots)) {
			watch.add(td);
		}
		return Array.from(watch);
	}

	async readTranscripts(
		paths: PlatformPathService = defaultPlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readRooTranscriptsSync(paths, targetFiles);
	}
}
