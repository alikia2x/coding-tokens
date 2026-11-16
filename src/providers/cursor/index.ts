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
	discoverCursorSessions,
	getAllCursorFiles,
	getCursorGlobalDbPath,
	getCursorRoots,
} from "./discovery";
import { readCursorTranscript, readCursorTranscripts } from "./transcripts";
import { readCursorUsage } from "./usage";

export class CursorProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const baseMeta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "cursor");
		this.metadata = {
			...baseMeta,
			id: "cursor",
			displayName: "Cursor",
			shortLabel: "Cur",
			color: "#10B981",
			description: "Cursor AI IDE Composer and Agent",
			defaultEnabled: true,
		};
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		const globalDb = getCursorGlobalDbPath(paths);
		if (globalDb) return true;

		return getAllCursorFiles(paths).length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverCursorSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readCursorUsage(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readCursorTranscript(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const files = getAllCursorFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const { globalStorage, workspaceStorage } = getCursorRoots(paths);
		return [globalStorage, workspaceStorage];
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readCursorTranscripts(paths, targetFiles);
	}
}
