import type { HarnessName } from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import { readTranscriptSources } from "../../src/transcripts";
import type { TranscriptSession } from "../../src/types";
import {
	type ExportWorkerEvent,
	type ExportWorkerItem,
	type ExportWorkerRequest,
	renderExportSessionItem,
} from "./session-export-format";
import { appendAll } from "./totals";

function emitEvent(event: ExportWorkerEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function resolveBatchTargets(
	harness: HarnessName,
	items: readonly ExportWorkerItem[],
): Set<string> {
	const provider = defaultHarnessRegistry.get(harness);
	const targetFiles = new Set<string>();
	const sessionIds = new Set(items.map((item) => item.meta.sessionId));
	if (provider?.resolveSessionFilesBatch && sessionIds.size) {
		const batched = provider.resolveSessionFilesBatch(
			defaultPlatformPathService,
			sessionIds,
		);
		for (const files of batched.values()) {
			for (const filePath of files) targetFiles.add(filePath);
		}
	}
	for (const item of items) {
		if (!provider?.resolveSessionFilesBatch && provider?.resolveSessionFiles) {
			for (const filePath of provider.resolveSessionFiles(
				defaultPlatformPathService,
				item.meta.sessionId,
			)) {
				targetFiles.add(filePath);
			}
		}
		if (item.meta.source) {
			targetFiles.add(item.meta.source.path);
		}
	}
	return targetFiles;
}

async function loadChunkTranscripts(
	harness: HarnessName,
	items: readonly ExportWorkerItem[],
): Promise<{
	bySessionId: Map<string, TranscriptSession>;
	warnings: string[];
}> {
	const provider = defaultHarnessRegistry.get(harness);
	const targetFiles = resolveBatchTargets(harness, items);
	const bySessionId = new Map<string, TranscriptSession>();
	const warnings: string[] = [];

	if (provider?.readTranscripts) {
		try {
			const batch = await provider.readTranscripts(
				defaultPlatformPathService,
				targetFiles.size ? targetFiles : undefined,
			);
			appendAll(warnings, batch.warnings);
			for (const sess of batch.sessions) {
				bySessionId.set(sess.sessionId, sess);
			}
			return { bySessionId, warnings };
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}

	if (targetFiles.size) {
		const res = readTranscriptSources([harness], {
			[harness]: targetFiles,
		})[0];
		if (res) {
			appendAll(warnings, res.warnings);
			for (const sess of res.sessions) {
				bySessionId.set(sess.sessionId, sess);
			}
			return { bySessionId, warnings };
		}
	}

	// Per-session fallback when batch file resolution wasn't available
	if (provider) {
		for (const item of items) {
			try {
				const sess = await provider.readTranscript(
					defaultPlatformPathService,
					item.meta.sessionId,
				);
				if (sess) bySessionId.set(item.meta.sessionId, sess);
			} catch {}
		}
	}
	return { bySessionId, warnings };
}

/**
 * Execute batch export work in an isolated OS process reading request JSON from stdin
 * and streaming NDJSON progress/entry lines to stdout.
 */
export async function runBatchExportWorker(): Promise<void> {
	const raw = await Bun.stdin.text();
	if (!raw.trim()) return;
	const request = JSON.parse(raw) as ExportWorkerRequest;
	const byHarness = new Map<HarnessName, ExportWorkerItem[]>();
	for (const item of request.items) {
		const list = byHarness.get(item.meta.harness) ?? [];
		list.push(item);
		byHarness.set(item.meta.harness, list);
	}

	for (const [harness, harnessItems] of byHarness) {
		const provider = defaultHarnessRegistry.get(harness);
		const harnessLabel =
			provider?.metadata.displayName ?? HARNESS_LABELS[harness] ?? harness;
		// OpenCode shares one SQLite database across sessions; read in one batch.
		// File-per-session harnesses stream every ~8 sessions for fine progress & isolation.
		const chunkSize = harness === "opencode" ? harnessItems.length : 8;
		for (let offset = 0; offset < harnessItems.length; offset += chunkSize) {
			const chunk = harnessItems.slice(offset, offset + chunkSize);
			const { bySessionId, warnings } = await loadChunkTranscripts(
				harness,
				chunk,
			);
			for (const item of chunk) {
				const currentTitle = item.meta.title
					?.replace(/\s+/gu, " ")
					.trim()
					.slice(0, 80);
				const session = bySessionId.get(item.meta.sessionId);
				if (!session) {
					emitEvent({
						type: "miss",
						key: item.key,
						warning: `${item.key}: ${warnings.at(-1) ?? `${harnessLabel}: transcript could not be read`}`,
						currentTitle,
					});
					continue;
				}
				try {
					const rendered = renderExportSessionItem(item, session, {
						detail: request.detail,
						includeTimestamps: request.includeTimestamps,
						includeTokenStats: request.includeTokenStats,
						organization: request.organization,
						pathTemplate: request.pathTemplate,
					});
					if (!rendered.content) {
						emitEvent({
							type: "miss",
							key: item.key,
							warning: "",
							currentTitle: rendered.currentTitle || currentTitle,
						});
					} else {
						emitEvent({
							type: "item",
							key: item.key,
							rawRelative: rendered.rawRelative,
							content: rendered.content,
							currentTitle: rendered.currentTitle || currentTitle,
						});
					}
				} catch (error) {
					emitEvent({
						type: "miss",
						key: item.key,
						warning: `${item.key}: ${error instanceof Error ? error.message : String(error)}`,
						currentTitle,
					});
				}
			}
		}
	}
}

if (import.meta.main) {
	await runBatchExportWorker();
}
