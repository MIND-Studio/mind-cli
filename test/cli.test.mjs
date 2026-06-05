// Tests for the CLI unknown-subcommand diagnostics (src/cli.mjs). node:test, no deps.
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, closest, diagnoseUnknown } from "../src/cli.mjs";

test("editDistance: counts an adjacent transposition as one edit (Damerau OSA)", () => {
  assert.equal(editDistance("next", "next"), 0);
  assert.equal(editDistance("enxt", "next"), 1, "swap e/n is a single transposition, not two substitutions");
  assert.equal(editDistance("lst", "list"), 1, "one insertion");
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("abc", ""), 3);
  // Plain Levenshtein would score enxt↔next == enxt↔init == 2; Damerau breaks the
  // tie toward the transposition, which is the whole point.
  assert.ok(editDistance("enxt", "next") < editDistance("enxt", "init"));
});

test("closest: picks the nearest command, prefix wins, and far tokens return null", () => {
  const cmds = ["init", "epic", "new", "list", "next", "show", "triage", "claim", "close", "build"];
  assert.equal(closest("enxt", cmds), "next", "transposition → next, not init");
  assert.equal(closest("lst", cmds), "list");
  assert.equal(closest("cloes", cmds), "close");
  assert.equal(closest("triaeg", cmds), "triage");
  assert.equal(closest("ini", cmds), "init", "prefix typo wins outright");
  assert.equal(closest("xyzzy", cmds), null, "no close match → no suggestion (don't guess wildly)");
});

test("diagnoseUnknown: walks the tree and flags the first unknown subcommand", async () => {
  // A minimal stand-in for the real command tree (citty shape: meta + subCommands).
  const leaf = { run() {} };
  const main = {
    meta: { name: "mind" },
    subCommands: {
      whoami: leaf,
      id: { subCommands: { create: leaf, ls: leaf, use: leaf } },
      issues: { subCommands: { next: leaf, list: leaf, close: leaf } },
    },
  };

  // Valid paths resolve → null (citty runs normally).
  assert.equal(await diagnoseUnknown(main, ["issues", "next", "--all"]), null);
  assert.equal(await diagnoseUnknown(main, ["id", "use", "foo"]), null);
  assert.equal(await diagnoseUnknown(main, ["whoami"]), null);
  assert.equal(await diagnoseUnknown(main, []), null, "no token → citty's help/no-command path");

  // Nested typo: the issue is at the `issues` level, suggestion = next.
  const bad = await diagnoseUnknown(main, ["issues", "enxt", "--all"]);
  assert.deepEqual(bad.path, ["mind", "issues"]);
  assert.equal(bad.token, "enxt");
  assert.equal(bad.suggestion, "next");

  // Root-level typo.
  const root = await diagnoseUnknown(main, ["whoam"]);
  assert.deepEqual(root.path, ["mind"]);
  assert.equal(root.suggestion, "whoami");

  // Flags before the subcommand are skipped (mirrors citty's first-non-flag rule).
  assert.equal((await diagnoseUnknown(main, ["id", "usse"])).suggestion, "use");
});
