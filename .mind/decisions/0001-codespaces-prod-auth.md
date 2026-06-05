# 0001 — How `mind codespaces` authenticates to a production bridge

- **Status:** proposed (recommendation; not yet implemented)
- **Date:** 2026-06-05
- **Tracks:** MC-15 (`codespaces: wire real OIDC for production bridge auth`)
- **Scope:** mind-cli (`plugins/codespaces.mjs`) + mind-codespaces-v0 (the bridge)

## Context

`mind codespaces …` (list/create repos, mint git push tokens) identifies itself to the codespaces
bridge with a single dev-only header:

```
X-Mind-Dev-WebId: <webid>
```

This is an unauthenticated *claim* — no proof. The bridge trusts it **only outside production**
(`plugins/codespaces.mjs` sends it; the bridge honours it on `localhost:3010`). The production
bridge (`codespaces.mindpods.org`) correctly ignores it, because anyone could forge the header and
impersonate any WebID. Net effect today:

- ✅ `mind codespaces` works against a **local** bridge you run yourself
- ❌ it does **not** work against the hosted bridge

v0.2.1 (MC-16) made this *fail legibly* — a non-local `BRIDGE_URL` now prints a one-line stderr
warning instead of a cryptic 401/403 — but the warning explains the wall, it does not remove it.

Everything else in the CLI (identity, pod I/O, the issue tracker) already works against prod; this
is the one feature still tethered to a local server.

## Decision

Replace the trust-me header with a real Solid-OIDC token, and make the bridge verify it. Two
authentication paths were considered; **client-credentials is the primary path**, with an optional
interactive login layered on later.

| | **Client-credentials** *(chosen, primary)* | **Interactive loopback auth-code** *(optional, later)* | **Device-code** *(rejected)* |
|---|---|---|---|
| Flow | stored `clientId`+`secret` → signed token, no human | open browser → log in → `localhost` redirect captures token | CLI prints a code, approve on another device |
| Headless? | ✅ yes — AFK agents & CI | ❌ needs a human + browser each time | ❌ needs a second device |
| IdP support | ✅ **CSS ships this today** | ✅ standard auth-code + PKCE | ⚠️ not reliably enabled in CSS |
| Fits the CLI | ✅ `mind id import <creds.json>` already *is* a client-credential | partial — new browser-dance code | poor |

### Why client-credentials first

1. **It serves the headline use case.** This tool is built around AFK agents (`mind-agent-01`, the
   `afk` flag) claiming and working issues. An agent has no browser; only a non-interactive flow
   serves it. Client-credentials is the only option that does.
2. **Zero IdP changes.** Community Solid Server supports client-credentials tokens out of the box —
   no pod/OIDC-provider redeploy. Device-code or anything custom would require that, turning a
   CLI-side feature into a cross-service project.
3. **It reuses what's already here.** `mind id import <creds.json>` already stores a CSS
   client-credential; the CLI already depends on `@inrupt/solid-client-authn-node`, whose
   `login({ clientId, clientSecret, … })` does exactly this. The change is "use the creds we
   already store to mint a token and attach it," not new infrastructure.

### Why *not* device-code

Device-code is for when the browser is on a *different* machine (SSH, TVs). This is a developer's
laptop — the browser is right there, so the loopback auth-code flow is simpler and better supported.
Keep it as the human-friendly option, not the critical path.

## Consequences

- **mind-cli:** in `plugins/codespaces.mjs`, replace the `X-Mind-Dev-WebId` header with
  `Authorization: DPoP <token>` minted from the active identity's stored client-credentials. The
  `isLocalBridge` warning (MC-16) stays as a fallback for the dev-header path during transition.
- **mind-codespaces-v0 (the bridge):** stop trusting the dev header in production; instead verify the
  Solid-OIDC token and derive the WebID from it. **This is why MC-15 is a "design first" task — it is
  a change in two repos, not just the CLI.**
- **Humans without a creds file:** a later `mind id login` (interactive loopback) can mint
  credentials without the manual `creds.json` import. Not on the critical path.

## Open question to resolve before implementing

**What does the production bridge actually expect on its end** — is it already set up to verify
Solid-OIDC tokens, or does that verification need building too? This decides whether MC-15 is "a CLI
change" or "a CLI + bridge change" (almost certainly the latter). Confirm this first; it sets the
real scope.
