import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderSessionMarkdown } from "../exporter";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../platform/paths";
import {
	defaultHarnessRegistry,
	type HarnessRegistry,
} from "../providers/registry";
import {
	filterTranscriptSessions,
	readTranscriptSources,
} from "../transcripts";
import type {
	HarnessId,
	HarnessName,
	SessionDetailLevel,
	SessionDetailPayload,
	SessionMeta,
	TranscriptFilters,
	TranscriptSession,
	UsageRecord,
} from "../types";

export interface TranscriptExportOptions {
	detail: SessionDetailLevel;
	includeTimestamps?: boolean;
	includeTokenStats?: boolean;
	targetDirectory?: string;
}

export interface TranscriptExportResult {
	filePath: string;
	fileName: string;
	bytes: number;
	markdown: string;
}

export interface TranscriptService {
	getTranscript(
		harnessId: HarnessId,
		sessionId: string,
	): Promise<TranscriptSession | null>;

	getSessionDetail(
		meta: SessionMeta,
		records: UsageRecord[],
		level: SessionDetailLevel,
	): Promise<SessionDetailPayload>;

	renderMarkdown(
		session: TranscriptSession,
		options?: Partial<TranscriptExportOptions>,
	): string;

	exportMarkdown(
		session: TranscriptSession,
		options?: Partial<TranscriptExportOptions>,
	): Promise<TranscriptExportResult>;

	extractSearchText(session: TranscriptSession): string;

	filterSessions(
		sessions: TranscriptSession[],
		filters: TranscriptFilters,
	): TranscriptSession[];
}

function safeFilename(value: string): string {
	const normalized = value
		.normalize("NFKD")
		.replaceAll(/[^\p{L}\p{N}._-]+/gu, "-")
		.replaceAll(/-+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "")
		.slice(0, 72);
	return normalized || "session";
}

function uniquePath(directory: string, base: string): string {
	let candidate = path.join(directory, `${base}.md`);
	let index = 2;
	while (existsSync(candidate)) {
		candidate = path.join(directory, `${base}-${index}.md`);
		index += 1;
	}
	return candidate;
}

export class DefaultTranscriptService implements TranscriptService {
	constructor(
		private readonly paths: PlatformPathService = defaultPlatformPathService,
		private readonly registry: HarnessRegistry = defaultHarnessRegistry,
	) {}

	async getTranscript(
		harnessId: HarnessId,
		sessionId: string,
	): Promise<TranscriptSession | null> {
		const provider = this.registry.get(harnessId);
		if (provider) {
			try {
				const session = await provider.readTranscript(this.paths, sessionId);
				if (session) return session;
			} catch {}
		}

		// Fallback to legacy reader
		try {
			const results = readTranscriptSources([harnessId as HarnessName]);
			const session = results[0]?.sessions.find(
				(s) => s.sessionId === sessionId,
			);
			return session ?? null;
		} catch {
			return null;
		}
	}

	async getSessionDetail(
		meta: SessionMeta,
		_records: UsageRecord[],
		level: SessionDetailLevel,
	): Promise<SessionDetailPayload> {
		const { sessionDetailPayload } = await import(
			"../../server/data/session-detail"
		);
		return sessionDetailPayload(meta.key, level);
	}

	renderMarkdown(
		session: TranscriptSession,
		options?: Partial<TranscriptExportOptions>,
	): string {
		return (
			renderSessionMarkdown(session, {
				detail: options?.detail ?? "chat",
				includeTimestamps: options?.includeTimestamps ?? true,
				includeTokenStats: options?.includeTokenStats ?? true,
			}) ?? ""
		);
	}

	async exportMarkdown(
		session: TranscriptSession,
		options?: Partial<TranscriptExportOptions>,
	): Promise<TranscriptExportResult> {
		const markdown = this.renderMarkdown(session, options);
		if (!markdown) {
			throw new Error("No messages to export at this detail level");
		}

		const targetDir =
			options?.targetDirectory ??
			path.join(this.paths.getHomeDir(), "Downloads");
		mkdirSync(targetDir, { recursive: true });

		const titleSafe = safeFilename(session.title ?? session.sessionId);
		const idSuffix = safeFilename(session.sessionId).slice(-8);
		const base = `${titleSafe.slice(0, 48)}-${idSuffix}`;
		const destination = uniquePath(targetDir, base);

		writeFileSync(destination, markdown, "utf8");
		return {
			filePath: destination,
			fileName: path.basename(destination),
			bytes: Buffer.byteLength(markdown, "utf8"),
			markdown,
		};
	}

	extractSearchText(session: TranscriptSession): string {
		const parts: string[] = [];
		let total = 0;
		for (const item of session.items) {
			if (
				item.kind !== "message" ||
				(item.role !== "user" && item.role !== "assistant") ||
				!item.text
			) {
				continue;
			}
			const cleaned = item.text.replaceAll(/\s+/gu, " ").trim();
			if (!cleaned) continue;
			parts.push(cleaned);
			total += cleaned.length + 1;
			if (total >= 200_000) break;
		}
		return parts.join("\n").slice(0, 200_000);
	}

	filterSessions(
		sessions: TranscriptSession[],
		filters: TranscriptFilters,
	): TranscriptSession[] {
		return filterTranscriptSessions(sessions, filters);
	}
}

export function createTranscriptService(
	paths?: PlatformPathService,
	registry?: HarnessRegistry,
): TranscriptService {
	return new DefaultTranscriptService(paths, registry);
}

export function resolveExportPath(
	sessionId: string,
	paths: PlatformPathService = defaultPlatformPathService,
): string {
	const downloadDir = path.join(paths.getHomeDir(), "Downloads");
	const safeId = safeFilename(sessionId);
	return path.join(downloadDir, `session-${safeId}.md`);
}

export function extractSearchText(session: TranscriptSession): string {
	return defaultTranscriptService.extractSearchText(session);
}

export const defaultTranscriptService = new DefaultTranscriptService();
