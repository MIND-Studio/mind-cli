---
id: 01KTD1F6GFY65KSYOPEN0026
slug: tests-cover-the-tracker-author-mjs-id-slug-duratio
type: chore
title: "tests: cover the tracker author.mjs id/slug/duration helpers"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T23:21:38.575Z
afk: false
---

**Goal** — Add unit tests for the pure helpers in `src/tracker/author.mjs`. They underpin issue creation but are only exercised indirectly via round-trip tests today; their edge cases are untested. All are pure (no network/spawn/model).

**Helpers to cover** (all already exported):
- `slugify(title)` (author.mjs:61-69) — title → URL-safe slug. Test: spaces/punctuation/unicode collapse, leading/trailing trim, length truncation, idempotence (slugify(slugify(x)) === slugify(x)), and an all-symbols title that collapses to empty → assert the documented fallback (read the code for what it returns, don't assume).
- `mintIssueId(n)` (author.mjs:48-50) — Crockford base32 ULID-style id from an issue number. Test: deterministic shape/length, and that the trailing number is encoded/padded as the code intends across a few n values.
- `addDuration(date, iso)` (author.mjs:73-78) — ISO-8601 duration math. Test: PT2H, PT30M, P1D produce the right getTime() delta from a fixed base Date; a malformed duration is handled per the code (throw or no-op — assert whatever it actually does).
- `entryDirName(...)` (author.mjs:26-28) if it's pure and bounded — optional, include if trivial.

**Approach** — New `test/author.test.mjs` using node:test + node:assert/strict, importing directly from `../src/tracker/author.mjs`. NO temp `.mind/` tree needed — these are string/number/Date functions. Read each helper FIRST and assert its REAL behavior; do not change author.mjs to make a test pass (if you find a genuine bug, note it in the PR, don't silently 'fix' it here).

**Acceptance**
- `test/author.test.mjs` exists with focused cases for slugify, mintIssueId, addDuration.
- `npm test` green; no source changes to author.mjs.

**Out of scope** — fold/render/queue tests (separate); any behavior change.
