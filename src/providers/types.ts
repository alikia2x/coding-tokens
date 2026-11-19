import type { HarnessId, HarnessMetadata } from "../../shared/types";
import type { PlatformPathService } from "../platform/paths";
import type {
	SourceResult,
	TranscriptReadResult,
	TranscriptSession,
} from "../types";

/**
 * Metadata descriptor for a discovered session file or DB record.
 */
export interface SessionDiscoveryItem {
	sessionId: string;
	harness: HarnessId;
	filePath: string;
	mtimeMs: number;
	sizeBytes: number;
	cwd?: string | null;
}

/**
 * Optional capability flags describing harness-specific behaviors.
 */
export interface HarnessCapabilities {
	/**
	 * Whether session titles should be cleaned via `cleanUserMessage(harness, text)`
	 * (e.g., when raw user messages contain injected wrappers).
	 */
	cleanTitleWithUserMessage?: boolean;
}

/**
 * Pluggable provider interface for an AI coding harness.
 * All harness integrations implement this interface.
 */
export interface HarnessProvider {
	readonly metadata: HarnessMetadata;
	readonly capabilities?: HarnessCapabilities;

	/**
	 * Checks whether the harness is installed or has local session data on the host.
	 */
	isAvailable(paths: PlatformPathService): Promise<boolean>;

	/**
	 * Scans harness storage directories and returns metadata items for all detected sessions.
	 * When `knownStamps` (keyed by `filePath`) is provided, providers may reuse unchanged
	 * file stamps whose `mtimeMs` and `sizeBytes` match without re-opening the file.
	 */
	discoverSessions(
		paths: PlatformPathService,
		knownStamps?: ReadonlyMap<string, SessionDiscoveryItem>,
	): Promise<SessionDiscoveryItem[]>;

	/**
	 * Parses token and cost usage records.
	 * If `item` is omitted, performs a full sweep across all sessions.
	 * If `item` is provided, parses usage only for the specified session file.
	 */
	readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult>;

	/**
	 * Parses and reconstructs the conversation transcript for a single session.
	 */
	readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null>;

	/**
	 * Computes a deterministic cache fingerprint based on the modification stamps
	 * of all session data files. Format: `v${INDEX_VERSION}:${files.length}:${sha256}`.
	 */
	computeFingerprint(paths: PlatformPathService): Promise<string>;

	/**
	 * Returns directory and file paths that should be monitored for file system change events.
	 */
	getWatchPaths(paths: PlatformPathService): string[];

	/**
	 * Optional batch transcript reader for bulk processing.
	 */
	readTranscripts?(
		paths: PlatformPathService,
		targetFiles?: ReadonlySet<string>,
	): Promise<TranscriptReadResult>;

	/**
	 * Optional resolver returning all transcript file paths for a given session ID.
	 * Useful for harnesses that split one conversation across multiple files.
	 */
	resolveSessionFiles?(paths: PlatformPathService, sessionId: string): string[];

	/**
	 * Optional batch resolver mapping multiple session IDs to their transcript files
	 * in a single directory walk.
	 */
	resolveSessionFilesBatch?(
		paths: PlatformPathService,
		sessionIds: ReadonlySet<string>,
	): Map<string, string[]>;
}
