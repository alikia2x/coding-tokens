# Coding Tokens

**See where every token and dollar goes across your AI coding tools.**

Coding Tokens is a fast, local-first desktop app and CLI that brings all of your AI coding sessions into one clean dashboard. It reads the session logs already stored on your machine across 15 coding agents—including Claude Code, Codex, OpenCode, Cursor, Windsurf, Cline, Roo Code, Continue, Antigravity, Goose, Aider, Copilot, OpenHands, Command Code, and DSH—so you can track spend, compare models, inspect full transcripts, and export conversations to Markdown without sending a single byte to the cloud.

## Why Coding Tokens

- **One place for every coding agent**: Automatically discovers local sessions across tools, projects, and models with unified cost estimates.
- **Deep session inspector**: Search full conversation histories, inspect tool-call chains, and track latency and output throughput.
- **Clean Markdown exports**: Export individual sessions or batch-export filtered conversations as a ready-to-share ZIP archive.
- **100% local and private**: Runs entirely on your machine. Your prompts, code, and usage history never leave your disk.
- **Desktop app & CLI**: Use the native desktop dashboard or run instant terminal reports with the standalone CLI.

## Download

Grab the latest release for your platform from [GitHub Releases](https://github.com/alikia2x/coding-tokens/releases/latest):

- **macOS (Apple Silicon)**: Download `macos-arm64-CodingTokens.dmg`, open it, and drag **Coding Tokens** into Applications.
- **Windows (x64)**: Download `win-x64-CodingTokens-Setup.zip`, extract, and run the installer.
- **Linux (x64)**: Download `linux-x64-CodingTokens-Setup.tar.gz`, extract, and launch the app.
- **Standalone CLI**: Download `coding-tokens-cli-macos-arm64`, `coding-tokens-cli-macos-x64`, `coding-tokens-cli-linux-x64`, or `coding-tokens-cli-win-x64.exe` from the same release page.

## Developer Quickstart

Requires [Bun](https://bun.sh/).

```bash
git clone https://github.com/alikia2x/coding-tokens.git
cd coding-tokens
bun install
```

Run the web dashboard and API in development mode:

```bash
bun run dev
```

Run the desktop app shell in development mode:

```bash
bun run dev:app
```

Run the CLI directly from source:

```bash
bun run start -- --help
```

Run checks and tests:

```bash
bun run check && bun run typecheck && bun test
```

## License

MIT
