import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

/**
 * Serializes an array of records to a standard JSONL string.
 */
export function toJsonl(records: unknown[]): string {
	if (records.length === 0) return "";
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/**
 * Serializes records to JSONL with an injected corrupted or malformed line.
 */
export function toJsonlWithCorruption(
	records: unknown[],
	corruptedLine = '{"type":"malformed", truncated...',
): string {
	const valid = records.map((r) => JSON.stringify(r));
	return `${[...valid, corruptedLine].join("\n")}\n`;
}

/**
 * Writes an array of records to a JSONL file, creating parent directories if needed.
 */
export function writeJsonlFile(filePath: string, records: unknown[]): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, toJsonl(records), "utf8");
}

/**
 * Compresses an array of records using Zstandard compression and writes to a file.
 */
export function writeZstdJsonlFile(filePath: string, records: unknown[]): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const jsonl = toJsonl(records);
	const compressed = zstdCompressSync(Buffer.from(jsonl, "utf8"));
	writeFileSync(filePath, compressed);
}

/**
 * Parses a JSONL string or buffer into an array of typed objects, skipping blank lines.
 */
export function parseJsonl<T = unknown>(content: string | Buffer): T[] {
	const text = typeof content === "string" ? content : content.toString("utf8");
	const lines = text.split("\n");
	const results: T[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		results.push(JSON.parse(trimmed) as T);
	}
	return results;
}

/**
 * Reads and parses a JSONL file from disk.
 */
export function readJsonlFile<T = unknown>(filePath: string): T[] {
	const raw = readFileSync(filePath, "utf8");
	return parseJsonl<T>(raw);
}

/**
 * Reads, decompresses (Zstandard), and parses a compressed JSONL file (.zst / .zstd).
 */
export function readZstdJsonlFile<T = unknown>(filePath: string): T[] {
	const compressed = readFileSync(filePath);
	const decompressed = zstdDecompressSync(compressed);
	return parseJsonl<T>(decompressed);
}
