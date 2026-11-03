# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Deterministic colors for chart series and legends: the same harness, project or model keeps the same color regardless of sort order or filters.
- Current activity streak in the contribution heatmap header.
- CI now packages unsigned builds for macOS (arm64 and x64), Windows x64 and Linux x64; releases build the full platform matrix.
- macOS releases are signed with a Developer ID certificate and notarized.

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
