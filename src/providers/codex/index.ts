import { existsSync } from "node:fs";
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
	codexSessionFiles,
	discoverCodexSessions,
	getCodexRolloutFiles,
	getCodexRoots,
} from "./discovery";
import {
	readCodexSingleTranscriptSync,
	readCodexTranscriptsSync,
} from "./transcripts";
import { readCodexUsageSync } from "./usage";

export class CodexProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;
	readonly capabilities: HarnessCapabilities = {
		cleanTitleWithUserMessage: true,
	};

	constructor() {
		const meta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "codex");
		if (!meta) {
			throw new Error("Missing built-in metadata for codex");
		}
		this.metadata = meta;
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		const { sessionsRoot, archivedRoot } = getCodexRoots(paths);
		return existsSync(sessionsRoot) || existsSync(archivedRoot);
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverCodexSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readCodexUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readCodexSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const files = getCodexRolloutFiles(paths);
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const { sessionsRoot, archivedRoot } = getCodexRoots(paths);
		const watch: string[] = [];
		if (existsSync(sessionsRoot)) watch.push(sessionsRoot);
		if (existsSync(archivedRoot)) watch.push(archivedRoot);
		return watch;
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readCodexTranscriptsSync(paths, targetFiles);
	}

	resolveSessionFiles(paths: PlatformPathService, sessionId: string): string[] {
		return codexSessionFiles(sessionId, paths);
	}
}
