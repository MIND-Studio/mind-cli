// Tests for the identity store helpers (src/commands.mjs). Built-in node:test.
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyHandle } from "../src/commands.mjs";

test("slugifyHandle: store key is a CLI-safe slug, symmetric with `id use`", () => {
  // The bug this guards: `id create X --name \"Some Name\"` must store under the
  // HANDLE (so `id use X` works), never under a label with spaces.
  assert.equal(slugifyHandle("drivetester"), "drivetester", "plain handle is unchanged");
  assert.equal(slugifyHandle("Drive Tester"), "drive-tester", "spaces → hyphen, lowercased");
  assert.equal(slugifyHandle("Claude X!"), "claude-x", "punctuation collapses, trailing trimmed");
  assert.equal(slugifyHandle("  Bob  "), "bob", "surrounding whitespace trimmed");
  assert.equal(slugifyHandle("   "), "identity", "empty after slug → safe fallback");
  // Idempotent: slugging a slug is a no-op.
  for (const h of ["drivetester", "drive-tester", "bob"]) assert.equal(slugifyHandle(slugifyHandle(h)), slugifyHandle(h));
});
