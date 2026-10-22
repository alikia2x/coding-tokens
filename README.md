# harness-token-usage

A local CLI for summarizing token usage from Codex, DSH, OpenCode, and Command Code.

Requires Bun 1.2 or later.

```sh
bun run src/cli.ts
bun run src/cli.ts --by project,model
bun run src/cli.ts --project ~/Code/my-project
bun run src/cli.ts --harness codex,opencode --date 2026-01-15
bun run src/cli.ts --by day,model --since 2026-01-01 --until 2026-01-31 --format json
bun run src/cli.ts --by model --since "2026-01-15 09:30:00" --until "2026-01-15 18:00"
bun run src/cli.ts --export-dir ~/Documents/conversations --detail chat_compact
bun run src/cli.ts --export-dir ~/Documents/conversations --detail agent --include-timestamps --include-token-stats
```

The default grouping is `harness,project,model`. Available grouping fields are `harness`, `project`, `model`, `day`, and `session`. `--project` matches a working-directory path and can be repeated. `--date` filters to one local calendar date and cannot be combined with `--since` or `--until`. `--since` and `--until` accept a local date with an optional time — `2026-01-15`, `2026-01-15 09:30`, or `2026-01-15 09:30:00` (a `T` may separate date and time) — and are inclusive of the whole unit named, so a date-only `--until 2026-01-15` covers that entire day.

Reports include uncached input, output (including reasoning), cache read, cache write, reasoning tokens, and recorded or estimated cost. Reasoning is a breakdown of output. Missing prices are estimated from models.dev; its catalog is cached for 24 hours and reused if refresh fails.

Conversation export writes one Markdown file per matching session, organized by harness and project, plus an `_index.md`. Rerunning an export refreshes its generated files and removes obsolete generated Markdown files. The default detail is `chat_compact`. Available levels are:

- `user_only`: user messages
- `chat_compact`: user messages and final assistant replies
- `chat`: all user and assistant messages
- `chat_tools`: `chat` plus a per-session tool summary
- `agent`: `chat` plus tool calls, command text, recognized file paths, and shortened tool results
- `agent_full`: full recorded tool inputs and outputs plus other non-reasoning transcript events

Use `--include-timestamps` to add compact local timestamps to messages. `--include-token-stats` adds per-conversation totals and attaches request-level model/token counts to assistant replies; in `chat_compact`, requests made during hidden tool rounds are combined onto that turn's final reply. Titles come from each harness's stored title metadata, and DSH subagent sessions are excluded. Existing `--harness`, `--project`, `--date`, `--since`, and `--until` filters apply to exports. `--date`, `--since`, and `--until` select sessions by their start time; exports then include the whole matching session. `--export-dir` runs export mode and cannot be combined with `--format`.

```sh
bun install
bun run check
bun run typecheck
```
