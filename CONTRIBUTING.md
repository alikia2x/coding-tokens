# Contributing

Thanks for taking a look. This is a small local-first tool; keep changes focused
and include a test when you touch aggregation, parsing or pricing.

## Setup

```sh
bun install
```

The pinned Bun version is in [.bun-version](.bun-version). The desktop app builds
on macOS, Windows and Linux; the CLI, server and web UI also run anywhere Bun is
available.

## Checks

Run these before opening a pull request — CI runs the same commands:

```sh
bun run check      # Biome lint and format
bun run typecheck  # app and server TypeScript projects
bun test
bun run build      # Vite production build
```

`bun run format` applies Biome's formatting. The codebase uses tabs, double
quotes and no semicolon-free style exceptions; let Biome decide.

## Desktop app

```sh
bun run dev:app
```

`bun run build:app` produces an unsigned bundle for a smoke test. Signing and
notarization are opt-in; see [docs/RELEASING.md](docs/RELEASING.md).

## Layout conventions

- `app/` is UI only. Data access goes through `app/lib/api.ts`, and localization catalogs live in `app/lib/locales/`.
- `server/` owns the SQLite index and the HTTP API.
- `src/` stays usable from the CLI without importing React or Electrobun.
- `src/providers/` owns harness discovery, usage, and transcript readers; `src/platform/` handles cross-platform paths and SQLite locking; `src/metrics/` calculates generation performance metrics.
- `shared/` holds types and registries that both sides need.

## Icon changes

`assets/icon.svg` is the master. After editing it, regenerate the platform
assets:

```sh
sips -s format png assets/icon.svg --out assets/icon.png
# ... regenerate assets/icon.iconset at 16/32/64/128/256/512/1024
iconutil -c icns assets/icon.iconset -o assets/icon.icns
```

The `.ico` is generated from `icon.png` with Pillow. Keep `icon.iconset`,
`icon.icns`, `icon.ico` and `icon.png` in sync with the SVG.

## Commits and pull requests

- Write commit subjects in the imperative mood (`fix: clamp empty ranges`).
- One logical change per pull request; include screenshots for UI changes.
- Update [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]` when a change is
  user-facing.
- Do not bump the version in a pull request; releases bump it separately.
