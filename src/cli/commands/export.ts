import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type {
	BatchExportOrganization,
	SessionDetailLevel,
	SessionSummary,
} from "@shared/types";
import { sessionSearchMatches } from "../../../server/data/search";
import { loadSessionTranscript } from "../../../server/data/session-detail";
import {
	renderExportSessionItem,
	uniqueRelativePath,
} from "../../../server/data/session-export-format";
import { createZipArchive, exportSessionsToMarkdown } from "../../exporter";
import { defaultPlatformPathService } from "../../platform/paths";
import { defaultHarnessRegistry } from "../../providers/registry";
import {
	type ExportDetail,
	filterTranscriptSessions,
	readTranscriptSources,
} from "../../transcripts";
import type {
	HarnessName,
	SourceResult,
	TranscriptReadResult,
	TranscriptSession,
} from "../../types";
import {
	allHarnessIds,
	BATCH_ORGANIZATIONS,
	CLI_NAME,
	CliUsageError,
	EXPORT_DETAIL_LEVELS,
	parseList,
	parseMultiList,
	resolveProjectPaths,
	resolveTimeWindow,
} from "../args";
import { printWarnings, resolveSessionKey, withCliStore } from "../data";
import { createSpinner, createStyle, formatNumber } from "../terminal";

export function printExportHelp(): void {
	console.log(`Usage: ${CLI_NAME} export [options]

Export filtered or selected conversations as Markdown files or a ZIP archive.

Selection Options:
  --session <id>         Export specific session ID or key (repeatable)
  -q, --query <text>     Filter sessions with boolean/FTS5 search query
  --harness <names>      Filter by harness (${allHarnessIds().join(", ")})
  --model <names>        Filter by model name
  --project <path>       Filter by project directory (repeatable)
  -r, --range <preset>   Time range: today, yesterday, 7d, 30d, 90d, 1y, all, <N>h/d/w
  --date <YYYY-MM-DD>    Filter to one local date
  --since <datetime>     Range start, inclusive
  --until <datetime>     Range end, inclusive
  --include-internal     Include subagent and internal review sessions

Output Options:
  -o, --out <path>       Destination directory (default: ~/Downloads/coding-tokens-export)
  --detail <level>       Detail level: ${EXPORT_DETAIL_LEVELS.join(", ")}
                         (default: chat_compact)
  --org <layout>         Folder structure: ${BATCH_ORGANIZATIONS.join(", ")}
                         (default: flat)
  --template <pattern>   Custom path template when --org custom is selected
  --zip                  Bundle all exported Markdown files into a single ZIP file
  --include-timestamps   Include message timestamps (default: on)
  --no-timestamps        Omit message timestamps
  --include-token-stats  Include conversation and reply token usage (default: on)
  --no-token-stats       Omit token usage stats
  -f, --format <fmt>     Command output format: text or json (default: text)
  --fresh                Re-sync local index before exporting
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  --quiet                Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} export --range 7d --out ./exports
  ${CLI_NAME} export --harness claude --org project --zip
  ${CLI_NAME} export --session abc12345 --detail agent --out ./debug`);
}

function timestampSlug(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function uniqueZipPath(directory: string, base: string): string {
	let candidate = path.join(directory, `${base}.zip`);
	let index = 2;
	while (existsSync(candidate)) {
		candidate = path.join(directory, `${base}-${index}.zip`);
		index += 1;
	}
	return candidate;
}

export async function runLegacyExport(args: string[]): Promise<void> {
	const harnesses = allHarnessIds();
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

	if (values.format && values["export-dir"]) {
		throw new CliUsageError("--format cannot be combined with --export-dir");
	}
	if (values.detail && !values["export-dir"]) {
		throw new CliUsageError("--detail requires --export-dir");
	}
	if (values["include-timestamps"] && !values["export-dir"]) {
		throw new CliUsageError("--include-timestamps requires --export-dir");
	}
	if (values["include-token-stats"] && !values["export-dir"]) {
		throw new CliUsageError("--include-token-stats requires --export-dir");
	}

	const window = resolveTimeWindow({
		date: values.date,
		since: values.since,
		until: values.until,
	});
	const details = parseList(values.detail, EXPORT_DETAIL_LEVELS, "--detail");
	if (details && details.length !== 1) {
		throw new CliUsageError("--detail accepts exactly one level");
	}

	const selectedHarnesses =
		parseList(values.harness, harnesses, "--harness") ?? harnesses;
	const projects = resolveProjectPaths(values.project);
	const exportDirectory = defaultPlatformPathService.normalize(
		defaultPlatformPathService.expandPath(values["export-dir"] as string),
	);
	const includeTokenStats = values["include-token-stats"] ?? false;
	const includeTimestamps = values["include-timestamps"] ?? false;
	const detail: ExportDetail = (details?.[0] as ExportDetail) ?? "chat_compact";

	const transcriptSources: TranscriptReadResult[] = [];
	const usageSources: SourceResult[] = [];

	for (const harness of selectedHarnesses) {
		const provider = defaultHarnessRegistry.get(harness);
		if (provider?.readTranscripts) {
			try {
				const tRes = await provider.readTranscripts(defaultPlatformPathService);
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

		if (includeTokenStats && provider) {
			try {
				const uRes = await provider.readUsage(defaultPlatformPathService);
				usageSources.push(uRes);
			} catch (err) {
				usageSources.push({
					harness,
					available: false,
					records: [],
					warnings: [`Failed reading usage for ${harness}: ${String(err)}`],
					messages: new Map(),
				});
			}
		}
	}

	const sessions = filterTranscriptSessions(
		transcriptSources.flatMap((source) => source.sessions),
		{
			harnesses: new Set(selectedHarnesses),
			projects: projects ? new Set(projects) : undefined,
			date: window.date,
			since: window.since?.ms,
			until: window.until?.ms,
		},
	);

	if (includeTokenStats) {
		const usageBySession = new Map<string, SourceResult["records"]>();
		for (const source of usageSources) {
			for (const record of source.records) {
				const key = `${record.harness}:${record.sessionId}`;
				const records = usageBySession.get(key) ?? [];
				records.push(record);
				usageBySession.set(key, records);
			}
		}
		for (const session of sessions) {
			session.usageRecords =
				usageBySession.get(`${session.harness}:${session.sessionId}`) ?? [];
		}
	}

	const exported = exportSessionsToMarkdown(sessions, {
		outputDirectory: exportDirectory,
		detail,
		includeTimestamps,
		includeTokenStats,
	});
	for (const source of [...transcriptSources, ...usageSources]) {
		for (const warning of source.warnings) {
			console.error(`Warning: ${warning}`);
		}
	}
	for (const warning of exported.warnings) {
		console.error(`Warning: ${warning}`);
	}
	console.log(
		`Exported ${exported.filesWritten} conversation(s) to ${exportDirectory}`,
	);
	if (exported.filesRemoved) {
		console.log(
			`Removed ${exported.filesRemoved} stale generated Markdown file(s).`,
		);
	}
}

export async function runExportCommand(args: string[]): Promise<void> {
	const harnesses = allHarnessIds();
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			allowPositionals: false,
			options: {
				out: { type: "string", short: "o" },
				"export-dir": { type: "string" },
				session: { type: "string", multiple: true },
				query: { type: "string", short: "q" },
				harness: { type: "string" },
				model: { type: "string", multiple: true },
				project: { type: "string", multiple: true },
				range: { type: "string", short: "r" },
				date: { type: "string" },
				since: { type: "string" },
				until: { type: "string" },
				"include-internal": { type: "boolean" },
				detail: { type: "string" },
				org: { type: "string" },
				template: { type: "string" },
				zip: { type: "boolean" },
				"include-timestamps": { type: "boolean" },
				"no-timestamps": { type: "boolean" },
				"include-token-stats": { type: "boolean" },
				"no-token-stats": { type: "boolean" },
				format: { type: "string", short: "f" },
				fresh: { type: "boolean" },
				db: { type: "string" },
				"no-color": { type: "boolean" },
				quiet: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		throw new CliUsageError(
			error instanceof Error ? error.message : String(error),
			{ hint: `Run "${CLI_NAME} export --help" for valid options` },
		);
	}

	if (values.help) {
		printExportHelp();
		return;
	}

	const format = (values.format as string | undefined) ?? "text";
	if (format !== "text" && format !== "json") {
		throw new CliUsageError("--format accepts text or json");
	}

	const detailList = parseList(
		values.detail as string | undefined,
		EXPORT_DETAIL_LEVELS,
		"--detail",
	);
	if (detailList && detailList.length !== 1) {
		throw new CliUsageError("--detail accepts exactly one level");
	}
	const detail: SessionDetailLevel = detailList?.[0] ?? "chat_compact";

	const orgList = parseList(
		values.org as string | undefined,
		BATCH_ORGANIZATIONS,
		"--org",
	);
	if (orgList && orgList.length !== 1) {
		throw new CliUsageError("--org accepts exactly one layout");
	}
	const organization: BatchExportOrganization = orgList?.[0] ?? "flat";
	const pathTemplate = values.template as string | undefined;

	const window = resolveTimeWindow({
		date: values.date as string | undefined,
		since: values.since as string | undefined,
		until: values.until as string | undefined,
		range: values.range as string | undefined,
	});

	const selectedHarnesses = parseList(
		values.harness as string | undefined,
		harnesses,
		"--harness",
	);
	const selectedModels = parseMultiList(values.model as string[] | undefined);
	const projects = resolveProjectPaths(values.project as string[] | undefined);
	const sessionInputs = (values.session as string[] | undefined) ?? [];
	const queryText = (values.query as string | undefined)?.trim() ?? "";
	const includeInternal = Boolean(values["include-internal"]);
	const asZip = Boolean(values.zip);
	const includeTimestamps = values["no-timestamps"]
		? false
		: ((values["include-timestamps"] as boolean | undefined) ?? true);
	const includeTokenStats = values["no-token-stats"]
		? false
		: ((values["include-token-stats"] as boolean | undefined) ?? true);
	const noColor = Boolean(values["no-color"]);
	const quiet = Boolean(values.quiet);
	const style = createStyle({ noColor });

	const rawOut =
		(values.out as string | undefined) ??
		(values["export-dir"] as string | undefined);
	const outDir = rawOut
		? defaultPlatformPathService.normalize(
				defaultPlatformPathService.expandPath(rawOut),
			)
		: path.join(
				defaultPlatformPathService.getHomeDir(),
				"Downloads",
				"coding-tokens-export",
			);

	await withCliStore(
		{
			dbPath: values.db as string | undefined,
			fresh: Boolean(values.fresh),
			quiet,
			json: format === "json",
			noColor,
		},
		async (s) => {
			let keysToExport: string[] = [];

			if (sessionInputs.length > 0) {
				keysToExport = [
					...new Set(sessionInputs.map((id) => resolveSessionKey(s, id))),
				];
			} else {
				const rangeArg = { from: window.fromMs, until: window.untilMs };
				const allSummaries = s.sessionSummaries(rangeArg);
				const summaryByKey = new Map(
					allSummaries.map((item) => [item.key, item]),
				);

				let candidates: SessionSummary[] = allSummaries;
				if (queryText) {
					const matched = sessionSearchMatches(queryText, rangeArg);
					candidates = matched.keys
						.map((k) => summaryByKey.get(k))
						.filter((item): item is SessionSummary => Boolean(item));
				}

				const harnessSet = selectedHarnesses
					? new Set(selectedHarnesses)
					: null;
				const projectSet = projects ? new Set(projects) : null;
				const modelSet = selectedModels
					? new Set(selectedModels.map((m) => m.toLowerCase()))
					: null;

				keysToExport = candidates
					.filter((session) => {
						if (!includeInternal && (session.isSubagent || session.isReview)) {
							return false;
						}
						if (harnessSet && !harnessSet.has(session.harness)) return false;
						if (projectSet && (!session.cwd || !projectSet.has(session.cwd))) {
							return false;
						}
						if (
							modelSet &&
							!session.models.some((m) => modelSet.has(m.toLowerCase()))
						) {
							return false;
						}
						return true;
					})
					.map((session) => session.key);
			}

			if (keysToExport.length === 0) {
				if (format === "json") {
					console.log(
						JSON.stringify(
							{
								outputPath: outDir,
								zip: asZip,
								filesWritten: 0,
								skippedCount: 0,
								bytes: 0,
								warnings: [],
							},
							null,
							2,
						),
					);
				} else {
					console.log(style.yellow("No matching sessions found to export."));
					console.log(
						style.dim(
							`Try widening "--range all" or run "${CLI_NAME} sessions" to inspect available sessions.`,
						),
					);
				}
				return;
			}

			const spinner = createSpinner({
				quiet,
				json: format === "json",
				noColor,
			});
			spinner.start(`Exporting 0/${keysToExport.length} session(s)...`);

			const entries: Array<{ name: string; content: string }> = [];
			const usedPaths = new Set<string>();
			const warnings: string[] = [];

			try {
				for (const [idx, key] of keysToExport.entries()) {
					spinner.update(
						`Exporting ${idx + 1}/${keysToExport.length} session(s)...`,
					);
					const loaded = await loadSessionTranscript(key);
					if (!loaded.ok) {
						warnings.push(...loaded.warnings.map((w) => `${key}: ${w}`));
						continue;
					}
					const { meta, records, session } = loaded.value;
					const rendered = renderExportSessionItem(
						{ key, meta, records },
						session,
						{
							detail,
							includeTimestamps,
							includeTokenStats,
							organization,
							pathTemplate,
						},
					);
					if (!rendered.content) continue;
					entries.push({
						name: uniqueRelativePath(usedPaths, rendered.rawRelative),
						content: rendered.content,
					});
				}
			} finally {
				spinner.stop();
			}

			mkdirSync(outDir, { recursive: true });
			let outputPath = outDir;
			let totalBytes = 0;

			if (asZip) {
				const zipBytes = createZipArchive(entries);
				const zipPath = uniqueZipPath(
					outDir,
					`coding-tokens-export-${timestampSlug()}`,
				);
				writeFileSync(zipPath, zipBytes);
				outputPath = zipPath;
				totalBytes = zipBytes.byteLength;
			} else {
				for (const entry of entries) {
					const dest = path.join(outDir, entry.name);
					mkdirSync(path.dirname(dest), { recursive: true });
					writeFileSync(dest, entry.content, "utf8");
					totalBytes += Buffer.byteLength(entry.content, "utf8");
				}
			}

			const skippedCount = Math.max(0, keysToExport.length - entries.length);

			if (format === "json") {
				console.log(
					JSON.stringify(
						{
							outputPath,
							zip: asZip,
							filesWritten: entries.length,
							skippedCount,
							bytes: totalBytes,
							warnings,
						},
						null,
						2,
					),
				);
				printWarnings(warnings, style, quiet);
				return;
			}

			console.log(
				`${style.green("Exported")} ${formatNumber(entries.length)} conversation(s) to ${style.bold(outputPath)}`,
			);
			if (skippedCount > 0) {
				console.log(
					style.dim(
						`Skipped ${formatNumber(skippedCount)} session(s) with no content at detail level "${detail}".`,
					),
				);
			}
			printWarnings(warnings, style, quiet);
		},
	);
}
