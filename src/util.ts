import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessName, SourceResult, UsageRecord } from "./types";

export const homeDir = homedir();

export function numberOrZero(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

export function textOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function objectOrEmpty(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function parseJsonl(text: string): unknown[] {
	const rows: unknown[] = [];
	const clean = text.replace(/^\uFEFF/u, "");
	for (const line of clean.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			rows.push(JSON.parse(trimmed) as unknown);
		} catch {
			// A concurrently-written or damaged final line should not hide other usage.
		}
	}
	return rows;
}

export function blankSourceResult(
	harness: HarnessName,
	available: boolean,
): SourceResult {
	return {
		harness,
		records: [],
		warnings: [],
		available,
		messages: new Map(),
	};
}

export function contentText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const raw of value) {
		const block = objectOrEmpty(raw);
		if (typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

export interface TokenUsageFields {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
}

/**
 * A usage record is only meaningful when at least one token counter moved.
 * Harnesses still write assistant/attempt rows for aborted, cancelled or
 * otherwise empty requests; those rows carry all-zero token objects and must
 * not become sessions, requests or report rows.
 */
export function hasTokenUsage(usage: TokenUsageFields): boolean {
	return (
		usage.inputTokens > 0 ||
		usage.outputTokens > 0 ||
		usage.cacheReadTokens > 0 ||
		usage.cacheWriteTokens > 0 ||
		usage.reasoningTokens > 0
	);
}

export function usageRecord(
	base: Pick<
		UsageRecord,
		| "harness"
		| "sessionId"
		| "messageId"
		| "cwd"
		| "model"
		| "timestamp"
		| "turnId"
		| "isSubagent"
		| "isReview"
		| "pricingModel"
	>,
	usage: {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		reasoning?: unknown;
		cost?: unknown;
	},
): UsageRecord {
	return {
		...base,
		inputTokens: numberOrZero(usage.input),
		outputTokens: numberOrZero(usage.output),
		cacheReadTokens: numberOrZero(usage.cacheRead),
		cacheWriteTokens: numberOrZero(usage.cacheWrite),
		reasoningTokens: numberOrZero(usage.reasoning),
		costUsd:
			usage.cost === undefined || usage.cost === null
				? null
				: numberOrZero(usage.cost),
		costEstimated: false,
	};
}

export function expandHome(value: string): string {
	if (value === "~") return homeDir;
	if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
	return value;
}

export function normalizedCwd(value: unknown): string | null {
	const text = textOrNull(value);
	if (text === null) return null;
	return path.normalize(text);
}

export function modelName(value: unknown, fallback = "Unknown model"): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const id = textOrNull(record.id) ?? textOrNull(record.model);
		const provider =
			textOrNull(record.providerID) ?? textOrNull(record.provider);
		if (provider && id) return `${provider}/${id}`;
		if (id) return id;
	}
	return fallback;
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const itemKey = key(item);
		if (seen.has(itemKey)) return false;
		seen.add(itemKey);
		return true;
	});
}

export function localDate(timestamp: number | null): string {
	if (timestamp === null || !Number.isFinite(timestamp)) return "Unknown date";
	const date = new Date(timestamp);
	if (Number.isNaN(date.valueOf())) return "Unknown date";
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function timestampMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

export function walkFiles(
	root: string,
	accept: (filePath: string, name: string) => boolean,
): string[] {
	const result: string[] = [];
	const visit = (directory: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const filePath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(filePath);
			} else if (entry.isFile() && accept(filePath, entry.name)) {
				result.push(filePath);
			}
		}
	};
	visit(root);
	return result;
}
