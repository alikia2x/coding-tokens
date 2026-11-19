import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToUri } from "./normalizer";

export interface SafeDatabaseHandle {
	readonly db: Database;
	readonly isSnapshotCopy: boolean;
	close(): void;
}

export interface OpenReadonlySqliteOptions {
	maxRetries?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	backoffFactor?: number;
	busyTimeoutMs?: number;
	allowSnapshotCopy?: boolean;
}

function syncSleep(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function asyncSleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasNonEmptySidecar(filePath: string): boolean {
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

function isLockError(error: unknown): boolean {
	const msg = String(error).toLowerCase();
	return (
		msg.includes("ebusy") ||
		msg.includes("busy") ||
		msg.includes("locked") ||
		msg.includes("sharing_violation") ||
		msg.includes("eperm")
	);
}

function copyWithRetry(src: string, dest: string, maxAttempts = 3): void {
	let attempt = 0;
	while (attempt < maxAttempts) {
		try {
			copyFileSync(src, dest);
			return;
		} catch (err) {
			attempt++;
			if (attempt >= maxAttempts || !isLockError(err)) throw err;
			syncSleep(30 * attempt);
		}
	}
}

async function asyncCopyWithRetry(
	src: string,
	dest: string,
	maxAttempts = 3,
): Promise<void> {
	let attempt = 0;
	while (attempt < maxAttempts) {
		try {
			copyFileSync(src, dest);
			return;
		} catch (err) {
			attempt++;
			if (attempt >= maxAttempts || !isLockError(err)) throw err;
			await asyncSleep(30 * attempt);
		}
	}
}

function openReadonlyCandidate(dbPath: string, hasSidecar: boolean): Database {
	if (!hasSidecar) {
		const immutableUri = `${pathToUri(dbPath)}?immutable=1`;
		try {
			return new Database(immutableUri, { readonly: true, create: false });
		} catch (error) {
			// Some SQLite builds (such as Linux bun:sqlite without SQLITE_USE_URI)
			// reject file:// URIs; fall back to opening the filesystem path directly.
			if (isLockError(error)) throw error;
		}
	}
	return new Database(dbPath, { readonly: true, create: false });
}

export function openSafeReadonlyDatabase(
	dbPath: string,
	options: OpenReadonlySqliteOptions = {},
): SafeDatabaseHandle {
	const maxRetries = options.maxRetries ?? 2;
	const initialDelayMs = options.initialDelayMs ?? 50;
	const maxDelayMs = options.maxDelayMs ?? 300;
	const backoffFactor = options.backoffFactor ?? 2;
	const busyTimeoutMs = options.busyTimeoutMs ?? 400;
	const allowSnapshotCopy = options.allowSnapshotCopy ?? true;

	const hasSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);

	let lastError: unknown = null;

	// Attempt 1: Direct open (or immutable URI if no sidecars) with retry backoff
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		let db: Database | undefined;
		try {
			db = openReadonlyCandidate(dbPath, hasSidecar);
			try {
				db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
				db.exec("PRAGMA query_only = ON;");
			} catch {}

			// Execute probe read query to touch the database and detect locks
			db.query("SELECT 1 FROM sqlite_master LIMIT 1;").get();

			const activeDb = db;
			return {
				db: activeDb,
				isSnapshotCopy: false,
				close: () => {
					try {
						activeDb.close();
					} catch {}
				},
			};
		} catch (error) {
			if (db) {
				try {
					db.close();
				} catch {}
			}
			lastError = error;
			if (!isLockError(error) || attempt === maxRetries) {
				break;
			}
			// Exponential backoff with jitter
			const delay = Math.min(
				maxDelayMs,
				initialDelayMs * backoffFactor ** attempt,
			);
			const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
			syncSleep(jittered);
		}
	}

	// Non-lock errors (corrupted DB, invalid format, missing file) abort immediately
	if (!isLockError(lastError)) {
		throw lastError ?? new Error(`Failed to open SQLite database: ${dbPath}`);
	}

	// If allowSnapshotCopy === false and lastError was a lock error, do not fall through to Attempt 3. Re-throw immediately.
	if (!allowSnapshotCopy) {
		throw lastError;
	}

	// Attempt 2: Snapshot Copy Fallback if locked
	if (allowSnapshotCopy && isLockError(lastError)) {
		let tmpDir: string | undefined;
		let db: Database | undefined;
		try {
			tmpDir = path.join(
				os.tmpdir(),
				`ct-sqlite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			);
			mkdirSync(tmpDir, { recursive: true });
			const baseName = path.basename(dbPath);
			const tmpDb = path.join(tmpDir, baseName);

			copyWithRetry(dbPath, tmpDb);
			for (const ext of ["-wal", "-shm", "-journal"]) {
				const sidecar = `${dbPath}${ext}`;
				if (existsSync(sidecar)) {
					try {
						copyWithRetry(sidecar, `${tmpDb}${ext}`);
					} catch {}
				}
			}

			db = new Database(tmpDb, { readonly: true, create: false });
			try {
				db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
				db.exec("PRAGMA query_only = ON;");
			} catch {}

			// Execute probe read query to verify snapshot database integrity
			db.query("SELECT 1 FROM sqlite_master LIMIT 1;").get();

			const activeTmpDir = tmpDir;
			const activeDb = db;
			return {
				db: activeDb,
				isSnapshotCopy: true,
				close: () => {
					try {
						activeDb.close();
					} catch {}
					try {
						rmSync(activeTmpDir, { recursive: true, force: true });
					} catch {}
				},
			};
		} catch {
			if (db) {
				try {
					db.close();
				} catch {}
			}
			if (tmpDir) {
				try {
					rmSync(tmpDir, { recursive: true, force: true });
				} catch {}
			}
			throw lastError;
		}
	}

	// Attempt 3: Last-ditch immutable URI attempt
	try {
		const immutableUri = `${pathToUri(dbPath)}?immutable=1`;
		const db = new Database(immutableUri, { readonly: true, create: false });
		try {
			db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
			db.exec("PRAGMA query_only = ON;");
		} catch {}
		db.query("SELECT 1 FROM sqlite_master LIMIT 1;").get();
		return {
			db,
			isSnapshotCopy: false,
			close: () => {
				try {
					db.close();
				} catch {}
			},
		};
	} catch {
		throw lastError ?? new Error(`Failed to open SQLite database: ${dbPath}`);
	}
}

export async function openSafeReadonlyDatabaseAsync(
	dbPath: string,
	options: OpenReadonlySqliteOptions = {},
): Promise<SafeDatabaseHandle> {
	const maxRetries = options.maxRetries ?? 2;
	const initialDelayMs = options.initialDelayMs ?? 50;
	const maxDelayMs = options.maxDelayMs ?? 300;
	const backoffFactor = options.backoffFactor ?? 2;
	const busyTimeoutMs = options.busyTimeoutMs ?? 400;
	const allowSnapshotCopy = options.allowSnapshotCopy ?? true;

	const hasSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);

	let lastError: unknown = null;

	// Attempt 1: Direct open with retry backoff
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		let db: Database | undefined;
		try {
			db = openReadonlyCandidate(dbPath, hasSidecar);
			try {
				db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
				db.exec("PRAGMA query_only = ON;");
			} catch {}

			// Execute probe read query to touch the database and detect locks
			db.query("SELECT 1 FROM sqlite_master LIMIT 1;").get();

			const activeDb = db;
			return {
				db: activeDb,
				isSnapshotCopy: false,
				close: () => {
					try {
						activeDb.close();
					} catch {}
				},
			};
		} catch (error) {
			if (db) {
				try {
					db.close();
				} catch {}
			}
			lastError = error;
			if (!isLockError(error) || attempt === maxRetries) {
				break;
			}
			const delay = Math.min(
				maxDelayMs,
				initialDelayMs * backoffFactor ** attempt,
			);
			const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
			await asyncSleep(jittered);
		}
	}

	// Non-lock errors (corrupted DB, invalid format, missing file) abort immediately
	if (!isLockError(lastError)) {
		throw lastError ?? new Error(`Failed to open SQLite database: ${dbPath}`);
	}

	// If allowSnapshotCopy === false and lastError was a lock error, do not fall through to Attempt 3. Re-throw immediately.
	if (!allowSnapshotCopy) {
		throw lastError;
	}

	// Attempt 2: Snapshot Copy Fallback if locked
	if (allowSnapshotCopy && isLockError(lastError)) {
		let tmpDir: string | undefined;
		let db: Database | undefined;
		try {
			tmpDir = path.join(
				os.tmpdir(),
				`ct-sqlite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			);
			mkdirSync(tmpDir, { recursive: true });
			const baseName = path.basename(dbPath);
			const tmpDb = path.join(tmpDir, baseName);

			await asyncCopyWithRetry(dbPath, tmpDb);
			for (const ext of ["-wal", "-shm", "-journal"]) {
				const sidecar = `${dbPath}${ext}`;
				if (existsSync(sidecar)) {
					try {
						await asyncCopyWithRetry(sidecar, `${tmpDb}${ext}`);
					} catch {}
				}
			}

			db = new Database(tmpDb, { readonly: true, create: false });
			try {
				db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
				db.exec("PRAGMA query_only = ON;");
			} catch {}

			// Execute probe read query to verify snapshot database integrity
			db.query("SELECT 1 FROM sqlite_master LIMIT 1;").get();

			const activeTmpDir = tmpDir;
			const activeDb = db;
			return {
				db: activeDb,
				isSnapshotCopy: true,
				close: () => {
					try {
						activeDb.close();
					} catch {}
					try {
						rmSync(activeTmpDir, { recursive: true, force: true });
					} catch {}
				},
			};
		} catch {
			if (db) {
				try {
					db.close();
				} catch {}
			}
			if (tmpDir) {
				try {
					rmSync(tmpDir, { recursive: true, force: true });
				} catch {}
			}
			throw lastError;
		}
	}

	// Attempt 3: Last-ditch immutable URI attempt
	try {
		const immutableUri = `${pathToUri(dbPath)}?immutable=1`;
		const db = new Database(immutableUri, { readonly: true, create: false });
		try {
			db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
			db.exec("PRAGMA query_only = ON;");
		} catch {}
		db.query("SELECT 1 FROM sqlite_master LIMIT 1;").get();
		return {
			db,
			isSnapshotCopy: false,
			close: () => {
				try {
					db.close();
				} catch {}
			},
		};
	} catch {
		throw lastError ?? new Error(`Failed to open SQLite database: ${dbPath}`);
	}
}
