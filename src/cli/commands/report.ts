import { parseArgs } from "node:util";
import { createReport, type GroupField, type GroupRow } from "../../aggregate";
import { defaultPlatformPathService } from "../../platform/paths";
import { enrichWithModelsDev } from "../../pricing/modelsdev";
import { defaultHarnessRegistry } from "../../providers/registry";
import type { SourceResult, UsageRecord } from "../../types";
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
	createSpinner,
	createStyle,
	formatCost,
	formatNumber,
	formatTokens,
	renderTable,
	shortenHome,
	type TableColumn,
} from "../terminal";

const GROUP_FIELDS = ["harness", "project", "model", "day", "session"] as const;
const SORT_KEYS = [
	"volume",
	"cost",
	"tokens",
	"requests",
	"sessions",
	"name",
] as const;
type SortKey = (typeof SORT_KEYS)[number];

const FIELD_LABELS: Record<GroupField, string> = {
	harness: "Harness",
	project: "Project",
	model: "Model",
	day: "Date",
	session: "Session",
};

export function printReportHelp(): void {
	console.log(`Usage: ${CLI_NAME} report [options]
       ${CLI_NAME} [options]

Aggregate token usage and estimated cost across coding harnesses.

Grouping & Filtering:
  --by <fields>          Group by harness, project, model, day, or session
                         (default: harness,project,model)
  --harness <names>      Comma-separated harnesses (${allHarnessIds().join(", ")})
  --model <names>        Filter to one or more models (repeatable or comma-separated)
  --project <path>       Filter to a project directory (repeatable)
  -r, --range <preset>   Time range: today, yesterday, 7d, 30d, 90d, 1y, all, <N>h/d/w
  --date <YYYY-MM-DD>    Filter to one local calendar date
  --since <datetime>     Range start, inclusive (YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS])
  --until <datetime>     Range end, inclusive of the named unit
  --exclude-internal     Exclude subagent and review traffic from totals

Display & Output:
  -f, --format <fmt>     Output format: table or json (default: table)
  --sort <key>           Sort groups by: cost, tokens, requests, sessions, name
  --limit <n>            Limit the number of rows shown in table output
  --exact                Show exact uncompacted token counts in table mode
  --no-index             Skip local SQLite index and scan raw harness files directly
  --fresh                Force re-syncing the local index before reporting
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  -q, --quiet            Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} --range 7d --by model
  ${CLI_NAME} report --harness codex,claude --by day --sort cost
  ${CLI_NAME} report --project ~/Code/my-app --format json`);
}

function rowTotalTokens(row: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}): number {
	return (
		row.inputTokens +
		row.outputTokens +
		row.cacheReadTokens +
		row.cacheWriteTokens
	);
}

function sortGroupRows(
	groups: GroupRow[],
	sortBy: SortKey,
	groupBy: GroupField[],
): GroupRow[] {
	if (sortBy === "volume") return groups;
	const copy = [...groups];
	copy.sort((a, b) => {
		if (sortBy === "cost") {
			return b.costUsd - a.costUsd || rowTotalTokens(b) - rowTotalTokens(a);
		}
		if (sortBy === "tokens") {
			return rowTotalTokens(b) - rowTotalTokens(a) || b.costUsd - a.costUsd;
		}
		if (sortBy === "requests") {
			return b.requests - a.requests || b.costUsd - a.costUsd;
		}
		if (sortBy === "sessions") {
			return b.sessions - a.sessions || b.costUsd - a.costUsd;
		}
		const aLabel = groupBy.map((f) => a.values[f] ?? "").join(" ");
		const bLabel = groupBy.map((f) => b.values[f] ?? "").join(" ");
		return aLabel.localeCompare(bLabel);
	});
	return copy;
}

export async function runReportCommand(args: string[]): Promise<void> {
	const harnesses = allHarnessIds();
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			allowPositionals: false,
			options: {
				by: { type: "string" },
				harness: { type: "string" },
				model: { type: "string", multiple: true },
				project: { type: "string", multiple: true },
				range: { type: "string", short: "r" },
				date: { type: "string" },
				since: { type: "string" },
				until: { type: "string" },
				format: { type: "string", short: "f" },
				sort: { type: "string" },
				limit: { type: "string" },
				"exclude-internal": { type: "boolean" },
				"include-internal": { type: "boolean" },
				exact: { type: "boolean" },
				"no-index": { type: "boolean" },
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
			{ hint: `Run "${CLI_NAME} report --help" for valid options` },
		);
	}

	if (values.help) {
		printReportHelp();
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

	const groupBy = parseList(
		values.by as string | undefined,
		GROUP_FIELDS,
		"--by",
	) ?? ["harness", "project", "model"];
	const selectedHarnesses =
		parseList(values.harness as string | undefined, harnesses, "--harness") ??
		harnesses;
	const selectedModels = parseMultiList(values.model as string[] | undefined);
	const projects = resolveProjectPaths(values.project as string[] | undefined);
	const sortList = parseList(
		values.sort as string | undefined,
		SORT_KEYS,
		"--sort",
	);
	if (sortList && sortList.length !== 1) {
		throw new CliUsageError("--sort accepts exactly one value");
	}
	const sortBy: SortKey = sortList?.[0] ?? "volume";
	const limit = parsePositiveInt(values.limit as string | undefined, "--limit");
	const excludeInternal = Boolean(values["exclude-internal"]);
	const exact = Boolean(values.exact);
	const noIndex = Boolean(values["no-index"]);
	const fresh = Boolean(values.fresh);
	const dbPath = values.db as string | undefined;
	const noColor = Boolean(values["no-color"]);
	const quiet = Boolean(values.quiet);
	const style = createStyle({ noColor });

	let sources: SourceResult[] = [];
	let warnings: string[] = [];

	if (noIndex) {
		const spinner = createSpinner({
			quiet,
			json: format === "json",
			noColor,
		});
		spinner.start("Scanning harness logs...");
		try {
			for (const harness of selectedHarnesses) {
				const provider = defaultHarnessRegistry.get(harness);
				if (!provider) continue;
				spinner.update(`Reading ${provider.metadata.displayName}...`);
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
			spinner.update("Resolving model pricing...");
			const pricingWarning = await enrichWithModelsDev(
				sources.flatMap((item) => item.records),
			);
			warnings = sources.flatMap((s) => s.warnings);
			if (pricingWarning) warnings.push(pricingWarning);
		} finally {
			spinner.stop();
		}
	} else {
		await withCliStore(
			{ dbPath, fresh, quiet, json: format === "json", noColor },
			async (s) => {
				const selectedSet = new Set(selectedHarnesses);
				const byHarness = new Map<string, UsageRecord[]>();
				for (const record of s.allRecords()) {
					if (!selectedSet.has(record.harness)) continue;
					const list = byHarness.get(record.harness) ?? [];
					list.push(record);
					byHarness.set(record.harness, list);
				}
				sources = selectedHarnesses.map((harness) => {
					const src = s.source(harness);
					return {
						harness,
						available: src?.available ?? false,
						records: byHarness.get(harness) ?? [],
						warnings: src?.warnings ?? [],
						messages: new Map(),
					};
				});
				warnings = s.warningList();
			},
		);
	}

	if (selectedModels || excludeInternal) {
		const modelSet = selectedModels
			? new Set(selectedModels.map((m) => m.toLowerCase()))
			: null;
		sources = sources.map((source) => ({
			...source,
			records: source.records.filter((record) => {
				if (excludeInternal && (record.isSubagent || record.isReview)) {
					return false;
				}
				if (modelSet) {
					const name = record.model.toLowerCase();
					const raw = (record.rawModel ?? "").toLowerCase();
					if (!modelSet.has(name) && !modelSet.has(raw)) return false;
				}
				return true;
			}),
		}));
	}

	const report = createReport(sources, {
		harnesses: new Set(selectedHarnesses),
		projects: projects ? new Set(projects) : undefined,
		groupBy,
		date: window.date,
		since: window.since?.ms ?? window.range?.sinceMs ?? undefined,
		until: window.until?.ms ?? window.range?.untilMs ?? undefined,
	});

	const sortedGroups = sortGroupRows(report.groups, sortBy, groupBy);

	if (format === "json") {
		const finalGroups =
			limit !== undefined ? sortedGroups.slice(0, limit) : sortedGroups;
		console.log(
			JSON.stringify(
				{
					groupBy,
					filters: {
						harnesses: selectedHarnesses,
						projects: projects ?? [],
						...(selectedModels ? { models: selectedModels } : {}),
						...(window.range ? { range: window.range.label } : {}),
						date: window.date ?? null,
						since: window.since?.text ?? null,
						until: window.until?.text ?? null,
					},
					totals: report.totals,
					groups: finalGroups,
				},
				null,
				2,
			),
		);
		printWarnings(warnings, style, quiet);
		return;
	}

	if (sortedGroups.length === 0) {
		console.log(style.yellow("No usage records found."));
		console.log(
			style.dim(
				`Try widening the time range with "--range all", removing filters, or running "${CLI_NAME} doctor" to inspect detected tools.`,
			),
		);
		printWarnings(warnings, style, quiet);
		return;
	}

	const displayGroups =
		limit !== undefined ? sortedGroups.slice(0, limit) : sortedGroups;

	const columns: TableColumn[] = [
		...groupBy.map((field) => ({
			key: field,
			header: FIELD_LABELS[field],
			minWidth: field === "day" ? 10 : 8,
			maxWidth: field === "project" ? 34 : field === "session" ? 28 : 30,
			shrinkPriority:
				field === "project"
					? 3
					: field === "session"
						? 2
						: field === "model"
							? 1
							: 0,
		})),
		{ key: "sessions", header: "Sessions", align: "right" },
		{ key: "requests", header: "Requests", align: "right" },
		{ key: "input", header: "Input", align: "right" },
		{ key: "output", header: "Output", align: "right" },
		{ key: "cacheRead", header: "Cache Read", align: "right" },
		{ key: "cacheWrite", header: "Cache Write", align: "right" },
		{ key: "reasoning", header: "Reasoning", align: "right" },
		{ key: "cost", header: "Cost", align: "right" },
	];

	const toDisplayRow = (
		totals: typeof report.totals,
		valuesMap?: GroupRow["values"],
		isTotal = false,
	): Record<string, string> => {
		const row: Record<string, string> = {};
		for (const [index, field] of groupBy.entries()) {
			let value = isTotal && index === 0 ? "Total" : (valuesMap?.[field] ?? "");
			if (!isTotal && field === "harness") value = getHarnessLabel(value);
			if (!isTotal && field === "project") value = shortenHome(value);
			row[field] = value;
		}
		row.sessions = formatNumber(totals.sessions);
		row.requests = formatNumber(totals.requests);
		row.input = formatTokens(totals.inputTokens, exact);
		row.output = formatTokens(totals.outputTokens, exact);
		row.cacheRead = formatTokens(totals.cacheReadTokens, exact);
		row.cacheWrite = formatTokens(totals.cacheWriteTokens, exact);
		row.reasoning = formatTokens(totals.reasoningTokens, exact);
		row.cost = formatCost(
			totals.costUsd,
			totals.estimatedRequests > 0 || totals.unpricedRequests > 0,
			totals.unpricedRequests === totals.requests && totals.requests > 0,
			exact,
		);
		return row;
	};

	const rows = displayGroups.map((group) =>
		toDisplayRow(group, group.values, false),
	);
	const footerRow = toDisplayRow(report.totals, undefined, true);

	const totalTok = rowTotalTokens(report.totals);
	const totalCostStr = formatCost(
		report.totals.costUsd,
		report.totals.estimatedRequests > 0 || report.totals.unpricedRequests > 0,
		report.totals.unpricedRequests === report.totals.requests &&
			report.totals.requests > 0,
		exact,
	);

	console.log(
		`${style.bold("Usage Summary")}  Sessions: ${style.cyan(formatNumber(report.totals.sessions))}, Requests: ${style.cyan(formatNumber(report.totals.requests))}, Tokens: ${style.cyan(formatTokens(totalTok, exact))}, Cost: ${style.green(totalCostStr)}`,
	);
	console.log("");
	console.log(
		renderTable({
			columns,
			rows,
			footerRow,
			style,
		}),
	);

	if (limit !== undefined && sortedGroups.length > limit) {
		console.log(
			style.dim(
				`Showing ${limit} of ${sortedGroups.length} groups. Pass --limit ${sortedGroups.length} to see all.`,
			),
		);
	}
	if (report.totals.unpricedRequests > 0) {
		console.log(
			style.dim(
				`${formatNumber(report.totals.unpricedRequests)} unpriced request(s) excluded from cost. Run "${CLI_NAME} models --unpriced" to review.`,
			),
		);
	}

	printWarnings(warnings, style, quiet);
}
