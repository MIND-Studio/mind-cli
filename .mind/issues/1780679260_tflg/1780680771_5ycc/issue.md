---
id: 01KTCDGJ6ZXY5FYROPEN0009
slug: triage-blocks-silently-drops-handle-unresolved-ref
type: bug
title: "triage --blocks silently drops handle/unresolved refs"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T17:32:51.807Z
epic: issues-plugin-hardening
afk: false
---

`mind issues triage <ref> --blocks MC-2` (or any non-raw-ULID / typo'd ref) is accepted and writes the event, but the fold drops unresolved refs (fold.mjs:210 `i.blocks.filter(ref => byId.has(ref))`), so the dependency link silently vanishes — no error, no warning, blocks: — on both issues. Only raw ULIDs that happen to match work.

**Fix:** resolve each --blocks ref through resolveIssue (so MC-N, #N, N, slug, and ULID all work), write the canonical ULID, and error with candidates when a ref doesn't resolve. Keeps build-trio parity (still writes ULIDs).

**Acceptance:**
- [ ] --blocks MC-2 links to MC-2's ULID (show MC-1 → blocks: MC-2, show MC-2 → blockedBy: MC-1)
- [ ] --blocks with an unknown ref errors (no event written), listing valid forms
- [ ] golden trio still byte-identical; new unit test covers resolve + reject
