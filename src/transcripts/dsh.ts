import { existsSync } from "node:fs";
import path from "node:path";
import {
	expandHome,
	homeDir,
	normalizedCwd,
	objectOrEmpty,
	textOrNull,
	timestampMs,
	walkFiles,
} from "../util";
import {
	addItem,
	addToolCall,
	contentBlocks,
	idString,
	newSession,
	readJsonlFile,
	type TranscriptItem,
	type TranscriptReadResult,
	type TranscriptSession,
	textFromContent,
	typeOf,
} from "./shared";

interface DshSessionLog {
	filePath: string;
	generation: number;
}

function dshGeneration(name: string): number {
	const match = name.match(/^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u);
	return match?.[1] ? Number(match[1]) : 0;
}

function dshLogs(root: string): DshSessionLog[] {
	const candidates = walkFiles(path.join(root, "sessions"), (_filePath, name) =>
		/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(name),
	);
	const byDirectory = new Map<string, DshSessionLog>();
	for (const filePath of candidates) {
		const candidate = {
			filePath,
			generation: dshGeneration(path.basename(filePath)),
		};
		const directory = path.dirname(filePath);
		const current = byDirectory.get(directory);
		if (
			!current ||
			candidate.generation > current.generation ||
			(candidate.generation === current.generation &&
				filePath.endsWith(".zstd"))
		) {
			byDirectory.set(directory, candidate);
		}
	}
	return [...byDirectory.values()];
}

function dshEventId(
	event: Record<string, unknown>,
	data: Record<string, unknown>,
	type: string,
): string {
	return (
		textOrNull(event.id) ??
		`${String(data.turn ?? "?")}:${String(data.step ?? "?")}:${type}:${String(event.seq ?? "?")}`
	);
}

function dshToolIsError(
	message: Record<string, unknown>,
	eventError: unknown,
): boolean {
	if (message.isError === true) return true;
	if (eventError !== undefined && eventError !== null) return true;
	return contentBlocks(message.content).some(
		(block) =>
			(typeOf(block) === "tool-result" || typeOf(block) === "tool_result") &&
			block.isError === true,
	);
}

function unwrapDshToolOutput(
	message: Record<string, unknown>,
	eventError: unknown,
): unknown {
	const blocks = contentBlocks(message.content);
	if (blocks.length === 1 && typeOf(blocks[0]) === "tool-result") {
		return blocks[0]?.content ?? message.content;
	}
	if (message.content !== undefined) return message.content;
	const errObj = objectOrEmpty(eventError);
	return (
		textOrNull(errObj.reason) ??
		textOrNull(errObj.name) ??
		(typeof eventError === "string" ? eventError : message)
	);
}

function markCompletedTurnFinal(
	session: TranscriptSession,
	turnId: string,
): void {
	let lastToolOrder = -1;
	for (const item of session.items) {
		if (item.turnId === turnId && item.kind === "tool_call")
			lastToolOrder = Math.max(lastToolOrder, item.order);
	}
	let final: TranscriptItem | undefined;
	for (const item of session.items) {
		if (
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message" &&
			item.order > lastToolOrder
		) {
			final = item;
		}
	}
	if (!final) return;
	for (const item of session.items) {
		if (
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message"
		) {
			item.phase = item === final ? "final" : "intermediate";
		}
	}
}

export function readDshTranscripts(
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const roots = process.env.DSH_HOME
		? [path.resolve(expandHome(process.env.DSH_HOME))]
		: [
				path.join(homeDir, ".dsh"),
				path.join(homeDir, "Library/Application Support/dsh-desktop/harness"),
			];
	const existing = roots.filter((root) =>
		existsSync(path.join(root, "sessions")),
	);
	const result: TranscriptReadResult = {
		harness: "dsh",
		available: existing.length > 0,
		sessions: [],
		warnings: [],
	};
	const seen = new Set<string>();
	for (const root of existing) {
		for (const { filePath } of dshLogs(root).filter(
			(log) => !targetFiles || targetFiles.has(log.filePath),
		)) {
			try {
				const events = readJsonlFile(filePath).map(objectOrEmpty);
				const header = events.find((event) => event.type === "session") ?? {};
				const sessionId =
					textOrNull(header.id) ?? path.basename(path.dirname(filePath));
				const origin = (textOrNull(header.origin) ?? "").toLowerCase();
				const isSubagent =
					origin === "subagent" ||
					textOrNull(header.parentSession) !== null ||
					(Number(header.delegationDepth) || 0) > 0;
				if (isSubagent && !targetFiles) continue;
				if (seen.has(sessionId)) continue;
				seen.add(sessionId);
				const session = newSession(
					"dsh",
					sessionId,
					normalizedCwd(header.cwd),
					timestampMs(header.createdAt),
					textOrNull(header.title) ?? undefined,
				);
				let fallbackTurn = 0;
				for (const event of events) {
					const type = textOrNull(event.type) ?? "";
					const data = objectOrEmpty(event.data);
					const time = timestampMs(event.time);
					if (type === "session/title") {
						session.title = textOrNull(data.title) ?? session.title;
						continue;
					}
					if (type === "user/message") {
						fallbackTurn += 1;
						const text = textFromContent(data.content);
						if (!text) continue;
						const cleaned = text.trim();
						if (
							/^\s*Current runtime context\. This snapshot supersedes earlier runtime-context snapshots\./iu.test(
								cleaned,
							)
						)
							continue;
						addItem(session, {
							id: textOrNull(data.id) ?? `user-${session.items.length}`,
							turnId: idString(data.turn) ?? String(fallbackTurn),
							role: "user",
							kind: "message",
							phase: "unknown",
							text: cleaned,
							timestamp: time,
						});
						continue;
					}
					if (type === "assistant/message") {
						const message = objectOrEmpty(data.message);
						const turnId = idString(data.turn) ?? String(fallbackTurn);
						const blocks = contentBlocks(message.content);
						const hasToolCall = blocks.some(
							(block) => typeOf(block) === "tool-call",
						);
						const text = textFromContent(message.content);
						if (text)
							addItem(session, {
								id:
									textOrNull(message.id) ?? `assistant-${session.items.length}`,
								usageId: dshEventId(event, data, type),
								turnId,
								role: "assistant",
								kind: "message",
								phase: hasToolCall ? "intermediate" : "unknown",
								text,
								timestamp: time,
							});
						continue;
					}
					if (type === "system/message" || type === "developer/message") {
						const role = type.startsWith("developer") ? "developer" : "system";
						const message = objectOrEmpty(data.message);
						const text = textFromContent(
							data.content ?? message.content ?? data.message,
						);
						if (text)
							addItem(session, {
								id: textOrNull(data.id) ?? `${role}-${session.items.length}`,
								turnId: idString(data.turn) ?? String(fallbackTurn),
								role,
								kind: "other",
								phase: "unknown",
								text,
								timestamp: time,
							});
						continue;
					}
					if (type === "tool/call") {
						const name = textOrNull(data.name) ?? "tool";
						addToolCall(
							session,
							name,
							data.arguments,
							idString(data.callId),
							idString(data.turn) ?? String(fallbackTurn),
							time,
						);
						continue;
					}
					if (type === "tool/result") {
						const message = objectOrEmpty(data.message);
						const output = unwrapDshToolOutput(message, data.error);
						const text = textFromContent(output);
						addItem(session, {
							id: `tool-result-${session.items.length}`,
							turnId: idString(data.turn) ?? String(fallbackTurn),
							role: "tool",
							kind: "tool_result",
							phase: "intermediate",
							text,
							output: text || output,
							toolCallId: idString(data.callId) ?? undefined,
							status: dshToolIsError(message, data.error)
								? "error"
								: "completed",
							timestamp: time,
						});
						continue;
					}
					if (type === "turn/end") {
						const reason = objectOrEmpty(data.reason);
						if (reason.kind === "completed")
							markCompletedTurnFinal(
								session,
								idString(data.turn) ?? String(fallbackTurn),
							);
						continue;
					}
					if (
						type === "todo/write" ||
						type === "workspace/changes" ||
						type === "deliverables/presented"
					) {
						addItem(session, {
							id: `${type}-${session.items.length}`,
							turnId: idString(data.turn) ?? String(fallbackTurn),
							role: "other",
							kind: "other",
							phase: "unknown",
							text: JSON.stringify(data, null, 2),
							timestamp: time,
						});
					}
				}
				result.sessions.push(session);
			} catch (error) {
				result.warnings.push(
					`DSH: failed to read ${filePath} (${String(error)})`,
				);
			}
		}
	}
	return result;
}
