---
id: 01KTCYXJ4NZ7V6HWOPEN0021
slug: agents-add-no-persona-flag-to-start-launch-the-bar
type: feature
title: "agents: add --no-persona flag to start (launch the bare backend)"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T22:37:03.509Z
afk: false
---

Add a `--no-persona` boolean flag to `mind agents start`.

When set, skip all persona injection and launch the backend bare (still in the
repo cwd): no prepended persona for codex, no `--append-system-prompt` for claude,
no `GEMINI_SYSTEM_MD` for gemini. The persona file is not read.

Scope:
- Add the flag in `plugins/agents.mjs` `start` args.
- Pass `personaText: undefined` / `personaFile: undefined` into the backend
  `build()` when `--no-persona` is set (so the existing argv logic naturally omits
  injection — no per-backend special-casing needed).
- `--issue`/`-p` task handling is unchanged; `--no-persona` only drops the system prompt.
- Update the README `agents` row and add a test (e.g. codex `build()` with no
  personaText emits just the task; claude omits `--append-system-prompt`).

Acceptance:
- `mind agents start coder --no-persona -p "echo hi" --dry-run` shows a codex
  command with no `[SYSTEM PERSONA …]` block.
- `npm test` green.
