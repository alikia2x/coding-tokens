import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	addItem,
	addToolCall,
	inferFinalMessages,
	newSession,
} from "../../transcripts/shared";
import type { TranscriptReadResult, TranscriptSession } from "../../types";
import { normalizedCwd } from "../../util";
import { getAiderLocations, parseAiderSessionStarts } from "./discovery";

export function readAiderSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const locations = getAiderLocations(paths);

	for (const loc of locations) {
		if (!existsSync(loc.historyFile)) continue;
		try {
			const content = readFileSync(loc.historyFile, "utf8");
			const sessionStarts = parseAiderSessionStarts(content);
			const defaultSessId =
				sessionStarts[0]?.sessionId ?? `aider-${path.basename(loc.directory)}`;

			if (
				sessionId !== defaultSessId &&
				!sessionStarts.some((s) => s.sessionId === sessionId) &&
				!loc.historyFile.includes(sessionId)
			) {
				continue;
			}

			const lines = content.split(/\r?\n/u);
			let currentSessionId = defaultSessId;
			let currentTimestamp = sessionStarts[0]?.timestampMs ?? Date.now();
			let sessionLines: string[] = [];
			let targetStartedAt = currentTimestamp;

			for (const line of lines) {
				if (
					/#\s+aider\s+chat\s+started\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/iu.test(
						line,
					)
				) {
					const match =
						/([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/iu.exec(
							line,
						);
					if (match?.[1]) {
						if (currentSessionId === sessionId && sessionLines.length > 0) {
							break;
						}
						currentSessionId = `aider-${match[1].replace(/[\s:]/gu, "-")}`;
						const parsed = Date.parse(match[1].replace(" ", "T"));
						currentTimestamp = Number.isNaN(parsed) ? Date.now() : parsed;
						if (currentSessionId === sessionId) {
							targetStartedAt = currentTimestamp;
							sessionLines = [];
							continue;
						}
					}
				}
				if (currentSessionId === sessionId || sessionId === defaultSessId) {
					sessionLines.push(line);
				}
			}

			if (sessionLines.length === 0 && lines.length > 0) {
				sessionLines = lines;
			}

			let title: string | undefined;
			for (const line of sessionLines) {
				if (line.startsWith("#### ")) {
					title = line.slice(5).trim();
					break;
				}
			}

			const session = newSession(
				"aider",
				sessionId,
				normalizedCwd(loc.directory),
				targetStartedAt,
				title,
			);

			let assistantBuffer: string[] = [];
			let turnIndex = 0;

			const flushAssistant = (): void => {
				if (assistantBuffer.length > 0) {
					const text = assistantBuffer.join("\n").trim();
					if (text) {
						addItem(session, {
							id: `aider-asst-${session.items.length}`,
							turnId: `turn-${turnIndex}`,
							role: "assistant",
							kind: "message",
							phase: "unknown",
							text,
							timestamp: targetStartedAt,
						});
					}
					assistantBuffer = [];
				}
			};

			for (let i = 0; i < sessionLines.length; i++) {
				const line = sessionLines[i] ?? "";

				if (line.startsWith("#### ")) {
					flushAssistant();
					turnIndex++;
					const prompt = line.slice(5).trim();
					addItem(session, {
						id: `aider-user-${session.items.length}`,
						turnId: `turn-${turnIndex}`,
						role: "user",
						kind: "message",
						phase: "final",
						text: prompt,
						timestamp: targetStartedAt,
					});
					continue;
				}

				if (line.startsWith("> ")) {
					flushAssistant();
					const toolOutput = line.slice(2).trim();
					if (toolOutput.startsWith("/")) {
						addToolCall(
							session,
							toolOutput.slice(1).split(" ")[0] ?? "command",
							{ command: toolOutput },
							`call-${session.items.length}`,
							`turn-${turnIndex}`,
							targetStartedAt,
						);
					} else {
						addItem(session, {
							id: `aider-tool-${session.items.length}`,
							turnId: `turn-${turnIndex}`,
							role: "tool",
							kind: "tool_result",
							phase: "intermediate",
							output: toolOutput,
							timestamp: targetStartedAt,
						});
					}
					continue;
				}

				if (line.trim().length > 0 && !line.startsWith("#")) {
					assistantBuffer.push(line);
				}
			}

			flushAssistant();
			inferFinalMessages(session);
			return session;
		} catch {
			// skip
		}
	}

	return null;
}

export function readAiderTranscriptsSync(
	paths: PlatformPathService = defaultPlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const locations = getAiderLocations(paths);
	const sessions: TranscriptSession[] = [];
	const warnings: string[] = [];

	for (const loc of locations) {
		if (targetFiles && !targetFiles.has(loc.historyFile)) continue;
		try {
			if (!existsSync(loc.historyFile)) continue;
			const content = readFileSync(loc.historyFile, "utf8");
			const starts = parseAiderSessionStarts(content);
			const sessionIds =
				starts.length > 0
					? starts.map((s) => s.sessionId)
					: [`aider-${path.basename(loc.directory)}`];

			for (const sessId of sessionIds) {
				const s = readAiderSingleTranscriptSync(paths, sessId);
				if (s) sessions.push(s);
			}
		} catch (err) {
			warnings.push(
				`Aider: failed to read transcripts from ${loc.historyFile} (${String(err)})`,
			);
		}
	}

	return {
		harness: "aider",
		available: locations.length > 0,
		sessions,
		warnings,
	};
}
