import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	addItem,
	addToolCall,
	cleanUserMessage,
	inferFinalMessages,
	newSession,
	textFromContent,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import {
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
} from "../../util";
import { decodeClaudeProjectPath, getClaudeSessionFiles } from "./discovery";

function appendClaudeToolResultBlock(
	session: TranscriptSession,
	block: Record<string, unknown>,
	id: string,
	turnId: string,
	timestamp: number | null,
): void {
	const callId = textOrNull(block.tool_use_id) ?? textOrNull(block.id);
	const output = block.content ?? block.text ?? block.output;
	addItem(session, {
		id,
		turnId,
		role: "tool",
		kind: "tool_result",
		phase: "intermediate",
		output,
		toolCallId: callId ?? undefined,
		status: block.is_error === true ? "error" : "completed",
		timestamp,
	});
}

function parseClaudeTranscriptFile(
	targetFile: string,
	requestedSessionId?: string,
	warnings?: string[],
): TranscriptSession | null {
	try {
		const content = readFileSync(targetFile, "utf8");
		const rows = parseJsonl(content);
		if (rows.length === 0) return null;

		const defaultSessionId = path.basename(targetFile, ".jsonl");
		let sessionCwd: string | null = null;
		let startedAt: number | null = null;
		let title: string | undefined;
		let embeddedSessionId: string | null = null;

		for (const raw of rows) {
			const row = objectOrEmpty(raw);
			if (!embeddedSessionId && row.sessionId) {
				embeddedSessionId = textOrNull(row.sessionId);
			}
			if (row.cwd && !sessionCwd) {
				sessionCwd = normalizedCwd(row.cwd);
			}
			if (row.timestamp && startedAt === null) {
				startedAt = timestampMs(row.timestamp);
			}
			if (row.type === "user" && !title) {
				const msg = objectOrEmpty(row.message);
				const text = textFromContent(msg.content ?? msg.text ?? row.text);
				if (text) {
					title = text.slice(0, 100);
				}
			}
		}

		if (!sessionCwd) {
			const dirName = path.basename(path.dirname(targetFile));
			sessionCwd = decodeClaudeProjectPath(dirName);
		}

		const sessionId =
			requestedSessionId ?? embeddedSessionId ?? defaultSessionId;
		const session = newSession(
			"claude",
			sessionId,
			sessionCwd,
			startedAt,
			title,
		);

		for (let i = 0; i < rows.length; i++) {
			const row = objectOrEmpty(rows[i]);
			const rowType = textOrNull(row.type) ?? "";
			const turnId =
				textOrNull(row.parentUuid) ??
				textOrNull(row.uuid) ??
				`turn-${Math.floor(i / 2)}`;
			const timestamp = timestampMs(row.timestamp);

			if (rowType === "user") {
				const message = objectOrEmpty(row.message);
				const msgContent = message.content;
				const nonToolBlocks: unknown[] = [];
				let hasToolResult = false;
				if (Array.isArray(msgContent)) {
					for (let blockIdx = 0; blockIdx < msgContent.length; blockIdx++) {
						const block = objectOrEmpty(msgContent[blockIdx]);
						const blockType = textOrNull(block.type) ?? "";
						if (blockType === "tool_result" || blockType === "tool-result") {
							hasToolResult = true;
							appendClaudeToolResultBlock(
								session,
								block,
								`result-${i}-${blockIdx}`,
								turnId,
								timestamp,
							);
						} else {
							nonToolBlocks.push(msgContent[blockIdx]);
						}
					}
				}
				const rawText = hasToolResult
					? textFromContent(nonToolBlocks)
					: textFromContent(msgContent ?? message.text ?? row.text);
				const cleaned = cleanUserMessage("claude", rawText);
				if (cleaned) {
					addItem(session, {
						id: textOrNull(row.uuid) ?? `user-${i}`,
						turnId,
						role: "user",
						kind: "message",
						phase: "final",
						text: cleaned,
						timestamp,
					});
				}
				continue;
			}

			if (rowType === "assistant") {
				const message = objectOrEmpty(row.message);
				const msgContent = message.content;

				if (Array.isArray(msgContent)) {
					for (let blockIdx = 0; blockIdx < msgContent.length; blockIdx++) {
						const block = objectOrEmpty(msgContent[blockIdx]);
						const blockType = textOrNull(block.type) ?? "";

						if (blockType === "text" && typeof block.text === "string") {
							const text = block.text.trim();
							if (text) {
								addItem(session, {
									id: textOrNull(row.uuid) ?? `asst-${i}-${blockIdx}`,
									turnId,
									role: "assistant",
									kind: "message",
									phase: "unknown",
									text,
									timestamp,
								});
							}
						} else if (
							blockType === "thinking" &&
							typeof block.thinking === "string"
						) {
							const thinkingText = block.thinking.trim();
							if (thinkingText) {
								addItem(session, {
									id: `${textOrNull(row.uuid) ?? `asst-${i}`}-thinking-${blockIdx}`,
									turnId,
									role: "other",
									kind: "other",
									phase: "intermediate",
									text: thinkingText,
									timestamp,
								});
							}
						} else if (blockType === "tool_use") {
							const name = textOrNull(block.name) ?? "tool";
							const callId = textOrNull(block.id);
							addToolCall(
								session,
								name,
								block.input,
								callId,
								turnId,
								timestamp,
							);
						} else if (
							blockType === "tool_result" ||
							blockType === "tool-result"
						) {
							appendClaudeToolResultBlock(
								session,
								block,
								`result-${i}-${blockIdx}`,
								turnId,
								timestamp,
							);
						}
					}
				} else if (typeof message.content === "string") {
					addItem(session, {
						id: textOrNull(row.uuid) ?? `asst-${i}`,
						turnId,
						role: "assistant",
						kind: "message",
						phase: "unknown",
						text: message.content,
						timestamp,
					});
				}
				continue;
			}

			if (rowType === "attachment") {
				const attachment = objectOrEmpty(row.attachment);
				const toolUseID = textOrNull(attachment.toolUseID);
				if (toolUseID) {
					addItem(session, {
						id: textOrNull(row.uuid) ?? `attach-${i}`,
						turnId,
						role: "tool",
						kind: "tool_result",
						phase: "intermediate",
						output:
							attachment.stdout ??
							attachment.stderr ??
							attachment.content ??
							attachment,
						toolCallId: toolUseID,
						status: attachment.exitCode === 0 ? "success" : "error",
						timestamp,
					});
				}
			}
		}

		inferFinalMessages(session);
		return session;
	} catch (error) {
		warnings?.push(`Claude: failed to read ${targetFile} (${String(error)})`);
		return null;
	}
}

export function readClaudeSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const { allFiles } = getClaudeSessionFiles(paths);
	const exactFile = allFiles.find(
		(f) => path.basename(f, ".jsonl") === sessionId,
	);
	if (exactFile) {
		return parseClaudeTranscriptFile(exactFile, sessionId);
	}

	// Fallback: match embedded row.sessionId inside files when filename differs
	for (const filePath of allFiles) {
		try {
			const rows = parseJsonl(readFileSync(filePath, "utf8"));
			const hasSession = rows.some(
				(raw) => textOrNull(objectOrEmpty(raw).sessionId) === sessionId,
			);
			if (hasSession) {
				return parseClaudeTranscriptFile(filePath, sessionId);
			}
		} catch {
			// Skip unreadable candidate while searching for matching sessionId.
		}
	}
	return null;
}

export function readClaudeTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const { allFiles } = getClaudeSessionFiles(paths);
	const sessions: TranscriptSession[] = [];
	const warnings: string[] = [];

	for (const filePath of allFiles) {
		if (targetFiles && !targetFiles.has(filePath)) continue;
		const sessionId = path.basename(filePath, ".jsonl");
		const session = parseClaudeTranscriptFile(filePath, sessionId, warnings);
		if (session) {
			sessions.push(session);
		}
	}

	return {
		harness: "claude",
		available: allFiles.length > 0,
		sessions,
		warnings,
	};
}
