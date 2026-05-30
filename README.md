# mind-cli (`@mind-studio/cli`)

One CLI to manage **Solid identities** and drive the **Mind prototypes** from
the terminal — for you, for scripts/CI, and for agents (this is how Claude acts
as its own WebID). Standalone Node bin, no build step.

It's the headless twin of `mind-shared-ui` (the unified login *card*) and
`mind-home-v0` (the GUI account front door): the same identity + pod
capabilities, exposed as commands.

```
mind id create claude            # mint a WebID + pod + client-credentials
mind whoami                      # who am I right now
mind ls / · cat <p> · put <p> -  # read/write the active identity's pod
mind grant <webid> <p> --modes r # share part of your pod (WAC)
mind codespaces repos            # a plugin: drive the Solid Git bridge
```

## Why it exists

Every prototype re-rolled the same CSS v7 account-API dance (create account →
pod → client-credentials) and its own pod I/O — ~10 copies. `mind` does it once,
keeps a multi-identity store, and lets each prototype plug in as a command group.

## Install

**One-liner** (recommended — requires Node.js ≥20):

```bash
curl -fsSL https://raw.githubusercontent.com/MIND-Studio/mind-cli/main/install.sh | bash
```

This fetches the latest release, installs its deps, and puts a `mind` launcher in
`~/.local/bin`. Re-run it any time to update. Overridable via `MIND_CLI_REF`
(pin a tag/branch), `MIND_CLI_HOME` (source dir), `MIND_CLI_BIN` (launcher dir).

To inspect before running (it's `curl | bash`, after all):

```bash
curl -fsSL https://raw.githubusercontent.com/MIND-Studio/mind-cli/main/install.sh -o install.sh
less install.sh && bash install.sh
```

**From source** (for hacking on the CLI itself — no build step, plain ESM):

```bash
git clone https://github.com/MIND-Studio/mind-cli && cd mind-cli
npm install
npm link                       # gives you a global `mind`
node bin/mind.mjs --help       # or run it directly
```

**Stack:** [`citty`](https://github.com/unjs/citty) for the command layer
(typed args, auto-generated help, nested subcommands), `picocolors` + `cli-table3`
+ `ora` + `@clack/prompts` for output, and `@inrupt/solid-client-authn-node` for
Solid auth. All real dependencies — `npm install` is required (the one-liner installer does
this for you). `solid.mjs` still falls back to a sibling prototype's `@inrupt`
install if its own is missing, but `citty`/styling are not borrowable.

## The identity store

Identities live in **`~/.mind/`** (outside any git repo, `chmod 600`):

```
~/.mind/
  config.json              { "active": "claude" }
  identities/claude.json   issuer, webId, podRoot, email, password, clientId, clientSecret
  identities/agent.json
```

`mind id ls` shows them, `* ` marks the active one. Switch with `mind id use <name>`.
All pod commands act as the active identity. **Secrets never print** — `mind id show`
redacts `clientSecret`/`password`.

## Developer- & agent-friendly

- **Help everywhere** (citty-generated): `mind --help`, `mind <group> --help`,
  `mind <group> <cmd> --help` — typed args and options documented automatically.
- **`--version`**, and citty validates required args with a clear error.
- **Pretty for humans:** color, tables (`id ls`, `codespaces repos`), spinners on
  network calls, and an interactive picker for `mind id use` (no arg).
- **Clean for machines:** all styling auto-disables when stdout isn't a TTY, when
  `NO_COLOR` is set, or under `--json`. Spinners write to **stderr** so stdout
  stays pure. `FORCE_COLOR=1` forces color (e.g. CI).
- **`--json`** (`-j`) on any command → structured output for agents/scripts.
  Errors also emit `{"ok":false,"error":"…"}` in `--json` mode.
- **Exit codes:** `0` on success, non-zero on any error — safe in `set -e`.
- **Secrets never print:** `id show` redacts `clientSecret`/`password`.

```bash
mind whoami --json
#   { "name": "claude", "webId": "…/claude/profile/card#me", "podRoot": "…", "loggedIn": true }
mind ls / --json
#   { "container": "…/claude/", "members": ["workspace/","README","notes/","profile/"] }
```

## Commands

### Identity
| | |
|---|---|
| `mind id create <handle> [--issuer URL] [--name N]` | new account+pod+WebID+creds (default issuer `http://localhost:3011/`, override with `--issuer` or `MIND_ISSUER`) |
| `mind id ls` | list identities (active marked `*`) |
| `mind id use <name>` | set the active identity |
| `mind id rm <name>` | forget an identity (does not delete the pod) |
| `mind id show [name]` | print an identity, secrets redacted |
| `mind id import <creds.json> [--name N]` | adopt an existing creds file |
| `mind whoami` | live-verify and print the active identity |

### Pod I/O (as the active identity)
Paths are pod-relative, or absolute `http(s)://` URLs (for cross-pod access you've been granted).
| | |
|---|---|
| `mind ls [path]` | list a container |
| `mind cat <path>` | print a resource |
| `mind put <path> [file\|-] [--type ct]` | write (stdin with `-`, default `text/plain`) |
| `mind mkdir <path>` | create a container |
| `mind rm <path>` | delete |
| `mind grant <webid> <path> --modes rwc` | WAC grant (`r`ead `w`rite `c`ontrol `a`ppend); owner keeps control, grantee gets exactly these modes |

### Plugins
`mind <group> …`, auto-loaded from `plugins/*.mjs`.

**`codespaces`** — drives the mind-codespaces bridge (`BRIDGE_URL`, default `http://localhost:3010`) as the active identity (dev-auth header):
| | |
|---|---|
| `mind codespaces repos` | list repos |
| `mind codespaces new <name> [--private]` | create a repo (returns clone URL) |
| `mind codespaces token <repo> [--label L]` | mint a git push token |

## Writing a plugin

Drop a `plugins/<name>.mjs` with a default export:

```js
export default {
  name: "drive",
  summary: "browse pod files like a drive",
  commands: { ls: "list", get: "download <path>" },
  async run(argv, ctx) {
    // ctx.identity = active identity (creds, webId, podRoot)
    // ctx.log = printer
  },
};
```

Future ideas: `mind drive`, `mind chat`, `mind social`, `mind builder` — each
prototype exposing its verbs. Keep plugins thin; real logic stays in the
prototype/bridge.

## Notes & limits

- **Local-first.** Default issuer is the mind-codespaces local CSS `:3011`.
  Point at production with `--issuer https://codespaces-pod.duckdns.org/`.
- An identity only works while its CSS is up, and its creds go stale if that
  server's `.css-data/` is wiped — just `mind id create` again.
- By default a WebID can only touch its **own** pod; `mind grant` (run by the
  pod owner) is how you open up cross-pod access.
- TS-vs-Rust: this is Node/ESM on purpose — the Solid auth stack (Solid-OIDC,
  DPoP, client-credentials) only has a mature implementation in JS. A Rust
  rewrite would mean reimplementing DPoP/OIDC; revisit only if a single static
  binary becomes a hard requirement.
