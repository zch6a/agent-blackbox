---
name: agent-blackbox
description: Look back at AI coding agent sessions (Claude Code, Codex, OpenCode, DeepSeek Harness) with agent-blackbox. Use when the user asks what an agent did in a past session, where a session went wrong, which commands failed, which files were changed, how much their coding agents cost (per day, project, model), or wants a shareable replay of a session with secrets removed.
license: MIT
compatibility: Needs Node 22.15+ on the machine. Runs agent-blackbox with npx from GitHub (github:zch6a/agent-blackbox) unless a blackbox command is installed. Reads the agents' local session logs; nothing is uploaded.
metadata:
  homepage: https://github.com/zch6a/agent-blackbox
---

# Looking back at agent sessions with agent-blackbox

agent-blackbox reads the session logs that coding agents already write to disk and turns them into timelines,
costs and replays. It runs locally and sends nothing anywhere.

## Sessions are private

Session logs hold the user's code, prompts, file contents and sometimes secrets. Read only the sessions the user
asks about, summarise instead of pasting long logs back, and never send session content anywhere. When exporting
something meant to be shared, always pass `--redact`.

## Which session

A session is named by an id prefix (like git), `last`, or `-2` for the second most recent. The session you are
running in right now is usually the most recent one, so for "my previous session" use `-2`, or list them and pick:

```bash
npx -y github:zch6a/agent-blackbox list --since 7d -n 10 --json
```

Use `blackbox` instead of `npx -y github:zch6a/agent-blackbox` if the command is installed. Each entry has `key`,
`agent`, `id`, `title`, `cwd`, `startedAt`, `endedAt`, `cost.usd`, `toolCalls`, `toolErrors`, `filesChanged`,
`linesAdded`, `linesRemoved`, `models`. `-p <text>` keeps only sessions whose working directory contains the text;
`-a claude,codex` only some agents.

## What happened, and what went wrong

```bash
npx -y github:zch6a/agent-blackbox show -2 --errors --no-pager
```

`--errors` keeps only the failed tool calls with their output; without it the whole timeline is shown. For the
full detail as data, `show <session> --json` gives the session with its `events` (each with `kind`, `t`, `text`).
Tell the user what the agent did, what failed and why, and which files it changed.

## What it cost

```bash
npx -y github:zch6a/agent-blackbox stats --by day --since 30d --json
```

`--by` takes `day`, `week`, `month`, `agent`, `model`, `project` or `tool`. Costs marked as estimated come from
token counts and published prices, not from the agent's own record; say so when it matters.

## A shareable replay

```bash
npx -y github:zch6a/agent-blackbox export -2 --redact -o session.html
```

A self-contained HTML replay with secrets scrubbed (`-f md` for Markdown). Tell the user where the file is and
that `--redact` removes known secret patterns but they should still read it before sharing.

## Nothing found?

```bash
npx -y github:zch6a/agent-blackbox doctor
```

shows which agents were found and where their logs are.
