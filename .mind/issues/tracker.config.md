---
title: "mind-cli"
description: "Epic-scoped, event-sourced. Issues are markdown folders with an append-only events/ log; `mind issues build` folds events to build/*.ttl. This frontmatter is the authoritative vocab."
namespace: "https://mindpods.org/ns/mind-cli#"
initialState: needs-triage
# Current state is the FOLD of an issue's events/ — never a field on issue.md.
# These are the legal `state:` values an event may transition `to:`.
states:
  - id: needs-triage
    label: "needs triage"
    open: true
    handoff: human
  - id: ready-for-agent
    label: "ready for agent"
    open: true
    handoff: agent
  - id: ready-for-human
    label: "ready for human"
    open: true
    handoff: human
  - id: in-progress
    label: "in progress"
    open: true
  - id: blocked
    label: "blocked"
    open: true
  - id: done
    label: "done"
    open: false
  - id: wontfix
    label: "won't fix"
    open: false
# Issue categories (the `type:` axis).
categories:
  - id: feature
  - id: bug
  - id: refactor
  - id: chore
  - id: docs
# The four orthogonal axes a triager sets.
axes:
  type: categories
  state: states
  priority: [urgent, high, normal, low]
  labels: open-set
# Coordination for multi-agent work (claim before working).
coordination:
  claimTtl: PT2H
  tieBreak: lowest-ulid
  queueGateLabels: [human-only, needs-design, blocked]
# Generated — never hand-edit.
generated:
  - build/tracker.ttl
  - build/epics.ttl
  - build/state.ttl
---

# mind-cli

This file's **YAML frontmatter is the source of truth** for the controlled vocabulary
(states, categories, axes, coordination). `mind issues build` reads it, folds every
issue's `events/` log to a current state, and writes `build/{tracker,epics,state}.ttl`.

- **State** is derived, not declared — it is the `to:` of an issue's latest state-changing event.
- **Categories** = the `type:` axis. **Priority/labels** are the other two triage axes.

Never hand-edit `build/*` — it is generated.
