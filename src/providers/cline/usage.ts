import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import type { SourceResult, UsageRecord } from "../../types";
import {
	blankSourceResult,
	hasTokenUsage,
	modelName,
	normalizedCwd,
	objectOrEmpty,
	textOrNull,
	timestampMs,
	usageRecord,
} from "../../util";
import type { SessionDiscoveryItem } from "../types";
import {
	findClineTaskHistoryFiles,
	findClineTasksDirs,
	getClineRoots,
} from "./discovery";

interface ApiReqPayload {
	request?: string;
	tokensIn?: number;
	tokensOut?: number;
	cacheWrites?: number;
	cacheReads?: number;
	cost?: number;
}

export function readClineUsageSync(
	paths: PlatformPathService = defaultPlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const roots = getClineRoots(paths);
	const historyFiles = findClineTaskHistoryFiles(roots);
	const tasksDirs = findClineTasksDirs(roots);

	const available = historyFiles.length > 0 || tasksDirs.length > 0;
	const result = blankSourceResult("cline", available);
	if (!result.available) return result;

	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();

	// 1. Collect summary info from taskHistory.json
	const historySummaryMap = new Map<
		string,
		{
			id: string;
			ts: number | null;
			cwd: string | null;
			modelId: string;
			tokensIn: number;
			tokensOut: number;
			cacheWrites: number;
			cacheReads: number;
			totalCost: number | null;
		}
	>();

	for (const historyFile of historyFiles) {
		try {
			const content = readFileSync(historyFile, "utf8");
			const historyArray = JSON.parse(content);
			if (Array.isArray(historyArray)) {
				for (const raw of historyArray) {
					const entry = objectOrEmpty(raw);
					const id = textOrNull(entry.id);
					if (!id) continue;
					historySummaryMap.set(id, {
						id,
						ts: timestampMs(entry.ts),
						cwd: normalizedCwd(entry.cwdOnTaskInitialization),
						modelId: modelName(entry.modelId),
						tokensIn: typeof entry.tokensIn === "number" ? entry.tokensIn : 0,
						tokensOut:
							typeof entry.tokensOut === "number" ? entry.tokensOut : 0,
						cacheWrites:
							typeof entry.cacheWrites === "number" ? entry.cacheWrites : 0,
						cacheReads:
							typeof entry.cacheReads === "number" ? entry.cacheReads : 0,
						totalCost:
							typeof entry.totalCost === "number" ? entry.totalCost : null,
					});
				}
			}
		} catch (error) {
			result.warnings.push(
				`Cline: failed to parse ${historyFile} (${String(error)})`,
			);
		}
	}

	// Helper to process a single task directory
	const processedTaskIds = new Set<string>();

	const processTaskDirectory = (
		taskId: string,
		taskDir: string,
		uiMessagesPath: string,
	): void => {
		processedTaskIds.add(taskId);
		const summary = historySummaryMap.get(taskId);
		let taskCwd = summary?.cwd ?? null;
		const metaPath = path.join(taskDir, "task_metadata.json");

		if (!taskCwd && existsSync(metaPath)) {
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf8"));
				taskCwd = normalizedCwd(meta.cwd) ?? null;
			} catch {
				// ignore
			}
		}

		let taskUserMessages = 0;
		let granularFound = false;

		if (existsSync(uiMessagesPath)) {
			try {
				const content = readFileSync(uiMessagesPath, "utf8");
				const uiMsgs = JSON.parse(content);
				if (Array.isArray(uiMsgs)) {
					let reqIndex = 0;
					let isFirstText = true;

					for (let i = 0; i < uiMsgs.length; i++) {
						const m = objectOrEmpty(uiMsgs[i]);
						const ts = timestampMs(m.ts) ?? summary?.ts ?? null;

						// Detect user messages
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
						}

						// Detect telemetry api_req_started
						if (m.say === "api_req_started") {
							reqIndex += 1;
							let details: ApiReqPayload = {};
							if (typeof m.text === "string") {
								try {
									details = JSON.parse(m.text) as ApiReqPayload;
								} catch {
									// ignore malformed inner json
								}
							}

							const modelInfo = objectOrEmpty(m.modelInfo);
							const modelId =
								textOrNull(modelInfo.modelId) ?? summary?.modelId ?? "unknown";
							const providerId = textOrNull(modelInfo.providerId);
							const pricingModel =
								providerId && modelId ? `${providerId}/${modelId}` : undefined;

							const inTokens = details.tokensIn ?? 0;
							const outTokens = details.tokensOut ?? 0;
							const cReads = details.cacheReads ?? 0;
							const cWrites = details.cacheWrites ?? 0;
							const cost =
								typeof details.cost === "number" ? details.cost : null;

							const rec = usageRecord(
								{
									harness: "cline",
									sessionId: taskId,
									messageId: `${taskId}:req-${reqIndex}`,
									turnId: String(reqIndex),
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
					`Cline: failed to parse ${uiMessagesPath} (${String(error)})`,
				);
			}
		}

		if (taskUserMessages > 0) {
			messages.set(taskId, taskUserMessages);
		}

		// Fallback to summary if no granular records produced
		if (!granularFound && summary) {
			const fallbackRec = usageRecord(
				{
					harness: "cline",
					sessionId: taskId,
					messageId: `${taskId}:summary`,
					turnId: "1",
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

	// If item is specifically requested
	if (item) {
		const taskId = item.sessionId;
		let uiPath = item.filePath;
		let taskDir = path.dirname(uiPath);
		if (uiPath.endsWith("taskHistory.json")) {
			// Find task directory if possible
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
		// Sweep all task directories in all tasksDirs
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
			} catch {
				// ignore
			}
		}

		// Check any remaining tasks from taskHistory.json that didn't have a local task directory
		for (const [taskId, summary] of historySummaryMap.entries()) {
			if (!processedTaskIds.has(taskId)) {
				const rec = usageRecord(
					{
						harness: "cline",
						sessionId: taskId,
						messageId: `${taskId}:summary`,
						turnId: "1",
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
	}

	result.records = records;
	result.messages = messages;
	return result;
}
