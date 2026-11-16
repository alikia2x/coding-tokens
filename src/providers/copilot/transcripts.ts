import type { PlatformPathService } from "../../platform/paths";
import {
	addItem,
	addToolCall,
	inferFinalMessages,
	newSession,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { discoverCopilotSessions } from "./discovery";
import { parseCopilotChatJson } from "./usage";

export async function readCopilotTranscript(
	paths: PlatformPathService,
	sessionId: string,
): Promise<TranscriptSession | null> {
	const sessions = await discoverCopilotSessions(paths);
	const target = sessions.find((s) => s.sessionId === sessionId);

	if (!target?.filePath.endsWith(".json")) {
		return null;
	}

	const chatData = parseCopilotChatJson(target.filePath);
	if (!chatData) return null;

	const startedAt = chatData.creationDate ?? target.mtimeMs ?? Date.now();
	const title =
		chatData.title ??
		(typeof chatData.requests?.[0]?.message === "string"
			? chatData.requests[0].message
			: chatData.requests?.[0]?.message?.text?.slice(0, 100) ||
				"Copilot Chat Session");

	const session = newSession(
		"copilot",
		sessionId,
		target.cwd ?? null,
		startedAt,
		title,
	);

	const requests = Array.isArray(chatData.requests) ? chatData.requests : [];

	for (const [i, req] of requests.entries()) {
		if (!req) continue;
		const turnId = `turn-${sessionId}-${i + 1}`;
		const ts = req.timestamp ?? startedAt;

		const userText =
			typeof req.message === "string" ? req.message : (req.message?.text ?? "");
		const aiText =
			typeof req.response === "string"
				? req.response
				: Array.isArray(req.response)
					? req.response
							.map((r: { value?: string } | undefined) => r?.value ?? "")
							.join("\n")
					: (req.response?.value ?? "");

		if (userText) {
			addItem(session, {
				id: `msg-user-${i + 1}`,
				turnId,
				role: "user",
				kind: "message",
				phase: "final",
				text: userText,
				timestamp: ts,
			});
		}

		// Tool calls if present
		const rounds = req.result?.metadata?.toolCallRounds;
		if (Array.isArray(rounds)) {
			for (const [r, round] of rounds.entries()) {
				if (!round) continue;
				const calls = round.toolCalls ?? (round.call ? [round.call] : []);
				for (const [c, call] of calls.entries()) {
					if (!call) continue;
					addToolCall(
						session,
						call.name ?? round.name ?? "copilot_tool",
						call.input ?? round.input,
						call.callId ?? `tool-${i + 1}-${r}-${c}`,
						turnId,
						ts,
						call.status,
					);
				}
			}
		}

		if (aiText) {
			addItem(session, {
				id: `msg-ai-${i + 1}`,
				turnId,
				role: "assistant",
				kind: "message",
				phase: "final",
				text: aiText,
				timestamp: ts,
			});
		}
	}

	inferFinalMessages(session);
	return session;
}

export async function readCopilotTranscripts(
	paths: PlatformPathService,
	targetFiles?: ReadonlySet<string>,
): Promise<TranscriptReadResult> {
	const result: TranscriptReadResult = {
		harness: "copilot",
		available: false,
		sessions: [],
		warnings: [],
	};

	try {
		const sessions = await discoverCopilotSessions(paths);
		if (sessions.length > 0) result.available = true;

		for (const sess of sessions) {
			if (targetFiles && !targetFiles.has(sess.filePath)) continue;
			const transcript = await readCopilotTranscript(paths, sess.sessionId);
			if (transcript) {
				result.sessions.push(transcript);
			}
		}
	} catch (e) {
		result.warnings.push(`Failed to read Copilot transcripts: ${e}`);
	}

	return result;
}
