import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import type { SourceResult } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	numberOrZero,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import { decodeEscapedPath, getWindsurfPbFiles } from "./discovery";
import { decodeProto, protoSub, protoText } from "./proto";
import type { WindsurfChatState, WindsurfInteraction } from "./types";

export function parseWindsurfPbFile(
	filePath: string,
	warnings?: string[],
): WindsurfChatState | null {
	if (!existsSync(filePath)) return null;

	try {
		const stat = statSync(filePath);
		if (stat.size === 0) return null;

		const buf = readFileSync(filePath);
		const fields = decodeProto(buf);

		const fileName = path.basename(filePath);
		const defaultId = fileName.replace(/\.pb$/, "");

		const idField = fields.find((f) => f.field === 1 && f.wire === 2);
		const modelField = fields.find((f) => f.field === 2 && f.wire === 2);

		const conversationId = protoText(idField) || defaultId;
		const model = protoText(modelField) || "claude-3-5-sonnet";
		const cwd = fileName.startsWith("codeium_chat_state_file_")
			? decodeEscapedPath(fileName)
			: null;

		const interactions: WindsurfInteraction[] = [];
		const turnFields = fields.filter((f) => f.field === 3 && f.wire === 2);

		for (const turnField of turnFields) {
			const sub = protoSub(turnField);

			const promptField = sub.find((f) => f.field === 1 && f.wire === 2);
			const completionField = sub.find((f) => f.field === 2 && f.wire === 2);
			const tsField = sub.find((f) => f.field === 3 && f.wire === 0);
			const tokensField = sub.find((f) => f.field === 4 && f.wire === 2);

			const prompt = protoText(promptField) ?? undefined;
			const completion = protoText(completionField) ?? undefined;

			const timestamp =
				tsField?.val !== undefined
					? (timestampMs(tsField.val) ?? undefined)
					: undefined;

			let inTokens = 0;
			let outTokens = 0;
			let cacheRead = 0;
			let cacheWrite = 0;
			let reasoning = 0;

			if (tokensField) {
				const tokSub = protoSub(tokensField);
				for (const tf of tokSub) {
					if (tf.wire === 0 && tf.val !== undefined) {
						if (tf.field === 1) inTokens = tf.val;
						else if (tf.field === 2) outTokens = tf.val;
						else if (tf.field === 3) cacheRead = tf.val;
						else if (tf.field === 4) cacheWrite = tf.val;
						else if (tf.field === 5) reasoning = tf.val;
					}
				}
			}

			interactions.push({
				prompt,
				completion,
				timestamp,
				inputTokens: inTokens,
				outputTokens: outTokens,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite,
				reasoningTokens: reasoning,
			});
		}

		return {
			conversationId,
			model,
			cwd,
			filePath,
			mtimeMs: stat.mtimeMs,
			interactions,
		};
	} catch (error) {
		warnings?.push(`Windsurf: failed to parse ${filePath} (${String(error)})`);
		return null;
	}
}

export async function readWindsurfUsage(
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): Promise<SourceResult> {
	const result = blankSourceResult("windsurf", false);

	const filesToRead = item ? [item.filePath] : getWindsurfPbFiles(paths);

	if (filesToRead.length > 0) {
		result.available = true;
	}

	for (const filePath of filesToRead) {
		const state = parseWindsurfPbFile(filePath, result.warnings);
		if (!state) continue;

		const cwd = item?.cwd ?? state.cwd;
		let userMessageCount = 0;

		for (const [i, turn] of state.interactions.entries()) {
			if (!turn) continue;
			if (turn.prompt) userMessageCount++;

			let inTokens = numberOrZero(turn.inputTokens);
			let outTokens = numberOrZero(turn.outputTokens);
			const cacheRead = numberOrZero(turn.cacheReadTokens);
			const cacheWrite = numberOrZero(turn.cacheWriteTokens);
			const reasoning = numberOrZero(turn.reasoningTokens);

			if (
				inTokens === 0 &&
				outTokens === 0 &&
				cacheRead === 0 &&
				cacheWrite === 0 &&
				reasoning === 0 &&
				(turn.prompt || turn.completion)
			) {
				const promptLen = turn.prompt?.length || 40;
				const replyLen = turn.completion?.length || 40;
				inTokens = Math.max(1, Math.ceil(promptLen / 4));
				outTokens = Math.max(1, Math.ceil(replyLen / 4));
			} else if (outTokens < reasoning) {
				outTokens += reasoning;
			}

			const usageFields = {
				inputTokens: inTokens,
				outputTokens: outTokens,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite,
				reasoningTokens: reasoning,
			};

			if (hasTokenUsage(usageFields)) {
				const rec = usageRecord(
					{
						harness: "windsurf",
						sessionId: state.conversationId,
						messageId: `windsurf-${state.conversationId}-turn-${i + 1}`,
						cwd: cwd ?? null,
						model: modelName(state.model),
						timestamp:
							timestampMs(turn.timestamp) ?? timestampMs(state.mtimeMs),
					},
					{
						input: inTokens,
						output: outTokens,
						cacheRead,
						cacheWrite,
						reasoning,
					},
				);
				result.records.push(rec);
			}
		}

		result.messages.set(state.conversationId, userMessageCount);
	}

	return result;
}
