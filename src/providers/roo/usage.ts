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
	findRooTaskHistoryFiles,
	findRooTasksDirs,
	getRooRoots,
} from "./discovery";

interface ApiReqPayload {
	request?: string;
	tokensIn?: number;
	tokensOut?: number;
	cacheWrites?: number;
	cacheReads?: number;
	cost?: number;
}

export function readRooUsageSync(
	paths: PlatformPathService = defaultPlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	const roots = getRooRoots(paths);
	const historyFiles = findRooTaskHistoryFiles(roots);
	const tasksDirs = findRooTasksDirs(roots);

	const available = historyFiles.length > 0 || tasksDirs.length > 0;
	const result = blankSourceResult("roo", available);
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
			mode?: string;
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
						mode: textOrNull(entry.mode) ?? undefined,
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
				`Roo Code: failed to parse ${historyFile} (${String(error)})`,
			);
		}
	}

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

		if (existsSync(metaPath)) {
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf8"));
				taskCwd = taskCwd ?? normalizedCwd(meta.cwd);
				taskMode = taskMode ?? textOrNull(meta.mode) ?? undefined;
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
						const msgMode = textOrNull(m.mode) ?? taskMode;

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
									// ignore
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

							const turnId = msgMode
								? `${reqIndex}:${msgMode}`
								: String(reqIndex);

							const rec = usageRecord(
								{
									harness: "roo",
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
					`Roo Code: failed to parse ${uiMessagesPath} (${String(error)})`,
				);
			}
		}

		if (taskUserMessages > 0) {
			messages.set(taskId, taskUserMessages);
		}

		// Fallback to summary if no granular records produced
		if (!granularFound && summary) {
			const turnId = summary.mode ? `1:${summary.mode}` : "1";
			const fallbackRec = usageRecord(
				{
					harness: "roo",
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
			} catch {
				// ignore
			}
		}

		for (const [taskId, summary] of historySummaryMap.entries()) {
			if (!processedTaskIds.has(taskId)) {
				const turnId = summary.mode ? `1:${summary.mode}` : "1";
				const rec = usageRecord(
					{
						harness: "roo",
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
	}

	result.records = records;
	result.messages = messages;
	return result;
}
