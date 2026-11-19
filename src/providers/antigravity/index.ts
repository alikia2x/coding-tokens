import path from "node:path";
import { BUILTIN_HARNESS_METADATA } from "../../../shared/colors";
import type { HarnessMetadata } from "../../../shared/types";
import type { PlatformPathService } from "../../platform/paths";
import type {
	SourceResult,
	TranscriptReadResult,
	TranscriptSession,
} from "../../types";
import type {
	HarnessCapabilities,
	HarnessProvider,
	SessionDiscoveryItem,
} from "../types";
import { computeFilesFingerprint } from "../utils";
import {
	discoverAntigravitySessions,
	existingAntigravityRoots,
	getAntigravityDbFiles,
} from "./discovery";
import {
	readAntigravitySingleTranscriptSync,
	readAntigravityTranscriptsSync,
} from "./transcripts";
import { readAntigravityUsageSync } from "./usage";

export class AntigravityProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;
	readonly capabilities: HarnessCapabilities = {
		cleanTitleWithUserMessage: true,
	};

	constructor() {
		const meta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "antigravity");
		if (!meta) {
			throw new Error("Missing built-in metadata for antigravity");
		}
		this.metadata = meta;
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		return existingAntigravityRoots(paths).length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
		knownStamps?: ReadonlyMap<string, SessionDiscoveryItem>,
	): Promise<SessionDiscoveryItem[]> {
		return discoverAntigravitySessions(paths, knownStamps);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readAntigravityUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readAntigravitySingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const files = getAntigravityDbFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		return existingAntigravityRoots(paths).map((r) =>
			path.join(r, "conversations"),
		);
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readAntigravityTranscriptsSync(paths, targetFiles);
	}
}
