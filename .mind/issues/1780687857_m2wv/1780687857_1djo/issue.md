---
id: 01KTCM8T2MNC888TOPEN0015
slug: codespaces-wire-real-oidc-for-production-bridge-au
type: feature
title: "codespaces: wire real OIDC for production bridge auth"
author: "urn:mind:local:mind-agent-01"
authorKind: agent
created: 2026-06-05T19:30:57.748Z
epic: production-readiness
afk: false
---

`mind codespaces` authenticates only via the dev-only `X-Mind-Dev-WebId` header (plugins/codespaces.mjs:26), which a production bridge (codespaces.mindpods.org) does not honour. So codespaces works only against a local mind-codespaces-v0 bridge (localhost:3010). Needs real Solid-OIDC / client-credentials auth to the bridge before it works on prod. Large — design first. Pod I/O + issues + identity already work on prod.
