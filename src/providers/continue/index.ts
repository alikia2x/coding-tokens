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
	discoverContinueSessions,
	findContinueDevDataFiles,
	findContinueSessionsFiles,
	getContinueRoots,
	getContinueSessionFiles,
} from "./discovery";
import {
	readContinueSingleTranscriptSync,
	readContinueTranscriptsSync,
} from "./transcripts";
import { readContinueUsageSync } from "./usage";

export class ContinueProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const builtin = BUILTIN_HARNESS_METADATA.find((m) => m.id === "continue");
		this.metadata = builtin ?? {
			id: "continue",
			displayName: "Continue",
			shortLabel: "Cont",
			color: "#059669",
			description: "Continue open-source AI code assistant",
			defaultEnabled: true,
		};
	}

	async isAvailable(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<boolean> {
		const roots = getContinueRoots(paths);
		const sessionsFiles = findContinueSessionsFiles(roots);
		const devDataFiles = findContinueDevDataFiles(roots);
		return (
			sessionsFiles.catalogs.length > 0 ||
			sessionsFiles.sessionFiles.length > 0 ||
			devDataFiles.sqliteDbs.length > 0 ||
			devDataFiles.tokensJsonl.length > 0
		);
	}

	async discoverSessions(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverContinueSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService = defaultPlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readContinueUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService = defaultPlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readContinueSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<string> {
		const files = getContinueSessionFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(
		paths: PlatformPathService = defaultPlatformPathService,
	): string[] {
		const roots = getContinueRoots(paths);
		const watch = new Set<string>();
		for (const r of roots) {
			watch.add(r);
		}
		return Array.from(watch);
	}

	async readTranscripts(
		paths: PlatformPathService = defaultPlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readContinueTranscriptsSync(paths, targetFiles);
	}
}
