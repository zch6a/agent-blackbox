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

## Round 2 — v0.2.0 (2026-11-10)

The big finding of this round was a **cost bug**: Claude Code's `cost-state` is not always a full record. On this machine, 25 of 56 sessions that have one only got it partway through (it appeared in a later Claude Code version), and some got it only because an old session was reopened weeks later — one session's "recorded" cost was $53 against $1,743 of actual usage. Treating `cost-state` as authoritative under-reported those sessions badly.

- **Costs:** requests before the agent's own record starts are now estimated and added; such sessions are labelled `mixed` and the UI explains which part was recorded. A sub-agent counts as *inside* its parent only if it ran while the parent was recording.
- **Sub-agents (new):** 702 Claude Code sub-agent logs (`<session>/subagents/agent-*.jsonl` + `meta.json`) were being ignored entirely. They are now parsed and linked to the parent's exact `Agent` tool call via `toolUseId`; Codex (`thread_spawn.parent_thread_id`), DeepSeek Harness (`parentSession`) and OpenCode (`parent_id`) children are linked too. Checked against real data: for parents with complete records, recorded ≈ own estimate + children's estimates (e.g. $142 vs $134, $357 vs $375), which confirms Claude Code's recorded cost includes its sub-agents, so those are never added twice.
  - The delegated task is shown as "Task from the parent agent", not counted as a human prompt.
  - `list` hides sub-agents by default (`--subagents` to include); parents show `⑂N`. `show` marks the tool call that spawned each sub-agent and lists them at the end. `last` means the last *top-level* session.
  - UI: a Sub-agents chip in the filters, a Sub-agents tab, `⑂ Explore · 3 tools` links on tool rows, a parent link on child sessions, and parent rows show the whole family's cost.
  - Insights and `stats` count top-level sessions and report sub-agents separately; per-model costs spread a recorded total across the whole family.
  - Demo data now includes a sub-agent.
- **Cache:** invalidation is now a hash of the parser source code instead of a hand-bumped number — a stale cache (from my own forgotten bump) was serving pre-fix summaries during this round.
- **Accessibility:** measured contrast and fixed every pair under 4.5:1 (secondary text in both themes, status colours on their tinted backgrounds, white-on-orange button text at 2.6:1 → dark text at 7.3:1); visible focus rings; proper `nav`/`aria-current` instead of a misused listbox; labelled search inputs; a text alternative for the flight-path canvas; filter chips are real buttons with `aria-pressed`.
- **Terminal:** `show` pipes long output through `$PAGER` (`less -FRX`) like git, with `--no-pager`. The 6,389-tool session renders in 2.2 s (the 20 s I first measured was PowerShell capturing 14,000 lines). Not verified in an interactive terminal from this environment, which has no TTY.
- **Code:** enabled `noUnusedLocals`/`noUnusedParameters`; removed leftover helpers and hacks found by an unreferenced-export scan.
- **UI:** the find box and Replay wrap together as one group instead of Replay falling onto its own line.

64 tests passing.

## Round 3 — backlog

- [ ] README: a short animated GIF of replay (scripted headless capture of frames).
- [ ] Session list for 1,000+ sessions: measure render time; virtualize if needed.
- [ ] `stats --by project` merges different projects with the same folder name; disambiguate.
- [ ] Live sessions: refresh the open session when its log grows (tail the file).
- [ ] Try the pager in a real terminal.
