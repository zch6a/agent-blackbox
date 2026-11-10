# Polish log

Each round goes through the full checklist: features vs. README, code read-through, tests, first-run UX, docs, engineering, security & privacy.

## v0.1.0 — initial build (2026-11-10)

Built and verified against 366 real local sessions (83 Claude Code, 183 Codex, 3 OpenCode, 97 DeepSeek Harness), 57 tests passing.

## Round 1 — v0.1.1 (2026-11-10)

Found by using it on real logs, the demo data, and a phone-sized viewport.

- **Performance:** cold indexing of 9.5 GB of logs went from 40 s to 15 s. Two changes: bookkeeping lines (`api-request-blob` stores whole request bodies, about a quarter of a Claude Code log) are skipped before `JSON.parse`, and uncached sessions are parsed on a worker-thread pool, biggest first. Workers fall back to the main thread on any failure. Added a test that pooled and in-process parsing give identical summaries.
- **Correctness:** Insights now includes sessions that were *active* in the range (it used start time). The daily chart fills days without sessions so the time axis is continuous, and "active days" counts only real ones.
- **UI:** MCP tool names are shortened (`mcp__github__create_issue` → dim `github ·` + `create_issue`); sub-second durations show as `340ms` instead of `0s`; the page title resets when leaving a session; replay defaults to 1× and remembers the chosen speed; phones get a "← All sessions" link and a brand that no longer wraps; exported files no longer show the "local only" badge.
- **Terminal:** session header shows active time *and* wall-clock span (`2h 10m active over 3d 4h`).
- **Engineering:** `.gitattributes` keeps the repo LF on Windows; demo data has its own test (all four agents, deterministic output).
- Verified in a real browser: replay, light and dark themes, 375 px layout, and an exported HTML file opened from `file://` with no network.

60 tests passing.

## Round 2 — backlog

- [ ] Read every source file top to bottom with fresh eyes; look for dead code and unclear names.
- [ ] Adapter edge cases: Claude sub-agent files (`<session>/subagents/*.jsonl`), Codex sessions forked from another, OpenCode child sessions, DeepSeek sub-agent sessions (63 locally) — link parent and child.
- [ ] Keyboard and screen-reader pass on the UI (focus states, aria labels, contrast).
- [ ] `blackbox show` on a 6,000-tool session: check speed and readability.
- [ ] README: add a short animated GIF of replay (scripted capture).
