# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-11-20

### Added

- Unified global UI state management (`zustand`) persisting filters, search queries, sorting, grouping, expanded groups, progressive reveal limits, and per-route scroll positions across page navigation and tab switches.
- Custom overlay scrollbars (`OverlayScrollbars`) across the app shell, modals, and scrollable panels without layout shift.

### Changed

- Redesigned the `TimeRangePicker` popover with presets, dual-month range calendar, editable time inputs, timezone indicator, and clean custom range labels.
- Overhauled the Explore stacked area chart with smooth monotone curves, X-interval clipped active strokes, vibrant dark/light categorical palette contrast, active-only hover dots, and an ordered Tooltip with restored color swatches and totals.
- Refined Overview usage chart metric/unit controls, weekly Monday-to-Sunday bucketing, week/month axis formatting, and Models page table readability.

### Fixed

- Hardened local API origin/CORS checks, worker serialization, FTS5 search sanitization, atomic SQLite source state sync, and hour/week bucketing edge cases.
- Unified provider pricing enrichment, reasoning/streaming deduplication, empty-state handling, and UI/server test suite isolation.

## [0.4.0] - 2026-11-19

### Added

- Cache-first cold hydration and isolated `index-worker` background indexing so the desktop window and web UI load immediately without blocking on harness scans or SQLite locks.
- Transparent, configurable model pricing (`PricingCatalogManager`, SQLite migration v5 preserving `raw_model` and `raw_cost_usd`, custom 5-rate rules including `$0` free tiers, catalog alias mapping, JSON rule import/export, custom catalog URL, cache TTL, and offline mode).
- Multi-token non-contiguous catalog search (e.g. matching `Gemini 4 Neon` from `Gemini Neon`) and hover-to-edit pricing directly from the Models cost column.

### Changed

- Simplified the Models page and Model Pricing modal by removing redundant source pills, overview stat cards, raw cache paths, and fetch history logs.
- Improved session transcript formatting, tool call normalization, and batch export cancellation via isolated export worker.

### Fixed

- Preserve catalog canonical display names when applying custom pricing rules so rules keyed by display names remain matched across re-indexing.
- Lowered readonly SQLite retry/lock defaults and deduplicated concurrent `models.dev` catalog fetches to prevent startup stalls.

## [0.3.1] - 2026-11-17

### Changed

- Hide Windows and Linux application menu bars and remove macOS traffic-light left padding when not running in the macOS desktop shell.
- Hide harnesses with zero sessions and zero records from the Sessions sidebar, Explore harness filter, and Harnesses page.
- Strip Electrobun internal auto-updater artifacts from GitHub Releases so only platform GUI installers, CLI binaries, and `SHA256SUMS.txt` are published.

### Fixed

- Ensure SQLite migration v2/v3 creates `session_texts` before indexing FTS5 so upgrading from older `v0.2.0` local databases no longer stalls on `Opening local index 0/15`.
- Move database initialization inside `DataStore.refresh()` error handling so database errors report cleanly instead of leaving indexing stuck.

## [0.3.0] - 2026-11-17

### Added

- Support for 15 coding harnesses across macOS, Windows, and Linux via dynamic provider registration and cross-platform path resolution.
- Batch Markdown export for filtered sessions from the Sessions explorer (`POST /api/sessions/export`).
- Generation performance metrics per session, turn, and tool call, including TTFT, output throughput (tokens/s), model duration, tool execution duration, and active time split.
- Multi-language localization for English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Spanish, French, and German with natural localized quantifiers.
- Standalone cross-platform CLI executable builds (`bun run build:cli`) and macOS Developer ID signing setup helper (`bun run setup:signing`).
- Deterministic colors for chart series and legends: the same harness, project or model keeps the same color regardless of sort order or filters.
- Current activity streak in the contribution heatmap header.
- CI now packages unsigned builds and standalone CLI binaries for macOS (arm64 and x64), Windows x64 and Linux x64; releases build the full platform matrix.
- macOS releases sign and notarize automatically when Apple Developer ID secrets are configured, falling back cleanly to unsigned builds otherwise.

### Changed

- Heatmap tiles use a continuous usage-proportional color mix instead of five fixed buckets, and the legend is a gradient.

### Fixed

- Zero-token assistant and attempt rows no longer become usage records, sessions or report rows.
- Recorded `$0` costs are re-estimated when the resolved model has real pricing, so proxies, reseller ids and missing providers no longer hide usage behind a zero cost.
- Canonical model ids let reseller-only entries resolve correctly, and Codex rollouts use their first turn model for early requests instead of `Unrecorded model`.
- The index version was bumped so existing local indexes re-scan and pick up the new pricing and filtering rules.
- Remaining hardcoded UI labels and ARIA text now go through the translation catalog; language changes update formatting and the document language consistently.

## [0.2.0] - 2026-10-24

### Added

- Desktop app for macOS with overview, explore, sessions, projects, models and harnesses views.
- Local usage index with cost estimates, token breakdowns and per-session detail.
- Conversation export to Markdown at six detail levels.
- CLI reports grouped by harness, project, model, day or session.
- App icon in `.icns`, `.ico` and `.png` variants.

### Changed

- Token totals include uncached input, output, cache read and cache write.
- Reasoning tokens are reported as a breakdown of output.
