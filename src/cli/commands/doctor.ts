import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { harnessReportPayload } from "../../../server/data/reports";
import {
	CLI_NAME,
	CLI_VERSION,
	CliUsageError,
	HARNESS_ENV_VARS,
	resolveTimeWindow,
} from "../args";
import { printWarnings, withCliStore } from "../data";
import {
	createStyle,
	formatCost,
	formatNumber,
	formatTimestamp,
	formatTokens,
	renderTable,
	shortenHome,
} from "../terminal";

export function printHarnessesHelp(): void {
	console.log(`Usage: ${CLI_NAME} harnesses [options]

Show detected AI coding harnesses, local data paths, and usage totals.

Options:
  --all                  Include harnesses with no detected data or sessions
  -r, --range <preset>   Time range: today, yesterday, 7d, 30d, 90d, 1y, all, <N>h/d/w
  --date <YYYY-MM-DD>    Filter to one local date
  --since <datetime>     Range start, inclusive
  --until <datetime>     Range end, inclusive
  -f, --format <fmt>     Output format: table or json (default: table)
  --fresh                Re-sync local index before querying
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  -q, --quiet            Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} harnesses
  ${CLI_NAME} harnesses --all --format json`);
}

export function printDoctorHelp(): void {
	console.log(`Usage: ${CLI_NAME} doctor [options]

Inspect local database health, pricing catalog state, and all 15 harness paths.

Options:
  -f, --format <fmt>     Output format: text or json (default: text)
  --fresh                Force re-sync before reporting diagnostics
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  -q, --quiet            Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} doctor
  ${CLI_NAME} doctor --format json`);
}

export async function runHarnessesCommand(args: string[]): Promise<void> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			allowPositionals: false,
			options: {
				all: { type: "boolean" },
				range: { type: "string", short: "r" },
				date: { type: "string" },
				since: { type: "string" },
				until: { type: "string" },
				format: { type: "string", short: "f" },
				fresh: { type: "boolean" },
				db: { type: "string" },
				"no-color": { type: "boolean" },
				quiet: { type: "boolean", short: "q" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		throw new CliUsageError(
			error instanceof Error ? error.message : String(error),
			{ hint: `Run "${CLI_NAME} harnesses --help" for valid options` },
		);
	}

	if (values.help) {
		printHarnessesHelp();
		return;
	}

	const format = (values.format as string | undefined) ?? "table";
	if (format !== "table" && format !== "json") {
		throw new CliUsageError("--format accepts table or json");
	}

	const showAll = Boolean(values.all);
	const window = resolveTimeWindow({
		date: values.date as string | undefined,
		since: values.since as string | undefined,
		until: values.until as string | undefined,
		range: values.range as string | undefined,
	});
	const noColor = Boolean(values["no-color"]);
	const quiet = Boolean(values.quiet);
	const style = createStyle({ noColor });

	await withCliStore(
		{
			dbPath: values.db as string | undefined,
			fresh: Boolean(values.fresh),
			quiet,
			json: format === "json",
			noColor,
		},
		async (s) => {
			const payload = harnessReportPayload(
				{
					from: window.fromMs,
					until: window.untilMs,
					harnesses: null,
					projects: null,
					models: null,
				},
				s.sourcePaths(),
			);

			const rows = showAll
				? payload.rows
				: payload.rows.filter(
						(r) =>
							r.available || r.totals.sessions > 0 || r.totals.requests > 0,
					);

			if (format === "json") {
				console.log(
					JSON.stringify(
						{
							...payload,
							rows,
						},
						null,
						2,
					),
				);
				printWarnings(payload.warnings, style, quiet);
				return;
			}

			if (rows.length === 0) {
				console.log(style.yellow("No active coding harnesses were detected."));
				console.log(
					style.dim(
						`Run "${CLI_NAME} harnesses --all" or "${CLI_NAME} doctor" to inspect all 15 supported data paths.`,
					),
				);
				printWarnings(payload.warnings, style, quiet);
				return;
			}

			const tableRows = rows.map((row) => {
				const tokens =
					row.totals.inputTokens +
					row.totals.outputTokens +
					row.totals.cacheReadTokens +
					row.totals.cacheWriteTokens;
				const statusText = row.available
					? style.green("detected")
					: style.dim("not found");
				return {
					harness: `${row.label} (${row.harness})`,
					status: statusText,
					sessions: formatNumber(row.totals.sessions),
					requests: formatNumber(row.totals.requests),
					tokens: formatTokens(tokens),
					cost: formatCost(
						row.totals.costUsd,
						row.totals.estimatedRequests > 0 || row.totals.unpricedRequests > 0,
						row.totals.unpricedRequests === row.totals.requests &&
							row.totals.requests > 0,
					),
					paths: row.paths.map(shortenHome).join(", "),
				};
			});

			const totalTok =
				payload.totals.inputTokens +
				payload.totals.outputTokens +
				payload.totals.cacheReadTokens +
				payload.totals.cacheWriteTokens;

			console.log(
				renderTable({
					columns: [
						{ key: "harness", header: "Harness", minWidth: 16, maxWidth: 28 },
						{ key: "status", header: "Status", minWidth: 9, maxWidth: 12 },
						{ key: "sessions", header: "Sessions", align: "right" },
						{ key: "requests", header: "Requests", align: "right" },
						{ key: "tokens", header: "Tokens", align: "right" },
						{ key: "cost", header: "Cost", align: "right" },
						{
							key: "paths",
							header: "Paths",
							minWidth: 14,
							maxWidth: 36,
							shrinkPriority: 3,
						},
					],
					rows: tableRows,
					footerRow: {
						harness: "Total",
						status: "",
						sessions: formatNumber(payload.totals.sessions),
						requests: formatNumber(payload.totals.requests),
						tokens: formatTokens(totalTok),
						cost: formatCost(
							payload.totals.costUsd,
							payload.totals.estimatedRequests > 0 ||
								payload.totals.unpricedRequests > 0,
							payload.totals.unpricedRequests === payload.totals.requests &&
								payload.totals.requests > 0,
						),
						paths: "",
					},
					style,
				}),
			);

			if (!showAll && rows.length < payload.rows.length) {
				console.log(
					style.dim(
						`Showing ${rows.length} detected harness(es). Pass --all to view all ${payload.rows.length} supported tools.`,
					),
				);
			}
			printWarnings(payload.warnings, style, quiet);
		},
	);
}

export async function runDoctorCommand(args: string[]): Promise<void> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			allowPositionals: false,
			options: {
				format: { type: "string", short: "f" },
				fresh: { type: "boolean" },
				db: { type: "string" },
				"no-color": { type: "boolean" },
				quiet: { type: "boolean", short: "q" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		throw new CliUsageError(
			error instanceof Error ? error.message : String(error),
			{ hint: `Run "${CLI_NAME} doctor --help" for valid options` },
		);
	}

	if (values.help) {
		printDoctorHelp();
		return;
	}

	const format = (values.format as string | undefined) ?? "text";
	if (format !== "text" && format !== "json") {
		throw new CliUsageError("--format accepts text or json");
	}

	const noColor = Boolean(values["no-color"]);
	const quiet = Boolean(values.quiet);
	const style = createStyle({ noColor });

	await withCliStore(
		{
			dbPath: values.db as string | undefined,
			fresh: Boolean(values.fresh),
			quiet,
			json: format === "json",
			noColor,
		},
		async (s) => {
			const status = s.status();
			const pricing = s.pricingPayload();
			const dbPath = s.databasePath();
			const dbExists = existsSync(dbPath);
			const dbSizeBytes = dbExists ? statSync(dbPath).size : 0;

			const harnessDiagnostics = status.harnesses.map((h) => {
				const resolvedPaths = h.paths.map((p) => ({
					path: p,
					exists: existsSync(p),
				}));
				return {
					harness: h.harness,
					label: h.label,
					available: h.available,
					sessions: h.sessions,
					records: h.records,
					envVars: HARNESS_ENV_VARS[h.harness] ?? [],
					paths: resolvedPaths,
					warnings: h.warnings,
				};
			});

			const report = {
				version: CLI_VERSION,
				runtime: `Bun ${Bun.version}`,
				platform: `${process.platform}/${process.arch}`,
				database: {
					path: dbPath,
					exists: dbExists,
					sizeBytes: dbSizeBytes,
					indexedAt: status.indexedAt,
					sessions: status.totals.sessions,
					records: status.totals.records,
				},
				pricing: pricing.status,
				harnesses: harnessDiagnostics,
				warnings: status.warnings,
			};

			if (format === "json") {
				console.log(JSON.stringify(report, null, 2));
				return;
			}

			console.log(style.bold(`Coding Tokens Diagnostics (v${CLI_VERSION})`));
			console.log(
				`${style.dim("Runtime:")} Bun ${Bun.version}   ${style.dim("Platform:")} ${process.platform}/${process.arch}`,
			);
			console.log(
				`${style.dim("Database:")} ${shortenHome(dbPath)} (${dbExists ? `${(dbSizeBytes / 1024).toFixed(1)} KB` : "not created"})`,
			);
			console.log(
				`${style.dim("Index:")} ${formatNumber(status.totals.sessions)} sessions, ${formatNumber(status.totals.records)} records, updated ${formatTimestamp(status.indexedAt)}`,
			);
			console.log("");

			console.log(style.bold("Pricing Catalog"));
			console.log(
				`  State: ${pricing.status.state}, Models: ${formatNumber(pricing.status.modelCount)}, Custom rules: ${formatNumber(Object.keys(pricing.settings.customRules).length)}, Unpriced active: ${formatNumber(pricing.status.summary.unpricedModels)}`,
			);
			console.log(`  Endpoint: ${pricing.status.endpoint}`);
			console.log(`  Cache file: ${shortenHome(pricing.status.cachePath)}`);
			if (pricing.status.lastError) {
				console.log(
					`  ${style.yellow("Last error:")} ${pricing.status.lastError}`,
				);
			}
			console.log("");

			console.log(style.bold(`Harnesses (${harnessDiagnostics.length})`));
			for (const h of harnessDiagnostics) {
				const badge = h.available
					? style.green("detected")
					: style.dim("not found");
				const counts =
					h.records > 0
						? `  ${formatNumber(h.sessions)} sessions, ${formatNumber(h.records)} records`
						: "";
				console.log(
					`  ${style.bold(h.label)} (${h.harness})  [${badge}]${counts}`,
				);
				for (const entry of h.paths) {
					const mark = entry.exists ? style.green("+") : style.dim("-");
					console.log(`    ${mark} ${shortenHome(entry.path)}`);
				}
				if (h.envVars.length > 0) {
					console.log(
						`    ${style.dim(`Env overrides: ${h.envVars.join(", ")}`)}`,
					);
				}
				for (const w of h.warnings) {
					console.log(`    ${style.yellow(`Warning: ${w}`)}`);
				}
			}

			printWarnings(status.warnings, style, quiet);
		},
	);
}
