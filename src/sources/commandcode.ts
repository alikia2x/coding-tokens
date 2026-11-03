import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SourceResult, UsageRecord } from "../types";
import {
	blankSourceResult,
	expandHome,
	hasTokenUsage,
	homeDir,
	modelName,
	normalizedCwd,
	objectOrEmpty,
	parseJsonl,
	textOrNull,
	timestampMs,
	usageRecord,
	walkFiles,
} from "../util";

export function readCommandCode(): SourceResult {
	const commandCodeHome = process.env.COMMANDCODE_HOME
		? path.resolve(expandHome(process.env.COMMANDCODE_HOME))
		: path.join(homeDir, ".commandcode");
	const projectsRoot = path.join(commandCodeHome, "projects");
	const result = blankSourceResult("commandcode", existsSync(projectsRoot));
	if (!result.available) return result;

	let projectDirs: string[] = [];
	try {
		projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(projectsRoot, entry.name));
	} catch (error) {
		result.warnings.push(
			`Command Code: failed to read projects directory (${String(error)})`,
		);
	}

	const files = projectDirs.flatMap((projectDir) =>
		walkFiles(
			projectDir,
			(_filePath, name) =>
				name.endsWith(".jsonl") &&
				!name.endsWith(".checkpoints.jsonl") &&
				!name.endsWith(".prompts.jsonl"),
		),
	);
	const records: UsageRecord[] = [];
	const messages = new Map<string, number>();
	for (const filePath of files) {
		try {
			const rows = parseJsonl(readFileSync(filePath, "utf8"));
			const header = rows
				.map(objectOrEmpty)
				.find((row) => row.type === "session");
			if (!header) continue;
			const sessionId =
				textOrNull(header.id) ?? path.basename(filePath, ".jsonl");
			const cwd =
				normalizedCwd(header.cwd) ??
				`Unknown directory (${path.basename(path.dirname(filePath))})`;
			const sessionTime = timestampMs(header.timestamp);
			for (let index = 0; index < rows.length; index += 1) {
				const row = objectOrEmpty(rows[index]);
				if (row.type !== "message") continue;
				const message = objectOrEmpty(row.message);
				if (message.role === "user")
					messages.set(sessionId, (messages.get(sessionId) ?? 0) + 1);
				const usage = objectOrEmpty(row.usage);
				if (Object.keys(usage).length === 0) continue;
				if (message.role && message.role !== "assistant") continue;
				records.push(
					usageRecord(
						{
							harness: "commandcode",
							sessionId,
							messageId:
								textOrNull(row.id) ?? `${path.basename(filePath)}:${index}`,
							cwd,
							model: modelName(row.model),
							timestamp: timestampMs(row.timestamp) ?? sessionTime,
						},
						{
							input: usage.inputTokens,
							output: usage.outputTokens,
							cacheRead: usage.cacheReadTokens,
							cacheWrite: usage.cacheWriteTokens,
							reasoning: usage.reasoningTokens ?? usage.reasoning,
							cost: usage.costUsd,
						},
					),
				);
			}
		} catch (error) {
			result.warnings.push(
				`Command Code: failed to read ${filePath} (${String(error)})`,
			);
		}
	}
	result.records = records.filter(hasTokenUsage);
	result.messages = messages;
	return result;
}
