#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createReport, type GroupField, type GroupRow } from "./aggregate";
import { exportSessionsToMarkdown } from "./exporter";
import { defaultPlatformPathService } from "./platform/paths";
import { enrichWithModelsDev } from "./pricing/modelsdev";
import { defaultHarnessRegistry } from "./providers/registry";
import {
	type ExportDetail,
	filterTranscriptSessions,
	readTranscriptSources,
} from "./transcripts";
import type {
	HarnessName,
	SourceResult,
	TranscriptReadResult,
	TranscriptSession,
	UsageTotals,
} from "./types";

const harnesses = defaultHarnessRegistry.getAll().map((p) => p.metadata.id);
const groupFields = ["harness", "project", "model", "day", "session"] as const;
const exportDetails = [
	"user_only",
	"chat_compact",
	"chat",
	"chat_tools",
	"agent",
	"agent_full",
] as const;
const labels: Record<GroupField, string> = {
	harness: "Harness",
	project: "Project",
	model: "Model",
	day: "Date",
	session: "Session",
};

function getHarnessLabel(id: string): string {
	return defaultHarnessRegistry.get(id)?.metadata.displayName ?? id;
}

const numberFormat = new Intl.NumberFormat("en-US");
const costFormat = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 8,
});

function help(): void {
	const home = defaultPlatformPathService.getHomeDir();
	console.log(`Usage: bun run src/cli.ts [options]

Options:
  --by <fields>          Group by harness, project, model, day, or session
  --harness <names>      Select harnesses: ${harnesses.join(", ")}
  --project <path>       Filter to a project directory (repeatable)
  --date <YYYY-MM-DD>    Filter to one local date
  --since <datetime>     Range start, inclusive (default time 00:00:00)
  --until <datetime>     Range end, inclusive of the whole day/minute/second named
  --format <table|json>  Output format (default: table)
  --export-dir <path>    Export matching conversations as Markdown files
  --detail <level>       user_only, chat_compact, chat, chat_tools, agent, agent_full
                         (default: chat_compact; requires --export-dir)
  --include-timestamps   Include message timestamps in exported Markdown
  --include-token-stats  Include conversation and per-reply token usage
  -h, --help             Show help

--since and --until accept a local calendar date with an optional time:
  YYYY-MM-DD, YYYY-MM-DD HH:MM, or YYYY-MM-DD HH:MM:SS (a T also separates
  date and time, as in 2026-01-15T09:30:00).

Data directories: CODEX_HOME, DSH_HOME, OPENCODE_DATA_DIR, OPENCODE_DB,
COMMANDCODE_HOME, ANTIGRAVITY_HOME. Default Codex directory: ${home}/.codex.`);
}

function parseList<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	flag: string,
): T[] | undefined {
	if (value === undefined) return undefined;
	const values = [...new Set(value.split(",").map((item) => item.trim()))];
	const invalid = values.filter((item) => !allowed.includes(item as T));
	if (invalid.length) {
		throw new Error(`${flag} accepts: ${allowed.join(", ")}`);
	}
	return values as T[];
}

function parseDate(
	value: string | undefined,
	flag: string,
): string | undefined {
	if (value === undefined) return undefined;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
		Number.isNaN(parsed.valueOf()) ||
		parsed.toISOString().slice(0, 10) !== value
	) {
		throw new Error(`${flag} must be a valid YYYY-MM-DD date`);
	}
	return value;
}

interface TimeBound {
	/** Canonical local text, e.g. "2026-01-15" or "2026-01-15 09:30:00". */
	text: string;
	/** Epoch milliseconds: an inclusive start, or an exclusive end for --until. */
	ms: number;
}

const dateTimePattern =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/u;

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseTimeBound(
	value: string | undefined,
	flag: string,
	isEnd: boolean,
): TimeBound | undefined {
	if (value === undefined) return undefined;
	const match = dateTimePattern.exec(value.trim());
	if (!match) {
		throw new Error(
			`${flag} must be YYYY-MM-DD, YYYY-MM-DD HH:MM, or YYYY-MM-DD HH:MM:SS`,
		);
	}
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
		match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hasTime = hourText !== undefined;
	const hasSeconds = secondText !== undefined;
	const hour = hasTime ? Number(hourText) : 0;
	const minute = hasTime ? Number(minuteText) : 0;
	const second = hasSeconds ? Number(secondText) : 0;
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new Error(
			`${flag} is not a valid local date and time: ${value.trim()}`,
		);
	}
	// --since starts at the named unit; --until stays inclusive of the whole
	// day, minute, or second the user named, so it ends one unit later.
	let ms = new Date(year, month - 1, day, hour, minute, second, 0).valueOf();
	if (isEnd) {
		if (hasSeconds) {
			ms = new Date(
				year,
				month - 1,
				day,
				hour,
				minute,
				second + 1,
				0,
			).valueOf();
		} else if (hasTime) {
			ms = new Date(year, month - 1, day, hour, minute + 1, 0, 0).valueOf();
		} else {
			ms = new Date(year, month - 1, day + 1, 0, 0, 0, 0).valueOf();
		}
	}
	const text = hasTime
		? `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}${hasSeconds ? `:${secondText}` : ""}`
		: `${yearText}-${monthText}-${dayText}`;
	return { text, ms };
}

function parseOptions(args: string[]) {
	const { values } = parseArgs({
		args,
		allowPositionals: false,
		options: {
			by: { type: "string" },
			harness: { type: "string" },
			project: { type: "string", multiple: true },
			date: { type: "string" },
			since: { type: "string" },
			until: { type: "string" },
			format: { type: "string" },
			"export-dir": { type: "string" },
			detail: { type: "string" },
			"include-timestamps": { type: "boolean" },
			"include-token-stats": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const date = parseDate(values.date, "--date");
	const since = parseTimeBound(values.since, "--since", false);
	const until = parseTimeBound(values.until, "--until", true);
	if (date && (since || until)) {
		throw new Error("--date cannot be combined with --since or --until");
	}
	if (since && until && since.ms >= until.ms) {
		throw new Error("--since must be earlier than --until");
	}
	if (values.format && values.format !== "table" && values.format !== "json") {
		throw new Error("--format accepts table or json");
	}
	if (values.detail && !values["export-dir"]) {
		throw new Error("--detail requires --export-dir");
	}
	if (values["include-timestamps"] && !values["export-dir"]) {
		throw new Error("--include-timestamps requires --export-dir");
	}
	if (values["include-token-stats"] && !values["export-dir"]) {
		throw new Error("--include-token-stats requires --export-dir");
	}
	if (values["export-dir"] && values.format) {
		throw new Error("--format cannot be combined with --export-dir");
	}
	const details = parseList(values.detail, exportDetails, "--detail");
	if (details && details.length !== 1) {
		throw new Error("--detail accepts exactly one level");
	}
	return {
		help: values.help ?? false,
		format: values.format ?? "table",
		groupBy: parseList(values.by, groupFields, "--by") ?? [
			"harness",
			"project",
			"model",
		],
		harnesses: parseList(values.harness, harnesses, "--harness") ?? harnesses,
		projects: values.project?.map((project) =>
			defaultPlatformPathService.normalize(
				defaultPlatformPathService.expandPath(project),
			),
		),
		date,
		since,
		until,
		exportDirectory: values["export-dir"]
			? defaultPlatformPathService.normalize(
					defaultPlatformPathService.expandPath(values["export-dir"]),
				)
			: undefined,
		detail: (details?.[0] as ExportDetail | undefined) ?? "chat_compact",
		includeTimestamps: values["include-timestamps"] ?? false,
		includeTokenStats: values["include-token-stats"] ?? false,
	};
}

function tableRow(
	totals: UsageTotals,
	values: GroupRow["values"] | undefined,
	groupBy: GroupField[],
	isTotal = false,
): Record<string, string | number> {
	const home = defaultPlatformPathService.getHomeDir();
	const row: Record<string, string | number> = {};
	for (const [index, field] of groupBy.entries()) {
		let value = isTotal && index === 0 ? "Total" : (values?.[field] ?? "");
		if (field === "harness") value = getHarnessLabel(value);
		if (field === "project" && value.startsWith(home)) {
			value = `~${value.slice(home.length)}`;
		}
		row[labels[field]] = value;
	}
	row.Sessions = numberFormat.format(totals.sessions);
	row.Requests = numberFormat.format(totals.requests);
	row.Input = numberFormat.format(totals.inputTokens);
	row.Output = numberFormat.format(totals.outputTokens);
	row["Cache read"] = numberFormat.format(totals.cacheReadTokens);
	row["Cache write"] = numberFormat.format(totals.cacheWriteTokens);
	row.Reasoning = numberFormat.format(totals.reasoningTokens);
	row.Unpriced = numberFormat.format(totals.unpricedRequests);
	row["Cost (USD)"] =
		totals.unpricedRequests === totals.requests
			? "—"
			: `${totals.estimatedRequests || totals.unpricedRequests ? "~" : ""}${costFormat.format(totals.costUsd)}`;
	return row;
}

function renderTable(
	report: ReturnType<typeof createReport>,
	groupBy: GroupField[],
): void {
	if (!report.groups.length) console.log("No usage records found.");
	console.table([
		...report.groups.map((group) => tableRow(group, group.values, groupBy)),
		tableRow(report.totals, undefined, groupBy, true),
	]);
}

function printWarnings(sources: SourceResult[]): void {
	for (const { warnings } of sources) {
		for (const warning of warnings) console.error(`Warning: ${warning}`);
	}
}

async function main(): Promise<void> {
	let options: ReturnType<typeof parseOptions>;
	try {
		options = parseOptions(process.argv.slice(2));
	} catch (error) {
		console.error(String(error));
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		help();
		return;
	}
	if (options.exportDirectory) {
		const transcriptSources: TranscriptReadResult[] = [];
		const usageSources: SourceResult[] = [];

		for (const harness of options.harnesses) {
			const provider = defaultHarnessRegistry.get(harness);
			if (provider?.readTranscripts) {
				try {
					const tRes = await provider.readTranscripts(
						defaultPlatformPathService,
					);
					transcriptSources.push(tRes);
				} catch (err) {
					transcriptSources.push({
						harness,
						available: false,
						sessions: [],
						warnings: [
							`Failed reading transcripts for ${harness}: ${String(err)}`,
						],
					});
				}
			} else if (provider) {
				try {
					const items = await provider.discoverSessions(
						defaultPlatformPathService,
					);
					const sessions: TranscriptSession[] = [];
					for (const item of items) {
						const t = await provider.readTranscript(
							defaultPlatformPathService,
							item.sessionId,
						);
						if (t) sessions.push(t);
					}
					transcriptSources.push({
						harness,
						available: await provider.isAvailable(defaultPlatformPathService),
						sessions,
						warnings: [],
					});
				} catch (err) {
					transcriptSources.push({
						harness,
						available: false,
						sessions: [],
						warnings: [
							`Failed reading transcripts for ${harness}: ${String(err)}`,
						],
					});
				}
			} else {
				const legacy = readTranscriptSources([harness as HarnessName]);
				if (legacy[0]) transcriptSources.push(legacy[0]);
			}

			if (options.includeTokenStats && provider) {
				try {
					const uRes = await provider.readUsage(defaultPlatformPathService);
					usageSources.push(uRes);
				} catch {}
			}
		}

		const sessions = filterTranscriptSessions(
			transcriptSources.flatMap((source) => source.sessions),
			{
				harnesses: new Set(options.harnesses),
				projects: options.projects ? new Set(options.projects) : undefined,
				date: options.date,
				since: options.since?.ms,
				until: options.until?.ms,
			},
		);
		if (options.includeTokenStats) {
			const usageBySession = new Map<string, SourceResult["records"]>();
			for (const source of usageSources) {
				for (const record of source.records) {
					const key = `${record.harness}:${record.sessionId}`;
					const records = usageBySession.get(key) ?? [];
					records.push(record);
					usageBySession.set(key, records);
				}
			}
			for (const session of sessions)
				session.usageRecords =
					usageBySession.get(`${session.harness}:${session.sessionId}`) ?? [];
		}
		const exported = exportSessionsToMarkdown(sessions, {
			outputDirectory: options.exportDirectory,
			detail: options.detail,
			includeTimestamps: options.includeTimestamps,
			includeTokenStats: options.includeTokenStats,
		});
		for (const source of [...transcriptSources, ...usageSources]) {
			for (const warning of source.warnings)
				console.error(`Warning: ${warning}`);
		}
		for (const warning of exported.warnings)
			console.error(`Warning: ${warning}`);
		console.log(
			`Exported ${exported.filesWritten} conversation(s) to ${options.exportDirectory}`,
		);
		if (exported.filesRemoved)
			console.log(
				`Removed ${exported.filesRemoved} stale generated Markdown file(s).`,
			);
		return;
	}

	const sources: SourceResult[] = [];
	for (const harness of options.harnesses) {
		const provider = defaultHarnessRegistry.get(harness);
		if (!provider) continue;
		try {
			const res = await provider.readUsage(defaultPlatformPathService);
			sources.push(res);
		} catch (err) {
			sources.push({
				harness,
				available: false,
				records: [],
				warnings: [`Failed reading usage for ${harness}: ${String(err)}`],
				messages: new Map(),
			});
		}
	}

	const pricingWarning = await enrichWithModelsDev(
		sources.flatMap((item) => item.records),
	);
	const report = createReport(sources, {
		harnesses: new Set(options.harnesses),
		projects: options.projects ? new Set(options.projects) : undefined,
		groupBy: options.groupBy,
		date: options.date,
		since: options.since?.ms,
		until: options.until?.ms,
	});
	if (options.format === "json") {
		console.log(
			JSON.stringify(
				{
					groupBy: options.groupBy,
					filters: {
						harnesses: options.harnesses,
						projects: options.projects ?? [],
						date: options.date ?? null,
						since: options.since?.text ?? null,
						until: options.until?.text ?? null,
					},
					...report,
				},
				null,
				2,
			),
		);
	} else {
		renderTable(report, options.groupBy);
	}
	printWarnings(sources);
	if (pricingWarning) console.error(`Warning: ${pricingWarning}`);
}

void main();
