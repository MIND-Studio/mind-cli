# mind-cli (`@mind-studio/cli`)

One CLI to manage **Solid identities** and drive the **Mind prototypes** from
the terminal — for you, for scripts/CI, and for agents (this is how Claude acts
as its own WebID). Standalone Node bin, no build step.

It's the headless twin of `mind-shared-ui` (the unified login *card*) and
`home` (the GUI account front door): the same identity + pod
capabilities, exposed as commands.

```
mind id create claude            # mint a WebID + pod + client-credentials
mind whoami                      # who am I right now
mind ls / · cat <p> · put <p> -  # read/write the active identity's pod
mind grant <webid> <p> --modes r # share part of your pod (WAC)
mind codespaces repos            # a plugin: drive the Solid Git bridge
mind issues add "Fix it"         # a plugin: manage a local .mind tracker (add · start · done)
mind issues next --claim         #   …and the agent loop: grab the next ready issue
mind agents start coder          # a plugin: launch a local CLI coding agent (codex) with a persona
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
`~/.local/bin`. Re-run it any time to update, or run `mind update`. Overridable
via `MIND_CLI_REF` (pin a tag/branch), `MIND_CLI_HOME` (source dir),
`MIND_CLI_BIN` (launcher dir).

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
- **Typo-friendly:** a mistyped subcommand prints a tight `did you mean \`mind issues next\`?`
  (Damerau distance, so transpositions like `enxt`→`next` resolve) instead of dumping the full help.
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
| `mind update [--ref tag\|branch] [--dry-run]` | update the CLI by re-running the installer (`upgrade` alias) |

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

**`chat`** — post to and tail a Solid **long-chat** room as the active identity
(same WebID you drive with `ls`/`put`/`grant`). Self-contained raw turtle over
`session.fetch` — no SDK. Room defaults to `pod.mindpods.org/testuser/chat/general`
(override with `--room <url>` or `$MIND_CHAT_ROOM`):
| | |
|---|---|
| `mind chat whoami` | active identity + resolved room/day-file |
| `mind chat say "<message>"` | post a message (appends to today's `chat.ttl` via SPARQL `INSERT DATA`) |
| `mind chat read` | list today's messages (table; `--json` for raw) |
| `mind chat watch` | live-tail the room (WebSocketChannel2023 push + poll fallback; rolls to the new day file at UTC midnight; Ctrl-C to stop) |
| `mind chat connect [--outbox FILE]` | bidirectional agent loop: one held session streams inbound to stdout and posts each line appended to `--outbox` (default `~/.mind/chat-outbox`) — no per-message login |
| `mind chat rm <message-url>` | soft-delete a message (appends a `schema:dateDeleted` marker; `read` then hides it) |

`watch`/`connect` poll fallback is 5s; tighten with `MIND_CHAT_POLL_MS=1000`. `connect`
holds one session (re-login every 10 min, under the CSS token TTL), so an appended outbox
line posts in ~150ms vs. `say`'s ~0.8s fresh-login round-trip — built for driving the room
from a script or agent. `rm` is a *soft* delete (a marker triple) because shared rooms grant
`acl:Append`, not `acl:Write` — hard removal needs room-owner (Write) access.

**`agents`** — launch a *local* CLI coding agent (codex / claude / gemini) with a
per-repo **persona** (a specialized system prompt) and the current repo as its
working directory. First plugin to shell out — `node:child_process.spawn` with
`stdio: "inherit"`, so the child owns the terminal (full TUI). Personas live in
`<repo>/.mind/agents/<name>.md` (YAML frontmatter `name`/`description`/optional
`backend`/`model` + a markdown body that **is** the system prompt):
| | |
|---|---|
| `mind agents list` | personas in `.mind/agents/` + which backends are on PATH (`--json` for scripts) |
| `mind agents start <persona>` | interactive: hand over the backend's TUI with the persona injected |
| `mind agents start <persona> -p "<task>"` | headless: run the task, print the result, exit (child's exit code propagates) |
| `mind agents start <persona> --no-persona -p "<task>"` | launch the bare backend in the repo cwd; task/issue handling still works, but no system prompt is injected or read |
| `mind agents start <persona> --issue MC-N` | **load a tracker issue** (ULID/`MC-N`/slug, or `next` for the top of the agent queue) as the task — folds its title+body into the prompt, then **claims it** (→ `doing`, with the config ttl) so a re-run of `--issue next` advances to the next issue instead of re-picking this one. It never *closes* the issue — a human reviews and closes. Pass `--no-claim` to read the issue without touching tracker state, `--force` to steal a live claim, or `--dry-run` to print the resolved backend/argv/task (and whether it would claim) without spawning |

Backends are **pluggable** (`--backend codex\|claude\|gemini`, or the persona's
`backend:`; **codex** is the default). Persona injection differs per CLI: codex
**prepends the persona to the prompt** (it has no system-prompt channel), claude via
`--append-system-prompt`, gemini via `GEMINI_SYSTEM_MD`. A missing backend errors with an install hint and a
non-zero exit. The agent authenticates with **its own** creds (codex/claude login is
separate from the Mind identity); the active identity is exposed to the child only as
`$MIND_WEBID`/`$MIND_AUTHOR`/`$MIND_POD_ROOT` context.

**`issues`** — manage a local **`.mind/`** event-sourced issue tracker (the same
markdown-folder + append-only `events/` format the codespaces bridge folds into
`build/*.ttl`). Operates on the `.mind/` of the repo you're in (walks up from cwd
like git); state is the **fold** of each issue's events, never a stored field.
Fully standalone — its own fold + Turtle renderer (a faithful port of the
codespaces `tracker-build`), no bridge or server required.

The everyday path is three verbs — no flags, no ceremony — over four lanes
(**todo · doing · review · done**). Bare `mind issues` shows the board:

| | |
|---|---|
| `mind issues add "<title>"` | file an issue (no required flags; `--type` optional, defaults to `chore`) → **todo** |
| `mind issues` _(or_ `board`_)_ | the board: issues in lanes todo · doing · review · done (Done collapsed; `--all` to show) |
| `mind issues start <ref>` | you're working on it → **doing** |
| `mind issues done <ref>` | finished → **done** |
| `mind issues show <ref>` | one issue: facts + body + a plain-English **activity feed** |

Coordination & setup verbs (the `(advanced)` group in `--help`) drive multi-agent work:

| | |
|---|---|
| `mind issues init [--title T] [--namespace IRI]` | scaffold a fresh `.mind/` tracker here |
| `mind issues epic <title> [--status S]` | create an epic (a goal grouping issues) |
| `mind issues new "<title>" [--type T] [--priority P] [--epic SLUG]` | create an issue (alias of `add`; interactive if `<title>` omitted) |
| `mind issues list [--state/--type/--priority/--epic/--label/--mine/--open/--closed]` | folded list, grouped by epic (priority shown as a leading `↑`/`‼`/`↓` glyph) |
| `mind issues next [--claim] [--all]` | pick the next claimable issue for an agent (priority then lowest-ULID; `--claim` claims it; `--all` shows the whole ranked queue, read-only) |
| `mind issues triage <ref> --to S [--labels a,b] [--blocks REF,…]` | append a triage event (`--blocks` refs accept any form — ULID/`MC-N`/`#N`/`N`/slug — and are rejected if they don't resolve) |
| `mind issues claim/release <ref>` | claim (→ doing, ttl) / release a claim |
| `mind issues state <ref> --to S` · `handoff <ref>` _(→ review)_ · `comment <ref> -m …` · `link <ref> --pr B` | other lifecycle events |
| `mind issues close <ref> [--to done\|wontfix]` | close an issue (humans only; agents `handoff` to review) |
| `mind issues build [--check]` | regenerate `build/{tracker,epics,state}.ttl` (`--check` = drift gate) |

`<ref>` is a ULID, an `MC-NNNN`/`#NNNN`/`NNNN` display handle, or a slug. Events
are authored as the active identity (or `--author`/`$MIND_AUTHOR`, falling back to
a local user urn); `--agent` flips the actor to an agent and enforces the
`AGENTS.md` rules (respect gate labels, never self-close).

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

Future ideas: `mind drive`, `mind social`, `mind builder` — each
prototype exposing its verbs. Keep plugins thin; real logic stays in the
prototype/bridge.

## Notes & limits

- **Local-first.** Default issuer is the mind-codespaces local CSS `:3011`.
  Point at production with `--issuer https://pod.mindpods.org/`.
- An identity only works while its CSS is up, and its creds go stale if that
  server's `.css-data/` is wiped — just `mind id create` again.
- By default a WebID can only touch its **own** pod; `mind grant` (run by the
  pod owner) is how you open up cross-pod access.
- TS-vs-Rust: this is Node/ESM on purpose — the Solid auth stack (Solid-OIDC,
  DPoP, client-credentials) only has a mature implementation in JS. A Rust
  rewrite would mean reimplementing DPoP/OIDC; revisit only if a single static
  binary becomes a hard requirement.

## Releases

Versioning, `CHANGELOG.md`, and tags are automated with
[release-please](https://github.com/googleapis/release-please) — **don't tag or
edit `CHANGELOG.md` by hand.**

1. Commit to `main` using [Conventional Commits](https://www.conventionalcommits.org):
   `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major.
   `chore:` / `docs:` / `refactor:` / `test:` don't trigger a release.
2. release-please keeps an open **"chore(main): release X.Y.Z"** PR that rolls the
   pending commits into `CHANGELOG.md` and bumps the version.
3. Merge that PR to release: it creates the `vX.Y.Z` tag + GitHub Release and
   updates `CHANGELOG.md`. (Publishing is still manual — no publish workflow yet.)
