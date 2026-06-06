# AGENTS.md — machine contract for `.mind`

This tracker is read and written by agents. These rules are binding.

## Reading — query, never slurp

- **Facts** come from `issue.md` frontmatter; **narrative** from its body; **state & history**
  from `events/`.
- **Current state is the fold of `events/`** — the `to:` of the latest state-changing event.
  There is no `state:` field on the issue; do not invent one.

## Writing — events are the only way to change state

- **Change state = append one event** (`mind issues triage|claim|state|handoff|close …`).
  Do not edit `issue.md`'s body to record state.
- **Claim before working** (`mind issues claim <ref>`). Claims carry a ttl; lowest ULID wins ties.
- **Suggest, don't decide. Never self-close** — hand back with `mind issues handoff` to
  `review`.
- **Respect gates.** Do not pick up issues labelled `human-only`, `needs-design`, or `blocked`.

## Event kinds

`open` · `triage` · `claim` · `release` · `state` · `link` · `comment` · `handoff` · `close`.

## Referencing issues

Reference an issue by its canonical **ULID** (`issue.md` `id:`), never by path or display handle.
