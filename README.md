# Coding Tokens

Local token usage reports for coding harnesses. Coding Tokens reads the session
data that Codex, DSH, OpenCode, Command Code and Antigravity already keep on
disk, then turns it into usage, cost and conversation reports. Nothing is
uploaded and no account is required.

It ships as a macOS, Windows and Linux desktop app, a local web UI and a CLI over
the same index.

## Install

Download the latest installer from the [Releases](../../releases/latest) page:

| Platform                      | File                                  |
| ----------------------------- | ------------------------------------- |
| macOS 13+, Apple silicon      | `macos-arm64-CodingTokens.dmg`        |
| macOS 13+, Intel              | `macos-x64-CodingTokens.dmg`          |
| Windows 11+                   | `win-x64-CodingTokens-Setup.zip`      |
| Linux (GTK 3 / WebKitGTK 4.1) | `linux-x64-CodingTokens-Setup.tar.gz` |

The macOS builds are signed and notarized. Windows and Linux builds are not
code-signed yet. The app reads harness data from your home directory; it does not
modify it.

Building from source requires [Bun](https://bun.sh) 1.4.4 or later; the pinned
version lives in [.bun-version](.bun-version).

## Desktop app

```sh
bun install
bun run dev:app          # build the web assets and launch Electrobun
bun run dev:app:watch    # same, with the Bun process watching for changes
bun run build:app        # packaged .app, DMG and update bundle in build/
```

The packaged app starts a local HTTP server on a random port and opens a native
window against it, so the same server also powers `bun run web`.

## CLI

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

Reports include uncached input, output (including reasoning), cache read, cache write, reasoning tokens, and recorded or estimated cost. Reasoning is a breakdown of output. Missing prices are estimated from models.dev; a recorded zero is re-estimated when the resolved model has real rates, so unknown providers and reseller model ids do not appear as free usage. The catalog is cached for 24 hours and reused if refresh fails.

Conversation export writes one Markdown file per matching session, organized by
harness and project, plus an `_index.md`. Rerunning an export refreshes its
generated files and removes obsolete generated Markdown files. The default
detail is `chat_compact`. Available levels are:

- `user_only`: user messages
- `chat_compact`: user messages and final assistant replies
- `chat`: all user and assistant messages
- `chat_tools`: `chat` plus a per-session tool summary
- `agent`: `chat` plus tool calls, command text, recognized file paths, and shortened tool results
- `agent_full`: full recorded tool inputs and outputs plus other non-reasoning transcript events

Use `--include-timestamps` to add compact local timestamps to messages.
`--include-token-stats` adds per-conversation totals and attaches request-level
model/token counts to assistant replies; in `chat_compact`, requests made during
hidden tool rounds are combined onto that turn's final reply. Titles come from
each harness's stored title metadata, and DSH subagent sessions are excluded.
Existing `--harness`, `--project`, `--date`, `--since`, and `--until` filters
apply to exports. `--date`, `--since`, and `--until` select sessions by their
start time; exports then include the whole matching session. `--export-dir`
runs export mode and cannot be combined with `--format`.

## Web UI

```sh
bun run web        # build and serve on http://127.0.0.1:4317
bun run web:serve  # serve the existing dist/ build
```

`PORT`, `HOST`, `STATIC_DIR` and `DB_PATH` override the defaults.

## Development

```sh
bun install
bun run check      # Biome lint and format
bun run typecheck  # app and server TypeScript projects
bun test
bun run build      # Vite production build
```

CI runs the same checks on every push and pull request, then packages unsigned
builds for macOS (arm64 and x64), Windows (x64) and Linux (x64) to prove the
desktop build still works on each host.

## Releasing

Releases are built on GitHub Actions from a `v*` tag. The matrix builds all
platforms on native runners; the macOS jobs sign with a Developer ID
certificate, notarize the app, publish the DMGs plus the update bundles, and
generate checksums.

See [docs/RELEASING.md](docs/RELEASING.md) for the one-time certificate and
secret setup, the local signing flow, and the release checklist. Version bumps
come from `bun run release <major|minor|patch|x.y.z>`, which updates
`package.json` and the changelog; `electrobun.config.ts` reads the version from
`package.json` so there is a single source of truth.

## Project layout

| Path       | Contents                                            |
| ---------- | --------------------------------------------------- |
| `app/`     | React UI, routes, charts and theme                  |
| `desktop/` | Electrobun main process and application menu        |
| `server/`  | Local HTTP API and SQLite index                     |
| `src/`     | CLI, harness readers, aggregation and export        |
| `shared/`  | Types shared by app, server and CLI                 |
| `assets/`  | App icon source (`icon.svg`) and platform icon sets |
| `scripts/` | Dev server and release helpers                      |
| `docs/`    | Release and contribution documentation              |

## Privacy

Everything stays local. The only network request is the optional models.dev
price catalog refresh, cached for 24 hours.
