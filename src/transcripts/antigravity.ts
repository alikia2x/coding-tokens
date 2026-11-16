import path from "node:path";
import {
	decodeProto,
	existingAntigravityRoots,
	loadSummaries,
	loadT3AntigravityMeta,
	openSafeReadonlyDatabase,
	protoSub,
	protoText,
	readAntigravityBlobMeta,
	readAntigravitySidecarCwd,
	readAntigravityStepTimestamp,
} from "../sources/antigravity";
import { walkFiles } from "../util";
import {
	addItem,
	categoryForTool,
	cleanUserMessage,
	inferFinalMessages,
	newSession,
	type TranscriptReadResult,
} from "./shared";

interface AntigravityToolOutcome {
	output: string | null;
	status: string;
}

function extractAntigravityToolOutcome(
	stepType: number,
	stepStatus: number,
	payload: ReturnType<typeof decodeProto>,
): AntigravityToolOutcome {
	let output: string | null = null;
	if (stepType === 132) {
		const f156 = protoSub(payload.find((f) => f.field === 156));
		const f2 = protoSub(f156.find((f) => f.field === 2));
		output = protoText(f2.find((f) => f.field === 1));
	} else if (stepType === 21) {
		const f28 = protoSub(payload.find((f) => f.field === 28));
		const f21 = protoSub(f28.find((f) => f.field === 21));
		output = protoText(f21.find((f) => f.field === 1));
	} else if (stepType === 38) {
		const f63 = protoSub(payload.find((f) => f.field === 63));
		output = protoText(f63.find((f) => f.field === 3));
	} else if (stepType === 103 || stepType === 17) {
		const f116 = protoSub(payload.find((f) => f.field === 116));
		const f4 = protoSub(f116.find((f) => f.field === 4));
		const inner = protoSub(f4.find((f) => f.field === 2));
		output = protoText(inner.find((f) => f.field === 2));
	}

	if (stepStatus === 7) {
		const f31 = protoSub(payload.find((f) => f.field === 31));
		const err =
			protoText(f31.find((f) => f.field === 2)) ??
			protoText(f31.find((f) => f.field === 3));
		return { output: err ?? output, status: "error" };
	}
	if (stepStatus === 6) {
		const f148 = protoSub(payload.find((f) => f.field === 148));
		const canceledOut = protoText(f148.find((f) => f.field === 3));
		return { output: output ?? canceledOut, status: "cancelled" };
	}
	return { output, status: "completed" };
}

function stepHasAntigravityToolCall(
	step:
		| {
				step_type: number;
				step_payload: Uint8Array | null;
		  }
		| undefined,
): boolean {
	if (!step?.step_payload) return false;
	if (step.step_type === 132) return true;
	if (step.step_type === 14 || step.step_type === 15) return false;
	const payload = decodeProto(step.step_payload);
	const f5 = protoSub(payload.find((f) => f.field === 5));
	const f4 = protoSub(f5.find((f) => f.field === 4));
	return Boolean(protoText(f4.find((f) => f.field === 2)));
}

export function readAntigravityTranscripts(
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const existingRoots = existingAntigravityRoots();
	const result: TranscriptReadResult = {
		harness: "antigravity",
		available: existingRoots.length > 0,
		sessions: [],
		warnings: [],
	};
	if (!result.available) return result;

	const t3Meta = loadT3AntigravityMeta();
	const seen = new Set<string>();
	for (const root of existingRoots) {
		const summaries = loadSummaries(root);
		const convFiles = walkFiles(
			path.join(root, "conversations"),
			(_filePath, name) => name.endsWith(".db"),
		).filter((filePath) => !targetFiles || targetFiles.has(filePath));

		for (const filePath of convFiles) {
			const sessionId = path.basename(filePath, ".db");
			if (seen.has(sessionId)) continue;
			seen.add(sessionId);

			try {
				const { db, cleanup } = openSafeReadonlyDatabase(filePath);
				try {
					const blobMeta = readAntigravityBlobMeta(db, sessionId);
					const isSubagent =
						blobMeta.isSubagent || t3Meta.subagents.has(sessionId);
					if (isSubagent && !targetFiles) continue;

					const cwd =
						summaries.get(sessionId)?.cwd ??
						blobMeta.cwd ??
						readAntigravitySidecarCwd(filePath);
					const title =
						t3Meta.titles.get(sessionId) ??
						summaries.get(sessionId)?.title ??
						(isSubagent
							? `Subagent: ${blobMeta.subagentRole ?? blobMeta.subagentType ?? "unnamed"}`
							: undefined);

					const steps = db
						.query<
							{
								idx: number;
								step_type: number;
								status: number;
								metadata: Uint8Array | null;
								step_payload: Uint8Array | null;
							},
							[]
						>(
							"SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx",
						)
						.all();

					let startedAt = blobMeta.startedAt;
					if (startedAt === null) {
						for (const step of steps) {
							const ts = readAntigravityStepTimestamp(step.metadata);
							if (ts !== null) {
								startedAt = ts;
								break;
							}
						}
					}

					const session = newSession(
						"antigravity",
						sessionId,
						cwd,
						startedAt,
						title,
					);

					let currentTurn = 0;
					for (let i = 0; i < steps.length; i++) {
						const step = steps[i];
						if (!step?.step_payload) continue;
						const timestamp =
							readAntigravityStepTimestamp(step.metadata) ?? startedAt;

						if (step.step_type === 14) {
							currentTurn += 1;
							const turnId = String(currentTurn);
							const payload = decodeProto(step.step_payload);
							const f19 = protoSub(payload.find((f) => f.field === 19));
							const text = cleanUserMessage(
								"antigravity",
								protoText(f19.find((f) => f.field === 2)) ?? "",
							);
							if (text) {
								addItem(session, {
									id: `${sessionId}:user-${step.idx}`,
									turnId,
									role: "user",
									kind: "message",
									phase: "unknown",
									text,
									timestamp,
								});
							}
							continue;
						}

						if (step.step_type === 15) {
							const turnId = String(currentTurn);
							const payload = decodeProto(step.step_payload);
							const f20 = protoSub(payload.find((f) => f.field === 20));
							const text = protoText(f20.find((f) => f.field === 1));
							const thinking = protoText(f20.find((f) => f.field === 3));
							const hasToolCalls =
								f20.some((f) => f.field === 7) ||
								stepHasAntigravityToolCall(steps[i + 1]);

							const f5 = protoSub(payload.find((f) => f.field === 5));
							const f9 = protoSub(f5.find((f) => f.field === 9));
							const requestId = protoText(f9.find((f) => f.field === 11));

							if (thinking) {
								addItem(session, {
									id: `${sessionId}:assistant-${step.idx}-thinking`,
									turnId,
									role: "other",
									kind: "other",
									phase: "intermediate",
									text: `Thinking:\n${thinking}`,
									timestamp,
								});
							}

							if (text) {
								addItem(session, {
									id: `${sessionId}:assistant-${step.idx}`,
									usageId: requestId ?? undefined,
									turnId,
									role: "assistant",
									kind: "message",
									phase: hasToolCalls ? "intermediate" : "unknown",
									text,
									timestamp,
								});
							}
							continue;
						}

						const payload = decodeProto(step.step_payload);
						const f5 = protoSub(payload.find((f) => f.field === 5));
						const f4 = protoSub(f5.find((f) => f.field === 4));
						const rawToolName = protoText(f4.find((f) => f.field === 2));
						if (step.step_type !== 132 && !rawToolName) continue;

						const turnId = String(currentTurn);
						const toolName = rawToolName ?? "tool";
						const callId = protoText(f4.find((f) => f.field === 1));
						const rawInput = protoText(f4.find((f) => f.field === 3));
						let input: unknown = rawInput;
						if (rawInput) {
							try {
								input = JSON.parse(rawInput);
							} catch {}
						}

						const { output, status } = extractAntigravityToolOutcome(
							step.step_type,
							step.status,
							payload,
						);

						addItem(session, {
							id: callId ?? `${sessionId}:tool-${step.idx}`,
							turnId,
							role: "tool",
							kind: "tool_call",
							phase: "intermediate",
							name: toolName,
							input,
							toolCallId: callId ?? undefined,
							category: categoryForTool(toolName),
							status,
							timestamp,
						});

						if (output !== null && output !== undefined) {
							addItem(session, {
								id: `${callId ?? `${sessionId}:tool-${step.idx}`}-result`,
								turnId,
								role: "tool",
								kind: "tool_result",
								phase: "intermediate",
								name: toolName,
								output,
								text: output,
								toolCallId: callId ?? undefined,
								status,
								timestamp,
							});
						}
					}

					inferFinalMessages(session);
					result.sessions.push(session);
				} finally {
					cleanup();
				}
			} catch (error) {
				result.warnings.push(
					`Antigravity: failed to read ${filePath} (${String(error)})`,
				);
			}
		}
	}
	return result;
}
