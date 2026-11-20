import type { PlatformPathService } from "../../platform/paths";
import {
	addItem,
	inferFinalMessages,
	newSession,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { timestampMs } from "../../util";
import { discoverWindsurfSessions, getWindsurfPbFiles } from "./discovery";
import type { WindsurfChatState } from "./types";
import { parseWindsurfPbFile } from "./usage";

function buildWindsurfTranscriptFromState(
	state: WindsurfChatState,
	sessionId: string,
	cwd: string | null,
): TranscriptSession {
	const firstInteraction = state.interactions[0];
	const startedAt =
		timestampMs(firstInteraction?.timestamp) ?? timestampMs(state.mtimeMs);
	const title =
		firstInteraction?.prompt?.slice(0, 100) || "Windsurf Cascade Session";

	const session = newSession(
		"windsurf",
		sessionId,
		cwd ?? state.cwd ?? null,
		startedAt,
		title,
	);

	for (const [i, turn] of state.interactions.entries()) {
		if (!turn) continue;
		const turnId = `turn-${sessionId}-${i + 1}`;
		const ts = timestampMs(turn.timestamp) ?? startedAt;

		if (turn.prompt) {
			addItem(session, {
				id: `msg-user-${i + 1}`,
				turnId,
				role: "user",
				kind: "message",
				phase: "final",
				text: turn.prompt,
				timestamp: ts,
			});
		}

		if (turn.completion) {
			addItem(session, {
				id: `msg-ai-${i + 1}`,
				turnId,
				role: "assistant",
				kind: "message",
				phase: "final",
				text: turn.completion,
				timestamp: ts,
			});
		}
	}

	inferFinalMessages(session);
	return session;
}

export async function readWindsurfTranscript(
	paths: PlatformPathService,
	sessionId: string,
): Promise<TranscriptSession | null> {
	const sessions = await discoverWindsurfSessions(paths);
	const target = sessions.find((s) => s.sessionId === sessionId);

	let filePath = target?.filePath;
	if (!filePath) {
		const pbFiles = getWindsurfPbFiles(paths);
		for (const file of pbFiles) {
			const state = parseWindsurfPbFile(file);
			if (state?.conversationId === sessionId) {
				filePath = file;
				break;
			}
		}
	}

	if (!filePath) return null;

	const state = parseWindsurfPbFile(filePath);
	if (!state) return null;

	return buildWindsurfTranscriptFromState(
		state,
		sessionId,
		target?.cwd ?? state.cwd ?? null,
	);
}

export async function readWindsurfTranscripts(
	paths: PlatformPathService,
	targetFiles?: ReadonlySet<string>,
): Promise<TranscriptReadResult> {
	const result: TranscriptReadResult = {
		harness: "windsurf",
		available: false,
		sessions: [],
		warnings: [],
	};

	try {
		const sessions = await discoverWindsurfSessions(paths);
		if (sessions.length > 0) result.available = true;

		for (const sess of sessions) {
			if (targetFiles && !targetFiles.has(sess.filePath)) continue;
			const state = parseWindsurfPbFile(sess.filePath, result.warnings);
			if (state) {
				result.sessions.push(
					buildWindsurfTranscriptFromState(
						state,
						sess.sessionId,
						sess.cwd ?? state.cwd ?? null,
					),
				);
			}
		}
	} catch (e) {
		result.warnings.push(`Failed to read Windsurf transcripts: ${e}`);
	}

	return result;
}
