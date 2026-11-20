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

const AIDER_START_RE =
	/#\s+aider\s+chat\s+started\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/iu;

interface AiderSessionSlice {
	sessionId: string;
	startedAt: number | null;
	lines: string[];
}

function splitAiderHistorySlices(
	content: string,
	directory: string,
): AiderSessionSlice[] {
	const sessionStarts = parseAiderSessionStarts(content);
	const defaultSessId =
		sessionStarts[0]?.sessionId ?? `aider-${path.basename(directory)}`;
	const lines = content.split(/\r?\n/u);
	const slices: AiderSessionSlice[] = [];

	let currentSessionId = defaultSessId;
	let currentTimestamp: number | null = sessionStarts[0]?.timestampMs ?? null;
	let sessionLines: string[] = [];

	for (const line of lines) {
		const match = AIDER_START_RE.exec(line);
		if (match?.[1]) {
			if (sessionLines.length > 0) {
				slices.push({
					sessionId: currentSessionId,
					startedAt: currentTimestamp,
					lines: sessionLines,
				});
				sessionLines = [];
			}
			currentSessionId = `aider-${match[1].replace(/[\s:]/gu, "-")}`;
			const parsed = Date.parse(match[1].replace(" ", "T"));
			currentTimestamp = Number.isNaN(parsed) ? null : parsed;
			continue;
		}
		sessionLines.push(line);
	}

	if (sessionLines.length > 0 || (slices.length === 0 && lines.length > 0)) {
		slices.push({
			sessionId: currentSessionId,
			startedAt: currentTimestamp,
			lines: sessionLines,
		});
	}

	return slices;
}

function buildAiderTranscriptSession(
	sessionId: string,
	directory: string,
	startedAt: number | null,
	sessionLines: string[],
): TranscriptSession {
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
		normalizedCwd(directory),
		startedAt,
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
					timestamp: startedAt,
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
				timestamp: startedAt,
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
					startedAt,
				);
			} else {
				addItem(session, {
					id: `aider-tool-${session.items.length}`,
					turnId: `turn-${turnIndex}`,
					role: "tool",
					kind: "tool_result",
					phase: "intermediate",
					output: toolOutput,
					timestamp: startedAt,
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
}

export function readAiderSingleTranscriptSync(
	paths: PlatformPathService = defaultPlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const locations = getAiderLocations(paths);

	for (const loc of locations) {
		if (!existsSync(loc.historyFile)) continue;
		const content = readFileSync(loc.historyFile, "utf8");
		const slices = splitAiderHistorySlices(content, loc.directory);
		const exact = slices.find((s) => s.sessionId === sessionId);
		if (exact) {
			return buildAiderTranscriptSession(
				exact.sessionId,
				loc.directory,
				exact.startedAt,
				exact.lines,
			);
		}
		const dirFallbackId = `aider-${path.basename(loc.directory)}`;
		if (
			sessionId === dirFallbackId ||
			path.basename(loc.historyFile) === sessionId ||
			path.basename(loc.directory) === sessionId
		) {
			const first = slices[0];
			if (first) {
				return buildAiderTranscriptSession(
					sessionId,
					loc.directory,
					first.startedAt,
					first.lines,
				);
			}
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
			const slices = splitAiderHistorySlices(content, loc.directory);
			for (const slice of slices) {
				sessions.push(
					buildAiderTranscriptSession(
						slice.sessionId,
						loc.directory,
						slice.startedAt,
						slice.lines,
					),
				);
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
