---
id: 01KTCCCS5BAC04PDOPEN0007
slug: webid-display-collapses-every-identity-to-card
type: bug
title: "WebID display collapses every identity to 'card'"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T17:13:19.275Z
epic: issues-plugin-hardening
afk: false
---

displayName/actorTag took the last path segment after stripping #me, but Solid WebIDs end in /profile/card#me, so everyone rendered as 'card'. Fixed in src/tracker/actor.mjs: strip the canonical card location, surface the account/pod name; regression test added.
