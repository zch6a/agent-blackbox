# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-11-12

### Fixed

- The Markdown renderer took time quadratic in a run of `[` characters (about 4 s for 50,000 on a CI
  runner), so a session log containing such a run could freeze the viewer. Link labels now stop at `[`
  as well as `]`, and the same input takes under a millisecond.

## [1.0.0] — 2026-11-10

### Security

- The Markdown renderer and escaping live in `ui/markdown.js` and are fuzzed in the test suite (known attacks, 3,000 random hostile inputs, ReDoS-shaped inputs).
- Autolinks no longer absorb escaped `<`, `>` or quotes, and need a real host.

### Fixed

- A malformed session key returns 400 instead of 500.
- Insights captions no longer truncate.

### Tested

- Half-written, empty, binary and corrupt logs are skipped without errors; a log deleted while the UI is open gives a clean 404.

## [0.3.0] — 2026-11-10

### Added

- HTML exports include the session's sub-agents and work as a small offline site (`--no-subagents` to skip).
- Insights: "Where the time went" — total and average time per tool, with failure rates; `stats --by tool` shows them too.

### Changed

- Relative edit paths (Codex `apply_patch`) are resolved against the session's working directory.
- README: `demo` command, a legend for list markers, live-update FAQ.

## [0.2.1] — 2026-11-10

### Added

- The UI offers to update an open session when the agent is still writing to it; the server keeps its index fresh in the background.
- Replay GIF in the README, recorded from demo data with `scripts/record-replay.mjs`.

### Fixed

- The pager works on Windows (finds Git for Windows' `less`) and never prints a "command not found" error.
- Different projects with the same folder name are no longer merged in stats and Insights.
- Empty states point to `blackbox demo`.

## [0.2.0] — 2026-11-10

### Added

- Sub-agent sessions for all four agents, linked to their parent and to the tool call that spawned them (Claude Code `subagents/` logs were previously ignored). `list --subagents`, a Sub-agents tab and filter chip in the UI, and family totals on parent rows.
- `mixed` cost source for sessions whose recorded cost only covers part of the session.
- `show` uses a pager for long output (`$PAGER`, `--no-pager`).

### Fixed

- Sessions where Claude Code's `cost-state` started late (agent upgrade, or reopening an old session) were under-reported, sometimes by over $1,000. The uncovered part is now estimated.
- `last` / `-2` pick the latest top-level session, not a sub-agent.
- The summary cache now invalidates itself whenever the parser code changes.
- Colour contrast now meets WCAG AA in both themes; focus rings and ARIA roles fixed.

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
