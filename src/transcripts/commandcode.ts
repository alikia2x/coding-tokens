import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	defaultPlatformPathService,
	type PlatformPathService,
} from "../platform/paths";
import {
	getCommandCodeProjectsRoot,
	getCommandCodeSessionFiles,
} from "../providers/commandcode/discovery";
import { normalizedCwd, objectOrEmpty, textOrNull, timestampMs } from "../util";
import {
	addItem,
	addToolCall,
	cleanUserMessage,
	contentBlocks,
	inferFinalMessages,
	newSession,
	readJsonlFile,
	type TranscriptReadResult,
	textFromContent,
	typeOf,
} from "./shared";

export function readCommandCodeTranscripts(
	targetFiles?: ReadonlySet<string>,
	paths: PlatformPathService = defaultPlatformPathService,
): TranscriptReadResult {
	const projectsRoot = getCommandCodeProjectsRoot(paths);
	const result: TranscriptReadResult = {
		harness: "commandcode",
		available: existsSync(projectsRoot),
		sessions: [],
		warnings: [],
	};
	const files = getCommandCodeSessionFiles(paths).filter(
		(filePath) => !targetFiles || targetFiles.has(filePath),
	);
	for (const filePath of files) {
		try {
			const rows = readJsonlFile(filePath).map(objectOrEmpty);
			const header = rows.find((row) => row.type === "session");
			if (!header) continue;
			const sessionId =
				textOrNull(header.id) ?? path.basename(filePath, ".jsonl");
			let metadata: Record<string, unknown> = {};
			try {
				metadata = objectOrEmpty(
					JSON.parse(
						readFileSync(filePath.replace(/\.jsonl$/u, ".meta.json"), "utf8"),
					),
				);
			} catch {
				// Older Command Code sessions may not have a metadata sidecar.
			}
			const sessionInfo = rows.find((row) => row.type === "session_info");
			const session = newSession(
				"commandcode",
				sessionId,
				normalizedCwd(header.cwd) ??
					`Unknown directory (${path.basename(path.dirname(filePath))})`,
				timestampMs(header.timestamp),
				textOrNull(metadata.title) ??
					textOrNull(objectOrEmpty(sessionInfo).name) ??
					textOrNull(header.title) ??
					undefined,
			);
			let turn = 0;
			for (const [index, row] of rows.entries()) {
				if (row.type !== "message") continue;
				const message = objectOrEmpty(row.message);
				const role = textOrNull(message.role);
				const blocks = contentBlocks(message.content);
				const hasToolResult = blocks.some(
					(block) => typeOf(block) === "tool_result",
				);
				const text = textFromContent(message.content);
				if (role === "user" && text && !hasToolResult) turn += 1;
				const turnId = String(turn);
				const timestamp = timestampMs(row.timestamp);
				if (role === "user") {
					for (const block of blocks) {
						if (typeOf(block) !== "tool_result") continue;
						const output = block.content ?? block;
						addItem(session, {
							id: `tool-result-${textOrNull(block.tool_use_id) ?? index}`,
							turnId,
							role: "tool",
							kind: "tool_result",
							phase: "intermediate",
							text: textFromContent(output),
							output,
							toolCallId: textOrNull(block.tool_use_id) ?? undefined,
							status: block.is_error === true ? "error" : "completed",
							timestamp,
						});
					}
					const userText = cleanUserMessage("commandcode", text);
					if (userText && !hasToolResult)
						addItem(session, {
							id: textOrNull(row.id) ?? `user-${index}`,
							turnId,
							role: "user",
							kind: "message",
							phase: "unknown",
							text: userText,
							timestamp,
						});
					continue;
				}
				if (role === "assistant") {
					const toolBlocks = blocks.filter(
						(block) => typeOf(block) === "tool_use",
					);
					const assistantText = textFromContent(blocks);
					if (assistantText)
						addItem(session, {
							id: textOrNull(row.id) ?? `assistant-${index}`,
							usageId: textOrNull(row.id) ?? undefined,
							turnId,
							role: "assistant",
							kind: "message",
							phase: toolBlocks.length > 0 ? "intermediate" : "unknown",
							text: assistantText,
							timestamp,
						});
					for (const block of toolBlocks) {
						const name = textOrNull(block.name) ?? "tool";
						addToolCall(
							session,
							name,
							block.input,
							textOrNull(block.id),
							turnId,
							timestamp,
						);
					}
				}
			}
			inferFinalMessages(session);
			result.sessions.push(session);
		} catch (error) {
			result.warnings.push(
				`Command Code: failed to read ${filePath} (${String(error)})`,
			);
		}
	}
	return result;
}
