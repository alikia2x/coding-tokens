# Project: Coding Tokens — Architecture Refactoring, Cross-Platform Support & Mainstream Harness Expansion

## Architecture

Coding Tokens is a high-performance token and cost tracking application for AI coding harnesses, combining a CLI, a local Bun HTTP server/SQLite backend, an Electrobun desktop wrapper, and a React 19 web frontend.

### Architectural Core Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Clients / Consumers                            │
│    CLI (`src/cli.ts`)   │  Bun API Server (`server/`) │  Desktop (Electrobun)│
└──────────────┬──────────────────────────┬───────────────────────────┬───────┘
               │                          │                           │
               ▼                          ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Service Layer                                 │
│  - StorageService (SQLite WAL, atomic transactions, indexing)               │
│  - PlatformPathService (macOS, Linux XDG, Windows %APPDATA%/%LOCALAPPDATA%) │
│  - HarnessRegistry & ProviderService (dynamic discovery, registration)       │
│  - PricingService (models.dev cache, price calculations, cost estimation)   │
│  - SessionCatalogService & ReportingService (caching, search, aggregations) │
│  - TranscriptService (formatting, token inspection, Markdown export)        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      HarnessProvider Plugin Interface                       │
│  `id`, `displayName`, `color`, `discoverSessions()`, `readUsage()`,        │
│  `readTranscript()`, `computeFingerprint()`, `getWatchPaths()`               │
├──────────────────────────────────────┬──────────────────────────────────────┤
│ Core / Existing Harnesses:           │ New Mainstream Harnesses:            │
│  - Claude Code (CLI)                 │  - Cline (VS Code / Standalone)      │
│  - OpenAI Codex CLI                  │  - Roo Code (VS Code Extension)      │
│  - Google Antigravity / Gemini / T3  │  - Continue (VS Code / JetBrains)    │
│  - Command Code                      │  - Cursor (IDE Composer / Agent)     │
│  - DSH (DeepSeek Harness)            │  - GitHub Copilot (VS Code / CLI)    │
│  - OpenCode                          │  - Aider (CLI / Analytics)           │
│                                      │  - Windsurf (Codeium Cascade)        │
│                                      │  - Goose (Block / Square CLI)        │
│                                      │  - OpenHands (OpenDevin)             │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

## Feature Inventory

| #   | Feature                                  | Description                                                                                                | Milestone | Source |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- | ------ |
| 1   | PlatformPathService                      | Cross-platform base dir resolution (macOS, Linux XDG, Windows APPDATA/LOCALAPPDATA/USERPROFILE)            | M1        | Survey |
| 2   | Path Normalization & Windows Safety      | Separator normalization, drive letters, URI parsing, safe basename, SQLite EBUSY retry/backoff             | M1        | Survey |
| 3   | Tooling & Checks Modernization           | Biome glob pattern recursive wildcards (`**`), Tailwind v4 CSS handling, clean `check` & `typecheck`       | M1        | Survey |
| 4   | Extensible Core Models & Color Registry  | Open `HarnessId`, dynamic metadata/labels, dynamic color registry, decoupling from rigid union enum        | M1        | Survey |
| 5   | HarnessProvider Plugin Abstraction       | Clean provider interface (`discoverSessions`, `readUsage`, `readTranscript`, `getWatchPaths`, etc.)        | M2        | Survey |
| 6   | HarnessRegistry & Dynamic Registration   | Registry for dynamic provider discovery, enumeration, lookup, and dependency injection                     | M2        | Survey |
| 7   | StorageService & Database Abstraction    | Encapsulated SQLite layer, WAL mode, migrations, atomic batch inserts, fingerprint caching                 | M2        | Survey |
| 8   | PricingService Modernization             | Cross-platform cache directory resolution, resilient TTL caching, models.dev rate matching                 | M2        | Survey |
| 9   | Catalog, Reporting & Transcript Services | Decoupled session indexing, full-text search, multi-dimensional reports, Markdown export                   | M2        | Survey |
| 10  | Refactor Existing Harnesses to Provider  | Migrate Codex, DSH, OpenCode, Command Code, Antigravity into new `HarnessProvider` architecture            | M2        | Survey |
| 11  | Claude Code Provider                     | Official `~/.claude` projects JSONL, stats-cache, prompt caching, reasoning extraction, transcripts        | M3        | Survey |
| 12  | Cline Provider                           | `~/.cline` & VS Code globalStorage, taskHistory.json, ui_messages.json per-request telemetry, transcripts  | M3        | Survey |
| 13  | Roo Code Provider                        | `rooveterinaryinc.roo-cline` globalStorage, mode-aware task history and per-request telemetry              | M3        | Survey |
| 14  | Continue Provider                        | `~/.continue` sessions JSON, `tokensGenerated.jsonl`, `chatInteraction.jsonl`, devdata SQLite              | M3        | Survey |
| 15  | Cursor Provider                          | Cursor IDE `state.vscdb` (globalStorage & workspaceStorage), `cursorDiskKV` Composer/Chat sessions         | M3        | Survey |
| 16  | GitHub Copilot Provider                  | VS Code `chatSessions/*.json`, workspaceStorage state, Copilot CLI process logs                            | M3        | Survey |
| 17  | Aider Provider                           | Repo-level `.aider.chat.history.md` markdown parsing, `--analytics-log` JSONL usage metrics                | M3        | Survey |
| 18  | Windsurf Provider                        | `~/.codeium/` & `~/.windsurf/` cascade agent state, workspaceStorage state, Protobuf wire decoding         | M3        | Survey |
| 19  | Goose Provider                           | Block Goose `sessions.db` SQLite reader and legacy JSONL session parser                                    | M3        | Survey |
| 20  | OpenHands Provider                       | OpenHands/OpenDevin conversation directories, base_state and event streams                                 | M3        | Survey |
| 21  | CLI Modernization                        | Updated CLI with dynamic harness options, cross-platform path exports, multi-harness reporting             | M4        | Survey |
| 22  | Server API Modernization                 | REST endpoints powered by new Service Layer & HarnessRegistry, dynamic metadata APIs                       | M4        | Survey |
| 23  | Desktop Cross-Platform Support           | Electrobun packaging, window lifecycle, menu accelerators, cross-platform paths                            | M4        | Survey |
| 24  | E2E Test Suite Pass (Tiers 1-4)          | Requirement-driven test suite published in TEST_READY.md passing 100% across all harnesses & platforms     | M5        | Survey |
| 25  | Host Dogfooding Verification             | Real local session verification on host machine across live harnesses (Claude, Cline, Cursor, Codex, etc.) | M5        | Survey |
| 26  | Adversarial Hardening (Tier 5)           | White-box adversarial testing, edge cases (malformed JSONL, file locks, encoding, token subtraction)       | M5        | Survey |

## Milestones

| #   | Name                                           | Scope                                           | Dependencies   | Status                                               |
| --- | ---------------------------------------------- | ----------------------------------------------- | -------------- | ---------------------------------------------------- |
| M1  | Foundation, Core Types & PlatformPathService   | Features 1, 2, 3, 4                             | none           | DONE |
| M2  | Architecture Deep Refactoring & Service Layer  | Features 5, 6, 7, 8, 9, 10                      | M1             | DONE                                                 |
| M3  | Mainstream Harness Integrations                | Batch 1 (Claude Code, Aider, Goose, OpenHands); Batch 2 (Cline, Roo, Continue); Batch 3 (Cursor, Windsurf, Copilot) | M2             | DONE                                                 |
| M4  | CLI, Server & Desktop Full Integration         | Features 21, 22, 23                             | M2, M3         | DONE                                                 |
| M5  | Final Milestone: E2E Verification & Dogfooding | Features 24, 25, 26                             | M1, M2, M3, M4 | DONE                                                 |

## Interface Contracts

### PlatformPathService

```typescript
export interface OsEnvProvider {
	get(name: string): string | undefined;
	homedir(): string;
	platform(): "darwin" | "linux" | "win32";
}

export interface PlatformPathService {
	getHomeDir(): string;
	getConfigDir(appName?: string): string;
	getDataDir(appName?: string): string;
	getCacheDir(appName?: string): string;
	expandPath(rawPath: string): string;
	normalize(filePath: string): string;
	safeBasename(filePath: string): string;
	resolveHarnessPaths(harnessId: string): string[];
}
```

### HarnessProvider Interface

```typescript
export interface HarnessMetadata {
	id: string;
	displayName: string;
	shortLabel: string;
	color: string;
	description?: string;
	defaultEnabled?: boolean;
}

export interface SessionDiscoveryItem {
	sessionId: string;
	harness: string;
	filePath: string;
	mtimeMs: number;
	sizeBytes: number;
	cwd?: string | null;
}

export interface HarnessProvider {
	readonly metadata: HarnessMetadata;
	isAvailable(paths: PlatformPathService): Promise<boolean>;
	discoverSessions(paths: PlatformPathService): Promise<SessionDiscoveryItem[]>;
	readUsage(
		paths: PlatformPathService,
		item?: SessionDiscoveryItem,
	): Promise<SourceResult>;
	readTranscript(
		paths: PlatformPathService,
		sessionId: string,
	): Promise<TranscriptSession | null>;
	computeFingerprint(paths: PlatformPathService): Promise<string>;
	getWatchPaths(paths: PlatformPathService): string[];
}
```

### Service Layer Contracts

```typescript
export interface StorageService {
	init(): Promise<void>;
	close(): Promise<void>;
	getUsageRecords(filter?: UsageFilter): Promise<UsageRecord[]>;
	saveUsageRecords(records: UsageRecord[]): Promise<void>;
	getSourceState(harnessId: string): Promise<SourceState | null>;
	saveSourceState(state: SourceState): Promise<void>;
	getSessionText(harnessId: string, sessionId: string): Promise<string | null>;
	saveSessionText(
		harnessId: string,
		sessionId: string,
		text: string,
	): Promise<void>;
}

export interface PricingService {
	init(): Promise<void>;
	enrichRecords(records: UsageRecord[]): Promise<UsageRecord[]>;
	calculateCost(
		model: string,
		inputTokens: number,
		outputTokens: number,
		cacheReadTokens?: number,
		cacheWriteTokens?: number,
	): number | null;
}

export interface SessionCatalogService {
	refresh(harnessId?: string, force?: boolean): Promise<CatalogRefreshResult>;
	getCatalog(): Promise<SessionMeta[]>;
	getSessionDetail(
		harness: string,
		sessionId: string,
	): Promise<SessionDetail | null>;
	search(query: SearchQuery): Promise<SearchResult>;
}
```

## Code Layout

- `src/platform/`: `OsEnvProvider`, `PlatformPathService`, path normalizers, cross-platform file locking helpers.
- `src/providers/`: Co-located `HarnessProvider` implementations (`claude/`, `cline/`, `roo/`, `continue/`, `cursor/`, `copilot/`, `aider/`, `windsurf/`, `goose/`, `openhands/`, `codex/`, `dsh/`, `opencode/`, `commandcode/`, `antigravity/`).
- `src/providers/registry.ts`: Dynamic `HarnessRegistry` and provider factory.
- `src/services/`: Core service implementations (`StorageService`, `PricingService`, `PlatformPathService`, `TranscriptService`).
- `server/services/`: Server-specific services (`SessionCatalogService`, `ReportingService`, `SearchService`).
- `shared/`: Common types, open interfaces, color registry, utilities.
- `tests/`: Automated unit, integration, and E2E test suites.
- `tests/fixtures/`: Synthetic cross-platform transcripts and session fixtures for all 15+ harnesses.
