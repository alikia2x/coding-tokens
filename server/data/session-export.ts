import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	BatchExportOrganization,
	BatchSessionExportResult,
	SessionDetailLevel,
} from "@shared/types";
import { createZipArchive, renderSessionMarkdown } from "../../src/exporter";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { loadSessionTranscript } from "./session-detail";
import {
	type ExportWorkerEvent,
	type ExportWorkerItem,
	type ExportWorkerRequest,
	resolveExportTitle,
	safeFilename,
	uniqueRelativePath,
} from "./session-export-format";
import { store } from "./store";
import { resolveWorkerCommand } from "./worker-command";

export interface SessionExportResult {
	path: string;
	filename: string;
	bytes: number;
}

const WORKER_STALL_TIMEOUT_MS = 45_000;

function timestampSlug(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function uniqueExtensionPath(
	directory: string,
	base: string,
	ext: string,
): string {
	let candidate = path.join(directory, `${base}${ext}`);
	let index = 2;
	while (existsSync(candidate)) {
		candidate = path.join(directory, `${base}-${index}${ext}`);
		index += 1;
	}
	return candidate;
}

function uniquePath(directory: string, base: string): string {
	return uniqueExtensionPath(directory, base, ".md");
}

function uniqueFolderPath(directory: string, base: string): string {
	let candidate = path.join(directory, base);
	let index = 2;
	while (existsSync(candidate)) {
		candidate = path.join(directory, `${base}-${index}`);
		index += 1;
	}
	return candidate;
}

export async function renderSingleSessionExport(
	key: string,
	detail: SessionDetailLevel,
): Promise<{ filename: string; markdown: string }> {
	const loaded = await loadSessionTranscript(key);
	if (!loaded.ok)
		throw new Error(loaded.warnings.at(-1) ?? "Session could not be loaded");
	const { meta, session } = loaded.value;
	session.title = resolveExportTitle(
		meta.title,
		session.title,
		session.harness,
	);
	const markdown = renderSessionMarkdown(session, {
		detail,
		includeTimestamps: true,
		includeTokenStats: true,
	});
	if (!markdown) throw new Error("No messages at this detail level");
	const base = `${safeFilename(session.title ?? session.sessionId)}-${safeFilename(
		session.sessionId,
	).slice(-8)}`;
	return { filename: `${base}.md`, markdown };
}

export async function exportSessionMarkdown(
	key: string,
	detail: SessionDetailLevel,
	directory?: string,
): Promise<SessionExportResult> {
	const { filename, markdown } = await renderSingleSessionExport(key, detail);
	const base = filename.replace(/\.md$/u, "");
	const targetDirectory = directory
		? defaultPlatformPathService.normalize(directory)
		: path.join(defaultPlatformPathService.getHomeDir(), "Downloads");
	mkdirSync(targetDirectory, { recursive: true });
	const destination = uniquePath(targetDirectory, base);
	writeFileSync(destination, markdown, "utf8");
	return {
		path: destination,
		filename: path.basename(destination),
		bytes: Buffer.byteLength(markdown, "utf8"),
	};
}

export interface BatchExportProgress {
	completed: number;
	total: number;
	currentTitle?: string;
}

interface WorkerShardResult {
	rendered: Map<string, { rawRelative: string; content: string }>;
	warningsByKey: Map<string, string>;
	unfinished: ExportWorkerItem[];
	stalledOrCrashed: boolean;
}

async function runSingleWorkerShard(
	items: ExportWorkerItem[],
	options: {
		detail: SessionDetailLevel;
		includeTimestamps: boolean;
		includeTokenStats: boolean;
		organization: BatchExportOrganization;
		pathTemplate?: string;
		signal?: AbortSignal;
		onItemSettled: (title?: string) => void;
	},
): Promise<WorkerShardResult> {
	if (options.signal?.aborted) {
		throw new DOMException("Export cancelled", "AbortError");
	}

	const rendered = new Map<string, { rawRelative: string; content: string }>();
	const warningsByKey = new Map<string, string>();
	const settledKeys = new Set<string>();
	const payload: ExportWorkerRequest = {
		items,
		detail: options.detail,
		includeTimestamps: options.includeTimestamps,
		includeTokenStats: options.includeTokenStats,
		organization: options.organization,
		pathTemplate: options.pathTemplate,
	};

	const proc = Bun.spawn(resolveWorkerCommand("export-worker.ts"), {
		env: {
			...process.env,
			CODING_TOKENS_WORKER: "batch-export",
		},
		stdin: new TextEncoder().encode(JSON.stringify(payload)),
		stdout: "pipe",
		stderr: "pipe",
	});

	let stalled = false;
	let watchdog: ReturnType<typeof setTimeout> | null = null;
	const resetWatchdog = () => {
		if (watchdog) clearTimeout(watchdog);
		watchdog = setTimeout(() => {
			stalled = true;
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, WORKER_STALL_TIMEOUT_MS);
	};
	resetWatchdog();

	const killWorker = () => {
		if (watchdog) {
			clearTimeout(watchdog);
			watchdog = null;
		}
		try {
			proc.kill("SIGKILL");
		} catch {}
	};
	options.signal?.addEventListener("abort", killWorker, { once: true });

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processLine = (line: string) => {
		if (!line.trim()) return;
		resetWatchdog();
		const event = JSON.parse(line) as ExportWorkerEvent;
		if (settledKeys.has(event.key)) return;
		settledKeys.add(event.key);
		if (event.type === "item") {
			rendered.set(event.key, {
				rawRelative: event.rawRelative,
				content: event.content,
			});
		} else if (event.type === "miss") {
			if (event.warning) warningsByKey.set(event.key, event.warning);
		}
		options.onItemSettled(event.currentTitle);
	};

	try {
		while (true) {
			if (options.signal?.aborted) {
				killWorker();
				throw new DOMException("Export cancelled", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				processLine(line);
				nl = buffer.indexOf("\n");
			}
		}
		const tail = (buffer + decoder.decode()).trim();
		if (tail) processLine(tail);
	} finally {
		if (watchdog) clearTimeout(watchdog);
		options.signal?.removeEventListener("abort", killWorker);
	}

	const exitCode = await proc.exited;
	if (options.signal?.aborted) {
		throw new DOMException("Export cancelled", "AbortError");
	}

	const unfinished = items.filter((item) => !settledKeys.has(item.key));
	return {
		rendered,
		warningsByKey,
		unfinished,
		stalledOrCrashed: stalled || exitCode !== 0 || unfinished.length > 0,
	};
}

/**
 * Execute batch export across parallel isolated child processes, bisecting any shard
 * whose worker crashes or stalls so a single malformed session is quarantined safely.
 */
async function runWorkerShardWithIsolation(
	items: ExportWorkerItem[],
	options: {
		detail: SessionDetailLevel;
		includeTimestamps: boolean;
		includeTokenStats: boolean;
		organization: BatchExportOrganization;
		pathTemplate?: string;
		signal?: AbortSignal;
		onItemSettled: (title?: string) => void;
	},
	rendered: Map<string, { rawRelative: string; content: string }>,
	warningsByKey: Map<string, string>,
): Promise<void> {
	const result = await runSingleWorkerShard(items, options);
	for (const [k, v] of result.rendered) rendered.set(k, v);
	for (const [k, w] of result.warningsByKey) warningsByKey.set(k, w);

	if (!result.stalledOrCrashed || result.unfinished.length === 0) return;

	if (result.unfinished.length === 1) {
		const poison = result.unfinished[0];
		if (!poison) return;
		warningsByKey.set(
			poison.key,
			`${poison.key}: Session parser timed out or crashed cleanly in isolated worker`,
		);
		options.onItemSettled(poison.meta.title);
		return;
	}

	const mid = Math.ceil(result.unfinished.length / 2);
	await Promise.all([
		runWorkerShardWithIsolation(
			result.unfinished.slice(0, mid),
			options,
			rendered,
			warningsByKey,
		),
		runWorkerShardWithIsolation(
			result.unfinished.slice(mid),
			options,
			rendered,
			warningsByKey,
		),
	]);
}

export async function renderBatchSessionEntries(options: {
	keys: string[];
	detail: SessionDetailLevel;
	includeTimestamps?: boolean;
	includeTokenStats?: boolean;
	organization?: BatchExportOrganization;
	pathTemplate?: string;
	signal?: AbortSignal;
	onProgress?: (progress: BatchExportProgress) => void;
}): Promise<{
	entries: Array<{ name: string; content: string }>;
	total: number;
	warnings: string[];
}> {
	const uniqueKeys = [
		...new Set(options.keys.map((key) => key.trim()).filter(Boolean)),
	];
	if (uniqueKeys.length === 0) {
		throw new Error("At least one session key is required");
	}
	if (options.signal?.aborted) {
		throw new DOMException("Export cancelled", "AbortError");
	}

	await store.ensureReady();
	const organization = options.organization ?? "flat";
	const includeTimestamps = options.includeTimestamps ?? true;
	const includeTokenStats = options.includeTokenStats ?? true;
	const total = uniqueKeys.length;

	const workerItems: ExportWorkerItem[] = [];
	const rendered = new Map<string, { rawRelative: string; content: string }>();
	const warningsByKey = new Map<string, string>();
	let completed = 0;

	for (const key of uniqueKeys) {
		const entry = store.sessionEntry(key);
		if (!entry) {
			warningsByKey.set(key, `${key}: Session could not be loaded`);
			completed += 1;
			options.onProgress?.({ completed, total });
			continue;
		}
		const meta = store.ensureSessionSource(entry);
		workerItems.push({ key, meta, records: entry.records });
	}

	if (workerItems.length > 0) {
		const cpuBudget = Math.min(
			4,
			Math.max(1, os.availableParallelism?.() ?? 2),
		);
		const workerCount =
			workerItems.length >= 16
				? Math.min(cpuBudget, Math.ceil(workerItems.length / 8))
				: 1;
		const shards: ExportWorkerItem[][] = Array.from(
			{ length: workerCount },
			() => [],
		);
		for (const [idx, item] of workerItems.entries()) {
			shards[idx % workerCount]?.push(item);
		}

		await Promise.all(
			shards
				.filter((shard) => shard.length > 0)
				.map((shard) =>
					runWorkerShardWithIsolation(
						shard,
						{
							detail: options.detail,
							includeTimestamps,
							includeTokenStats,
							organization,
							pathTemplate: options.pathTemplate,
							signal: options.signal,
							onItemSettled: (title) => {
								completed += 1;
								options.onProgress?.({
									completed: Math.min(completed, total),
									total,
									currentTitle: title,
								});
							},
						},
						rendered,
						warningsByKey,
					),
				),
		);
	}

	if (options.signal?.aborted) {
		throw new DOMException("Export cancelled", "AbortError");
	}

	const entries: Array<{ name: string; content: string }> = [];
	const usedPaths = new Set<string>();
	const warnings: string[] = [];

	for (const key of uniqueKeys) {
		const warn = warningsByKey.get(key);
		if (warn) warnings.push(warn);
		const item = rendered.get(key);
		if (item) {
			entries.push({
				name: uniqueRelativePath(usedPaths, item.rawRelative),
				content: item.content,
			});
		}
	}

	return { entries, total, warnings };
}

export async function buildSessionsBatchZip(options: {
	keys: string[];
	detail: SessionDetailLevel;
	includeTimestamps?: boolean;
	includeTokenStats?: boolean;
	organization?: BatchExportOrganization;
	pathTemplate?: string;
	signal?: AbortSignal;
	onProgress?: (progress: BatchExportProgress) => void;
}): Promise<{
	zipBytes: Uint8Array;
	filename: string;
	filesWritten: number;
	skippedCount: number;
	warnings: string[];
}> {
	const { entries, total, warnings } = await renderBatchSessionEntries(options);
	const zipBytes = createZipArchive(entries);
	const filename = `coding-tokens-export-${timestampSlug()}.zip`;
	return {
		zipBytes,
		filename,
		filesWritten: entries.length,
		skippedCount: Math.max(0, total - entries.length),
		warnings,
	};
}

export async function exportSessionsBatchMarkdown(options: {
	keys: string[];
	detail: SessionDetailLevel;
	includeTimestamps?: boolean;
	includeTokenStats?: boolean;
	directory?: string;
	asZip?: boolean;
	organization?: BatchExportOrganization;
	pathTemplate?: string;
	signal?: AbortSignal;
	onProgress?: (progress: BatchExportProgress) => void;
}): Promise<BatchSessionExportResult> {
	const baseDirectory = options.directory
		? defaultPlatformPathService.normalize(options.directory)
		: path.join(defaultPlatformPathService.getHomeDir(), "Downloads");
	mkdirSync(baseDirectory, { recursive: true });
	const slug = `coding-tokens-export-${timestampSlug()}`;

	if (options.asZip) {
		const built = await buildSessionsBatchZip(options);
		const zipPath = uniqueExtensionPath(baseDirectory, slug, ".zip");
		writeFileSync(zipPath, built.zipBytes);
		return {
			directory: baseDirectory,
			outputPath: zipPath,
			zipPath,
			filename: path.basename(zipPath),
			bytes: built.zipBytes.byteLength,
			filesWritten: built.filesWritten,
			skippedCount: built.skippedCount,
			warnings: built.warnings,
		};
	}

	const { entries, total, warnings } = await renderBatchSessionEntries(options);
	const exportFolder = uniqueFolderPath(baseDirectory, slug);
	mkdirSync(exportFolder, { recursive: true });
	let totalBytes = 0;
	for (const entry of entries) {
		const dest = path.join(exportFolder, entry.name);
		mkdirSync(path.dirname(dest), { recursive: true });
		writeFileSync(dest, entry.content, "utf8");
		totalBytes += Buffer.byteLength(entry.content, "utf8");
	}
	return {
		directory: exportFolder,
		outputPath: exportFolder,
		filename: path.basename(exportFolder),
		bytes: totalBytes,
		filesWritten: entries.length,
		skippedCount: Math.max(0, total - entries.length),
		warnings,
	};
}
