import { parseArgs } from "node:util";
import type {
	HarnessName,
	ModelReportRow,
	ProjectReportRow,
} from "@shared/types";
import {
	modelReportPayload,
	projectReportPayload,
} from "../../../server/data/reports";
import type { RecordFilters } from "../../../server/data/totals";
import {
	allHarnessIds,
	CLI_NAME,
	CliUsageError,
	getHarnessLabel,
	parseList,
	parseMultiList,
	parsePositiveInt,
	resolveProjectPaths,
	resolveTimeWindow,
} from "../args";
import { printWarnings, withCliStore } from "../data";
import {
	createStyle,
	formatCost,
	formatNumber,
	formatPercent,
	formatRelativeTime,
	formatTokens,
	renderTable,
	shortenHome,
} from "../terminal";

const MODEL_SORT_KEYS = [
	"cost",
	"tokens",
	"requests",
	"cache",
	"efficiency",
	"recent",
	"name",
] as const;
type ModelSortKey = (typeof MODEL_SORT_KEYS)[number];

const PROJECT_SORT_KEYS = [
	"cost",
	"tokens",
	"requests",
	"sessions",
	"recent",
	"name",
] as const;
type ProjectSortKey = (typeof PROJECT_SORT_KEYS)[number];

export function printModelsHelp(): void {
	console.log(`Usage: ${CLI_NAME} models [options]

Compare token volume, cache efficiency, pricing source, and cost per model.

Options:
  --harness <names>      Filter by harness (${allHarnessIds().join(", ")})
  --project <path>       Filter by project directory (repeatable)
  -r, --range <preset>   Time range: today, yesterday, 7d, 30d, 90d, 1y, all, <N>h/d/w
  --date <YYYY-MM-DD>    Filter to one local date
  --since <datetime>     Range start, inclusive
  --until <datetime>     Range end, inclusive
  --unpriced             Show only models missing price rules
  --sort <key>           Sort by: cost, tokens, requests, cache, efficiency, recent, name
                         (default: cost)
  --limit <n>            Limit rows shown in table mode
  -f, --format <fmt>     Output format: table or json (default: table)
  --fresh                Re-sync local index before querying
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  -q, --quiet            Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} models --range 30d
  ${CLI_NAME} models --unpriced
  ${CLI_NAME} models --sort efficiency --format json`);
}

export function printProjectsHelp(): void {
	console.log(`Usage: ${CLI_NAME} projects [options]

Compare sessions, token usage, and estimated cost across project directories.

Options:
  --harness <names>      Filter by harness (${allHarnessIds().join(", ")})
  --model <names>        Filter by model name (repeatable or comma-separated)
  -r, --range <preset>   Time range: today, yesterday, 7d, 30d, 90d, 1y, all, <N>h/d/w
  --date <YYYY-MM-DD>    Filter to one local date
  --since <datetime>     Range start, inclusive
  --until <datetime>     Range end, inclusive
  --sort <key>           Sort by: cost, tokens, requests, sessions, recent, name
                         (default: cost)
  --limit <n>            Limit rows shown in table mode
  -f, --format <fmt>     Output format: table or json (default: table)
  --fresh                Re-sync local index before querying
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  -q, --quiet            Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} projects --range 7d
  ${CLI_NAME} projects --sort sessions --limit 10`);
}

function rowTokens(row: {
	totals: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
}): number {
	return (
		row.totals.inputTokens +
		row.totals.outputTokens +
		row.totals.cacheReadTokens +
		row.totals.cacheWriteTokens
	);
}

function isModelUnpriced(row: ModelReportRow): boolean {
	return (
		row.pricing?.source === "unpriced" ||
		(row.totals.requests > 0 &&
			row.totals.unpricedRequests >= row.totals.requests)
	);
}

function compareNullableDesc(a: number | null, b: number | null): number {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return b - a;
}

function sortModelRows(rows: ModelReportRow[], sortBy: ModelSortKey): void {
	rows.sort((a, b) => {
		switch (sortBy) {
			case "tokens":
				return rowTokens(b) - rowTokens(a);
			case "requests":
				return b.totals.requests - a.totals.requests;
			case "cache":
				return compareNullableDesc(a.cacheReadShare, b.cacheReadShare);
			case "efficiency":
				return compareNullableDesc(
					a.costPerMillionTokens,
					b.costPerMillionTokens,
				);
			case "recent":
				return compareNullableDesc(a.lastActivityAt, b.lastActivityAt);
			case "name":
				return a.model.localeCompare(b.model);
			default:
				return (
					b.totals.costUsd - a.totals.costUsd || rowTokens(b) - rowTokens(a)
				);
		}
	});
}

function sortProjectRows(
	rows: ProjectReportRow[],
	sortBy: ProjectSortKey,
): void {
	rows.sort((a, b) => {
		switch (sortBy) {
			case "tokens":
				return rowTokens(b) - rowTokens(a);
			case "requests":
				return b.totals.requests - a.totals.requests;
			case "sessions":
				return b.totals.sessions - a.totals.sessions;
			case "recent":
				return compareNullableDesc(a.lastActivityAt, b.lastActivityAt);
			case "name":
				return a.name.localeCompare(b.name);
			default:
				return (
					b.totals.costUsd - a.totals.costUsd || rowTokens(b) - rowTokens(a)
				);
		}
	});
}

export async function runModelsCommand(args: string[]): Promise<void> {
	const harnesses = allHarnessIds();
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			allowPositionals: false,
			options: {
				harness: { type: "string" },
				project: { type: "string", multiple: true },
				range: { type: "string", short: "r" },
				date: { type: "string" },
				since: { type: "string" },
				until: { type: "string" },
				unpriced: { type: "boolean" },
				sort: { type: "string" },
				limit: { type: "string" },
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
			{ hint: `Run "${CLI_NAME} models --help" for valid options` },
		);
	}

	if (values.help) {
		printModelsHelp();
		return;
	}

	const format = (values.format as string | undefined) ?? "table";
	if (format !== "table" && format !== "json") {
		throw new CliUsageError("--format accepts table or json");
	}

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
	const projects = resolveProjectPaths(values.project as string[] | undefined);
	const sortList = parseList(
		values.sort as string | undefined,
		MODEL_SORT_KEYS,
		"--sort",
	);
	if (sortList && sortList.length !== 1) {
		throw new CliUsageError("--sort accepts exactly one value");
	}
	const sortBy: ModelSortKey = sortList?.[0] ?? "cost";
	const limit = parsePositiveInt(values.limit as string | undefined, "--limit");
	const unpricedOnly = Boolean(values.unpriced);
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
		async () => {
			const filters: RecordFilters = {
				from: window.fromMs,
				until: window.untilMs,
				harnesses: selectedHarnesses
					? new Set(selectedHarnesses as HarnessName[])
					: null,
				projects: projects ? new Set(projects) : null,
				models: null,
			};
			const payload = modelReportPayload(filters);
			const rows = unpricedOnly
				? payload.rows.filter(isModelUnpriced)
				: [...payload.rows];
			sortModelRows(rows, sortBy);

			const visible = limit !== undefined ? rows.slice(0, limit) : rows;

			if (format === "json") {
				console.log(
					JSON.stringify(
						{
							...payload,
							rows: visible,
						},
						null,
						2,
					),
				);
				printWarnings(payload.warnings, style, quiet);
				return;
			}

			if (visible.length === 0) {
				console.log(
					style.yellow(
						unpricedOnly
							? "All active models have pricing rules."
							: "No model usage records matched your filters.",
					),
				);
				if (!unpricedOnly) {
					console.log(
						style.dim(
							`Try widening "--range all" or run "${CLI_NAME} doctor" to inspect detected tools.`,
						),
					);
				}
				printWarnings(payload.warnings, style, quiet);
				return;
			}

			const tableRows = visible.map((row) => ({
				model: row.model,
				requests: formatNumber(row.totals.requests),
				tokens: formatTokens(rowTokens(row)),
				cache: formatPercent(row.cacheReadShare),
				cost: formatCost(
					row.totals.costUsd,
					row.totals.estimatedRequests > 0 || row.totals.unpricedRequests > 0,
					row.totals.unpricedRequests === row.totals.requests &&
						row.totals.requests > 0,
				),
				efficiency:
					row.costPerMillionTokens !== null
						? `$${row.costPerMillionTokens.toFixed(2)}/1M`
						: "-",
				pricing: row.pricing?.source ?? "-",
			}));

			console.log(
				renderTable({
					columns: [
						{
							key: "model",
							header: "Model",
							minWidth: 16,
							maxWidth: 36,
							shrinkPriority: 2,
						},
						{ key: "requests", header: "Requests", align: "right" },
						{ key: "tokens", header: "Tokens", align: "right" },
						{ key: "cache", header: "Cache Hit", align: "right" },
						{ key: "cost", header: "Cost", align: "right" },
						{ key: "efficiency", header: "$/1M", align: "right" },
						{ key: "pricing", header: "Pricing" },
					],
					rows: tableRows,
					footerRow: unpricedOnly
						? undefined
						: {
								model: "Total",
								requests: formatNumber(payload.totals.requests),
								tokens: formatTokens(rowTokens({ totals: payload.totals })),
								cache: "-",
								cost: formatCost(
									payload.totals.costUsd,
									payload.totals.estimatedRequests > 0 ||
										payload.totals.unpricedRequests > 0,
									payload.totals.unpricedRequests === payload.totals.requests &&
										payload.totals.requests > 0,
								),
								efficiency: "-",
								pricing: "",
							},
					style,
				}),
			);

			if (limit !== undefined && rows.length > limit) {
				console.log(
					style.dim(
						`Showing ${limit} of ${rows.length} models. Pass --limit ${rows.length} to see all.`,
					),
				);
			}
			const unpricedCount = rows.filter(isModelUnpriced).length;
			if (unpricedCount > 0) {
				console.log(
					style.dim(
						`${unpricedCount} unpriced model(s). Configure custom pricing with "${CLI_NAME} pricing set <model> --input <n> --output <n>".`,
					),
				);
			}
			printWarnings(payload.warnings, style, quiet);
		},
	);
}

export async function runProjectsCommand(args: string[]): Promise<void> {
	const harnesses = allHarnessIds();
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			allowPositionals: false,
			options: {
				harness: { type: "string" },
				model: { type: "string", multiple: true },
				range: { type: "string", short: "r" },
				date: { type: "string" },
				since: { type: "string" },
				until: { type: "string" },
				sort: { type: "string" },
				limit: { type: "string" },
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
			{ hint: `Run "${CLI_NAME} projects --help" for valid options` },
		);
	}

	if (values.help) {
		printProjectsHelp();
		return;
	}

	const format = (values.format as string | undefined) ?? "table";
	if (format !== "table" && format !== "json") {
		throw new CliUsageError("--format accepts table or json");
	}

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
	const sortList = parseList(
		values.sort as string | undefined,
		PROJECT_SORT_KEYS,
		"--sort",
	);
	if (sortList && sortList.length !== 1) {
		throw new CliUsageError("--sort accepts exactly one value");
	}
	const sortBy: ProjectSortKey = sortList?.[0] ?? "cost";
	const limit = parsePositiveInt(values.limit as string | undefined, "--limit");
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
		async () => {
			const filters: RecordFilters = {
				from: window.fromMs,
				until: window.untilMs,
				harnesses: selectedHarnesses
					? new Set(selectedHarnesses as HarnessName[])
					: null,
				projects: null,
				models: selectedModels ? new Set(selectedModels) : null,
			};
			const payload = projectReportPayload(filters);
			const rows = [...payload.rows];
			sortProjectRows(rows, sortBy);

			const visible = limit !== undefined ? rows.slice(0, limit) : rows;

			if (format === "json") {
				console.log(
					JSON.stringify(
						{
							...payload,
							rows: visible,
						},
						null,
						2,
					),
				);
				printWarnings(payload.warnings, style, quiet);
				return;
			}

			if (visible.length === 0) {
				console.log(
					style.yellow("No project usage records matched your filters."),
				);
				console.log(
					style.dim(
						`Try widening "--range all" or run "${CLI_NAME} doctor" to inspect detected tools.`,
					),
				);
				printWarnings(payload.warnings, style, quiet);
				return;
			}

			const tableRows = visible.map((row) => ({
				project: shortenHome(row.cwd),
				harnesses: row.harnesses.map(getHarnessLabel).join(", "),
				sessions: formatNumber(row.totals.sessions),
				requests: formatNumber(row.totals.requests),
				tokens: formatTokens(rowTokens(row)),
				cost: formatCost(
					row.totals.costUsd,
					row.totals.estimatedRequests > 0 || row.totals.unpricedRequests > 0,
					row.totals.unpricedRequests === row.totals.requests &&
						row.totals.requests > 0,
				),
				active: formatRelativeTime(row.lastActivityAt),
			}));

			console.log(
				renderTable({
					columns: [
						{
							key: "project",
							header: "Project",
							minWidth: 16,
							maxWidth: 38,
							shrinkPriority: 3,
						},
						{
							key: "harnesses",
							header: "Harnesses",
							minWidth: 10,
							maxWidth: 24,
							shrinkPriority: 2,
						},
						{ key: "sessions", header: "Sessions", align: "right" },
						{ key: "requests", header: "Requests", align: "right" },
						{ key: "tokens", header: "Tokens", align: "right" },
						{ key: "cost", header: "Cost", align: "right" },
						{ key: "active", header: "Last Active", align: "right" },
					],
					rows: tableRows,
					footerRow: {
						project: "Total",
						harnesses: "",
						sessions: formatNumber(payload.totals.sessions),
						requests: formatNumber(payload.totals.requests),
						tokens: formatTokens(rowTokens({ totals: payload.totals })),
						cost: formatCost(
							payload.totals.costUsd,
							payload.totals.estimatedRequests > 0 ||
								payload.totals.unpricedRequests > 0,
							payload.totals.unpricedRequests === payload.totals.requests &&
								payload.totals.requests > 0,
						),
						active: "",
					},
					style,
				}),
			);

			if (limit !== undefined && rows.length > limit) {
				console.log(
					style.dim(
						`Showing ${limit} of ${rows.length} projects. Pass --limit ${rows.length} to see all.`,
					),
				);
			}
			printWarnings(payload.warnings, style, quiet);
		},
	);
}
