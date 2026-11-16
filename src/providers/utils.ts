import { createHash } from "node:crypto";
import { statSync } from "node:fs";

export const INDEX_VERSION = 12;

export function stampFile(filePath: string): string {
	try {
		const stat = statSync(filePath);
		return `${filePath}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return `${filePath}:missing`;
	}
}

export function hashFiles(files: string[]): string {
	const hash = createHash("sha256");
	for (const file of [...files].sort()) {
		hash.update(stampFile(file));
	}
	return hash.digest("hex");
}

export function computeFilesFingerprint(
	files: string[],
	version = INDEX_VERSION,
): string {
	return `v${version}:${files.length}:${hashFiles(files)}`;
}
