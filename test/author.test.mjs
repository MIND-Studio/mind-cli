import { test } from "node:test";
import assert from "node:assert/strict";

import { slugify, mintIssueId, addDuration } from "../src/tracker/author.mjs";

// Pure helpers — no temp `.mind/` tree, no network, no spawn (MC-26). Each test
// asserts the helper's REAL behavior (read author.mjs), not an assumed one.

test("slugify: collapses spaces/punctuation/case into a single-dash slug", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Trim  Me  "), "trim-me");
  assert.equal(slugify("a___b...c"), "a-b-c");
});

test("slugify: drops unicode and trims leading/trailing dashes", () => {
  assert.equal(slugify("café déjà"), "caf-d-j"); // non-ascii collapses to dashes
  assert.equal(slugify("--edge--"), "edge");
});

test("slugify: truncates to 50 chars with no trailing dash", () => {
  const s = slugify("x".repeat(80));
  assert.ok(s.length <= 50);
  assert.doesNotMatch(s, /-$/);
});

test("slugify: an all-symbols title falls back to a usable slug", () => {
  // s becomes "" → not /^[a-z0-9]/ → `issue-` → trailing dash stripped → "issue"
  assert.equal(slugify("!!!"), "issue");
  assert.equal(slugify("---"), "issue");
});

test("slugify: leading symbols are trimmed before the alphanumeric check", () => {
  assert.equal(slugify("123abc"), "123abc"); // starts with a digit → kept
  assert.equal(slugify("!start"), "start"); // leading symbol collapses to a dash, then trims away
});

test("slugify: is idempotent", () => {
  for (const t of ["Hello, World!", "!!!", "  Trim  Me  ", "café"]) {
    assert.equal(slugify(slugify(t)), slugify(t));
  }
});

test("mintIssueId: deterministic shape ending in OPEN<4-digit number>", () => {
  const id = mintIssueId(7);
  // 10 (time) + 6 (rand) + "OPEN" + 4 (padded number) = 24
  assert.equal(id.length, 24);
  assert.match(id, /OPEN0007$/);
  assert.match(id, /^[0-9A-Z]+$/); // Crockford base32 alphabet, uppercase
});

test("mintIssueId: pads then preserves larger numbers", () => {
  assert.match(mintIssueId(42), /OPEN0042$/);
  assert.match(mintIssueId(12345), /OPEN12345$/); // padStart(4) does not truncate
});

test("addDuration: applies PnDTnHnMnS deltas from a fixed base", () => {
  const base = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(addDuration(base, "PT2H").getTime() - base.getTime(), 2 * 60 * 60 * 1000);
  assert.equal(addDuration(base, "PT30M").getTime() - base.getTime(), 30 * 60 * 1000);
  assert.equal(addDuration(base, "P1D").getTime() - base.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(addDuration(base, "P1DT2H30M15S").getTime() - base.getTime(), ((24 + 2) * 60 + 30) * 60 * 1000 + 15 * 1000);
});

test("addDuration: does not mutate the input Date", () => {
  const base = new Date("2026-01-01T00:00:00.000Z");
  const before = base.getTime();
  addDuration(base, "PT2H");
  assert.equal(base.getTime(), before);
});

test("addDuration: a malformed duration throws a clear error", () => {
  const base = new Date("2026-01-01T00:00:00.000Z");
  assert.throws(() => addDuration(base, "2 hours"), /invalid ISO-8601 duration/);
  assert.throws(() => addDuration(base, "PT2X"), /invalid ISO-8601 duration/);
});
