import { parseArgs } from "node:util";
import { CLI_NAME, CliUsageError, parsePositiveInt } from "../args";
import { withCliStore } from "../data";
import {
	createSpinner,
	createStyle,
	formatNumber,
	formatTimestamp,
	renderTable,
	shortenHome,
} from "../terminal";

export function printPricingHelp(): void {
	console.log(`Usage: ${CLI_NAME} pricing [subaction] [options]

Inspect model pricing catalog status, search catalog rates, and manage custom rules.

Subactions:
  status                 Show catalog cache, active models summary, and rule counts (default)
  search <query>         Search models.dev catalog rates
  refresh                Fetch and cache the latest models.dev catalog
  rules                  List custom pricing and alias rules
  set <model>            Create or update a custom price rule or alias
  remove <model>         Delete a custom price rule

Set Options:
  --input <usd>          Input USD per 1M tokens (required unless --alias is used)
  --output <usd>         Output USD per 1M tokens (required unless --alias is used)
  --cache-read <usd>     Cache read USD per 1M tokens
  --cache-write <usd>    Cache write USD per 1M tokens
  --reasoning <usd>      Reasoning USD per 1M tokens
  --alias <target>       Map model to another catalog/model ID instead of fixed rates
  --override             Override recorded harness cost when present
  --note <text>          Optional note describing the rule

General Options:
  --limit <n>            Max search results (default: 20)
  -f, --format <fmt>     Output format: table or json (default: table)
  --db <path>            Override local SQLite database path
  --no-color             Disable colored terminal output
  -q, --quiet            Suppress warnings and progress spinners
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} pricing status
  ${CLI_NAME} pricing search "claude sonnet"
  ${CLI_NAME} pricing set my-custom-model --input 1.5 --output 6.0 --override
  ${CLI_NAME} pricing set glm-4-proxy --alias zhipuai/glm-4.5`);
}

function parseOptionalRate(
	raw: string | undefined,
	flag: string,
): number | null {
	if (raw === undefined) return null;
	const num = Number(raw);
	if (!Number.isFinite(num) || num < 0) {
		throw new CliUsageError(`${flag} must be a non-negative number`);
	}
	return num;
}

function fmtRate(rate: number | null | undefined): string {
	if (rate === null || rate === undefined) return "-";
	return `$${rate}`;
}

export async function runPricingCommand(args: string[]): Promise<void> {
	let values: ReturnType<typeof parseArgs>["values"];
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				input: { type: "string" },
				output: { type: "string" },
				"cache-read": { type: "string" },
				"cache-write": { type: "string" },
				reasoning: { type: "string" },
				alias: { type: "string" },
				override: { type: "boolean" },
				note: { type: "string" },
				limit: { type: "string" },
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
			{ hint: `Run "${CLI_NAME} pricing --help" for valid options` },
		);
	}

	if (values.help) {
		printPricingHelp();
		return;
	}

	const format = (values.format as string | undefined) ?? "table";
	if (format !== "table" && format !== "json") {
		throw new CliUsageError("--format accepts table or json");
	}

	const subaction = positionals[0] ?? "status";
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
			if (subaction === "status") {
				const payload = s.pricingPayload();
				if (format === "json") {
					console.log(JSON.stringify(payload, null, 2));
					return;
				}
				const st = payload.status;
				console.log(style.bold("Pricing Catalog Status"));
				console.log(`  State: ${st.state}`);
				console.log(`  Endpoint: ${st.endpoint}`);
				console.log(`  Cache file: ${shortenHome(st.cachePath)}`);
				console.log(`  Last fetched: ${formatTimestamp(st.fetchedAt)}`);
				console.log(
					`  Catalog size: ${formatNumber(st.modelCount)} models across ${formatNumber(st.providerCount)} providers`,
				);
				console.log(
					`  Active models: ${formatNumber(st.summary.activeModels)} (custom ${formatNumber(st.summary.customModels)}, catalog ${formatNumber(st.summary.catalogModels)}, fallback ${formatNumber(st.summary.fallbackModels)}, unpriced ${formatNumber(st.summary.unpricedModels)})`,
				);
				console.log(
					`  Custom rules: ${formatNumber(Object.keys(payload.settings.customRules).length)}`,
				);
				if (st.lastError) {
					console.log(`  ${style.yellow("Last error:")} ${st.lastError}`);
				}
				return;
			}

			if (subaction === "search") {
				const query = positionals.slice(1).join(" ").trim();
				if (!query) {
					throw new CliUsageError("Search query is required", {
						hint: `Example: ${CLI_NAME} pricing search "claude sonnet"`,
					});
				}
				const limit =
					parsePositiveInt(values.limit as string | undefined, "--limit") ?? 20;
				const items = s.searchPricingCatalog(query, limit);
				if (format === "json") {
					console.log(JSON.stringify({ query, items }, null, 2));
					return;
				}
				if (items.length === 0) {
					console.log(style.yellow(`No catalog models matched "${query}".`));
					return;
				}
				console.log(
					renderTable({
						columns: [
							{
								key: "provider",
								header: "Provider",
								minWidth: 10,
								maxWidth: 18,
							},
							{
								key: "id",
								header: "Catalog ID",
								minWidth: 16,
								maxWidth: 34,
								shrinkPriority: 2,
							},
							{
								key: "name",
								header: "Name",
								minWidth: 14,
								maxWidth: 28,
								shrinkPriority: 3,
							},
							{ key: "input", header: "In $/1M", align: "right" },
							{ key: "output", header: "Out $/1M", align: "right" },
							{ key: "cacheRead", header: "Cache R", align: "right" },
							{ key: "cacheWrite", header: "Cache W", align: "right" },
						],
						rows: items.map((item) => ({
							provider: item.provider,
							id: item.id,
							name: item.name,
							input: fmtRate(item.rates?.input),
							output: fmtRate(item.rates?.output),
							cacheRead: fmtRate(item.rates?.cacheRead),
							cacheWrite: fmtRate(item.rates?.cacheWrite),
						})),
						style,
					}),
				);
				return;
			}

			if (subaction === "refresh") {
				const spinner = createSpinner({
					quiet,
					json: format === "json",
					noColor,
				});
				spinner.start("Refreshing pricing catalog...");
				let res: Awaited<ReturnType<typeof s.refreshPricingCatalog>>;
				try {
					res = await s.refreshPricingCatalog("manual");
				} finally {
					spinner.stop();
				}
				if (format === "json") {
					console.log(JSON.stringify(res, null, 2));
					return;
				}
				if (res.attempt.status === "ok") {
					console.log(
						`${style.green("Catalog refreshed:")} ${formatNumber(res.attempt.modelCount ?? 0)} models across ${formatNumber(res.attempt.providerCount ?? 0)} providers (${res.attempt.durationMs}ms).`,
					);
				} else {
					console.error(
						`${style.red("Refresh failed:")} ${res.attempt.error ?? "Unknown error"}`,
					);
					process.exitCode = 1;
				}
				return;
			}

			if (subaction === "rules") {
				const payload = s.pricingPayload();
				const rules = Object.values(payload.settings.customRules);
				if (format === "json") {
					console.log(JSON.stringify({ rules }, null, 2));
					return;
				}
				if (rules.length === 0) {
					console.log(style.yellow("No custom pricing rules configured."));
					console.log(
						style.dim(
							`Add one with "${CLI_NAME} pricing set <model> --input <n> --output <n>".`,
						),
					);
					return;
				}
				console.log(
					renderTable({
						columns: [
							{
								key: "model",
								header: "Model",
								minWidth: 14,
								maxWidth: 32,
								shrinkPriority: 2,
							},
							{ key: "mode", header: "Mode" },
							{
								key: "detail",
								header: "Rates / Alias",
								minWidth: 16,
								maxWidth: 42,
								shrinkPriority: 3,
							},
							{ key: "override", header: "Override" },
							{
								key: "note",
								header: "Note",
								minWidth: 8,
								maxWidth: 24,
								shrinkPriority: 1,
							},
						],
						rows: rules.map((r) => ({
							model: r.model,
							mode: r.mode,
							detail:
								r.mode === "alias"
									? `-> ${r.aliasTarget ?? ""}`
									: `in $${r.rates?.input ?? 0}, out $${r.rates?.output ?? 0}`,
							override: r.overrideRecorded ? "yes" : "no",
							note: r.note ?? "-",
						})),
						style,
					}),
				);
				return;
			}

			if (subaction === "set") {
				const model = positionals[1]?.trim();
				if (!model) {
					throw new CliUsageError("Model name is required for pricing set", {
						hint: `Example: ${CLI_NAME} pricing set my-model --input 1.5 --output 6.0`,
					});
				}
				const alias = (values.alias as string | undefined)?.trim();
				const overrideRecorded = Boolean(values.override);
				const note = (values.note as string | undefined)?.trim();

				let payload: ReturnType<typeof s.upsertCustomPriceRule>;
				if (alias) {
					payload = s.upsertCustomPriceRule({
						model,
						mode: "alias",
						aliasTarget: alias,
						overrideRecorded,
						...(note ? { note } : {}),
					});
				} else {
					const input = parseOptionalRate(
						values.input as string | undefined,
						"--input",
					);
					const output = parseOptionalRate(
						values.output as string | undefined,
						"--output",
					);
					if (input === null || output === null) {
						throw new CliUsageError(
							"Both --input and --output are required unless --alias is provided",
							{
								hint: `Example: ${CLI_NAME} pricing set ${model} --input 2.0 --output 8.0`,
							},
						);
					}
					const cacheRead = parseOptionalRate(
						values["cache-read"] as string | undefined,
						"--cache-read",
					);
					const cacheWrite = parseOptionalRate(
						values["cache-write"] as string | undefined,
						"--cache-write",
					);
					const reasoning = parseOptionalRate(
						values.reasoning as string | undefined,
						"--reasoning",
					);
					payload = s.upsertCustomPriceRule({
						model,
						mode: "rates",
						rates: {
							input,
							output,
							cacheRead,
							cacheWrite,
							reasoning,
						},
						overrideRecorded,
						...(note ? { note } : {}),
					});
				}

				if (format === "json") {
					console.log(JSON.stringify(payload, null, 2));
					return;
				}
				console.log(
					`${style.green("Saved pricing rule")} for ${style.bold(model)} and updated local cost estimates.`,
				);
				return;
			}

			if (subaction === "remove") {
				const model = positionals[1]?.trim();
				if (!model) {
					throw new CliUsageError("Model name is required for pricing remove", {
						hint: `Run "${CLI_NAME} pricing rules" to list configured rules`,
					});
				}
				const payload = s.deleteCustomPriceRule(model);
				if (format === "json") {
					console.log(JSON.stringify(payload, null, 2));
					return;
				}
				console.log(
					`${style.green("Removed pricing rule")} for ${style.bold(model)}.`,
				);
				return;
			}

			throw new CliUsageError(`Unknown pricing subaction: ${subaction}`, {
				hint: `Run "${CLI_NAME} pricing --help" to list valid subactions`,
			});
		},
	);
}
