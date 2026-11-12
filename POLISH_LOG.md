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

## Round 3 — v0.2.1 (2026-11-10)

- **Pager, verified in a real terminal:** Windows has no `less` on PATH, so the default pager would have failed with a "not recognized" error before falling back. The pager is now resolved first (PATH, then Git for Windows' bundled `less`), and `PAGER`/`BLACKBOX_PAGER`/`cat` behave as documented. Ran `show` in a real terminal tab: output pages through `less` with the `:` prompt.
- **Projects:** `stats --by project` and Insights merged different directories that share a folder name (`work/api` and `personal/api`). Labels now add parent folders only where names collide, and the same Windows directory spelled differently (`F:\a` vs `f:/a/`) is one project.
- **Live sessions:** the server now rescans in the background every 15 s (unchanged logs come from the cache), and the UI shows a "New activity — update" pill when the open session grows instead of yanking the view. Tested on this very session while it was running: 588 → 591 tool calls, scrolled to the newest event. Found along the way: the old stale-while-revalidate meant the UI only saw changes a full poll late.
- **Replay GIF:** `scripts/record-replay.mjs` drives headless Chrome over the DevTools protocol (Node's built-in WebSocket, no dependencies) and encodes with ffmpeg; `docs/replay.gif` is in both READMEs. First takes were wrong (4× finished the demo in under 4 s, leaving a static GIF); now 1×, 16 s.
- **First run:** with no logs at all, `list`, `show` and the UI suggest `blackbox demo`.
- **Measured, no change needed:** with all 1,041 sessions shown the list re-renders in 13 ms and search filters in 1.3 ms (150 rows at a time), so virtualization is not worth its complexity.

66 tests passing.

## Round 4 — v0.3.0 (2026-11-10)

- **Fresh install:** `npm pack` → 96 KB tarball, 37 files (dist, ui, READMEs, LICENSE — no tests or docs). Installed it into an empty directory and ran `--version`, `doctor`, `list --demo`, `export`, the UI server (page, token, `app.js`) and the worker pool from the compiled `dist/` (forced with `BLACKBOX_WORKER_MIN_BYTES=0`). All worked.
  - Publishing prerequisite: README images use relative `docs/…` paths, which npm only resolves when `package.json` has a `repository`. Add it once the GitHub repo exists.
- **Edit paths:** Codex `apply_patch` records paths relative to the working directory; they are now resolved against `cwd` (keeping its separator style), so a file has one name across agents and in the Files tab.
- **Export with sub-agents:** HTML exports embed the parent's sub-agent sessions (smaller output budget each); the offline file routes between them by hash, so `⑂` links, the Sub-agents tab and the "spawned by" link all work from `file://`. `--no-subagents` to leave them out. Verified with headless Chrome opening the exported file at the child's URL.
- **Insights — where the time went:** summaries now carry time and failures per tool; Insights has a slowest-tools table (total, average, calls, failure rate) and states how much of the active time was tool time. `stats --by tool` shows FAILED, TIME and AVG. On real data: shell tools account for ~45 days of runtime (long builds and tests), edits average under 300 ms.
- **README:** reread as a newcomer. Added the missing `demo` row, a legend for `⑂ ✗ ↑ ~`, `demo` in Quick start, sub-agents in export, time insights, the live-update behaviour in the FAQ, and a pointer from the cost feature to the Accuracy section.
- Small: a sub-agent's cost card no longer shows `~<$0.01`, and its Prompts card says "task from the parent".

67 tests passing.

## Round 5 — v1.0.0 (2026-11-10)

Security and failure modes — the round for things that only go wrong on someone else's machine.

- **Renderer split out and fuzzed:** escaping and the Markdown renderer moved to `ui/markdown.js`, shared by the UI, exported files and a new test that loads it in a VM sandbox. The test checks 26 known attack strings (script tags, event handlers, `javascript:`/`data:` links, attribute breakouts, fence escapes, nested brackets), 3,000 random strings of hostile fragments, and ReDoS-shaped inputs (50k `*`, `[`, backticks, 2 MB lines; all under 1.5 s). Every output may contain only allow-listed tags, only `href`/`target`/`rel`, and only `http(s)` hrefs.
  - **Found:** the autolinker accepted `https://|#&lt;script…` and swallowed escaped `<`, `>` and quotes into the link. It could not run script (it is still an `https:` URL), but it was wrong. URLs now need a real host start and stop at any escaped angle bracket or quote.
- **innerHTML audit:** listed every `${…}` interpolation in `app.js` that is not wrapped in an escaping/formatting helper (~120). All remaining ones are numbers or adapter-generated constants (`agent`, `level`, `op`); none carry log text.
- **Messy disks (new tests):** a log cut off mid-line, empty and binary `.jsonl` files, a directory named `x.jsonl`, a non-zstd `.zstd` log, a garbage Codex rollout and a junk SQLite WAL — the good sessions are all listed, the rest skipped, nothing throws. A log deleted while the UI is open returns a clean 404; a malformed session key returns 400 instead of 500; no stack traces reach the client.
- **Final assets:** screenshots and replay GIF regenerated from demo data; Insights KPI captions shortened so they no longer truncate ("74% recorded by agents", "+1 sub-agent").

75 tests passing. Five polish rounds done.

## Next cycle (after all 12 projects) — ideas

- Add `repository` to `package.json` once the GitHub repo exists (npm needs it for README images), then publish.
- Gemini CLI and Cursor adapters if their local logs are readable.
- A `blackbox watch` TUI for a running session.

## Agent Skill — 2026-11-12 (1.1.0)

The plan in PROGRESS.md: an entry point for AI coding assistants on each finished tool.

- `plugin/skills/agent-blackbox/SKILL.md`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json` (`claude plugin validate` passes both). The skill: sessions are private (read only what the user asks about, summarise rather than paste, send nothing anywhere, always `--redact` exports); which session (the one the assistant is running in is usually the most recent, so "my previous session" is `-2`); `list --json` with the fields named, `show -2 --errors`, `show --json` events, `stats --by`, `export --redact`, `doctor`.
- **A bug found by writing the skill's test**: `blackbox show -2`, which `--help` documents ("-2 for the 2nd most recent"), failed with "Unknown option '-2'". Node's `parseArgs` takes any token starting with "-" for an option; the session resolver already understood "-2", nothing could reach it. `sessionShorthands()` moves bare `-N` tokens after "--" (positionals there), unless they follow an option that takes a value (`-n -2`). Tested through the CLI and directly.
- `test/skill.test.ts`: frontmatter, plugin and marketplace against package.json, every export in the skill redacted, and every command in the skill's bash blocks run in order on the demo sessions (`--demo`, never real logs; the export into a temp folder).
- README section "Ask your AI assistant", both languages.
