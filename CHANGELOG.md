# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.1] — 2026-11-10

### Changed

- Cold indexing is about 2.5× faster: bookkeeping lines are skipped before parsing and uncached sessions are parsed on worker threads.
- Insights counts sessions that were active in the selected range, and the daily chart shows days without sessions.
- Shorter MCP tool names, millisecond durations, replay defaults to 1× and remembers its speed.
- Phone layout: back link from a session to the list.

### Added

- `blackbox demo` and `--demo`: fictional sample sessions for every agent.
- Codex thread names from `session_index.jsonl` are used as titles.
- `exitCode` on tool events, so failures show `exit 2` instead of the first output line.

## [0.1.0] — 2026-11-10

### Added

- Adapters for Claude Code, Codex (CLI and desktop), OpenCode (SQLite and legacy JSON storage) and DeepSeek Harness (multi-frame zstd logs).
- Local web UI: session list with search and filters, flight-path chart, timeline with diffs, step-by-step replay, Files and Tools tabs, Insights dashboard, light and dark themes, keyboard shortcuts.
- CLI: `ui`, `list`, `show`, `stats`, `export`, `doctor`, with `--json` output.
- Cost accounting that prefers agent-recorded costs, de-duplicates repeated usage, and clearly marks estimates.
- Privacy flag for DeepSeek Harness sessions whose logs were uploaded to the DeepSeek API.
- Self-contained HTML, Markdown and JSON export with optional secret redaction.
- Summary cache for fast startup.
