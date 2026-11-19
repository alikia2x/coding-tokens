import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolves the Bun command tuple for spawning an isolated worker script in
 * both source/dev execution (`server/data/<filename>`) and bundled desktop
 * builds (`index.js` dispatched via `CODING_TOKENS_WORKER`).
 */
export function resolveWorkerCommand(workerFilename: string): string[] {
	const localWorker = path.resolve(import.meta.dir, workerFilename);
	if (existsSync(localWorker)) {
		return [process.execPath, localWorker];
	}
	const entry = process.argv[1];
	if (entry && existsSync(entry)) {
		return [process.execPath, entry];
	}
	const bundledEntry = path.resolve(import.meta.dir, "index.js");
	if (existsSync(bundledEntry)) {
		return [process.execPath, bundledEntry];
	}
	return [process.execPath];
}
