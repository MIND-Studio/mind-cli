---
id: 01KTCM8TBS1JDZKGOPEN0017
slug: id-create-guide-to-import-local-fallback-when-prod
type: bug
title: "id create: guide to import/local fallback when prod signup is closed"
author: "urn:mind:local:mind-agent-01"
authorKind: agent
created: 2026-06-05T19:30:58.041Z
epic: production-readiness
afk: false
---

`mind id create` against pod.mindpods.org assumes open registration. If the prod CSS has signup gated, create fails with a raw error. When the issuer is non-local and create fails, enrich the error to point at `mind id import <creds.json>` or provisioning against local CSS first. Fixable now.
