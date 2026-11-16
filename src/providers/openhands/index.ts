import { existsSync, readdirSync } from "node:fs";
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
import {
	discoverOpenHandsSessions,
	findOpenHandsConversations,
} from "./discovery";
import {
	readOpenHandsSingleTranscriptSync,
	readOpenHandsTranscriptsSync,
} from "./transcripts";
import { readOpenHandsUsageSync } from "./usage";

export class OpenHandsProvider implements HarnessProvider {
	readonly metadata: HarnessMetadata;

	constructor() {
		const baseMeta = BUILTIN_HARNESS_METADATA.find((m) => m.id === "openhands");
		this.metadata = {
			id: "openhands",
			displayName: "OpenHands",
			shortLabel: "OH",
			color: "light-dark(oklch(0.6 0.18 30), oklch(0.7 0.17 30))",
			description: "OpenHands software dev agent",
			defaultEnabled: true,
			...baseMeta,
		};
	}

	async isAvailable(paths: PlatformPathService): Promise<boolean> {
		const conversations = findOpenHandsConversations(paths);
		return conversations.length > 0;
	}

	async discoverSessions(
		paths: PlatformPathService,
	): Promise<SessionDiscoveryItem[]> {
		return discoverOpenHandsSessions(paths);
	}

	async readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult> {
		return readOpenHandsUsageSync(paths, item);
	}

	async readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		return readOpenHandsSingleTranscriptSync(paths, sessionId);
	}

	async computeFingerprint(paths: PlatformPathService): Promise<string> {
		const conversations = findOpenHandsConversations(paths);
		const files: string[] = [];

		for (const conv of conversations) {
			files.push(conv.baseStatePath);
			if (conv.eventsDir && existsSync(conv.eventsDir)) {
				try {
					const eventFiles = readdirSync(conv.eventsDir)
						.filter((name) => name.endsWith(".json"))
						.map((name) => path.join(conv.eventsDir as string, name));
					files.push(...eventFiles);
				} catch {
					// skip
				}
			}
		}

		return computeFilesFingerprint(files);
	}

	getWatchPaths(paths: PlatformPathService): string[] {
		const conversations = findOpenHandsConversations(paths);
		return conversations.map((c) => c.directory);
	}

	async readTranscripts(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult> {
		return readOpenHandsTranscriptsSync(paths, targetFiles);
	}
}
