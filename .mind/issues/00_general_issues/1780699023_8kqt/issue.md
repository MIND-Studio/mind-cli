---
id: 01KTCYXJADYPVRD9OPEN0022
slug: agents-list-show-each-persona-s-model
type: feature
title: "agents list: show each persona's model"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T22:37:03.694Z
afk: false
---

`mind agents list` currently shows columns: persona, backend, description. Add a
`model` column sourced from each persona's frontmatter `model:` field (already
parsed into `readPersonas`), rendering a dim `—` when unset.

Scope:
- In `plugins/agents.mjs` `list`, add the column to the human table only; the
  `--json` output already includes `model`, so leave it untouched.
- Keep alignment/colors consistent with the existing table.
- Add/extend a test if practical (the table is print-only; at minimum verify
  `readPersonas` carries `model` through — a pure assertion).

Acceptance:
- A persona with `model: gpt-5.5` shows that model in `mind agents list`.
- A persona without a model shows `—`.
- `npm test` green.
