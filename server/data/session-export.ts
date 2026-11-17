import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	BatchSessionExportResult,
	SessionDetailLevel,
} from "@shared/types";
import {
	exportSessionsToMarkdown,
	renderSessionMarkdown,
} from "../../src/exporter";
import { defaultPlatformPathService } from "../../src/platform/paths";
import type { TranscriptSession } from "../../src/transcripts";
import { loadSessionTranscript } from "./session-detail";

export interface SessionExportResult {
	path: string;
	filename: string;
	bytes: number;
}

function timestampSlug(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function uniqueDirectory(base: string): string {
	let candidate = base;
	let index = 2;
	while (existsSync(candidate)) {
		candidate = `${base}-${index}`;
		index += 1;
	}
	return candidate;
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

export async function exportSessionMarkdown(
	key: string,
	detail: SessionDetailLevel,
	directory?: string,
): Promise<SessionExportResult> {
	const loaded = await loadSessionTranscript(key);
	if (!loaded.ok)
		throw new Error(loaded.warnings.at(-1) ?? "Session could not be loaded");
	const { session } = loaded.value;
	const markdown = renderSessionMarkdown(session, {
		detail,
		includeTimestamps: true,
		includeTokenStats: true,
	});
	if (!markdown) throw new Error("No messages at this detail level");
	const targetDirectory = directory
		? defaultPlatformPathService.normalize(directory)
		: path.join(defaultPlatformPathService.getHomeDir(), "Downloads");
	mkdirSync(targetDirectory, { recursive: true });
	const base = `${safeFilename(session.title ?? session.sessionId)}-${safeFilename(
		session.sessionId,
	).slice(-8)}`;
	const destination = uniquePath(targetDirectory, base);
	writeFileSync(destination, markdown, "utf8");
	return {
		path: destination,
		filename: path.basename(destination),
		bytes: Buffer.byteLength(markdown, "utf8"),
	};
}

export async function exportSessionsBatchMarkdown(options: {
	keys: string[];
	detail: SessionDetailLevel;
	includeTimestamps?: boolean;
	includeTokenStats?: boolean;
	directory?: string;
}): Promise<BatchSessionExportResult> {
	const uniqueKeys = [
		...new Set(options.keys.map((key) => key.trim()).filter(Boolean)),
	];
	if (uniqueKeys.length === 0) {
		throw new Error("At least one session key is required");
	}

	const sessions: TranscriptSession[] = [];
	const loadWarnings: string[] = [];

	for (const key of uniqueKeys) {
		try {
			const loaded = await loadSessionTranscript(key);
			if (!loaded.ok) {
				loadWarnings.push(
					`${key}: ${loaded.warnings.at(-1) ?? "Session could not be loaded"}`,
				);
				continue;
			}
			const { meta, records, session } = loaded.value;
			session.usageRecords = records;
			session.title =
				meta.title !== "Untitled session"
					? meta.title
					: (session.title ?? meta.title);
			sessions.push(session);
		} catch (error) {
			loadWarnings.push(
				`${key}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const targetDirectory = options.directory
		? defaultPlatformPathService.normalize(options.directory)
		: uniqueDirectory(
				path.join(
					defaultPlatformPathService.getHomeDir(),
					"Downloads",
					"coding-tokens-exports",
					`export-${timestampSlug()}`,
				),
			);

	const result = exportSessionsToMarkdown(sessions, {
		outputDirectory: targetDirectory,
		detail: options.detail,
		includeTimestamps: options.includeTimestamps ?? true,
		includeTokenStats: options.includeTokenStats ?? true,
	});

	return {
		directory: targetDirectory,
		indexPath: result.indexPath,
		filesWritten: result.filesWritten,
		skippedCount: Math.max(0, uniqueKeys.length - result.filesWritten),
		warnings: [...loadWarnings, ...result.warnings],
	};
}
