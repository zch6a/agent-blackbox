# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-11-12

A second polishing cycle: an independent review (13 confirmed problems, all fixed below), and a fifth agent.

### Security
- **The Markdown renderer could run script from a session (stored XSS).** Inline formatting was a chain of
  `.replace()` passes, and the autolink pass found a URL inside the `href="…"` the link pass had just written:
  `[x](https://a/(https://b/autofocus/onfocus=…)` broke out of the attribute and ran, with no click, in the live UI
  and in HTML exports, with access to the page's API token. Session text comes from models, tools and web pages, so
  a prompt-injected page could plant it. Inline Markdown is now one left-to-right pass whose output is never scanned
  again; the review's payloads are tests, and a second fuzzer builds 20,000 hostile links from URL pieces.
- **Escape sequences in a log reached the terminal.** `list`, `show`, `stats` and `export -f md` printed what an
  agent or a tool had printed: clear the screen, set the window title, write the clipboard (OSC 52), disguised
  links (OSC 8), even with `--no-color`. Control characters are now shown as symbols (`␛`), never sent, and
  bidirectional overrides are neutralised.

### Added
- **Gemini CLI**, the fifth agent: `~/.gemini/tmp/*/chats/` (or `$GEMINI_CLI_HOME`). The log is append-only and
  rewrites itself (a message written again replaces the first copy, `$rewindTo` drops what the user rewound,
  `$patch` and `$set` update messages and the title); agent-blackbox applies it the way Gemini CLI does. Also the
  older whole-file `session-*.json`, sub-agents (`chats/<session>/`), the project folder from `projects.json` or
  `.project_root` (older hash-named folders included), file changes from Gemini's own diffs, shell exit codes, and
  tokens priced correctly (Gemini counts cached tokens inside the prompt and thought tokens beside the output).
  `--agent gemini`, a demo session, both READMEs and the banner.
- A release workflow: each version tag is tested, packed (the packed CLI is installed and run once), and published as
  a GitHub release with its CHANGELOG section and the installable `.tgz` attached.
- `scripts/screenshots.mjs` regenerates the README screenshots from the demo.

### Changed
- CI pins its actions to commits, keeps no token in the checkout, installs without running dependency scripts, and
  smoke-tests `list --demo` on all three systems.

### Fixed
- **`export --redact`:** it took seconds to minutes on long runs of dots, dashes or `+` (7.5 s for 100 KB of
  `a.`; every pattern is now linear); it missed `SECRET_KEY=…`, `PGPASSWORD=…`, JSON-escaped `\"api_key\": \"…\"`,
  `Authorization: Token …`, private keys cut off before their END line, short `github_pat_` tokens, Google OAuth
  secrets, Slack and Discord webhooks, short passwords, and secrets stored as values of parsed tool inputs
  (`{env: {PGPASSWORD: …}}`, now redacted by their key); it over-redacted code (`token = getToken()`), branch names
  (`sk-feature-…`), package versions (`foo@1.2.3.tgz`) and SSH remotes (`git@host`); and it replaced the home folder
  as a substring (`/home/al` ate the start of `/home/alex`; with home `/`, every slash). A home folder that cannot be
  determined no longer crashes it.
- Two more patterns were quadratic on long runs of spaces: Markdown table separators (2 s for 50,000) and the
  "exit code" in error summaries.
- Symbolic links and Windows junctions in log folders were skipped; they are followed now (each real folder once,
  never into a FIFO or a device).
- The Insights chart for more than 800 days dropped the newest days instead of the oldest.
- A tool called `constructor` or `toString`, or a model called `__proto__`, broke the counts (and the latter wrote
  onto `Object.prototype`).
- Project names from Windows paths read on Linux or WSL (`--root`) were the whole path.
- `--host ::1` printed and opened an invalid URL; `--host 0.0.0.0` refused requests from the network it was told
  to serve (IP addresses are accepted now when bound to every interface; domain names are still refused, so DNS
  rebinding stays blocked, and the API still needs the token).
- A malformed link (`#/s/%E0`) kept the UI on "Reading your agent logs…".
- `blackbox stat` and other typos said "No session matches"; they now suggest the command. `show c` matched every
  Claude Code session (key prefixes count only with the agent: `codex:019a`). `-o out.txt` complained about
  `--format` without naming the file.
- **Tests used the real home folder.** They read the user's own price file (`~/.config/agent-blackbox/pricing.json`)
  if there was one, and an agent without a test folder fell back to its real one: adding Gemini CLI would have made
  the test suite read the real `~/.gemini`. Every test process now runs with the home folder, the cache and every agent's folder
  variable pointed at an empty temp folder, and a test checks that every agent's default folders are inside it.

## [1.1.0] — 2026-11-12

### Added
- An Agent Skill and a Claude Code plugin: `/plugin marketplace add zch6a/agent-blackbox`, then
  `/plugin install agent-blackbox@agent-blackbox`. Ask the assistant what went wrong in a session, what your agents
  cost, or for a shareable replay; the skill keeps it to the sessions you ask about and always redacts exports. A test
  runs every command it gives, on the demo sessions.

### Fixed
- `show -2` (and every `-N` session shorthand that `--help` promises) failed with "Unknown option '-2'": the argument
  parser took it for an option. Such tokens are now read as the session, unless they are an option's value (`-n -2`).

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
