#!/usr/bin/env bun
import {
	CLI_NAME,
	CLI_VERSION,
	CliUsageError,
	suggestClosest,
} from "./cli/args";
import { runCompletionCommand } from "./cli/commands/completion";
import { runDoctorCommand, runHarnessesCommand } from "./cli/commands/doctor";
import { runExportCommand, runLegacyExport } from "./cli/commands/export";
import { runPricingCommand } from "./cli/commands/pricing";
import { runReportCommand } from "./cli/commands/report";
import { runSessionsCommand, runShowCommand } from "./cli/commands/sessions";
import { runModelsCommand, runProjectsCommand } from "./cli/commands/views";
import { createStyle } from "./cli/terminal";

const KNOWN_COMMANDS = [
	"report",
	"sessions",
	"search",
	"show",
	"models",
	"projects",
	"export",
	"harnesses",
	"pricing",
	"doctor",
	"completion",
] as const;

function printTopLevelHelp(): void {
	console.log(`Coding Tokens v${CLI_VERSION}
Track local token usage, model spend, and transcripts across 15 coding harnesses.

Usage: ${CLI_NAME} [command] [options]

Analytics & Reporting:
  report                 Aggregate usage and estimated cost (default command)
  models                 Compare usage, cache efficiency, and pricing by model
  projects               Compare sessions, tokens, and cost by project
  harnesses              Show detected coding harnesses and local data paths

Sessions & Search:
  sessions [query]       List sessions or run boolean / full-text search
  search <query>         Search sessions by title, project, model, or transcript
  show <session-id>      Inspect a session transcript and generation metrics

Export & Maintenance:
  export                 Export conversations as Markdown folders or a ZIP archive
  pricing [subaction]    Inspect models.dev catalog and manage custom price rules
  doctor                 Diagnose local database, pricing, and all 15 harness paths
  completion <shell>     Generate autocompletion script for zsh, bash, or fish

Common Options:
  -r, --range <preset>   Time range: today, yesterday, 7d, 30d, 90d, 1y, all, <N>h/d/w
  --harness <names>      Comma-separated harness filter
  -f, --format <fmt>     Output format (table or json)
  --no-color             Disable colored output
  -q, --quiet            Suppress warnings and progress spinners
  -v, --version          Show CLI version
  -h, --help             Show this help message

Examples:
  ${CLI_NAME} --range 7d --by model
  ${CLI_NAME} sessions "authentication OR oauth"
  ${CLI_NAME} export --harness claude --org project --zip
  ${CLI_NAME} doctor

Run "${CLI_NAME} <command> --help" for command-specific options and examples.`);
}

function hasFlag(args: string[], flag: string): boolean {
	return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

async function dispatch(args: string[]): Promise<void> {
	const first = args[0];

	if (first && !first.startsWith("-")) {
		const rest = args.slice(1);
		switch (first) {
			case "report":
				await runReportCommand(rest);
				return;
			case "sessions":
				await runSessionsCommand(rest, false);
				return;
			case "search":
				await runSessionsCommand(rest, true);
				return;
			case "show":
				await runShowCommand(rest);
				return;
			case "models":
				await runModelsCommand(rest);
				return;
			case "projects":
				await runProjectsCommand(rest);
				return;
			case "export":
				await runExportCommand(rest);
				return;
			case "harnesses":
				await runHarnessesCommand(rest);
				return;
			case "pricing":
				await runPricingCommand(rest);
				return;
			case "doctor":
				await runDoctorCommand(rest);
				return;
			case "completion":
				await runCompletionCommand(rest);
				return;
			default: {
				const closest = suggestClosest(first, KNOWN_COMMANDS);
				throw new CliUsageError(`Unknown command: ${first}`, {
					suggestion: closest ? `Did you mean "${closest}"?` : undefined,
					hint: `Run "${CLI_NAME} --help" to see available commands`,
				});
			}
		}
	}

	if (args.includes("--version") || args.includes("-v")) {
		console.log(`${CLI_NAME} ${CLI_VERSION}`);
		return;
	}

	if (args.includes("--help") || args.includes("-h")) {
		printTopLevelHelp();
		return;
	}

	if (hasFlag(args, "--export-dir")) {
		const modernFlags = [
			"--org",
			"--template",
			"--zip",
			"--session",
			"--query",
			"--model",
		];
		if (modernFlags.some((flag) => hasFlag(args, flag))) {
			await runExportCommand(args);
		} else {
			await runLegacyExport(args);
		}
		return;
	}

	if (hasFlag(args, "--detail")) {
		throw new CliUsageError("--detail requires --export-dir", {
			hint: `Or run "${CLI_NAME} export --detail <level>" or "${CLI_NAME} show <id> --detail <level>"`,
		});
	}
	if (hasFlag(args, "--include-timestamps")) {
		throw new CliUsageError("--include-timestamps requires --export-dir");
	}
	if (hasFlag(args, "--include-token-stats")) {
		throw new CliUsageError("--include-token-stats requires --export-dir");
	}

	await runReportCommand(args);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const noColor = args.includes("--no-color");
	const style = createStyle({ noColor });

	try {
		await dispatch(args);
	} catch (error) {
		if (error instanceof CliUsageError) {
			console.error(`${style.red("Error:")} ${error.message}`);
			if (error.suggestion) {
				console.error(style.yellow(error.suggestion));
			}
			if (error.hint) {
				console.error(style.dim(error.hint));
			}
			process.exitCode = 2;
			return;
		}
		console.error(
			`${style.red("Error:")} ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}

void main();
