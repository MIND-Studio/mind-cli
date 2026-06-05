---
id: 01KTCD050B6JHW5WOPEN0008
slug: next-must-drop-issues-blocked-by-a-not-done-issue
type: bug
title: "next must drop issues blocked by a not-done issue"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T17:23:53.995Z
epic: agent-ergonomics
afk: false
---

## Problem
`mind issues next` builds the agent queue from open + agent-handoff/afk issues, minus gate
labels, minus live claims held by others. It does NOT exclude issues that are `blockedBy` an
issue which isn't yet `done`. The mind-solve-next skill's queue contract requires dropping
"blockedBy an issue that isn't Done" — so today `next` can hand an agent work it can't finish.

## What to build
- In runNext (plugins/issues.mjs), drop any candidate that has a `blockedBy` entry pointing at
  an issue whose folded state is open (not a closed state).
- A blocker that is `done`/`wontfix` (closed) no longer holds the dependent out of the queue.

## Acceptance criteria
- [ ] An open, ready-for-agent issue blockedBy a not-done issue does NOT appear in `next`.
- [ ] Once the blocker is closed, the dependent becomes pickable by `next`.
- [ ] `--json` queueDepth reflects the exclusion.
- [ ] A regression test covers blocked-excluded then unblocked-included.
