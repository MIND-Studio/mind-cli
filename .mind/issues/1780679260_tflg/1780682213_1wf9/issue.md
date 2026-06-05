---
id: 01KTCEWJGESX11PSOPEN0011
slug: id-create-stores-under-name-breaking-id-use-handle
type: bug
title: "id create stores under --name, breaking 'id use <handle>'"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T17:56:53.902Z
epic: issues-plugin-hardening
afk: false
---

Found while dogfooding the discover skill: `mind id create drivetester --name "Drive Tester"` saved the identity as ~/.mind/identities/'Drive Tester.json' (the display label, with a space) instead of keying it by the handle. Result: `mind id use drivetester` → 'no identity drivetester', and the store file has a space in its name. commands.mjs:58 uses `const name = args.name || args.handle` as the *store key*, conflating a human display name with the lookup key.

**Fix:** key the identity by the handle (slugified for safety); treat --name purely as a display label (stored in creds.label). Update help text. Then create<->use are always consistent.

**Acceptance:**
- [ ] `id create X --name "Some Name"` stores under key `X`; `id use X` works
- [ ] the human name is preserved as the label shown in `id ls`
- [ ] no store file ever contains a space; handle is slugified
- [ ] help text for --name no longer says 'name to store it under'
