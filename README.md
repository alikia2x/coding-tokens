# Coding Tokens

Local token usage, cost, performance, and conversation reports for AI coding harnesses. Coding Tokens reads session data already stored on disk across Claude Code, Codex, Cursor, Windsurf, Cline, Roo Code, Continue, GitHub Copilot, Aider, Goose, OpenHands, OpenCode, Antigravity, Command Code, and DSH, then turns it into unified usage reports and searchable conversation archives. Nothing is uploaded and no account is required.

It ships as a macOS, Windows, and Linux desktop app, a local web UI, and a standalone CLI backed by the same local index.

## Features

- Overview dashboard with cost, token breakdown, daily activity heatmap, activity streaks, and top projects and models.
- Multi-dimensional explorer for analyzing spend, tokens, requests, and sessions over time or by harness, project, and model.
- Full-text session browser with facet filters, transcript detail levels, and batch Markdown export of filtered sessions.
- Generation performance metrics per session and per turn, including time to first token (TTFT), output throughput in tokens per second, model inference duration, and tool execution duration.
- Multi-language interface supporting English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Spanish, French, and German.

## Install

Download the latest desktop installer or standalone CLI binary from the [Releases](../../releases/latest) page:

| Platform                      | Desktop Installer                     | Standalone CLI                      |
| ----------------------------- | ------------------------------------- | ----------------------------------- |
| macOS 13+, Apple silicon      | `macos-arm64-CodingTokens.dmg`        | `coding-tokens-cli-macos-arm64`     |
| macOS 13+, Intel              | `macos-x64-CodingTokens.dmg`          | `coding-tokens-cli-macos-x64`       |
| Windows 11+                   | `win-x64-CodingTokens-Setup.zip`      | `coding-tokens-cli-win-x64.exe`     |
| Linux (GTK 3 / WebKitGTK 4.1) | `linux-x64-CodingTokens-Setup.tar.gz` | `coding-tokens-cli-linux-x64`       |

macOS releases are signed and notarized when Apple signing secrets are configured, or published unsigned otherwise. The app reads harness data from your home directory and does not modify source session files.

Building from source requires [Bun](https://bun.sh) 1.4.4 or later; the pinned version lives in [.bun-version](.bun-version).

## Desktop app

```sh
bun install
bun run dev:app          # build the web assets and launch Electrobun
bun run dev:app:watch    # same, with the Bun process watching for changes
bun run build:app        # packaged app bundle and installer in build/ and artifacts/
```

The packaged app starts a local HTTP server on an ephemeral localhost port and opens a native window against it, so the same server also powers `bun run web`.

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

The default grouping is `harness,project,model`. Available grouping fields are `harness`, `project`, `model`, `day`, and `session`. `--project` matches a working-directory path and can be repeated. `--date` filters to one local calendar date and cannot be combined with `--since` or `--until`. `--since` and `--until` accept a local date with an optional time (`2026-01-15`, `2026-01-15 09:30`, or `2026-01-15 09:30:00`, with a space or `T` separator) and are inclusive of the whole unit named.

Reports include uncached input, output (including reasoning), cache read, cache write, reasoning tokens, and recorded or estimated cost. Missing prices are estimated from models.dev, and a recorded zero is re-estimated when the resolved model has real rates. The catalog is cached for 24 hours and reused if refresh fails.

Conversation export writes one Markdown file per matching session, organized by harness and project, plus an `_index.md` catalog. Rerunning an export into the same directory refreshes generated files and cleans up stale generated files. The default detail level is `chat_compact`. Available levels are:

- `user_only`: user messages
- `chat_compact`: user messages and final assistant replies
- `chat`: all user and assistant messages
- `chat_tools`: `chat` plus a per-session tool summary
- `agent`: `chat` plus tool calls, command text, recognized file paths, and shortened tool results
- `agent_full`: full recorded tool inputs and outputs plus other non-reasoning transcript events

Use `--include-timestamps` to add compact local timestamps to messages. `--include-token-stats` adds per-conversation totals and attaches request-level model and token counts to assistant replies. Existing `--harness`, `--project`, `--date`, `--since`, and `--until` filters apply to exports as well. You can also export any filtered list directly from the Sessions page in the UI.

## Web UI

```sh
bun run web        # build and serve on http://127.0.0.1:4317
bun run web:serve  # serve the existing dist/ build
```

`PORT`, `HOST`, `STATIC_DIR`, and `DB_PATH` override the defaults.

## Development

```sh
bun install
bun run check      # Biome lint and format
bun run typecheck  # app and server TypeScript projects
bun test
bun run build      # Vite production build
bun run build:cli  # standalone CLI binary in artifacts/
```

CI runs lint, typecheck, tests, and Vite build on every push and pull request, then packages desktop bundles and standalone CLI binaries for macOS (arm64 and x64), Windows (x64), and Linux (x64).

## Releasing

Releases are built on GitHub Actions from a `v*` tag. Native runners build each platform, sign and notarize macOS when Apple secrets are configured (or build unsigned installers otherwise), generate `SHA256SUMS.txt`, and publish the GitHub Release.

See [docs/RELEASING.md](docs/RELEASING.md) for Apple certificate setup, signing helper scripts, and the release checklist. Version bumps use `bun run release <major|minor|patch|x.y.z>`, which updates `package.json` and `CHANGELOG.md`.

## Project layout

| Path       | Contents                                            |
| ---------- | --------------------------------------------------- |
| `app/`     | React UI, routes, charts, locales, and theme        |
| `desktop/` | Electrobun main process and application menu        |
| `server/`  | Local HTTP API and SQLite index                     |
| `src/`     | CLI, harness providers, metrics, and export         |
| `shared/`  | Types and registries shared by app, server, and CLI |
| `assets/`  | App icon source and platform icon sets              |
| `scripts/` | Dev server, CLI binary builder, and release helpers |
| `docs/`    | Release documentation                               |

## Privacy

Everything stays local. The only network request is the optional models.dev price catalog refresh, cached for 24 hours.
