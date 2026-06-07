import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { updateCommand } from "../src/commands.mjs";

test("updateCommand: default installer command fetches install.sh and pipes to bash", () => {
  const planned = updateCommand();
  assert.match(planned.command, /raw\.githubusercontent\.com\/MIND-Studio\/mind-cli\/main\/install\.sh/);
  assert.match(planned.command, /\|\s*bash$/);
  assert.equal(planned.ref, null);
});

test("updateCommand: ref sets MIND_CLI_REF in child env", () => {
  const planned = updateCommand({ ref: "v0.3.0", env: { PATH: "/bin" } });
  assert.equal(planned.ref, "v0.3.0");
  assert.equal(planned.env.MIND_CLI_REF, "v0.3.0");
  assert.equal(planned.env.PATH, "/bin");
});

test("mind update --dry-run --json prints planned command without running installer", () => {
  const r = spawnSync(process.execPath, ["bin/mind.mjs", "update", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, MIND_CLI_REF: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.ref, null);
  assert.match(out.command, /raw\.githubusercontent\.com\/MIND-Studio\/mind-cli\/main\/install\.sh/);
  assert.match(out.command, /\|\s*bash$/);
});

test("mind update --ref --dry-run --json prints pinned ref", () => {
  const r = spawnSync(process.execPath, ["bin/mind.mjs", "update", "--ref", "v0.4.0", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, MIND_CLI_REF: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.ref, "v0.4.0");
});

test("mind update fails cleanly when curl is missing", () => {
  const r = spawnSync(process.execPath, ["bin/mind.mjs", "update"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /curl is required to update mind/);
});

test("mind --help lists update", () => {
  const r = spawnSync(process.execPath, ["bin/mind.mjs", "--help"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  // When colors are on (e.g. CI's FORCE_COLOR) citty decorates command names with
  // ANSI codes and/or backticks; strip ANSI and allow optional backticks so the
  // assertion holds in both colored and plain output.
  const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /^\s+`?update`?\s+update the CLI by re-running the installer/m);
});
