import type { PlatformPathService } from "../../platform/paths";
import {
	addItem,
	inferFinalMessages,
	newSession,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { discoverWindsurfSessions, getWindsurfPbFiles } from "./discovery";
import { parseWindsurfPbFile } from "./usage";

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

	const firstInteraction = state.interactions[0];
	const startedAt = firstInteraction?.timestamp ?? state.mtimeMs ?? Date.now();
	const title =
		firstInteraction?.prompt?.slice(0, 100) || "Windsurf Cascade Session";

	const session = newSession(
		"windsurf",
		sessionId,
		target?.cwd ?? state.cwd ?? null,
		startedAt,
		title,
	);

	for (const [i, turn] of state.interactions.entries()) {
		if (!turn) continue;
		const turnId = `turn-${sessionId}-${i + 1}`;
		const ts = turn.timestamp ?? startedAt;

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
			const transcript = await readWindsurfTranscript(paths, sess.sessionId);
			if (transcript) {
				result.sessions.push(transcript);
			}
		}
	} catch (e) {
		result.warnings.push(`Failed to read Windsurf transcripts: ${e}`);
	}

	return result;
}
