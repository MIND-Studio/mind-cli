---
id: 01KTD07PWGY1G8BSOPEN0023
slug: cli-add-a-mind-update-self-update-command
type: feature
title: "cli: add a `mind update` self-update command"
author: "https://pod.mindpods.org/mind-agent-01/profile/card#me"
authorKind: human
created: 2026-06-05T23:00:04.624Z
afk: false
---

**Goal** — Add a top-level `mind update` (alias `upgrade`) command that updates the
CLI in place by re-running the installer. Today the README says "Re-run it any time
to update" but there is **no** command — `mind update` errors with "unknown command".
(Confirmed: no update/upgrade in `src/commands.mjs`; `install.sh` is the only updater.)

**What it does** — Re-runs the published installer one-liner, which already fetches
the latest release, installs deps, and refreshes the `mind` launcher:
```
curl -fsSL https://raw.githubusercontent.com/MIND-Studio/mind-cli/main/install.sh | bash
```
It must respect the same env overrides `install.sh` documents: `MIND_CLI_REF`
(tag/branch), `MIND_CLI_HOME`, `MIND_CLI_BIN` — just pass the current environment
through to the child.

**Scope**
- New core command in `src/commands.mjs` (a sibling of `whoami`/`ls`), wired into the
  exported `coreCommands` map so it shows in `mind --help`.
- Args:
  - `--ref <tag|branch>` → sets `MIND_CLI_REF` for the child (pin a version).
  - `--dry-run` → print the exact command + resolved ref and exit 0 **without running**.
  - honor `--json` where meaningful (`{ ok, ref, command }` on dry-run).
- Run via `node:child_process.spawn("bash", ["-c", cmd], { stdio: "inherit", env })`;
  require `curl` on PATH (clear error + non-zero exit if missing, mirroring how the
  codespaces plugin fails with a hint). Propagate the child's exit code.
- Print the current version before launching (read from package.json, like `src/cli.mjs`).
- Add a `mind update` row to the README Install/Commands section.

**Factor for testability (important — keep the agent's test model-free):**
Extract a PURE helper, e.g. `export function updateCommand({ ref })` that RETURNS the
shell command string (and the env it would set), with **no** I/O. Unit-test that:
- default → contains the raw.githubusercontent install.sh URL piped to bash;
- `{ ref: "v0.3.0" }` → sets `MIND_CLI_REF=v0.3.0` (or equivalent) in the returned env.
Then a `--dry-run` integration test via `spawnSync(process.execPath, ["bin/mind.mjs",
"update", "--dry-run", "--json"])` asserting exit 0 and the printed command — this
NEVER touches the network or the real installer.

**Acceptance (v1)**
- `mind update --dry-run` prints the install command (and the resolved ref) and exits 0.
- `mind update --ref v0.4.0 --dry-run` shows the pinned ref.
- `mind --help` lists `update`.
- Missing `curl` → friendly error, non-zero exit (only reachable on real run, not dry-run).
- `npm test` green; new tests are model-free and do **not** execute the installer.

**Out of scope** — auto-update checks/nagging; npm-registry publish; Windows support
(install.sh is bash/curl, matching the current installer).

**Safety note for the implementing agent** — DO NOT run `mind update` for real (it would
overwrite the installed CLI). Verify only with `--dry-run` and the pure helper's unit test.
