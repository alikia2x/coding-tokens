import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import { openReadonlyDatabase, tablesIn } from "../../transcripts/shared";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import {
	decodeWorkspaceUri,
	findContinueDevDataFiles,
	findContinueSessionsFiles,
	getContinueRoots,
} from "./discovery";

interface RawTokenEntry {
	timestamp: number | null;
	model: string;
	provider: string;
	promptTokens: number;
	generatedTokens: number;
	source: string;
}

interface ChatInteractionEntry {
	timestamp: number | null;
	sessionId: string;
	modelName?: string;
	modelProvider?: string;
	tools?: string[];
}

export function readContinueUsageSync(
	paths: PlatformPathService = defaultPlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const roots = getContinueRoots(paths);
	const sessionsFiles = findContinueSessionsFiles(roots);
	const devDataFiles = findContinueDevDataFiles(roots);

	const available =
		sessionsFiles.catalogs.length > 0 ||
		sessionsFiles.sessionFiles.length > 0 ||
		devDataFiles.sqliteDbs.length > 0 ||
		devDataFiles.tokensJsonl.length > 0;

	const result = blankSourceResult("continue", available);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	// 1. Build session metadata map (sessionId -> { cwd, dateCreated, title })
	const sessionMetaMap = new Map<
		string,
		{ cwd: string | null; dateCreated: number | null; title?: string }
	>();

	for (const catPath of sessionsFiles.catalogs) {
		try {
			const list = JSON.parse(readFileSync(catPath, "utf8"));
			if (Array.isArray(list)) {
				for (const raw of list) {
					const entry = objectOrEmpty(raw);
					const id = textOrNull(entry.sessionId);
					if (!id) continue;
					sessionMetaMap.set(id, {
						cwd: normalizedCwd(
							decodeWorkspaceUri(textOrNull(entry.workspaceDirectory)),
						),
						dateCreated: timestampMs(entry.dateCreated),
						title: textOrNull(entry.title) ?? undefined,
					});
					const count =
						typeof entry.messageCount === "number" ? entry.messageCount : 1;
					messages.set(
						id,
						Math.max(messages.get(id) ?? 0, Math.ceil(count / 2)),
					);
				}
			}
		} catch (error) {
			result.warnings.push(
				`Continue: failed to read ${catPath} (${String(error)})`,
			);
		}
	}

	for (const sPath of sessionsFiles.sessionFiles) {
		try {
			const parsed = JSON.parse(readFileSync(sPath, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				const baseName = path.basename(sPath, ".json");
				const id = textOrNull(parsed.sessionId) ?? baseName;
				const cwd = normalizedCwd(
					decodeWorkspaceUri(textOrNull(parsed.workspaceDirectory)),
				);
				const dateCreated = timestampMs(parsed.dateCreated);
				const existing = sessionMetaMap.get(id);
				sessionMetaMap.set(id, {
					cwd: cwd ?? existing?.cwd ?? null,
					dateCreated: dateCreated ?? existing?.dateCreated ?? null,
					title: textOrNull(parsed.title) ?? existing?.title,
				});

				if (Array.isArray(parsed.history)) {
					const userMsgs = parsed.history.filter(
						(h: unknown) =>
							objectOrEmpty(objectOrEmpty(h).message).role === "user",
					).length;
					if (userMsgs > 0) {
						messages.set(id, Math.max(messages.get(id) ?? 0, userMsgs));
					}
				}
			}
		} catch {
			// ignore
		}
	}

	// 2. Parse chatInteraction.jsonl for sessionId correlation & user message counting
	const chatInteractions: ChatInteractionEntry[] = [];
	for (const chatPath of devDataFiles.chatJsonl) {
		try {
			const content = readFileSync(chatPath, "utf8");
			const rows = parseJsonl(content);
			for (const r of rows) {
				const obj = objectOrEmpty(r);
				const sId = textOrNull(obj.sessionId);
				if (!sId) continue;
				const ts = timestampMs(obj.timestamp);
				const tools = Array.isArray(obj.tools)
					? (obj.tools.filter((t) => typeof t === "string") as string[])
					: undefined;

				chatInteractions.push({
					timestamp: ts,
					sessionId: sId,
					modelName: textOrNull(obj.modelName) ?? undefined,
					modelProvider: textOrNull(obj.modelProvider) ?? undefined,
					tools,
				});

				// Each chat interaction represents a turn with a user prompt
				messages.set(sId, (messages.get(sId) ?? 0) + 1);
			}
		} catch (error) {
			result.warnings.push(
				`Continue: failed to read ${chatPath} (${String(error)})`,
			);
		}
	}

	// Sort chat interactions chronologically
	chatInteractions.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

	// Helper to find closest session for a timestamp
	const findClosestSession = (
		ts: number | null,
	): { sessionId: string; cwd: string | null } => {
		if (item?.sessionId) {
			return {
				sessionId: item.sessionId,
				cwd: sessionMetaMap.get(item.sessionId)?.cwd ?? item.cwd ?? null,
			};
		}

		if (ts !== null && chatInteractions.length > 0) {
			// Find closest chat interaction by absolute timestamp difference
			let bestDiff = Number.POSITIVE_INFINITY;
			let bestSessionId = chatInteractions[0]?.sessionId ?? "cont-sess-default";

			for (const ci of chatInteractions) {
				if (ci.timestamp === null) continue;
				const diff = Math.abs(ci.timestamp - ts);
				if (diff < bestDiff) {
					bestDiff = diff;
					bestSessionId = ci.sessionId;
				}
			}

			// If within 15 minutes, attribute to this session
			if (bestDiff <= 15 * 60 * 1000) {
				const meta = sessionMetaMap.get(bestSessionId);
				return { sessionId: bestSessionId, cwd: meta?.cwd ?? null };
			}
		}

		// Fallback: check session creation times
		if (ts !== null && sessionMetaMap.size > 0) {
			let bestDiff = Number.POSITIVE_INFINITY;
			let bestId = Array.from(sessionMetaMap.keys())[0] ?? "cont-sess-default";

			for (const [sId, meta] of sessionMetaMap.entries()) {
				if (meta.dateCreated === null) continue;
				const diff = Math.abs(meta.dateCreated - ts);
				if (diff < bestDiff) {
					bestDiff = diff;
					bestId = sId;
				}
			}

			if (bestDiff <= 60 * 60 * 1000) {
				const meta = sessionMetaMap.get(bestId);
				return { sessionId: bestId, cwd: meta?.cwd ?? null };
			}
		}

		// Default fallback
		const firstKnown = Array.from(sessionMetaMap.keys())[0];
		if (firstKnown) {
			return {
				sessionId: firstKnown,
				cwd: sessionMetaMap.get(firstKnown)?.cwd ?? null,
			};
		}

		return { sessionId: "cont-tokens", cwd: null };
	};

	// 3. Collect token generation events from SQLite & JSONL (deduplicated)
	const rawTokens: RawTokenEntry[] = [];
	const seenDedupeKeys = new Set<string>();

	// 3a. Read SQLite devdata.sqlite
	for (const dbPath of devDataFiles.sqliteDbs) {
		let db: Database | undefined;
		try {
			db = openReadonlyDatabase(dbPath);
			const tables = tablesIn(db);
			if (tables.has("tokens_generated")) {
				interface DbTokenRow {
					id: number;
					model: string;
					provider: string;
					tokens_generated: number;
					tokens_prompt: number;
					timestamp: string | number;
				}
				const rows = db
					.query<DbTokenRow, []>(
						"SELECT id, model, provider, tokens_generated, tokens_prompt, timestamp FROM tokens_generated ORDER BY id ASC",
					)
					.all();

				for (const row of rows) {
					const ts = timestampMs(row.timestamp);
					const prompt =
						typeof row.tokens_prompt === "number" ? row.tokens_prompt : 0;
					const gen =
						typeof row.tokens_generated === "number" ? row.tokens_generated : 0;
					const dedupeKey = `${ts}:${row.model}:${prompt}:${gen}`;
					if (!seenDedupeKeys.has(dedupeKey)) {
						seenDedupeKeys.add(dedupeKey);
						rawTokens.push({
							timestamp: ts,
							model: row.model,
							provider: row.provider,
							promptTokens: prompt,
							generatedTokens: gen,
							source: dbPath,
						});
					}
				}
			}
		} catch (error) {
			result.warnings.push(
				`Continue: failed to read ${dbPath} (${String(error)})`,
			);
		} finally {
			if (db) {
				try {
					db.close();
				} catch {
					// ignore
				}
			}
		}
	}

	// 3b. Read tokensGenerated.jsonl
	for (const jsonlPath of devDataFiles.tokensJsonl) {
		try {
			const content = readFileSync(jsonlPath, "utf8");
			const rows = parseJsonl(content);
			for (const r of rows) {
				const obj = objectOrEmpty(r);
				const ts = timestampMs(obj.timestamp);
				const model =
					textOrNull(obj.model) ?? textOrNull(obj.modelName) ?? "unknown";
				const provider =
					textOrNull(obj.provider) ?? textOrNull(obj.modelProvider) ?? "";
				const prompt =
					typeof obj.promptTokens === "number"
						? obj.promptTokens
						: typeof obj.tokens_prompt === "number"
							? obj.tokens_prompt
							: 0;
				const gen =
					typeof obj.generatedTokens === "number"
						? obj.generatedTokens
						: typeof obj.tokens_generated === "number"
							? obj.tokens_generated
							: 0;

				const dedupeKey = `${ts}:${model}:${prompt}:${gen}`;
				if (!seenDedupeKeys.has(dedupeKey)) {
					seenDedupeKeys.add(dedupeKey);
					rawTokens.push({
						timestamp: ts,
						model,
						provider,
						promptTokens: prompt,
						generatedTokens: gen,
						source: jsonlPath,
					});
				}
			}
		} catch (error) {
			result.warnings.push(
				`Continue: failed to read ${jsonlPath} (${String(error)})`,
			);
		}
	}

	// 4. Transform raw tokens into UsageRecord[]
	for (let i = 0; i < rawTokens.length; i++) {
		const t = rawTokens[i];
		if (!t) continue;
		const { sessionId, cwd } = findClosestSession(t.timestamp);

		const pricingModel =
			t.provider && t.model ? `${t.provider}/${t.model}` : t.model;

		const rec = usageRecord(
			{
				harness: "continue",
				sessionId,
				messageId: `${sessionId}:tok-${i + 1}`,
				turnId: String(i + 1),
				cwd,
				model: modelName(t.model),
				pricingModel,
				timestamp: t.timestamp,
			},
			{
				input: t.promptTokens,
				output: t.generatedTokens,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				cost: null,
			},
		);

		if (hasTokenUsage(rec)) {
			// If an item filter was specified, only include records matching item
			if (!item || rec.sessionId === item.sessionId) {
				records.push(rec);
			}
		}
	}

	result.records = records;
	result.messages = messages;
	return result;
}
