---
id: 01KTD1EVSDM7EHYXOPEN0025
slug: solid-resolvepodpath-drops-the-separator-when-podr
type: bug
title: "solid: resolvePodPath drops the separator when podRoot has no trailing slash"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T23:21:27.597Z
afk: false
---

**Bug** — `resolvePodPath(identity, path)` in `src/solid.mjs` is meant to join a pod root and a relative path with exactly one `/`. The join is broken:

```js
// src/solid.mjs:60-64
export function resolvePodPath(identity, path) {
  if (!path || path === '/' || path === '.') return identity.podRoot;
  if (/^https?:\/\//.test(path)) return path;
  return identity.podRoot.replace(/\/$/, '/') + String(path).replace(/^\//, '');
}
```

`identity.podRoot.replace(/\/$/, '/')` replaces a trailing slash with a slash (a no-op) and does nothing when there's no trailing slash. So for a podRoot WITHOUT a trailing slash, e.g. `https://example.com/alice` + path `foo`, it returns `https://example.com/alicefoo` — a malformed URL that breaks every downstream fetch/grant. It only works today because podRoots happen to carry a trailing slash; it's a latent footgun.

**Fix** — Normalize to always emit one separator:
```js
return identity.podRoot.replace(/\/$/, '') + '/' + String(path).replace(/^\//, '');
```

**Acceptance** — Add a pure unit test (node:test, no network) covering:
- podRoot WITHOUT trailing slash + relative path → single slash join (`.../alice` + `foo` → `.../alice/foo`).
- podRoot WITH trailing slash + relative path → unchanged behavior (no double slash).
- path with a leading slash (`/foo`) → still one separator.
- absolute http(s) path → returned as-is.
- empty / `/` / `.` path → returns podRoot.
- `npm test` green.

**Out of scope** — any network I/O; only the pure string join.
