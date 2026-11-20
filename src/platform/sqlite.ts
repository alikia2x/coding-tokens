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

interface NormalizedSqliteOptions {
	maxRetries: number;
	initialDelayMs: number;
	maxDelayMs: number;
	backoffFactor: number;
	busyTimeoutMs: number;
	allowSnapshotCopy: boolean;
}

function validateNonNegativeInt(
	value: number | undefined,
	defaultValue: number,
	name: string,
): number {
	const raw = value ?? defaultValue;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
	return raw;
}

function normalizeOptions(
	options: OpenReadonlySqliteOptions,
): NormalizedSqliteOptions {
	return {
		maxRetries: validateNonNegativeInt(options.maxRetries, 2, "maxRetries"),
		initialDelayMs: validateNonNegativeInt(
			options.initialDelayMs,
			50,
			"initialDelayMs",
		),
		maxDelayMs: validateNonNegativeInt(options.maxDelayMs, 300, "maxDelayMs"),
		backoffFactor:
			options.backoffFactor !== undefined &&
			Number.isFinite(options.backoffFactor) &&
			options.backoffFactor >= 1
				? options.backoffFactor
				: 2,
		busyTimeoutMs: validateNonNegativeInt(
			options.busyTimeoutMs,
			400,
			"busyTimeoutMs",
		),
		allowSnapshotCopy: options.allowSnapshotCopy ?? true,
	};
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

function configureAndProbeDatabase(db: Database, busyTimeoutMs: number): void {
	try {
		db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
		db.exec("PRAGMA query_only = ON;");
	} catch {
		// Some virtual/immutable opens disallow PRAGMA writes; SELECT probe below validates readability.
	}
	db.query("SELECT 1 FROM sqlite_master LIMIT 1;").get();
}

function makeHandle(
	db: Database,
	isSnapshotCopy: boolean,
	tmpDir?: string,
): SafeDatabaseHandle {
	return {
		db,
		isSnapshotCopy,
		close: () => {
			try {
				db.close();
			} catch {
				// Best-effort close during handle teardown.
			}
			if (tmpDir) {
				try {
					rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					// Best-effort cleanup of snapshot directory.
				}
			}
		},
	};
}

function retryDelayMs(attempt: number, opts: NormalizedSqliteOptions): number {
	const delay = Math.min(
		opts.maxDelayMs,
		opts.initialDelayMs * opts.backoffFactor ** attempt,
	);
	return Math.round(delay * (0.8 + Math.random() * 0.4));
}

function createSnapshotDir(): string {
	const tmpDir = path.join(
		os.tmpdir(),
		`ct-sqlite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(tmpDir, { recursive: true });
	return tmpDir;
}

function cleanupFailedAttempt(db?: Database, tmpDir?: string): void {
	if (db) {
		try {
			db.close();
		} catch {
			// Ignore close error on failed handle.
		}
	}
	if (tmpDir) {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup error on failed snapshot.
		}
	}
}

export function tablesIn(db: Database): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((row) => row.name),
	);
}

export function openSafeReadonlyDatabase(
	dbPath: string,
	options: OpenReadonlySqliteOptions = {},
): SafeDatabaseHandle {
	const opts = normalizeOptions(options);
	const hasSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);

	let lastError: unknown = null;

	// Attempt 1: Direct open (or immutable URI if no sidecars) with retry backoff
	for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
		let db: Database | undefined;
		try {
			db = openReadonlyCandidate(dbPath, hasSidecar);
			configureAndProbeDatabase(db, opts.busyTimeoutMs);
			return makeHandle(db, false);
		} catch (error) {
			cleanupFailedAttempt(db);
			lastError = error;
			if (!isLockError(error) || attempt === opts.maxRetries) {
				break;
			}
			syncSleep(retryDelayMs(attempt, opts));
		}
	}

	if (!isLockError(lastError)) {
		throw lastError ?? new Error(`Failed to open SQLite database: ${dbPath}`);
	}

	if (!opts.allowSnapshotCopy) {
		throw lastError;
	}

	// Attempt 2: Snapshot copy fallback if locked
	let tmpDir: string | undefined;
	let db: Database | undefined;
	try {
		tmpDir = createSnapshotDir();
		const tmpDb = path.join(tmpDir, path.basename(dbPath));

		copyWithRetry(dbPath, tmpDb);
		for (const ext of ["-wal", "-shm", "-journal"]) {
			const sidecar = `${dbPath}${ext}`;
			if (existsSync(sidecar)) {
				try {
					copyWithRetry(sidecar, `${tmpDb}${ext}`);
				} catch {
					// Optional sidecar copy; probe below verifies snapshot readability.
				}
			}
		}

		db = new Database(tmpDb, { readonly: true, create: false });
		configureAndProbeDatabase(db, opts.busyTimeoutMs);
		return makeHandle(db, true, tmpDir);
	} catch {
		cleanupFailedAttempt(db, tmpDir);
		throw lastError;
	}
}

export async function openSafeReadonlyDatabaseAsync(
	dbPath: string,
	options: OpenReadonlySqliteOptions = {},
): Promise<SafeDatabaseHandle> {
	const opts = normalizeOptions(options);
	const hasSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);

	let lastError: unknown = null;

	// Attempt 1: Direct open with async retry backoff
	for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
		let db: Database | undefined;
		try {
			db = openReadonlyCandidate(dbPath, hasSidecar);
			configureAndProbeDatabase(db, opts.busyTimeoutMs);
			return makeHandle(db, false);
		} catch (error) {
			cleanupFailedAttempt(db);
			lastError = error;
			if (!isLockError(error) || attempt === opts.maxRetries) {
				break;
			}
			await asyncSleep(retryDelayMs(attempt, opts));
		}
	}

	if (!isLockError(lastError)) {
		throw lastError ?? new Error(`Failed to open SQLite database: ${dbPath}`);
	}

	if (!opts.allowSnapshotCopy) {
		throw lastError;
	}

	// Attempt 2: Snapshot copy fallback if locked
	let tmpDir: string | undefined;
	let db: Database | undefined;
	try {
		tmpDir = createSnapshotDir();
		const tmpDb = path.join(tmpDir, path.basename(dbPath));

		await asyncCopyWithRetry(dbPath, tmpDb);
		for (const ext of ["-wal", "-shm", "-journal"]) {
			const sidecar = `${dbPath}${ext}`;
			if (existsSync(sidecar)) {
				try {
					await asyncCopyWithRetry(sidecar, `${tmpDb}${ext}`);
				} catch {
					// Optional sidecar copy; probe below verifies snapshot readability.
				}
			}
		}

		db = new Database(tmpDb, { readonly: true, create: false });
		configureAndProbeDatabase(db, opts.busyTimeoutMs);
		return makeHandle(db, true, tmpDir);
	} catch {
		cleanupFailedAttempt(db, tmpDir);
		throw lastError;
	}
}
