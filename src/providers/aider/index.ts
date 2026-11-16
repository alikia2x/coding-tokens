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
import { discoverAiderSessions, getAiderLocations } from "./discovery";
import {
	readAiderSingleTranscriptSync,
	readAiderTranscriptsSync,
} from "./transcripts";
import { readAiderUsageSync } from "./usage";

export class AiderProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const baseMeta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "aider");
		this.metadata = {
			id: "aider",
			displayName: "Aider",
			shortLabel: "Aid",
			color: "light-dark(oklch(0.62 0.16 140), oklch(0.72 0.15 140))",
			description: "Aider AI pair programming in terminal",
			defaultEnabled: true,
			...baseMeta,
		};
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		const locations = getAiderLocations(paths);
		return locations.length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverAiderSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readAiderUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readAiderSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const locations = getAiderLocations(paths);
		const files: string[] = [];
		for (const loc of locations) {
			if (loc.historyFile) files.push(loc.historyFile);
			if (loc.analyticsFile) files.push(loc.analyticsFile);
		}
		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const locations = getAiderLocations(paths);
		const watch = new Set<string>();
		for (const loc of locations) {
			watch.add(loc.directory);
		}
		return Array.from(watch);
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readAiderTranscriptsSync(paths, targetFiles);
	}
}
