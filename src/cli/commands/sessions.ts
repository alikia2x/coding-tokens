import { parseArgs } from "node:util";
import type { SessionDetailLevel, SessionSummary } from "@shared/types";
import { sessionSearchMatches } from "../../../server/data/search";
import { sessionDetailPayload } from "../../../server/data/session-detail";
import { renderSingleSessionExport } from "../../../server/data/session-export";
import {
	allHarnessIds,
	CLI_NAME,
	CliUsageError,
	EXPORT_DETAIL_LEVELS,
	getHarnessLabel,
	parseList,
	parseMultiList,
	parsePositiveInt,
	resolveProjectPaths,
	resolveTimeWindow,
} from "../args";
import { printWarnings, resolveSessionKey, withCliStore } from "../data";
import {
	createStyle,
	formatCost,
	formatDuration,
	formatNumber,
	formatRelativeTime,
	formatTimestamp,
	formatTokens,
	renderTable,
	shortenHome,
} from "../terminal";

const SORT_KEYS = ["recent", "cost", "tokens", "requests", "title"] as const;
type SessionSortKey = (typeof SORT_KEYS)[number];

export function printSessionsHelp(): void {
	console.log(`Usage: ${CLI_NAME} sessions [query] [options]
       ${CLI_NAME} search <query> [options]
       ${CLI_NAME} sessions show <session-id> [options]

List, search, and inspect AI coding sessions using the local FTS5 index.

Subactions:
  sessions [query]       List sessions or run boolean/full-text search
  sessions show <id>     Inspect messages, tool calls, and metrics for a session

Search & Filter Options:
  -q, --query <text>     Search query (supports AND, OR, -exclude, "phrases", harness:)
  --harness <names>      Filter by harness (${allHarnessIds().join(", ")})
  --model <names>        Filter by model name
  --project <path>       Filter by project directory (repeatable)
  -r, --range <preset>   Time range: today, yesterday, 7d, 30d, 90d, 1y, all, <N>h/d/w
  --date <YYYY-MM-DD>    Filter to one local date
  --since <datetime>     Range start, inclusive
  --until <datetime>     Range end, inclusive
  --include-internal     Include subagent and internal review sessions

Display Options:
  --sort <key>           Sort by: recent, cost, tokens, requests, title (default: recent)
  --limit <n>            Max sessions to display in table mode (default: 20)
  -f, --format <fmt>     Output format: table or json (default: table)
  --fresh                Re-sync local index before querying
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  --quiet                Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} sessions --range 7d --sort cost
  ${CLI_NAME} search "authentication OR oauth" --harness claude
  ${CLI_NAME} sessions show <session-id> --stats`);
}

export function printShowHelp(): void {
	console.log(`Usage: ${CLI_NAME} show <session-id> [options]
       ${CLI_NAME} sessions show <session-id> [options]

Inspect a single session transcript, token breakdown, and generation metrics.

Options:
  --detail <level>       Detail level: ${EXPORT_DETAIL_LEVELS.join(", ")}
                         (default: chat_compact)
  --stats                Show generation performance metrics (TTFT, throughput, durations)
  -f, --format <fmt>     Output format: text, markdown, or json (default: text)
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  --quiet                Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} show abc12345
  ${CLI_NAME} show codex:abc12345 --detail chat_tools --stats
  ${CLI_NAME} show abc12345 --format markdown > session.md`);
}

function totalTokens(s: SessionSummary): number {
	return (
		s.totals.inputTokens +
		s.totals.outputTokens +
		s.totals.cacheReadTokens +
		s.totals.cacheWriteTokens
	);
}

function shortKey(key: string): string {
	const sep = key.indexOf(":");
	const id = sep > 0 ? key.slice(sep + 1) : key;
	if (id.length <= 14) return key;
	const prefix = sep > 0 ? `${key.slice(0, sep)}:` : "";
	return `${prefix}${id.slice(0, 12)}`;
}

export async function runShowCommand(args: string[]): Promise<void> {
	let values: ReturnType<typeof parseArgs>["values"];
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				detail: { type: "string" },
				stats: { type: "boolean" },
				format: { type: "string", short: "f" },
				db: { type: "string" },
				"no-color": { type: "boolean" },
				quiet: { type: "boolean", short: "q" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		throw new CliUsageError(
			error instanceof Error ? error.message : String(error),
			{ hint: `Run "${CLI_NAME} show --help" for usage` },
		);
	}

	if (values.help) {
		printShowHelp();
		return;
	}

	const targetId = positionals[0];
	if (!targetId) {
		throw new CliUsageError("Missing session ID", {
			hint: `Run "${CLI_NAME} sessions" to find a session ID, then pass "${CLI_NAME} show <id>"`,
		});
	}

	const detailList = parseList(
		values.detail as string | undefined,
		EXPORT_DETAIL_LEVELS,
		"--detail",
	);
	if (detailList && detailList.length !== 1) {
		throw new CliUsageError("--detail accepts exactly one level");
	}
	const level: SessionDetailLevel = detailList?.[0] ?? "chat_compact";

	const format = (values.format as string | undefined) ?? "text";
	if (format !== "text" && format !== "markdown" && format !== "json") {
		throw new CliUsageError("--format accepts text, markdown, or json");
	}

	const showStats = Boolean(values.stats);
	const noColor = Boolean(values["no-color"]);
	const quiet = Boolean(values.quiet);
	const style = createStyle({ noColor });

	await withCliStore(
		{
			dbPath: values.db as string | undefined,
			quiet,
			json: format === "json",
			noColor,
		},
		async (s) => {
			const key = resolveSessionKey(s, targetId);

			if (format === "markdown") {
				const exported = await renderSingleSessionExport(key, level);
				process.stdout.write(exported.markdown);
				return;
			}

			const payload = await sessionDetailPayload(key, level);
			if (format === "json") {
				console.log(JSON.stringify(payload, null, 2));
				printWarnings(payload.warnings, style, quiet);
				return;
			}

			const { summary, stats, items } = payload;
			const cost = formatCost(
				summary.totals.costUsd,
				summary.totals.estimatedRequests > 0 ||
					summary.totals.unpricedRequests > 0,
				summary.totals.unpricedRequests === summary.totals.requests &&
					summary.totals.requests > 0,
			);

			console.log(style.bold(summary.title));
			console.log(
				`${style.dim("Key:")} ${summary.key}   ${style.dim("Harness:")} ${getHarnessLabel(summary.harness)}   ${style.dim("Project:")} ${shortenHome(summary.cwd)}`,
			);
			console.log(
				`${style.dim("Started:")} ${formatTimestamp(summary.startedAt)}   ${style.dim("Duration:")} ${formatDuration(summary.durationMs)}   ${style.dim("Models:")} ${summary.models.join(", ") || "-"}`,
			);
			console.log(
				`${style.dim("Usage:")} ${formatNumber(summary.totals.requests)} requests, ${formatTokens(totalTokens(summary))} tokens, ${style.green(cost)}`,
			);

			if (showStats && stats.metrics) {
				const m = stats.metrics;
				console.log("");
				console.log(style.bold("Generation Metrics"));
				console.log(
					`  Turns: ${formatNumber(stats.turns)} (measured ${formatNumber(m.measuredTurns)}), Tool calls: ${formatNumber(stats.toolCalls)}`,
				);
				console.log(
					`  TTFT avg: ${formatDuration(m.avgTtftMs)}, p50: ${formatDuration(m.p50TtftMs)}, Throughput: ${m.tokensPerSecond !== null ? `${m.tokensPerSecond.toFixed(1)} tok/s` : "-"}`,
				);
				console.log(
					`  Model time: ${formatDuration(m.modelDurationMs)}, Tool time: ${formatDuration(m.toolDurationMs)}`,
				);
			}

			console.log("");
			console.log(style.dim("-".repeat(72)));

			if (items.length === 0) {
				console.log(
					style.yellow(
						`No transcript items available at detail level "${level}".`,
					),
				);
				console.log(
					style.dim(
						`Try passing "--detail agent" or inspect the full list with "${CLI_NAME} sessions".`,
					),
				);
			} else {
				for (const item of items) {
					const ts = item.timestamp
						? style.dim(` (${formatTimestamp(item.timestamp)})`)
						: "";
					if (item.kind === "tool_call") {
						const name = item.name ?? "tool";
						console.log(
							`\n${style.magenta(`[TOOL ${name}]`)}${ts}${item.status ? ` ${style.dim(item.status)}` : ""}`,
						);
						if (item.inputText) {
							console.log(style.dim(item.inputText.trimEnd()));
						}
						continue;
					}
					if (item.kind === "tool_result") {
						const name = item.name ? ` ${item.name}` : "";
						console.log(
							`\n${style.yellow(`[RESULT${name}]`)}${ts}${item.status ? ` ${style.dim(item.status)}` : ""}`,
						);
						if (item.outputText) {
							console.log(style.dim(item.outputText.trimEnd()));
						}
						continue;
					}
					const roleBadge =
						item.role === "user"
							? style.cyan("[USER]")
							: item.role === "assistant"
								? style.green("[ASSISTANT]")
								: style.dim(`[${item.role.toUpperCase()}]`);
					console.log(`\n${roleBadge}${ts}`);
					if (item.text) {
						console.log(item.text.trimEnd());
					}
				}
			}

			printWarnings(payload.warnings, style, quiet);
		},
	);
}

export async function runSessionsCommand(
	args: string[],
	requireQuery = false,
): Promise<void> {
	if (!requireQuery && args[0] === "show") {
		await runShowCommand(args.slice(1));
		return;
	}

	const harnesses = allHarnessIds();
	let values: ReturnType<typeof parseArgs>["values"];
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				query: { type: "string", short: "q" },
				harness: { type: "string" },
				model: { type: "string", multiple: true },
				project: { type: "string", multiple: true },
				range: { type: "string", short: "r" },
				date: { type: "string" },
				since: { type: "string" },
				until: { type: "string" },
				"include-internal": { type: "boolean" },
				sort: { type: "string" },
				limit: { type: "string" },
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
			{ hint: `Run "${CLI_NAME} sessions --help" for valid options` },
		);
	}

	if (values.help) {
		printSessionsHelp();
		return;
	}

	const format = (values.format as string | undefined) ?? "table";
	if (format !== "table" && format !== "json") {
		throw new CliUsageError("--format accepts table or json");
	}

	const queryText =
		(values.query as string | undefined) ??
		(positionals.length ? positionals.join(" ") : "");
	if (requireQuery && !queryText.trim()) {
		throw new CliUsageError("Search query is required", {
			hint: `Example: ${CLI_NAME} search "auth AND token"`,
		});
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
	const projects = resolveProjectPaths(values.project as string[] | undefined);
	const includeInternal = Boolean(values["include-internal"]);
	const sortList = parseList(
		values.sort as string | undefined,
		SORT_KEYS,
		"--sort",
	);
	if (sortList && sortList.length !== 1) {
		throw new CliUsageError("--sort accepts exactly one value");
	}
	const sortBy: SessionSortKey | undefined = sortList?.[0];
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
		async (s) => {
			const rangeArg = { from: window.fromMs, until: window.untilMs };
			const allSummaries = s.sessionSummaries(rangeArg);
			const summaryByKey = new Map(
				allSummaries.map((item) => [item.key, item]),
			);

			let ordered: SessionSummary[];
			let snippets: Record<string, string> = {};

			if (queryText.trim()) {
				const searchRes = sessionSearchMatches(queryText, rangeArg);
				snippets = searchRes.snippets;
				ordered = searchRes.keys
					.map((k) => summaryByKey.get(k))
					.filter((item): item is SessionSummary => Boolean(item));
			} else {
				ordered = allSummaries;
			}

			const harnessSet = selectedHarnesses ? new Set(selectedHarnesses) : null;
			const projectSet = projects ? new Set(projects) : null;
			const modelSet = selectedModels
				? new Set(selectedModels.map((m) => m.toLowerCase()))
				: null;

			const filtered = ordered.filter((session) => {
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
			});

			if (sortBy) {
				filtered.sort((a, b) => {
					if (sortBy === "cost") {
						return b.totals.costUsd - a.totals.costUsd;
					}
					if (sortBy === "tokens") {
						return totalTokens(b) - totalTokens(a);
					}
					if (sortBy === "requests") {
						return b.totals.requests - a.totals.requests;
					}
					if (sortBy === "title") {
						return a.title.localeCompare(b.title);
					}
					return (
						(b.lastActivityAt ?? b.startedAt ?? 0) -
						(a.lastActivityAt ?? a.startedAt ?? 0)
					);
				});
			}

			const effectiveLimit =
				limit ?? (format === "table" ? 20 : filtered.length);
			const visible = filtered.slice(0, effectiveLimit);

			if (format === "json") {
				console.log(
					JSON.stringify(
						{
							query: queryText.trim() || null,
							total: filtered.length,
							sessions: visible.map((session) => ({
								...session,
								...(snippets[session.key]
									? { snippet: snippets[session.key] }
									: {}),
							})),
						},
						null,
						2,
					),
				);
				printWarnings(s.warningList(), style, quiet);
				return;
			}

			if (visible.length === 0) {
				console.log(style.yellow("No matching sessions found."));
				console.log(
					style.dim(
						queryText.trim()
							? `Try simplifying your search terms or widening "--range all".`
							: `Try "--range all", "--include-internal", or run "${CLI_NAME} doctor".`,
					),
				);
				printWarnings(s.warningList(), style, quiet);
				return;
			}

			const rows = visible.map((session) => ({
				id: shortKey(session.key),
				title: session.title,
				harness: getHarnessLabel(session.harness),
				project: shortenHome(session.cwd),
				tokens: formatTokens(totalTokens(session)),
				cost: formatCost(
					session.totals.costUsd,
					session.totals.estimatedRequests > 0 ||
						session.totals.unpricedRequests > 0,
					session.totals.unpricedRequests === session.totals.requests &&
						session.totals.requests > 0,
				),
				updated: formatRelativeTime(
					session.lastActivityAt ?? session.startedAt,
				),
			}));

			console.log(
				renderTable({
					columns: [
						{ key: "id", header: "Session", minWidth: 14, maxWidth: 24 },
						{
							key: "title",
							header: "Title",
							minWidth: 16,
							maxWidth: 38,
							shrinkPriority: 3,
						},
						{ key: "harness", header: "Harness", minWidth: 8, maxWidth: 14 },
						{
							key: "project",
							header: "Project",
							minWidth: 12,
							maxWidth: 26,
							shrinkPriority: 2,
						},
						{ key: "tokens", header: "Tokens", align: "right" },
						{ key: "cost", header: "Cost", align: "right" },
						{ key: "updated", header: "Updated", align: "right" },
					],
					rows,
					style,
				}),
			);

			if (queryText.trim()) {
				const matchedSnippets = visible
					.map((sess) => ({
						key: shortKey(sess.key),
						snippet: snippets[sess.key],
					}))
					.filter((entry) => Boolean(entry.snippet));
				if (matchedSnippets.length > 0) {
					console.log("");
					console.log(style.dim("Matched snippets:"));
					for (const entry of matchedSnippets.slice(0, 8)) {
						console.log(
							`  ${style.cyan(entry.key)}  ${style.dim(entry.snippet ?? "")}`,
						);
					}
				}
			}

			console.log("");
			const hiddenNote =
				filtered.length > visible.length
					? `Showing ${visible.length} of ${filtered.length} sessions (use --limit ${filtered.length} for all). `
					: `Total: ${filtered.length} session(s). `;
			console.log(
				style.dim(
					`${hiddenNote}Inspect a session with "${CLI_NAME} show <session-id>".`,
				),
			);
			printWarnings(s.warningList(), style, quiet);
		},
	);
}
