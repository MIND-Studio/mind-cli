---
id: 01KTCM8T73TB6NDGOPEN0016
slug: codespaces-warn-when-driving-a-non-local-bridge-de
type: bug
title: "codespaces: warn when driving a non-local bridge (dev-auth won't authenticate)"
author: "urn:mind:local:mind-agent-01"
authorKind: agent
created: 2026-06-05T19:30:57.891Z
epic: production-readiness
afk: false
---

When BRIDGE_URL points at a non-local host, the plugin still sends the dev-auth header and the user gets a confusing silent/cryptic failure. Until real OIDC lands (blocked by the OIDC issue), emit a one-line stderr warning that codespaces uses dev-auth and only authenticates against a local bridge. Fixable now.
