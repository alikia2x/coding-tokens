import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	addItem,
	addToolCall,
	cleanUserMessage,
	inferFinalMessages,
	newSession,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import {
	normalizedCwd,
	objectOrEmpty,
	textOrNull,
	timestampMs,
} from "../../util";
import {
	findOpenHandsConversations,
	type OpenHandsConversation,
} from "./discovery";

function parseOpenHandsConversation(
	conv: OpenHandsConversation,
): TranscriptSession {
	const baseStateRaw = readFileSync(conv.baseStatePath, "utf8");
	const baseState = objectOrEmpty(JSON.parse(baseStateRaw));
	const actualSessionId =
		textOrNull(baseState.conversation_id) ?? conv.conversationId;
	const cwd = normalizedCwd(baseState.workspace_path ?? conv.cwd);
	const startedAt = timestampMs(baseState.created_at) ?? conv.mtimeMs;
	const agentName = textOrNull(baseState.agent_name) ?? "CodeActAgent";

	const session = newSession(
		"openhands",
		actualSessionId,
		cwd,
		startedAt,
		`OpenHands: ${agentName}`,
	);

	if (conv.eventsDir && existsSync(conv.eventsDir)) {
		const eventFiles = readdirSync(conv.eventsDir)
			.filter((name) => name.endsWith(".json"))
			.sort((a, b) => {
				const numA = Number.parseInt(a.replace(/[^0-9]/gu, "") || "0", 10);
				const numB = Number.parseInt(b.replace(/[^0-9]/gu, "") || "0", 10);
				return numA - numB;
			});

		let turnIndex = 0;
		for (const eventFileName of eventFiles) {
			const eventFilePath = path.join(conv.eventsDir, eventFileName);
			const eventRaw = readFileSync(eventFilePath, "utf8");
			const event = objectOrEmpty(JSON.parse(eventRaw));
			const source = textOrNull(event.source) ?? "";
			const eventTime = timestampMs(event.timestamp) ?? startedAt;
			const eventId = String(event.id ?? eventFileName);

			if (source === "user") {
				turnIndex++;
				const userText =
					textOrNull(event.message) ?? textOrNull(event.text) ?? "";
				const cleaned = cleanUserMessage("openhands", userText);
				if (cleaned) {
					addItem(session, {
						id: `oh-user-${eventId}`,
						turnId: `turn-${turnIndex}`,
						role: "user",
						kind: "message",
						phase: "final",
						text: cleaned,
						timestamp: eventTime,
					});
				}
				continue;
			}

			if (source === "agent") {
				const thought = textOrNull(event.thought);
				if (thought) {
					addItem(session, {
						id: `oh-asst-${eventId}`,
						turnId: `turn-${turnIndex}`,
						role: "assistant",
						kind: "message",
						phase: "unknown",
						text: thought,
						timestamp: eventTime,
					});
				}

				const action = textOrNull(event.action);
				if (action) {
					addToolCall(
						session,
						action,
						event.args ?? {},
						`call-${eventId}`,
						`turn-${turnIndex}`,
						eventTime,
					);
				}
				continue;
			}

			if (source === "environment" || event.observation) {
				addItem(session, {
					id: `oh-obs-${eventId}`,
					turnId: `turn-${turnIndex}`,
					role: "tool",
					kind: "tool_result",
					phase: "intermediate",
					output: event.content ?? event.observation ?? event,
					timestamp: eventTime,
				});
			}
		}
	}

	inferFinalMessages(session);
	return session;
}

export function readOpenHandsSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const conversations = findOpenHandsConversations(paths);
	const exactConv = conversations.find((c) => c.conversationId === sessionId);
	if (exactConv) {
		try {
			return parseOpenHandsConversation(exactConv);
		} catch {
			return null;
		}
	}

	for (const conv of conversations) {
		try {
			const parsed = parseOpenHandsConversation(conv);
			if (parsed.sessionId === sessionId) return parsed;
		} catch {
			// skip unreadable conversation
		}
	}

	return null;
}

export function readOpenHandsTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const conversations = findOpenHandsConversations(paths);
	const sessions: TranscriptSession[] = [];
	const warnings: string[] = [];

	for (const conv of conversations) {
		if (targetFiles && !targetFiles.has(conv.baseStatePath)) continue;
		try {
			sessions.push(parseOpenHandsConversation(conv));
		} catch (err) {
			warnings.push(
				`OpenHands: failed to read transcript ${conv.baseStatePath} (${String(err)})`,
			);
		}
	}

	return {
		harness: "openhands",
		available: conversations.length > 0,
		sessions,
		warnings,
	};
}
