# Contributing

Thanks for helping! agent-blackbox is small on purpose: **zero runtime dependencies**, plain TypeScript run directly by Node.js, and a vanilla-JS UI.

## Setup

```bash
npm install          # dev dependencies only (typescript, @types/node)
npm run dev -- list  # run the CLI from source (Node runs .ts files directly)
npm run dev          # start the UI from source
npm test             # node:test, no extra framework
npm run check        # type-check + tests
```

Node.js 22.18+ runs TypeScript natively. On 22.15–22.17 add `--experimental-strip-types`.

## Project layout

```
src/
  adapters/      one file per agent: discover() + load() → normalized Session
    common.ts    shared "is this really a human prompt?" classification
  builder.ts     SessionBuilder: pairs tool calls with results, computes summaries
  catalog.ts     discovery, summary cache, id resolution
  pricing.ts     model price table + user overrides
  edits.ts       diff / apply_patch / string-replace → FileEdit
  zstd.ts        multi-frame zstd splitter (DeepSeek Harness logs)
  render/        terminal output
  server.ts      local UI server (127.0.0.1, token, Host check)
  export.ts      HTML / Markdown / JSON export
ui/              index.html, style.css, app.js — no build step
test/            synthetic fixtures for every agent; never real user logs
```

## Adding an agent

1. Create `src/adapters/<agent>.ts` exporting an `Adapter`:
   - `defaultRoots()` — where the agent stores logs on each OS (respect its env vars).
   - `discover(roots)` — return a `SessionRef` per session. Keep it cheap: list files, `stat` them, do not parse.
   - `load(ref)` — parse into a `Session` with `SessionBuilder`. Call `b.user()`, `b.assistant()`, `b.tool()` / `b.result()`, `b.usage()`, and set `b.recordedCostUsd` if the agent logs its own cost.
2. Add it to `ADAPTERS` and `parseAgent()` in `src/adapters/index.ts`, and a label in `AGENT_LABELS`.
3. Add a synthetic fixture to `test/helpers.ts` and tests to `test/adapters.test.ts`. **Never commit real session logs** — they contain code, secrets and personal data.
4. Document the location in both READMEs.

Things every adapter must get right:

- **Prompts are human input only.** Route injected context through `classifyUserText()` or show it with `b.system()`.
- **Usage is counted once per API request.** Check whether the agent repeats usage across lines or events.
- **`input` tokens exclude cached tokens.** Normalize if the provider reports them inclusively (OpenAI does).
- **Never throw on a weird line.** Logs get truncated mid-write; skip what you do not understand.

## Prices

Prices live in `src/pricing.ts` with the date they were last reviewed (`PRICES_UPDATED`). When updating, please link the official pricing page in your PR.

## Style

- Keep runtime dependencies at zero. If you think something needs one, open an issue first.
- Prefer small pure functions with tests over clever code.
- UI text should be short and plain. Every number that is an estimate must say so.
