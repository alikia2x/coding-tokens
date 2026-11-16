import path from "node:path";
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
import { collectDshLogs, discoverDshSessions, getDshRoots } from "./discovery";
import {
	readDshSingleTranscriptSync,
	readDshTranscriptsSync,
} from "./transcripts";
import { readDshUsageSync } from "./usage";

export class DshProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const meta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "dsh");
		if (!meta) {
			throw new Error("Missing built-in metadata for dsh");
		}
		this.metadata = meta;
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		return getDshRoots(paths).length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverDshSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readDshUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readDshSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const logs = collectDshLogs(paths);
		const files = logs.map((l) => l.filePath);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		return getDshRoots(paths).map((r) => path.join(r, "sessions"));
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readDshTranscriptsSync(paths, targetFiles);
	}
}
