import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionDetailLevel } from "@shared/types";
import { renderSessionMarkdown } from "../../src/exporter";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { loadSessionTranscript } from "./session-detail";

export interface SessionExportResult {
	path: string;
	filename: string;
	bytes: number;
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
