import { existsSync } from "node:fs";
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
	discoverCommandCodeSessions,
	getCommandCodeProjectsRoot,
	getCommandCodeSessionFiles,
} from "./discovery";
import {
	readCommandCodeSingleTranscriptSync,
	readCommandCodeTranscriptsSync,
} from "./transcripts";
import { readCommandCodeUsageSync } from "./usage";

export class CommandCodeProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const meta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "commandcode");
		if (!meta) {
			throw new Error("Missing built-in metadata for commandcode");
		}
		this.metadata = meta;
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		return existsSync(getCommandCodeProjectsRoot(paths));
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverCommandCodeSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readCommandCodeUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readCommandCodeSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const files = getCommandCodeSessionFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const root = getCommandCodeProjectsRoot(paths);
		return existsSync(root) ? [root] : [];
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readCommandCodeTranscriptsSync(paths, targetFiles);
	}
}
