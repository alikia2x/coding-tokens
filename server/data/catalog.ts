import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import type { HarnessName, UsageRecord } from "@shared/types";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import {
	decodeProto,
	loadSummaries,
	loadT3AntigravityMeta,
	openSafeReadonlyDatabase,
	protoSub,
	protoText,
	readAntigravityBlobMeta,
	readAntigravitySidecarCwd,
	readAntigravityStepTimestamp,
} from "../../src/sources/antigravity";
import { cleanUserMessage, codexSessionFiles } from "../../src/transcripts";
import {
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	walkFiles,
} from "../../src/util";
import {
	codexHome,
	commandCodeRoot,
	existingAntigravityRoots,
	existingDshRoots,
	openCodeDbPaths,
} from "./paths";
import { sessionKey } from "./totals";

export type SessionSource =
	| { kind: "file"; path: string }
	| { kind: "opencode"; path: string };

export interface SessionMeta {
	key: string;
	harness: HarnessName;
	sessionId: string;
	title: string;
	cwd: string | null;
	startedAt: number | null;
	isSubagent: boolean;
	isReview: boolean;
	hasTranscript: boolean;
	source: SessionSource | null;
}

export interface SessionCatalog {
	entries: Map<string, SessionMeta>;
	warnings: string[];
}

export function cleanSessionTitle(
	value: string | null | undefined,
	harness?: HarnessName,
): string {
	let text = (value ?? "").trim();
	const provider = harness ? defaultHarnessRegistry.get(harness) : undefined;
	if (harness && provider?.capabilities?.cleanTitleWithUserMessage) {
		text = cleanUserMessage(harness, text).trim();
		if (!text) return "Untitled session";
	}
	text = text.replaceAll(/\s+/gu, " ").trim();
	const requestMarker = "## My request:";
	const requestIndex = text.indexOf(requestMarker);
	if (requestIndex >= 0)
		text = text.slice(requestIndex + requestMarker.length).trim();
	text = text
		.replace(/^#+\s*/u, "")
		.replace(/^["'`]+|["'`]+$/gu, "")
		.trim();
	if (!text) return "Untitled session";
	const characters = Array.from(text);
	if (characters.length <= 160) return text;
	return `${characters.slice(0, 159).join("").trimEnd()}…`;
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const raw of value) {
		const block = objectOrEmpty(raw);
		const type = textOrNull(block.type) ?? "";
		if (type === "text" || type === "input_text" || type === "output_text") {
			if (typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function entryFrom(
	harness: HarnessName,
	sessionId: string,
	values: {
		title?: string | null;
		cwd?: string | null;
		startedAt?: number | null;
		isSubagent?: boolean;
		isReview?: boolean;
		source?: SessionSource | null;
	},
): SessionMeta {
	const source = values.source ?? null;
	return {
		key: `${harness}:${sessionId}`,
		harness,
		sessionId,
		title: cleanSessionTitle(values.title, harness),
		cwd: values.cwd ?? null,
		startedAt: values.startedAt ?? null,
		isSubagent: values.isSubagent ?? false,
		isReview: values.isReview ?? false,
		hasTranscript: source
			? source.kind === "opencode" || existsSync(source.path)
			: false,
		source,
	};
}

function mergeEntry(
	entries: Map<string, SessionMeta>,
	candidate: SessionMeta,
): void {
	const current = entries.get(candidate.key);
	if (!current) {
		entries.set(candidate.key, candidate);
		return;
	}
	if (
		candidate.title !== "Untitled session" &&
		current.title === "Untitled session"
	)
		current.title = candidate.title;
	current.cwd ??= candidate.cwd;
	if (candidate.startedAt !== null && candidate.startedAt !== undefined) {
		current.startedAt =
			current.startedAt === null || current.startedAt === undefined
				? candidate.startedAt
				: Math.min(current.startedAt, candidate.startedAt);
	}
	current.isSubagent ||= candidate.isSubagent;
	current.isReview ||= candidate.isReview;
	current.hasTranscript ||= candidate.hasTranscript;
	current.source ??= candidate.source;
}

function hasNonEmptySidecar(filePath: string): boolean {
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

function openReadonlyDatabase(dbPath: string): Database {
	const hasPendingSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);
	if (hasPendingSidecar)
		return new Database(dbPath, { readonly: true, create: false });
	try {
		return new Database(`${pathToFileURL(dbPath).href}?immutable=1`, {
			readonly: true,
			create: false,
		});
	} catch {
		return new Database(dbPath, { readonly: true, create: false });
	}
}

function tablesIn(db: Database): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((row) => row.name),
	);
}

function resolveRolloutPath(resolved: string): string {
	if (existsSync(resolved)) return resolved;
	for (const suffix of [".zst", ".zstd"]) {
		const candidate = `${resolved}${suffix}`;
		if (existsSync(candidate)) return candidate;
	}
	return resolved;
}

function codexCatalog(
	entries: Map<string, SessionMeta>,
	warnings: string[],
	titles: Map<string, string>,
): void {
	const root = codexHome();
	const databases = [
		...safeReadDir(root).filter((name) => /^state_.*\.sqlite$/u.test(name)),
		...(() => {
			const nested = path.join(root, "sqlite", "codex-dev.db");
			return existsSync(nested) ? [path.relative(root, nested)] : [];
		})(),
	].map((name) => path.join(root, name));
	const seen = new Set<string>();
	for (const databasePath of databases) {
		if (seen.has(databasePath) || !existsSync(databasePath)) continue;
		seen.add(databasePath);
		try {
			const db = openReadonlyDatabase(databasePath);
			try {
				const tables = tablesIn(db);
				if (tables.has("threads")) {
					const rows = db
						.query<
							{
								id: string;
								rollout_path: string | null;
								title: string | null;
								first_user_message: string | null;
								cwd: string | null;
								created_at_ms: number | null;
								thread_source: string | null;
								agent_nickname: string | null;
								agent_path: string | null;
							},
							[]
						>(
							"SELECT id, rollout_path, title, first_user_message, cwd, " +
								"created_at_ms, thread_source, agent_nickname, agent_path " +
								"FROM threads",
						)
						.all();
					for (const row of rows) {
						const sourcePath = row.rollout_path
							? resolveRolloutPath(path.resolve(row.rollout_path))
							: null;
						const subagent = (row.thread_source ?? "")
							.toLowerCase()
							.includes("subagent");
						const subagentTitle = subagent
							? `Subagent: ${row.agent_nickname ?? row.agent_path ?? "unnamed"}`
							: null;
						mergeEntry(
							entries,
							entryFrom("codex", row.id, {
								title:
									row.title?.trim() ||
									row.first_user_message?.trim() ||
									subagentTitle,
								cwd: normalizedCwd(row.cwd),
								startedAt:
									typeof row.created_at_ms === "number" &&
									Number.isFinite(row.created_at_ms)
										? row.created_at_ms
										: null,
								isSubagent: subagent,
								isReview:
									(row.thread_source ?? "").toLowerCase() ===
										"guardian_review" ||
									(row.title ?? "").toLowerCase() === "guardian review",
								source: sourcePath ? { kind: "file", path: sourcePath } : null,
							}),
						);
					}
				}

				// Codex Desktop writes its generated thread titles here, while the
				// threads table often only has the raw first user message.
				if (tables.has("local_thread_catalog")) {
					const catalogRows = db
						.query<
							{
								thread_id: string;
								display_title: string | null;
								cwd: string | null;
								source_created_at: number | null;
								thread_source: string | null;
							},
							[]
						>(
							"SELECT thread_id, display_title, cwd, source_created_at, " +
								"thread_source FROM local_thread_catalog " +
								"WHERE display_title IS NOT NULL",
						)
						.all();
					for (const row of catalogRows) {
						const title = row.display_title?.trim();
						if (!title) continue;
						const key = `codex:${row.thread_id}`;
						titles.set(key, title);
						const current = entries.get(key);
						if (current) current.title = cleanSessionTitle(title, "codex");
					}
				}
			} finally {
				db.close();
			}
		} catch (error) {
			warnings.push(
				`Codex: could not read session metadata (${String(error)})`,
			);
		}
	}
}

function dshGeneration(name: string): number {
	const match = name.match(/^session\.v(\d+)\.jsonl\.zstd$/u);
	return match ? Number(match[1]) : 0;
}

function dshLogs(
	root: string,
): Array<{ filePath: string; generation: number }> {
	const candidates = walkFiles(
		path.join(root, "sessions"),
		(_filePath, name) =>
			name.startsWith("session") && name.endsWith(".jsonl.zstd"),
	);
	const byDirectory = new Map<
		string,
		{ filePath: string; generation: number }
	>();
	for (const filePath of candidates) {
		const candidate = {
			filePath,
			generation: dshGeneration(path.basename(filePath)),
		};
		const directory = path.dirname(filePath);
		const current = byDirectory.get(directory);
		if (!current || candidate.generation > current.generation)
			byDirectory.set(directory, candidate);
	}
	return [...byDirectory.values()];
}

function dshCatalog(
	entries: Map<string, SessionMeta>,
	warnings: string[],
): void {
	const seen = new Set<string>();
	for (const root of existingDshRoots()) {
		for (const { filePath } of dshLogs(root)) {
			try {
				const bytes = readFileSync(filePath);
				const text = filePath.endsWith(".zstd")
					? zstdDecompressSync(bytes).toString("utf8")
					: bytes.toString("utf8");
				const events = parseJsonl(text).map(objectOrEmpty);
				const header = events.find((event) => event.type === "session") ?? {};
				const sessionId =
					textOrNull(header.id) ?? path.basename(path.dirname(filePath));
				if (seen.has(sessionId)) continue;
				seen.add(sessionId);
				const origin = (textOrNull(header.origin) ?? "").toLowerCase();
				const isSubagent =
					origin === "subagent" ||
					textOrNull(header.parentSession) !== null ||
					(Number(header.delegationDepth) || 0) > 0;
				const isReview = origin === "review";
				let title = textOrNull(header.title);
				let firstUserText: string | null = null;
				for (const event of events) {
					const type = textOrNull(event.type) ?? "";
					const data = objectOrEmpty(event.data);
					if (type === "session/title") title = textOrNull(data.title) ?? title;
					if (!firstUserText && type === "user/message")
						firstUserText = textFromContent(data.content) || null;
				}
				mergeEntry(
					entries,
					entryFrom("dsh", sessionId, {
						title: title ?? firstUserText,
						cwd: normalizedCwd(header.cwd),
						startedAt: timestampMs(header.createdAt),
						isSubagent,
						isReview,
						source: { kind: "file", path: filePath },
					}),
				);
			} catch (error) {
				warnings.push(
					`DSH: could not read session metadata (${String(error)})`,
				);
			}
		}
	}
}

function openCodeFirstUserText(
	db: Database,
	table: "session" | "session_v2",
	sessionId: string,
): string | null {
	try {
		if (table === "session_v2") {
			const row = db
				.query<{ data: string }, [string]>(
					"SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 1",
				)
				.get(sessionId);
			if (!row) return null;
			const data = objectOrEmpty(JSON.parse(row.data));
			const meta = objectOrEmpty(data.metadata);
			return (
				textOrNull(meta.displayText) ??
				textOrNull(data.text) ??
				(textFromContent(data.content) || null)
			);
		}
		const rows = db
			.query<{ data: string }, [string]>(
				"SELECT data FROM message WHERE session_id = ? ORDER BY time_created LIMIT 5",
			)
			.all(sessionId);
		for (const row of rows) {
			const data = objectOrEmpty(JSON.parse(row.data));
			if (data.role !== "user") continue;
			const text = textOrNull(data.text) ?? textFromContent(data.content);
			if (text) return text;
		}
	} catch {}
	return null;
}

function openCodeCatalog(
	entries: Map<string, SessionMeta>,
	warnings: string[],
): void {
	for (const dbPath of openCodeDbPaths()) {
		try {
			const db = openReadonlyDatabase(dbPath);
			try {
				const tables = tablesIn(db);
				const addRows = (
					table: "session" | "session_v2",
					titleColumn: string,
				): void => {
					if (!tables.has(table)) return;
					const rows = db
						.query<
							{
								id: string;
								title: string | null;
								directory: string | null;
								time_created: number | null;
								parent_id: string | null;
							},
							[]
						>(
							`SELECT id, ${titleColumn} AS title, directory, time_created, parent_id FROM ${table}`,
						)
						.all();
					for (const row of rows) {
						const title = row.title ?? openCodeFirstUserText(db, table, row.id);
						mergeEntry(
							entries,
							entryFrom("opencode", row.id, {
								title,
								cwd: normalizedCwd(row.directory),
								startedAt: row.time_created,
								isSubagent: Boolean(row.parent_id),
								source: { kind: "opencode", path: dbPath },
							}),
						);
					}
				};
				addRows("session", "title");
				addRows("session_v2", "title");
			} finally {
				db.close();
			}
		} catch (error) {
			warnings.push(
				`OpenCode: could not read session metadata (${String(error)})`,
			);
		}
	}
}

function commandCodeCatalog(
	entries: Map<string, SessionMeta>,
	warnings: string[],
): void {
	const projectsRoot = path.join(commandCodeRoot(), "projects");
	if (!existsSync(projectsRoot)) return;
	let projectDirs: string[] = [];
	try {
		projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(projectsRoot, entry.name));
	} catch (error) {
		warnings.push(`Command Code: could not list projects (${String(error)})`);
		return;
	}
	const files = projectDirs.flatMap((directory) =>
		walkFiles(
			directory,
			(_filePath, name) =>
				name.endsWith(".jsonl") &&
				!name.endsWith(".checkpoints.jsonl") &&
				!name.endsWith(".prompts.jsonl"),
		),
	);
	for (const filePath of files) {
		try {
			const text = readFileSync(filePath, "utf8");
			const newline = text.indexOf("\n");
			const firstLine = newline >= 0 ? text.slice(0, newline) : text;
			const header = objectOrEmpty(JSON.parse(firstLine));
			if (header.type !== "session") continue;
			const sessionId =
				textOrNull(header.id) ?? path.basename(filePath, ".jsonl");
			let metadataTitle: string | null = null;
			try {
				const meta = objectOrEmpty(
					JSON.parse(
						readFileSync(filePath.replace(/\.jsonl$/u, ".meta.json"), "utf8"),
					),
				);
				metadataTitle = textOrNull(meta.title);
			} catch {
				// Older sessions may not have a metadata sidecar.
			}
			mergeEntry(
				entries,
				entryFrom("commandcode", sessionId, {
					title: metadataTitle ?? textOrNull(header.title),
					cwd: normalizedCwd(header.cwd),
					startedAt: timestampMs(header.timestamp),
					source: { kind: "file", path: filePath },
				}),
			);
		} catch (error) {
			warnings.push(
				`Command Code: could not read session metadata (${String(error)})`,
			);
		}
	}
}

function antigravityFirstUserMessage(db: Database): string | null {
	try {
		const row = db
			.query<{ step_payload: Uint8Array | null }, []>(
				"SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1",
			)
			.get();
		if (!row?.step_payload) return null;
		const payload = decodeProto(row.step_payload);
		const f19 = protoSub(payload.find((f) => f.field === 19));
		const text = protoText(f19.find((f) => f.field === 2));
		return text ? cleanUserMessage("antigravity", text) || null : null;
	} catch {
		return null;
	}
}

function antigravityEarliestStepTimestamp(db: Database): number | null {
	try {
		const row = db
			.query<{ metadata: Uint8Array | null }, []>(
				"SELECT metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx LIMIT 1",
			)
			.get();
		return readAntigravityStepTimestamp(row?.metadata ?? null);
	} catch {
		return null;
	}
}

function antigravityCatalog(
	entries: Map<string, SessionMeta>,
	warnings: string[],
): void {
	const seen = new Set<string>();
	const t3Meta = loadT3AntigravityMeta();
	for (const root of existingAntigravityRoots()) {
		let summaries: ReturnType<typeof loadSummaries>;
		try {
			summaries = loadSummaries(root);
		} catch {
			summaries = new Map();
		}
		const files = walkFiles(
			path.join(root, "conversations"),
			(_filePath, name) => name.endsWith(".db"),
		);
		for (const filePath of files) {
			const sessionId = path.basename(filePath, ".db");
			if (seen.has(sessionId)) continue;
			seen.add(sessionId);
			const summary = summaries.get(sessionId);
			try {
				const { db, cleanup } = openSafeReadonlyDatabase(filePath);
				try {
					const blobMeta = readAntigravityBlobMeta(db, sessionId);
					const cwd =
						summary?.cwd ?? blobMeta.cwd ?? readAntigravitySidecarCwd(filePath);
					const startedAt =
						blobMeta.startedAt ?? antigravityEarliestStepTimestamp(db);
					const isSubagent =
						blobMeta.isSubagent || t3Meta.subagents.has(sessionId);
					const rawTitle =
						t3Meta.titles.get(sessionId) ??
						summary?.title ??
						(isSubagent
							? `Subagent: ${blobMeta.subagentRole ?? blobMeta.subagentType ?? "unnamed"}`
							: antigravityFirstUserMessage(db));
					mergeEntry(
						entries,
						entryFrom("antigravity", sessionId, {
							title: rawTitle,
							cwd,
							startedAt,
							isSubagent,
							source: { kind: "file", path: filePath },
						}),
					);
				} finally {
					cleanup();
				}
			} catch (error) {
				warnings.push(
					`Antigravity: could not read session metadata (${String(error)})`,
				);
			}
		}
	}
}

function safeReadDir(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

export function buildSessionCatalog(
	records: readonly UsageRecord[],
): SessionCatalog {
	const entries = new Map<string, SessionMeta>();
	const warnings: string[] = [];
	const codexTitles = new Map<string, string>();
	codexCatalog(entries, warnings, codexTitles);
	dshCatalog(entries, warnings);
	openCodeCatalog(entries, warnings);
	commandCodeCatalog(entries, warnings);
	antigravityCatalog(entries, warnings);

	const grouped = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = sessionKey(record);
		const list = grouped.get(key) ?? [];
		list.push(record);
		grouped.set(key, list);
	}

	for (const [key, sessionRecords] of grouped) {
		const current = entries.get(key);
		const first =
			sessionRecords.find((record) => record.cwd) ?? sessionRecords[0];
		const timestamps = sessionRecords
			.map((record) => record.timestamp)
			.filter((value): value is number => value !== null);
		const isSubagent = sessionRecords.some((record) => record.isSubagent);
		const isReview = sessionRecords.some((record) => record.isReview);
		if (current) {
			current.cwd ??= first?.cwd ?? null;
			if (timestamps.length > 0) {
				const earliest = Math.min(...timestamps);
				current.startedAt =
					current.startedAt === null || current.startedAt === undefined
						? earliest
						: Math.min(current.startedAt, earliest);
			}
			current.isSubagent ||= isSubagent;
			current.isReview ||= isReview;
			continue;
		}
		if (!first) continue;
		mergeEntry(
			entries,
			entryFrom(first.harness, first.sessionId, {
				cwd: first.cwd,
				startedAt: timestamps.length > 0 ? Math.min(...timestamps) : null,
				isSubagent,
				isReview,
			}),
		);
	}

	// Prefer Codex Desktop's generated title for sessions that only exist in
	// usage records, but never invent sessions that have no local usage.
	for (const [key, title] of codexTitles) {
		const entry = entries.get(key);
		if (entry) entry.title = cleanSessionTitle(title, "codex");
	}

	return { entries, warnings };
}

export function codexFallbackSource(sessionId: string): SessionSource | null {
	const files = codexSessionFiles(sessionId);
	const latest = files.at(-1);
	return latest ? { kind: "file", path: latest } : null;
}
