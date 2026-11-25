import { parseArgs } from "node:util";
import {
	allHarnessIds,
	CLI_NAME,
	CliUsageError,
	EXPORT_DETAIL_LEVELS,
	RANGE_PRESET_NAMES,
} from "../args";

const SUBCOMMANDS = [
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

export function printCompletionHelp(): void {
	console.log(`Usage: ${CLI_NAME} completion <zsh|bash|fish>

Generate shell autocompletion script for coding-tokens.

Examples:
  ${CLI_NAME} completion zsh > ~/.zsh/completions/_coding-tokens
  source <(${CLI_NAME} completion bash)
  ${CLI_NAME} completion fish > ~/.config/fish/completions/coding-tokens.fish`);
}

function zshCompletion(): string {
	const harnesses = allHarnessIds().join(" ");
	const details = EXPORT_DETAIL_LEVELS.join(" ");
	const ranges = RANGE_PRESET_NAMES.join(" ");
	return `#compdef ${CLI_NAME}

_${CLI_NAME}() {
  local -a commands
  commands=(
    'report:Aggregate token usage and estimated cost'
    'sessions:List or search sessions using FTS5 index'
    'search:Search sessions with boolean query'
    'show:Inspect a session transcript and generation metrics'
    'models:Compare usage and pricing across models'
    'projects:Compare usage across project directories'
    'export:Export conversations as Markdown or ZIP'
    'harnesses:Show detected harnesses and data paths'
    'pricing:Manage model pricing catalog and custom rules'
    'doctor:Run local database and environment diagnostics'
    'completion:Generate shell autocompletion script'
  )

  _arguments -C \\
    '(-h --help)'{-h,--help}'[Show help]' \\
    '(-v --version)'{-v,--version}'[Show version]' \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case "$state" in
    cmd)
      _describe 'command' commands
      ;;
    args)
      _arguments \\
        '--harness[Filter harnesses]:harnesses:(${harnesses})' \\
        '--range[Time range preset]:range:(${ranges})' \\
        '--detail[Transcript detail level]:detail:(${details})' \\
        '--format[Output format]:format:(table json text markdown)' \\
        '--no-color[Disable colors]' \\
        '--quiet[Suppress warnings and spinners]' \\
        '--help[Show command help]'
      ;;
  esac
}

compdef _${CLI_NAME} ${CLI_NAME}
`;
}

function bashCompletion(): string {
	const cmds = SUBCOMMANDS.join(" ");
	const harnesses = allHarnessIds().join(" ");
	const ranges = RANGE_PRESET_NAMES.join(" ");
	return `_coding_tokens_completions() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${cmds} --help --version" -- "\${cur}") )
    return 0
  fi

  case "\${prev}" in
    --harness)
      COMPREPLY=( $(compgen -W "${harnesses}" -- "\${cur}") )
      return 0
      ;;
    --range|-r)
      COMPREPLY=( $(compgen -W "${ranges}" -- "\${cur}") )
      return 0
      ;;
    --format|-f)
      COMPREPLY=( $(compgen -W "table json text markdown" -- "\${cur}") )
      return 0
      ;;
    --detail)
      COMPREPLY=( $(compgen -W "${EXPORT_DETAIL_LEVELS.join(" ")}" -- "\${cur}") )
      return 0
      ;;
  esac

  COMPREPLY=( $(compgen -W "--harness --project --model --range --date --since --until --format --sort --limit --no-color --quiet --help" -- "\${cur}") )
}

complete -F _coding_tokens_completions ${CLI_NAME}
`;
}

function fishCompletion(): string {
	const lines = [
		`complete -c ${CLI_NAME} -f`,
		...SUBCOMMANDS.map(
			(cmd) => `complete -c ${CLI_NAME} -n "__fish_use_subcommand" -a "${cmd}"`,
		),
		`complete -c ${CLI_NAME} -l harness -a "${allHarnessIds().join(" ")}"`,
		`complete -c ${CLI_NAME} -s r -l range -a "${RANGE_PRESET_NAMES.join(" ")}"`,
		`complete -c ${CLI_NAME} -s f -l format -a "table json text markdown"`,
		`complete -c ${CLI_NAME} -l detail -a "${EXPORT_DETAIL_LEVELS.join(" ")}"`,
		`complete -c ${CLI_NAME} -l no-color -d "Disable colored output"`,
		`complete -c ${CLI_NAME} -s q -l quiet -d "Suppress warnings and spinners"`,
		`complete -c ${CLI_NAME} -s h -l help -d "Show help"`,
		`complete -c ${CLI_NAME} -s v -l version -d "Show version"`,
	];
	return `${lines.join("\n")}\n`;
}

export async function runCompletionCommand(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		printCompletionHelp();
		return;
	}
	const shell = positionals[0]?.toLowerCase();
	if (!shell) {
		throw new CliUsageError("Shell name is required: zsh, bash, or fish", {
			hint: `Example: ${CLI_NAME} completion zsh`,
		});
	}
	if (shell === "zsh") {
		process.stdout.write(zshCompletion());
		return;
	}
	if (shell === "bash") {
		process.stdout.write(bashCompletion());
		return;
	}
	if (shell === "fish") {
		process.stdout.write(fishCompletion());
		return;
	}
	throw new CliUsageError(
		`Unsupported shell "${shell}". Expected zsh, bash, or fish`,
	);
}
