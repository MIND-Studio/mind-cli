---
id: 01KTCWT532TPDA58OPEN0020
slug: mind-agents-launch-local-cli-coding-agents-pluggab
type: feature
title: "mind agents: launch local CLI coding agents (pluggable backends)"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T22:00:14.690Z
afk: false
---

**Goal** — Add a `mind agents` plugin whose headline command launches a *local* CLI coding agent with a specialized persona and the current repo as context:

```
mind agents start coder            # interactive: hands over the codex/claude TUI, persona injected
mind agents start coder -p "task"  # headless: codex exec / claude -p, prints result, exits
mind agents list                   # personas found in .mind/agents/ + which backends are on PATH
```

**Personas** — defined per-repo in `.mind/agents/<name>.md`: YAML frontmatter (`name`, `description`, optional `backend`, `model`) + a markdown body that is the system prompt. Loosely coupled to the tracker: a persona may note that a `.mind/` tracker exists and that `mind issues next` surfaces work, but v1 hardcodes **no** claim/implement/handoff loop.

**Backends (pluggable)** — a small `Backend` interface mapping a common `{ personaFile, task?, model?, cwd, interactive }` to per-CLI argv/env. Ship **codex** (default), **claude**, **gemini**; pick via `--backend` or a persona's `backend:` field; auto-detect on PATH and error with an install hint when missing.
- codex 0.135.0: `codex [prompt]` / `codex exec [prompt] --json`; `-m`, `-C/--cd`, `-s`, `-a`; persona via `-c experimental_instructions_file=<file>` or prepend-to-prompt (no system-prompt flag).
- claude 2.1.165: `claude` / `claude -p`; `--model`, `--append-system-prompt-file <file>`, `--permission-mode`, `--add-dir`.
- gemini: `GEMINI_SYSTEM_MD=<file>` env (not installed locally yet).

**Spawning** — `node:child_process.spawn`. Interactive uses `stdio: "inherit"` (child owns the terminal); headless uses piped stdio to stream/collect. First plugin in mind-cli to shell out.

**Plugin shape** — `plugins/agents.mjs`, default-export `defineCommand` with `subCommands: { start, list }`. Reuse `src/ui.mjs` (`emit/guard/spin/table/sym/colors`); read the active identity via `getActive()` from `src/store.mjs` only to expose `$MIND_*`/author context to the child (the agent authenticates with its own backend creds — codex/claude login is separate from the Solid identity).

**Acceptance (v1)**
- `mind agents list` shows personas in `.mind/agents/` and marks which backends are installed.
- `.mind/agents/coder.md` exists as a starter persona (frontmatter + prompt).
- `mind agents start coder` launches the default backend interactively with the coder persona; exit code propagates from the child.
- `mind agents start coder -p "<task>"` runs headless and prints the result.
- `--backend codex|claude` overrides; missing backend -> clear install hint, non-zero exit.
- Honors `--json` where meaningful (`list`); README `agents` section added.

**Out of scope (later issues)** — autonomous issue-solver loop wired to `mind issues`; multi-agent orchestration; pod-backed agent roster (cf. mind-agents-v0); PTY support; gemini-specific testing.
