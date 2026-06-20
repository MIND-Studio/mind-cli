// Tests for the identity store helpers (src/commands.mjs). Built-in node:test.
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyHandle, isLocalIssuer } from "../src/commands.mjs";
import { isLocalBridge } from "../plugins/codespaces.mjs";

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

test("isLocalIssuer / isLocalBridge: loopback hosts are local, prod is not", () => {
  // Both helpers gate prod-only guidance (id-create fallback, codespaces dev-auth
  // warning), so they must agree on what counts as local. Same predicate, two homes.
  for (const fn of [isLocalIssuer, isLocalBridge]) {
    assert.equal(fn("http://localhost:3011/"), true);
    assert.equal(fn("http://127.0.0.1:3010"), true);
    assert.equal(fn("http://[::1]:3010/"), true, "ipv6 loopback, brackets stripped");
    assert.equal(fn("http://my-box.local/"), true, "mDNS .local");
    assert.equal(fn("https://pods.mindpods.org/"), false, "production pod is remote");
    assert.equal(fn("https://codespaces.mindpods.org"), false);
    assert.equal(fn("not a url"), false, "unparseable → not local (fail safe: still warn/guide)");
  }
});
