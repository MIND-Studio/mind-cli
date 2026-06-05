---
id: 01KTCDGJATBJREE6OPEN0010
slug: close-release-write-misleading-no-op-events
type: bug
title: "close/release write misleading no-op events"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T17:32:51.930Z
epic: issues-plugin-hardening
afk: false
---

Closing an already-closed issue writes a second CLOSE event, and `release` when you hold nothing writes a RELEASE event — both no-ops that pollute the append-only log and misrepresent history. close should refuse when the issue is already in the target closed state; release should refuse (or warn) when there's no live holder. Keep a --force override.

**Acceptance:**
- [ ] close on an already-done issue errors (state unchanged), --force overrides
- [ ] release with no holder errors/warns, --force overrides
- [ ] unit test covers the refusals
