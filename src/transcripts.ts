import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "./platform/paths";
import { readAntigravityTranscripts } from "./transcripts/antigravity";
import { codexSessionFiles, readCodexTranscripts } from "./transcripts/codex";
import { readCommandCodeTranscripts } from "./transcripts/commandcode";
import { readDshTranscripts } from "./transcripts/dsh";
import { readOpenCodeTranscripts } from "./transcripts/opencode";
import {
	cleanUserMessage,
	type ExportDetail,
	isInjectedUserMessage,
	selectItemsForDetail,
	shaSegment,
	type ToolCategory,
	type TranscriptFilters,
	type TranscriptItem,
	type TranscriptKind,
	type TranscriptReadResult,
	type TranscriptRole,
	type TranscriptSession,
} from "./transcripts/shared";
import type { HarnessName } from "./types";
import { localDate, normalizedCwd } from "./util";

export type {
	ExportDetail,
	ToolCategory,
	TranscriptFilters,
	TranscriptItem,
	TranscriptKind,
	TranscriptReadResult,
	TranscriptRole,
	TranscriptSession,
};

export {
	cleanUserMessage,
	codexSessionFiles,
	isInjectedUserMessage,
	selectItemsForDetail,
	shaSegment,
};

export function readTranscriptSources(
	harnesses: readonly HarnessName[],
	targets?: Partial<Record<HarnessName, ReadonlySet<string>>>,
	paths: PlatformPathService = defaultPlatformPathService,
): TranscriptReadResult[] {
	const readers: Partial<
		Record<
			HarnessName,
			(
				files?: ReadonlySet<string>,
				pathService?: PlatformPathService,
			) => TranscriptReadResult
		>
	> = {
		codex: readCodexTranscripts,
		dsh: readDshTranscripts,
		opencode: readOpenCodeTranscripts,
		commandcode: readCommandCodeTranscripts,
		antigravity: readAntigravityTranscripts,
	};
	return harnesses.map((harness) => {
		const reader = readers[harness];
		if (!reader) {
			return {
				harness,
				available: false,
				sessions: [],
				warnings: [
					`Harness ${harness} is not currently supported for transcripts`,
				],
			};
		}
		return reader(targets?.[harness], paths);
	});
}

const MAX_SESSION_SEARCH_CHARS = 200_000;

export function extractHarnessSearchTexts(
	harness: HarnessName,
	paths: PlatformPathService = defaultPlatformPathService,
): Map<string, string> {
	const result = readTranscriptSources([harness], undefined, paths)[0];
	const texts = new Map<string, string>();
	if (!result) return texts;
	for (const session of result.sessions) {
		const parts: string[] = [];
		let total = 0;
		for (const item of session.items) {
			if (
				item.kind !== "message" ||
				(item.role !== "user" && item.role !== "assistant") ||
				!item.text
			)
				continue;
			const cleaned = item.text.replaceAll(/\s+/gu, " ").trim();
			if (!cleaned) continue;
			parts.push(cleaned);
			total += cleaned.length + 1;
			if (total >= MAX_SESSION_SEARCH_CHARS) break;
		}
		if (!parts.length) continue;
		const joined = parts.join("\n").slice(0, MAX_SESSION_SEARCH_CHARS);
		const prev = texts.get(session.sessionId);
		texts.set(
			session.sessionId,
			prev ? `${prev}\n${joined}`.slice(0, MAX_SESSION_SEARCH_CHARS) : joined,
		);
	}
	return texts;
}

export function filterTranscriptSessions(
	sessions: TranscriptSession[],
	filters: TranscriptFilters,
): TranscriptSession[] {
	return sessions.filter((session) => {
		if (!filters.harnesses.has(session.harness)) return false;
		if (filters.projects) {
			const cwd = normalizedCwd(session.cwd);
			if (!cwd || !filters.projects.has(cwd)) return false;
		}
		if (
			filters.date !== undefined &&
			localDate(session.startedAt) !== filters.date
		) {
			return false;
		}
		if (filters.since === undefined && filters.until === undefined) return true;
		const startedAt = session.startedAt;
		if (startedAt === null || !Number.isFinite(startedAt)) return false;
		if (filters.since !== undefined && startedAt < filters.since) return false;
		if (filters.until !== undefined && startedAt >= filters.until) return false;
		return true;
	});
}
