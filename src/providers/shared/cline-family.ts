import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import {
	addItem,
	addToolCall,
	cleanUserMessage,
	contentBlocks,
	inferFinalMessages,
	isReasoningType,
	newSession,
	textFromContent,
} from "../../transcripts/shared";
import type {
	SourceResult,
	TranscriptReadResult,
	TranscriptSession,
	UsageRecord,
} from "../../types";
import {
	blankSourceResult,
	finiteCostOrNull,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	numberOrZero,
	objectOrEmpty,
	textOrNull,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";

export interface ClineFamilyConfig {
	harness: "cline" | "roo";
	label: string;
	includeMode: boolean;
	includeKiloNeighbors: boolean;
	fallbackHomeDirs: string[];
}

export const CLINE_FAMILY_CONFIG: ClineFamilyConfig = {
	harness: "cline",
	label: "Cline",
	includeMode: false,
	includeKiloNeighbors: false,
	fallbackHomeDirs: [".cline"],
};

export const ROO_FAMILY_CONFIG: ClineFamilyConfig = {
	harness: "roo",
	label: "Roo Code",
	includeMode: true,
	includeKiloNeighbors: true,
	fallbackHomeDirs: [".roo", ".kilo"],
};

export interface ClineFamilyTaskHistoryItem {
	id: string;
	ulid?: string;
	ts?: number;
	task?: string;
	tokensIn?: number;
	tokensOut?: number;
	cacheWrites?: number;
	cacheReads?: number;
	totalCost?: number;
	cwdOnTaskInitialization?: string;
	modelId?: string;
	mode?: string;
}

interface ParsedHistorySummary {
	id: string;
	ts: number | null;
	cwd: string | null;
	modelId: string;
	mode?: string;
	tokensIn: number;
	tokensOut: number;
	cacheWrites: number;
	cacheReads: number;
	totalCost: number | null;
	title?: string;
}

function safeJsonParse(raw: string): unknown {
	return JSON.parse(raw) as unknown;
}

export function getClineFamilyRoots(
	config: ClineFamilyConfig,
	paths: PlatformPathService,
): string[] {
	const resolved = paths.resolveHarnessPaths(config.harness);
	const candidates = [...resolved];

	if (config.includeKiloNeighbors) {
		for (const r of resolved) {
			const parent = path.dirname(r);
			candidates.push(path.join(parent, "kilo-code.kilo-code"));
			candidates.push(path.join(parent, "rooveterinaryinc.kilo-code"));
		}
	}

	if (candidates.length === 0) {
		const home = paths.getHomeDir();
		for (const sub of config.fallbackHomeDirs) {
			candidates.push(path.join(home, sub, "data"), path.join(home, sub));
		}
	}

	const uniqueDirs = new Set<string>();
	for (const candidate of candidates) {
		const normalized = paths.normalize(candidate);
		if (existsSync(normalized)) {
			uniqueDirs.add(normalized);
			const subData = path.join(normalized, "data");
			if (existsSync(subData)) {
				uniqueDirs.add(paths.normalize(subData));
			}
		}
	}

	return Array.from(uniqueDirs);
}

export function findClineFamilyTaskHistoryFiles(roots: string[]): string[] {
	const files: string[] = [];
	for (const root of roots) {
		const possible = [
			path.join(root, "taskHistory.json"),
			path.join(root, "state", "taskHistory.json"),
		];
		for (const p of possible) {
			if (existsSync(p)) {
				files.push(p);
			}
		}
	}
	return Array.from(new Set(files));
}

export function findClineFamilyTasksDirs(roots: string[]): string[] {
	const dirs: string[] = [];
	for (const root of roots) {
		const directTasks = path.join(root, "tasks");
		if (existsSync(directTasks)) {
			dirs.push(directTasks);
		}
	}
	return Array.from(new Set(dirs));
}

export function getClineFamilySessionFiles(
	config: ClineFamilyConfig,
	paths: PlatformPathService,
): string[] {
	const roots = getClineFamilyRoots(config, paths);
	const files = new Set<string>();

	for (const historyPath of findClineFamilyTaskHistoryFiles(roots)) {
		files.add(historyPath);
	}

	for (const tasksDir of findClineFamilyTasksDirs(roots)) {
		try {
			const entries = readdirSync(tasksDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const taskFolder = path.join(tasksDir, entry.name);
				for (const jsonName of [
					"ui_messages.json",
					"api_conversation_history.json",
					"task_metadata.json",
				]) {
					const jsonPath = path.join(taskFolder, jsonName);
					if (existsSync(jsonPath)) {
						files.add(jsonPath);
					}
				}
			}
		} catch {
			// Skip unreadable task directories during file listing.
		}
	}

	return Array.from(files);
}

export async function discoverClineFamilySessions(
	config: ClineFamilyConfig,
	paths: PlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	const roots = getClineFamilyRoots(config, paths);
	const itemsMap = new Map<string, SessionDiscoveryItem>();
	const historyMetadataMap = new Map<string, ClineFamilyTaskHistoryItem>();

	for (const historyFile of findClineFamilyTaskHistoryFiles(roots)) {
		try {
			const stat = statSync(historyFile);
			const parsed = safeJsonParse(readFileSync(historyFile, "utf8"));
			if (!Array.isArray(parsed)) continue;
			for (const raw of parsed) {
				const entry = objectOrEmpty(raw);
				const id = textOrNull(entry.id);
				if (!id) continue;
				const item: ClineFamilyTaskHistoryItem = {
					id,
					ulid: textOrNull(entry.ulid) ?? undefined,
					ts: timestampMs(entry.ts) ?? undefined,
					task: textOrNull(entry.task) ?? undefined,
					tokensIn: numberOrZero(entry.tokensIn),
					tokensOut: numberOrZero(entry.tokensOut),
					cacheWrites: numberOrZero(entry.cacheWrites),
					cacheReads: numberOrZero(entry.cacheReads),
					totalCost: finiteCostOrNull(entry.totalCost) ?? undefined,
					cwdOnTaskInitialization:
						normalizedCwd(entry.cwdOnTaskInitialization) ?? undefined,
					modelId: textOrNull(entry.modelId) ?? undefined,
					...(config.includeMode
						? { mode: textOrNull(entry.mode) ?? undefined }
						: {}),
				};
				historyMetadataMap.set(id, item);

				itemsMap.set(id, {
					sessionId: id,
					harness: config.harness,
					filePath: historyFile,
					mtimeMs: item.ts ?? stat.mtimeMs,
					sizeBytes: stat.size,
					cwd: item.cwdOnTaskInitialization ?? null,
				});
			}
		} catch {
			// Skip malformed or unreadable taskHistory.json during discovery.
		}
	}

	for (const tasksDir of findClineFamilyTasksDirs(roots)) {
		try {
			const entries = readdirSync(tasksDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const taskId = entry.name;
				const taskFolder = path.join(tasksDir, taskId);
				const uiMessagesPath = path.join(taskFolder, "ui_messages.json");
				const metaPath = path.join(taskFolder, "task_metadata.json");

				let primaryFile = taskFolder;
				let mtimeMs = 0;
				let sizeBytes = 0;

				if (existsSync(uiMessagesPath)) {
					primaryFile = uiMessagesPath;
					try {
						const stat = statSync(uiMessagesPath);
						mtimeMs = stat.mtimeMs;
						sizeBytes = stat.size;
					} catch {
						// Use fallback stat values if file disappeared mid-scan.
					}
				} else {
					try {
						const stat = statSync(taskFolder);
						mtimeMs = stat.mtimeMs;
						sizeBytes = stat.size;
					} catch {
						// Use fallback stat values if folder disappeared mid-scan.
					}
				}

				let cwd: string | null =
					historyMetadataMap.get(taskId)?.cwdOnTaskInitialization ?? null;

				if (!cwd && existsSync(metaPath)) {
					try {
						const metaContent = objectOrEmpty(
							safeJsonParse(readFileSync(metaPath, "utf8")),
						);
						cwd = normalizedCwd(metaContent.cwd) ?? null;
					} catch {
						// Ignore malformed task_metadata.json during discovery.
					}
				}

				itemsMap.set(taskId, {
					sessionId: taskId,
					harness: config.harness,
					filePath: primaryFile,
					mtimeMs,
					sizeBytes,
					cwd,
				});
			}
		} catch {
			// Skip unreadable tasks directory during discovery.
		}
	}

	return Array.from(itemsMap.values());
}

function readTaskHistorySummaryMap(
	config: ClineFamilyConfig,
	historyFiles: string[],
	warnings: string[],
): Map<string, ParsedHistorySummary> {
	const summaryMap = new Map<string, ParsedHistorySummary>();
	for (const historyFile of historyFiles) {
		try {
			const parsed = safeJsonParse(readFileSync(historyFile, "utf8"));
			if (!Array.isArray(parsed)) continue;
			for (const raw of parsed) {
				const entry = objectOrEmpty(raw);
				const id = textOrNull(entry.id);
				if (!id) continue;
				summaryMap.set(id, {
					id,
					ts: timestampMs(entry.ts),
					cwd: normalizedCwd(entry.cwdOnTaskInitialization),
					modelId: modelName(entry.modelId),
					mode: config.includeMode
						? (textOrNull(entry.mode) ?? undefined)
						: undefined,
					tokensIn: numberOrZero(entry.tokensIn),
					tokensOut: numberOrZero(entry.tokensOut),
					cacheWrites: numberOrZero(entry.cacheWrites),
					cacheReads: numberOrZero(entry.cacheReads),
					totalCost: finiteCostOrNull(entry.totalCost),
					title: textOrNull(entry.task) ?? undefined,
				});
			}
		} catch (error) {
			warnings.push(
				`${config.label}: failed to parse ${historyFile} (${String(error)})`,
			);
		}
	}
	return summaryMap;
}

export function readClineFamilyUsageSync(
	config: ClineFamilyConfig,
	paths: PlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const roots = getClineFamilyRoots(config, paths);
	const historyFiles = findClineFamilyTaskHistoryFiles(roots);
	const tasksDirs = findClineFamilyTasksDirs(roots);

	const available = historyFiles.length > 0 || tasksDirs.length > 0;
	const result = blankSourceResult(config.harness, available);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	const historySummaryMap = readTaskHistorySummaryMap(
		config,
		historyFiles,
		result.warnings,
	);
	const processedTaskIds = new Set<string>();

	const processTaskDirectory = (
		taskId: string,
		taskDir: string,
		uiMessagesPath: string,
	): void => {
		processedTaskIds.add(taskId);
		const summary = historySummaryMap.get(taskId);
		let taskCwd = summary?.cwd ?? null;
		let taskMode = summary?.mode;
		const metaPath = path.join(taskDir, "task_metadata.json");

		if (
			existsSync(metaPath) &&
			(!taskCwd || (config.includeMode && !taskMode))
		) {
			try {
				const meta = objectOrEmpty(
					safeJsonParse(readFileSync(metaPath, "utf8")),
				);
				taskCwd = taskCwd ?? normalizedCwd(meta.cwd);
				if (config.includeMode) {
					taskMode = taskMode ?? textOrNull(meta.mode) ?? undefined;
				}
			} catch (error) {
				result.warnings.push(
					`${config.label}: failed to parse ${metaPath} (${String(error)})`,
				);
			}
		}

		let taskUserMessages = 0;
		let granularFound = false;

		if (existsSync(uiMessagesPath)) {
			try {
				const uiMsgs = safeJsonParse(readFileSync(uiMessagesPath, "utf8"));
				if (Array.isArray(uiMsgs)) {
					let reqIndex = 0;
					let isFirstText = true;

					for (let i = 0; i < uiMsgs.length; i++) {
						const m = objectOrEmpty(uiMsgs[i]);
						const ts = timestampMs(m.ts) ?? summary?.ts ?? null;
						const msgMode = config.includeMode
							? (textOrNull(m.mode) ?? taskMode)
							: undefined;

						const isUserMsg =
							m.say === "user_feedback" ||
							m.say === "user_feedback_diff" ||
							m.conversationHistoryIndex === -1 ||
							(isFirstText && m.say === "text");

						if (isUserMsg) {
							taskUserMessages += 1;
							isFirstText = false;
						}

						if (m.say === "api_req_started") {
							isFirstText = false;
							reqIndex += 1;
							let details: Record<string, unknown> = {};
							if (typeof m.text === "string" && m.text.trim()) {
								try {
									details = objectOrEmpty(safeJsonParse(m.text));
								} catch {
									// Streaming or non-JSON api_req_started text is ignored for token metrics.
								}
							}

							const modelInfo = objectOrEmpty(m.modelInfo);
							const modelId =
								textOrNull(modelInfo.modelId) ?? summary?.modelId ?? "unknown";
							const providerId = textOrNull(modelInfo.providerId);
							const pricingModel =
								providerId && modelId ? `${providerId}/${modelId}` : undefined;

							const inTokens = numberOrZero(details.tokensIn);
							const outTokens = numberOrZero(details.tokensOut);
							const cReads = numberOrZero(details.cacheReads);
							const cWrites = numberOrZero(details.cacheWrites);
							const cost = finiteCostOrNull(details.cost);
							const turnId = msgMode
								? `${reqIndex}:${msgMode}`
								: String(reqIndex);

							const rec = usageRecord(
								{
									harness: config.harness,
									sessionId: taskId,
									messageId: `${taskId}:req-${reqIndex}`,
									turnId,
									cwd: taskCwd,
									model: modelName(modelId),
									pricingModel,
									timestamp: ts,
								},
								{
									input: inTokens,
									output: outTokens,
									cacheRead: cReads,
									cacheWrite: cWrites,
									cost,
								},
							);

							if (hasTokenUsage(rec)) {
								records.push(rec);
								granularFound = true;
							}
						}
					}
				}
			} catch (error) {
				result.warnings.push(
					`${config.label}: failed to parse ${uiMessagesPath} (${String(error)})`,
				);
			}
		}

		if (taskUserMessages > 0) {
			messages.set(taskId, taskUserMessages);
		}

		if (!granularFound && summary) {
			const turnId = summary.mode ? `1:${summary.mode}` : "1";
			const fallbackRec = usageRecord(
				{
					harness: config.harness,
					sessionId: taskId,
					messageId: `${taskId}:summary`,
					turnId,
					cwd: taskCwd ?? summary.cwd,
					model: summary.modelId,
					timestamp: summary.ts,
				},
				{
					input: summary.tokensIn,
					output: summary.tokensOut,
					cacheRead: summary.cacheReads,
					cacheWrite: summary.cacheWrites,
					cost: summary.totalCost,
				},
			);
			if (hasTokenUsage(fallbackRec)) {
				records.push(fallbackRec);
			}
			if (!messages.has(taskId)) {
				messages.set(taskId, 1);
			}
		}
	};

	if (item) {
		const taskId = item.sessionId;
		let uiPath = item.filePath;
		let taskDir = path.dirname(uiPath);
		if (uiPath.endsWith("taskHistory.json")) {
			for (const td of tasksDirs) {
				const candidateDir = path.join(td, taskId);
				if (existsSync(candidateDir)) {
					taskDir = candidateDir;
					uiPath = path.join(candidateDir, "ui_messages.json");
					break;
				}
			}
		}
		processTaskDirectory(taskId, taskDir, uiPath);
	} else {
		for (const td of tasksDirs) {
			try {
				const entries = readdirSync(td, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const taskId = entry.name;
					const taskDir = path.join(td, taskId);
					const uiMessagesPath = path.join(taskDir, "ui_messages.json");
					processTaskDirectory(taskId, taskDir, uiMessagesPath);
				}
			} catch (error) {
				result.warnings.push(
					`${config.label}: failed to scan ${td} (${String(error)})`,
				);
			}
		}

		for (const [taskId, summary] of historySummaryMap.entries()) {
			if (processedTaskIds.has(taskId)) continue;
			const turnId = summary.mode ? `1:${summary.mode}` : "1";
			const rec = usageRecord(
				{
					harness: config.harness,
					sessionId: taskId,
					messageId: `${taskId}:summary`,
					turnId,
					cwd: summary.cwd,
					model: summary.modelId,
					timestamp: summary.ts,
				},
				{
					input: summary.tokensIn,
					output: summary.tokensOut,
					cacheRead: summary.cacheReads,
					cacheWrite: summary.cacheWrites,
					cost: summary.totalCost,
				},
			);
			if (hasTokenUsage(rec)) {
				records.push(rec);
			}
			messages.set(taskId, 1);
		}
	}

	result.records = records;
	result.messages = messages;
	return result;
}

function parseToolText(text: unknown): {
	toolName: string;
	payload: unknown;
	content?: unknown;
} {
	if (typeof text === "string") {
		try {
			const parsed = objectOrEmpty(safeJsonParse(text));
			if (Object.keys(parsed).length > 0) {
				const toolName =
					textOrNull(parsed.tool) ?? textOrNull(parsed.name) ?? "tool";
				return { toolName, payload: parsed, content: parsed.content };
			}
		} catch {
			return { toolName: "command", payload: text };
		}
	}
	if (typeof text === "object" && text !== null && !Array.isArray(text)) {
		const obj = text as Record<string, unknown>;
		const toolName = textOrNull(obj.tool) ?? textOrNull(obj.name) ?? "tool";
		return { toolName, payload: obj, content: obj.content };
	}
	return { toolName: "tool", payload: text };
}

export function buildClineFamilySessionTranscript(
	config: ClineFamilyConfig,
	taskId: string,
	taskFolder?: string,
	summaryData?: {
		cwd?: string | null;
		startedAt?: number | null;
		title?: string;
		mode?: string;
	},
	warnings?: string[],
): TranscriptSession | null {
	let cwd = summaryData?.cwd ?? null;
	let startedAt = summaryData?.startedAt ?? null;
	let title = summaryData?.title;
	let mode = config.includeMode ? summaryData?.mode : undefined;

	let uiMessagesPath: string | undefined;
	let apiHistoryPath: string | undefined;

	if (taskFolder && existsSync(taskFolder)) {
		const metaPath = path.join(taskFolder, "task_metadata.json");
		if (existsSync(metaPath)) {
			try {
				const meta = objectOrEmpty(
					safeJsonParse(readFileSync(metaPath, "utf8")),
				);
				cwd = cwd ?? normalizedCwd(meta.cwd);
				startedAt = startedAt ?? timestampMs(meta.createdAt);
				title = title ?? textOrNull(meta.task) ?? undefined;
				if (config.includeMode) {
					mode = mode ?? textOrNull(meta.mode) ?? undefined;
				}
			} catch (error) {
				warnings?.push(
					`${config.label}: failed to parse ${metaPath} (${String(error)})`,
				);
			}
		}

		const uiP = path.join(taskFolder, "ui_messages.json");
		if (existsSync(uiP)) uiMessagesPath = uiP;

		const apiP = path.join(taskFolder, "api_conversation_history.json");
		if (existsSync(apiP)) apiHistoryPath = apiP;
	}

	const session = newSession(config.harness, taskId, cwd, startedAt, title);

	let currentTurn = 0;
	let parsedFromUi = false;

	if (uiMessagesPath) {
		try {
			const uiMsgs = safeJsonParse(readFileSync(uiMessagesPath, "utf8"));
			if (Array.isArray(uiMsgs) && uiMsgs.length > 0) {
				let isFirstText = true;

				for (let i = 0; i < uiMsgs.length; i++) {
					const m = objectOrEmpty(uiMsgs[i]);
					const ts = timestampMs(m.ts);
					if (startedAt === null && ts !== null) {
						session.startedAt = ts;
						startedAt = ts;
					}
					const msgMode = config.includeMode
						? (textOrNull(m.mode) ?? mode)
						: undefined;
					if (config.includeMode && !mode && msgMode) {
						mode = msgMode;
					}

					const isUserMsg =
						m.say === "user_feedback" ||
						m.say === "user_feedback_diff" ||
						m.conversationHistoryIndex === -1 ||
						(isFirstText && m.say === "text");

					if (isUserMsg) {
						currentTurn += 1;
						isFirstText = false;
						const rawText =
							typeof m.text === "string"
								? m.text
								: m.text !== undefined
									? JSON.stringify(m.text)
									: "";
						const userText = cleanUserMessage(config.harness, rawText);
						if (userText) {
							if (!session.title) {
								session.title = userText.slice(0, 100);
							}
							const turnId = msgMode
								? `${currentTurn}:${msgMode}`
								: String(currentTurn);
							addItem(session, {
								id: `${taskId}:ui-msg-${i}`,
								turnId,
								role: "user",
								kind: "message",
								phase: "unknown",
								text: userText,
								status: msgMode,
								timestamp: ts,
							});
						}
						continue;
					}

					if (m.say === "api_req_started") {
						isFirstText = false;
					}

					const turnId = msgMode
						? `${Math.max(1, currentTurn)}:${msgMode}`
						: String(Math.max(1, currentTurn));

					if (m.say === "reasoning") {
						const reasoningText =
							typeof m.text === "string"
								? m.text
								: m.text !== undefined
									? JSON.stringify(m.text)
									: "";
						if (reasoningText) {
							addItem(session, {
								id: `${taskId}:ui-reasoning-${i}`,
								turnId,
								role: "assistant",
								kind: "message",
								phase: "intermediate",
								text: reasoningText,
								status: "reasoning",
								timestamp: ts,
							});
						}
						continue;
					}

					if (m.say === "text") {
						const assistantText =
							typeof m.text === "string"
								? m.text
								: m.text !== undefined
									? JSON.stringify(m.text)
									: "";
						if (assistantText) {
							addItem(session, {
								id: `${taskId}:ui-text-${i}`,
								turnId,
								role: "assistant",
								kind: "message",
								phase: "unknown",
								text: assistantText,
								status: msgMode,
								timestamp: ts,
							});
						}
						continue;
					}

					if (m.say === "tool" || m.ask === "tool") {
						const { toolName, payload, content } = parseToolText(m.text);
						addToolCall(
							session,
							toolName,
							payload,
							`${taskId}:ui-tool-${i}`,
							turnId,
							ts,
							msgMode,
						);
						if (content !== undefined) {
							addItem(session, {
								id: `${taskId}:ui-tool-res-${i}`,
								turnId,
								role: "tool",
								kind: "tool_result",
								phase: "intermediate",
								name: toolName,
								output: content,
								toolCallId: `${taskId}:ui-tool-${i}`,
								status: msgMode,
								timestamp: ts,
							});
						}
						continue;
					}

					if (m.say === "command" || m.ask === "command") {
						addToolCall(
							session,
							"execute_command",
							m.text,
							`${taskId}:ui-cmd-${i}`,
							turnId,
							ts,
							msgMode,
						);
					}
				}
				parsedFromUi = session.items.length > 0;
			}
		} catch (error) {
			warnings?.push(
				`${config.label}: failed to parse ${uiMessagesPath} (${String(error)})`,
			);
		}
	}

	if (!parsedFromUi && apiHistoryPath) {
		try {
			const history = safeJsonParse(readFileSync(apiHistoryPath, "utf8"));
			if (Array.isArray(history)) {
				let turn = 0;
				for (let i = 0; i < history.length; i++) {
					const entry = objectOrEmpty(history[i]);
					const role = textOrNull(entry.role);

					if (role === "user") {
						turn += 1;
						const rawText =
							typeof entry.content === "string"
								? entry.content
								: textFromContent(entry.content);
						const userText = cleanUserMessage(config.harness, rawText);
						if (userText) {
							if (!session.title) {
								session.title = userText.slice(0, 100);
							}
							const turnId = mode ? `${turn}:${mode}` : String(turn);
							addItem(session, {
								id: `${taskId}:api-usr-${i}`,
								turnId,
								role: "user",
								kind: "message",
								phase: "unknown",
								text: userText,
								status: mode,
								timestamp: startedAt,
							});
						}
					} else if (role === "assistant") {
						const turnId = mode
							? `${Math.max(1, turn)}:${mode}`
							: String(Math.max(1, turn));
						if (typeof entry.content === "string") {
							addItem(session, {
								id: `${taskId}:api-asst-${i}`,
								turnId,
								role: "assistant",
								kind: "message",
								phase: "unknown",
								text: entry.content,
								status: mode,
								timestamp: startedAt,
							});
						} else if (Array.isArray(entry.content)) {
							const blocks = contentBlocks(entry.content);
							for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
								const block = blocks[bIdx];
								if (!block) continue;
								const bType = textOrNull(block.type) ?? "";
								if (isReasoningType(bType)) {
									const text =
										textOrNull(block.thinking) ?? textFromContent(block);
									if (text) {
										addItem(session, {
											id: `${taskId}:api-asst-${i}-${bIdx}`,
											turnId,
											role: "assistant",
											kind: "message",
											phase: "intermediate",
											text,
											status: "reasoning",
											timestamp: startedAt,
										});
									}
								} else if (bType === "text") {
									const text = textOrNull(block.text);
									if (text) {
										addItem(session, {
											id: `${taskId}:api-asst-${i}-${bIdx}`,
											turnId,
											role: "assistant",
											kind: "message",
											phase: "unknown",
											text,
											status: mode,
											timestamp: startedAt,
										});
									}
								} else if (bType === "tool_use") {
									const toolName = textOrNull(block.name) ?? "tool";
									const toolCallId = textOrNull(block.id);
									addToolCall(
										session,
										toolName,
										block.input,
										toolCallId ?? `${taskId}:api-tool-${i}-${bIdx}`,
										turnId,
										startedAt,
										mode,
									);
								} else if (bType === "tool_result") {
									const toolCallId = textOrNull(block.tool_use_id);
									addItem(session, {
										id: `${taskId}:api-res-${i}-${bIdx}`,
										turnId,
										role: "tool",
										kind: "tool_result",
										phase: "intermediate",
										output: block.content,
										toolCallId: toolCallId ?? undefined,
										status: mode,
										timestamp: startedAt,
									});
								}
							}
						}
					}
				}
			}
		} catch (error) {
			warnings?.push(
				`${config.label}: failed to parse ${apiHistoryPath} (${String(error)})`,
			);
		}
	}

	inferFinalMessages(session);
	return session;
}

export function readClineFamilySingleTranscriptSync(
	config: ClineFamilyConfig,
	paths: PlatformPathService,
	sessionId: string,
): TranscriptSession | null {
	const roots = getClineFamilyRoots(config, paths);
	const tasksDirs = findClineFamilyTasksDirs(roots);

	let targetFolder: string | undefined;
	for (const td of tasksDirs) {
		const candidate = path.join(td, sessionId);
		if (existsSync(candidate)) {
			targetFolder = candidate;
			break;
		}
	}

	let summaryData:
		| {
				cwd?: string | null;
				startedAt?: number | null;
				title?: string;
				mode?: string;
		  }
		| undefined;
	for (const historyFile of findClineFamilyTaskHistoryFiles(roots)) {
		try {
			const list = safeJsonParse(readFileSync(historyFile, "utf8"));
			if (Array.isArray(list)) {
				for (const raw of list) {
					const entry = objectOrEmpty(raw);
					if (textOrNull(entry.id) === sessionId) {
						summaryData = {
							cwd: normalizedCwd(entry.cwdOnTaskInitialization),
							startedAt: timestampMs(entry.ts),
							title: textOrNull(entry.task) ?? undefined,
							...(config.includeMode
								? { mode: textOrNull(entry.mode) ?? undefined }
								: {}),
						};
						break;
					}
				}
				if (summaryData) break;
			}
		} catch {
			// Skip corrupted taskHistory.json and try remaining files/task folders.
		}
	}

	if (!targetFolder && !summaryData) {
		return null;
	}

	return buildClineFamilySessionTranscript(
		config,
		sessionId,
		targetFolder,
		summaryData,
	);
}

export function readClineFamilyTranscriptsSync(
	config: ClineFamilyConfig,
	paths: PlatformPathService,
	targetFiles?: ReadonlySet<string>,
): TranscriptReadResult {
	const roots = getClineFamilyRoots(config, paths);
	const historyFiles = findClineFamilyTaskHistoryFiles(roots);
	const tasksDirs = findClineFamilyTasksDirs(roots);

	const available = historyFiles.length > 0 || tasksDirs.length > 0;
	const result: TranscriptReadResult = {
		harness: config.harness,
		available,
		sessions: [],
		warnings: [],
	};

	if (!available) return result;

	const discoveredTaskIds = new Set<string>();

	for (const td of tasksDirs) {
		try {
			const entries = readdirSync(td, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const taskId = entry.name;
				const taskFolder = path.join(td, taskId);
				const uiPath = path.join(taskFolder, "ui_messages.json");
				if (
					targetFiles &&
					!targetFiles.has(taskFolder) &&
					!targetFiles.has(uiPath)
				) {
					continue;
				}
				discoveredTaskIds.add(taskId);
				const s = buildClineFamilySessionTranscript(
					config,
					taskId,
					taskFolder,
					undefined,
					result.warnings,
				);
				if (s) result.sessions.push(s);
			}
		} catch (error) {
			result.warnings.push(
				`${config.label}: failed to scan ${td} (${String(error)})`,
			);
		}
	}

	for (const historyFile of historyFiles) {
		try {
			const list = safeJsonParse(readFileSync(historyFile, "utf8"));
			if (Array.isArray(list)) {
				for (const raw of list) {
					const entry = objectOrEmpty(raw);
					const id = textOrNull(entry.id);
					if (id && !discoveredTaskIds.has(id)) {
						if (targetFiles && !targetFiles.has(historyFile)) continue;
						discoveredTaskIds.add(id);
						const s = buildClineFamilySessionTranscript(
							config,
							id,
							undefined,
							{
								cwd: normalizedCwd(entry.cwdOnTaskInitialization),
								startedAt: timestampMs(entry.ts),
								title: textOrNull(entry.task) ?? undefined,
								...(config.includeMode
									? { mode: textOrNull(entry.mode) ?? undefined }
									: {}),
							},
							result.warnings,
						);
						if (s) result.sessions.push(s);
					}
				}
			}
		} catch (error) {
			result.warnings.push(
				`${config.label}: failed to parse ${historyFile} (${String(error)})`,
			);
		}
	}

	return result;
}
