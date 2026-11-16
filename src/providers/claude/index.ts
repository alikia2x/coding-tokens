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
	discoverClaudeSessions,
	getClaudeRoots,
	getClaudeSessionFiles,
} from "./discovery";
import {
	readClaudeSingleTranscriptSync,
	readClaudeTranscriptsSync,
} from "./transcripts";
import { readClaudeUsageSync } from "./usage";

export class ClaudeProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const baseMeta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "claude");
		this.metadata = {
			id: "claude",
			displayName: "Claude Code",
			shortLabel: "Claude",
			description: "Anthropic Claude Code CLI",
			defaultEnabled: true,
			...baseMeta,
			color: "#D97706",
		};
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		const { root, projectsRoot, statsCachePath } = getClaudeRoots(paths);
		return (
			existsSync(root) &&
			(existsSync(projectsRoot) || existsSync(statsCachePath))
		);
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverClaudeSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readClaudeUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readClaudeSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const { allFiles } = getClaudeSessionFiles(paths);
		const { statsCachePath } = getClaudeRoots(paths);
		const filesToHash = [...allFiles];
		if (existsSync(statsCachePath)) {
			filesToHash.push(statsCachePath);
		}
		return computeFilesFingerprint(filesToHash);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const { projectsRoot, statsCachePath } = getClaudeRoots(paths);
		const watch: string[] = [];
		if (existsSync(projectsRoot)) watch.push(projectsRoot);
		if (existsSync(statsCachePath)) watch.push(statsCachePath);
		return watch;
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readClaudeTranscriptsSync(paths, targetFiles);
	}
}
