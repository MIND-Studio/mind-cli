# `decisions/` — this project's decision records

This folder holds **mind-cli's own** architecture decisions (ADRs) — *why this project* is shaped
the way it is. One file per decision, append-only, supersede-don't-edit.

As project-specific calls are made *through the tracker* (a `review` issue resolved by a
design choice), capture the rationale here and link it from the issue. The first such call is
[`0001-codespaces-prod-auth.md`](0001-codespaces-prod-auth.md) (MC-15).

## This is not where the tracker's *own* design lives

The decisions about **how this tracker is built** (state-in-events, path-as-context,
milestones-as-calendar, identity, layout, storage-vs-agent-input, AI-suggests-humans-commit) are
**not** mind-cli decisions — they're design rationale for the Mind *issues* app and for Mind's base
human+agent collaboration. They live in the Mind decision log:

- **Tracker-app design** → `architecture/src/decisions/apps/issues/` (0001–0005)
- **Cross-cutting base** → `architecture/src/decisions/architecture/` (0008 storage-vs-agent-input,
  0009 AI-suggests-humans-commit)

(From this folder: `../../../../architecture/src/decisions/`.)

Keeping them there means any project that adopts this tracker format shares one rationale, and a
project's own `decisions/` stays about *that project*.
