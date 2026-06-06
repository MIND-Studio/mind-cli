---
id: 01KTD1EKW04Z1MJKOPEN0024
slug: tracker-invalid-to-state-throws-referenceerror-ins
type: bug
title: "tracker: invalid `to:` state throws ReferenceError instead of a clear validation error"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T23:21:19.488Z
afk: false
---

**Bug** — In `src/tracker/fold.mjs`, the fold loop validates each event's `to:` against the declared states, but the error path references an out-of-scope variable.

```js
// src/tracker/fold.mjs:85-92
for (const { data } of events) {       // <- destructures only { data }
  ...
  if (data.to != null) {
    if (!stateIds.has(data.to))
      fail(`${rel}/events/${f}: ...`); // <- `f` is NOT in scope here
    state = data.to;
  }
}
```

Each element of `events` carries its filename as `.f` (built at fold.mjs:74), but the loop only pulls `{ data }`. So when an event has an undeclared `to:` state, instead of the intended 'is not a declared state' message we throw `ReferenceError: f is not defined` — an obscure crash that hides the real problem and the offending file.

**Fix** — Destructure the filename in the loop: `for (const { data, f } of events)` (confirm `f` isn't shadowed/needed elsewhere in the body; rename the loop var if so). One-line change.

**Acceptance**
- Folding an issue whose event has an undeclared `to:` produces the intended error containing `<rel>/events/<file>: \`to: <bad>\` is not a declared state` — NOT a ReferenceError.
- Add a unit test (node:test, no network/spawn): build a tiny temp `.mind/` tree (config with known states + an issue whose event sets `to: bogus-state`), call the fold entry point, and assert it throws with a message matching /is not a declared state/ and including the event filename. Mirror the existing temp-dir pattern in test/tracker.test.mjs.
- Run `npm test` green.

**Out of scope** — any other fold validation; don't change the state model.
