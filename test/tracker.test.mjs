// Tests for the `mind issues` tracker (src/tracker/*). Built-in node:test, no deps.
//   node --test test/
//
// Two kinds of check:
//  1. round-trip — init → epic → new → full lifecycle in a tmp dir, asserting the
//     fold reflects each event and the build trio stays consistent.
//  2. golden — if the sibling mind-codespaces-v0 repo is present, assert our fold
//     reproduces its committed build/*.ttl byte-for-byte (the port-fidelity gate).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { initTracker } from "../src/tracker/scaffold.mjs";
import { loadConfig } from "../src/tracker/config.mjs";
import { foldTracker, buildTrackerOutputs } from "../src/tracker/fold.mjs";
import { createIssue, createEpic, appendEvent, resolveIssue, addDuration, assertClosable, assertReleasable } from "../src/tracker/author.mjs";
import { displayName, actorTag } from "../src/tracker/actor.mjs";
import { unifiedDiff } from "../src/tracker/diff.mjs";
import { agentQueue } from "../src/tracker/queue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const actor = { webId: "urn:mind:local:tester", kind: "human", tag: "tester", name: "tester" };
const agent = { webId: "urn:mind:local:bot", kind: "agent", tag: "bot", name: "bot" };

function tmpTracker() {
  const root = mkdtempSync(join(tmpdir(), "mind-issues-"));
  initTracker(root, { title: "Test" });
  return root;
}

function stateOf(root, ref) {
  return resolveIssue(foldTracker(root).epics, ref).state;
}

test("round-trip: lifecycle folds to the right state", () => {
  const root = tmpTracker();
  try {
    const cfg = loadConfig(join(root, ".mind", "issues"), root);
    createEpic(root, { title: "Onboarding", status: "active" });
    const { number } = createIssue(root, { title: "Write README", type: "docs", epicSlug: "onboarding", priority: "high" }, actor, cfg);
    assert.equal(number, 1);
    assert.equal(stateOf(root, "MC-1"), "todo", "new issues open into todo");

    // triage attaches labels without moving state — a fresh todo is already
    // agent-claimable, so there's no "ready" lane to advance to.
    let issue = resolveIssue(foldTracker(root).epics, "MC-1");
    appendEvent(root, issue, { kind: "triage", extra: { labels: ["area:docs"] } }, actor, "triaged");
    assert.equal(stateOf(root, "MC-1"), "todo");

    issue = resolveIssue(foldTracker(root).epics, "MC-1");
    const ttl = "PT2H";
    appendEvent(root, issue, { kind: "claim", to: "doing", extra: { ttl, expiresAt: addDuration(new Date(), ttl).toISOString() } }, actor, "claimed");
    assert.equal(stateOf(root, "MC-1"), "doing");
    assert.equal(resolveIssue(foldTracker(root).epics, "MC-1").assignee, actor.webId);

    issue = resolveIssue(foldTracker(root).epics, "MC-1");
    appendEvent(root, issue, { kind: "handoff", from: "doing", to: "review" }, actor, "back to you");
    assert.equal(stateOf(root, "MC-1"), "review");
    assert.equal(resolveIssue(foldTracker(root).epics, "MC-1").assignee, undefined, "handoff clears the holder");

    issue = resolveIssue(foldTracker(root).epics, "MC-1");
    appendEvent(root, issue, { kind: "close", from: "review", to: "done", extra: { resolution: "fixed" } }, actor, "done");
    assert.equal(stateOf(root, "MC-1"), "done");

    // The build trio rebuilds cleanly and the issue count is right.
    const { issueCount, epicCount } = buildTrackerOutputs(root);
    assert.equal(issueCount, 1);
    assert.equal(epicCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("round-trip: same-second events still fold in `at` order", () => {
  const root = tmpTracker();
  try {
    const cfg = loadConfig(join(root, ".mind", "issues"), root);
    createIssue(root, { title: "Quick", type: "bug" }, actor, cfg);
    // Append several events with no delay — they share a filename second; the
    // fold must use `at` (ms) order, not the alphabetical-by-kind filename order.
    for (const [kind, to] of [["state", "doing"], ["state", "review"], ["state", "doing"], ["close", "done"]]) {
      const issue = resolveIssue(foldTracker(root).epics, "MC-1");
      appendEvent(root, issue, { kind, to }, actor, "");
    }
    assert.equal(stateOf(root, "MC-1"), "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver: ULID, MC-NNNN, #NNNN, NNNN and slug all resolve", () => {
  const root = tmpTracker();
  try {
    const cfg = loadConfig(join(root, ".mind", "issues"), root);
    const { id, slug } = createIssue(root, { title: "Alpha Bug", type: "bug" }, actor, cfg);
    const epics = foldTracker(root).epics;
    // Stored ids are uppercase Crockford base32, but the ULID alphabet is
    // case-insensitive by spec and a copy-pasted id is often lowercased — both
    // the canonical and the lowercased form must resolve (regression: MC-12).
    for (const ref of [id, id.toLowerCase(), "MC-1", "mc-1", "#1", "1", slug, "alpha"]) {
      assert.equal(resolveIssue(epics, ref).number, 1, `ref ${ref}`);
    }
    assert.throws(() => resolveIssue(epics, "nope-9999"), /no issue matches/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queue: ranks by priority (urgent→low) then FIFO within a tier — the order `next --all` exposes", () => {
  const root = tmpTracker();
  try {
    const cfg = loadConfig(join(root, ".mind", "issues"), root);
    // Create out of priority order; FIFO tie-break is lowest-ULID = creation order.
    createIssue(root, { title: "low", type: "chore", priority: "low" }, actor, cfg); // MC-1
    createIssue(root, { title: "urgent A", type: "bug", priority: "urgent" }, actor, cfg); // MC-2
    createIssue(root, { title: "normal", type: "chore", priority: "normal" }, actor, cfg); // MC-3
    createIssue(root, { title: "high", type: "bug", priority: "high" }, actor, cfg); // MC-4
    createIssue(root, { title: "urgent B", type: "bug", priority: "urgent" }, actor, cfg); // MC-5
    // No triage step needed: a fresh issue opens into `todo`, which is
    // handoff:agent, so it's already in the agent queue.
    const order = agentQueue({ cfg, epics: foldTracker(root).epics }).map((i) => i.number);
    // urgent (FIFO: MC-2 before MC-5) → high → normal → low
    assert.deepEqual(order, [2, 5, 4, 3, 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actor: WebID label surfaces the account, never the literal `card`", () => {
  // Solid WebIDs almost always end in /profile/card#me — a naive last-segment
  // would collapse every identity to "card". The account name must win instead.
  const cases = [
    ["https://pod.mindpods.org/mind-agent-01/profile/card#me", "mind-agent-01"],
    ["http://localhost:3011/claude/profile/card#me", "claude"],
    ["https://alice.example/profile/card#me", "alice"], // card at host root → host label
    ["urn:mind:local:heussers", "heussers"],
    ["https://example.org/people/dan#me", "dan"], // non-card WebID → last segment
  ];
  for (const [webId, want] of cases) {
    assert.equal(displayName(webId), want, `displayName(${webId})`);
    assert.notEqual(displayName(webId), "card", `displayName(${webId}) must not be "card"`);
  }
  assert.equal(actorTag("https://pod.mindpods.org/mind-agent-01/profile/card#me"), "mindagent01");
});

test("diff: unifiedDiff marks changed lines and is empty when equal", () => {
  assert.equal(unifiedDiff("a\nb\nc", "a\nb\nc"), "", "identical → no diff");
  const d = unifiedDiff("a\nb\nc\nd\ne", "a\nB\nc\nd\ne", { context: 1 });
  assert.match(d, /^- b$/m, "old line marked -");
  assert.match(d, /^\+ B$/m, "new line marked +");
  assert.match(d, /^ {2}a$/m, "context line kept");
  assert.doesNotMatch(d, /^[ ]+e$/m, "far context collapsed");
});

test("queue: next drops an issue blocked by a not-done issue, includes it once the blocker closes", () => {
  const root = tmpTracker();
  try {
    const cfg = loadConfig(join(root, ".mind", "issues"), root);
    const blocker = createIssue(root, { title: "Blocker", type: "chore" }, actor, cfg); // MC-1
    const dependent = createIssue(root, { title: "Dependent", type: "feature" }, actor, cfg); // MC-2

    // blockedBy is derived: the blocker declares `blocks: [dependent]`, so the
    // fold links dependent.blockedBy = [blocker]. Both are already claimable
    // (fresh issues open into todo = handoff:agent); triage only sets the link.
    let blk = resolveIssue(foldTracker(root).epics, "MC-1");
    appendEvent(root, blk, { kind: "triage", extra: { blocks: [dependent.id] } }, actor, "");

    // Sanity: the link folded as expected.
    assert.deepEqual(resolveIssue(foldTracker(root).epics, "MC-2").blockedBy, [blocker.id]);

    const q1 = agentQueue({ cfg, epics: foldTracker(root).epics });
    const handles1 = q1.map((i) => i.number);
    assert.ok(handles1.includes(1), "blocker itself is queueable");
    assert.ok(!handles1.includes(2), "dependent is held out while its blocker is open");

    // Close the blocker → dependent becomes pickable.
    blk = resolveIssue(foldTracker(root).epics, "MC-1");
    appendEvent(root, blk, { kind: "close", from: blk.state, to: "done", extra: { resolution: "fixed" } }, actor, "");

    const q2 = agentQueue({ cfg, epics: foldTracker(root).epics });
    const handles2 = q2.map((i) => i.number);
    assert.ok(!handles2.includes(1), "closed blocker leaves the open queue");
    assert.ok(handles2.includes(2), "dependent is pickable once the blocker is done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks: triage resolves a handle/slug ref to a ULID; an unknown ref throws", () => {
  // Regression for the silent-drop bug: `triage --blocks MC-2` (or a slug) used
  // to be written verbatim and then dropped by the fold (which keeps only known
  // ULIDs). The plugin now maps each ref through resolveIssue before writing —
  // this test exercises that exact transformation and the rejection path.
  const root = tmpTracker();
  try {
    const cfg = loadConfig(join(root, ".mind", "issues"), root);
    createIssue(root, { title: "Blocker", type: "chore" }, actor, cfg); // MC-1
    const target = createIssue(root, { title: "Target Thing", type: "bug" }, actor, cfg); // MC-2, slug "target-thing"

    // The plugin's mapping: each --blocks ref → its canonical ULID.
    const epics0 = foldTracker(root).epics;
    for (const ref of ["MC-2", "#2", "2", "target-thing"]) {
      assert.equal(resolveIssue(epics0, ref).id, target.id, `ref ${ref} → MC-2 ULID`);
    }
    const blocks = ["MC-2"].map((ref) => resolveIssue(epics0, ref).id);
    const blk = resolveIssue(epics0, "MC-1");
    appendEvent(root, blk, { kind: "triage", extra: { blocks } }, actor, "");

    // The link survives the fold: MC-1 blocks MC-2, so MC-2 is blockedBy MC-1.
    assert.deepEqual(resolveIssue(foldTracker(root).epics, "MC-1").blocks, [target.id]);
    assert.deepEqual(resolveIssue(foldTracker(root).epics, "MC-2").blockedBy, [blk.id]);

    // Rejection path: an unknown ref throws before any event is written.
    assert.throws(() => resolveIssue(foldTracker(root).epics, "MC-999"), /no issue matches/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guards: no-op close and holderless release are refused, --force overrides", () => {
  // A close to the state the issue is already in, or a release with no live
  // claim, would write a misleading no-op event into the append-only log.
  const doneIssue = { state: "done", assignee: undefined };
  assert.throws(() => assertClosable(doneIssue, actor, { to: "done" }), /already done/);
  assert.doesNotThrow(() => assertClosable(doneIssue, actor, { to: "wontfix" }), "done→wontfix is a real re-close");
  assert.doesNotThrow(() => assertClosable(doneIssue, actor, { to: "done", force: true }), "--force overrides");
  assert.throws(() => assertClosable(doneIssue, agent, { to: "wontfix" }), /never self-close/, "agents still can't self-close");

  assert.throws(() => assertReleasable({ assignee: undefined }, actor, {}), /no active claim/);
  assert.doesNotThrow(() => assertReleasable({ assignee: "urn:x" }, actor, {}), "holder present → releasable");
  assert.doesNotThrow(() => assertReleasable({ assignee: undefined }, actor, { force: true }), "--force overrides");
});

test("golden: fold reproduces the codespaces build trio byte-for-byte", (t) => {
  const cs = join(HERE, "..", "..", "mind-codespaces-v0");
  if (!existsSync(join(cs, ".mind", "build", "state.ttl"))) {
    t.skip("sibling mind-codespaces-v0 not present");
    return;
  }
  const { outputs } = buildTrackerOutputs(cs);
  for (const [name, content] of Object.entries(outputs)) {
    const golden = readFileSync(join(cs, ".mind", "build", name), "utf8");
    assert.equal(content, golden, `${name} drifted from the committed trio`);
  }
});

// ── Fold validation ─────────────────────────────────────────────────────────────
// Write a tracker BY HAND (the 4-state vocab) with one issue whose events we
// control, and fold it — used to assert the fold's validation guarantees.
function handTracker(root, { events }) {
  const issueDir = join(root, ".mind", "issues", "00_general_issues", "1700000000_aaaa");
  mkdirSync(join(issueDir, "events"), { recursive: true });
  writeFileSync(
    join(root, ".mind", "issues", "tracker.config.md"),
    `---
title: "Hand"
namespace: "https://x/#"
initialState: todo
states:
  - { id: todo, open: true }
  - { id: doing, open: true }
  - { id: review, open: true }
  - { id: done, open: false }
categories:
  - { id: bug }
---
`,
    "utf8",
  );
  writeFileSync(
    join(issueDir, "issue.md"),
    `---
id: 01TESTTESTTESTTESTOPEN0001
slug: legacy
type: bug
title: "Legacy"
author: "urn:mind:local:t"
authorKind: human
created: 2026-01-01T00:00:00.000Z
afk: false
---
`,
    "utf8",
  );
  events.forEach((fm, idx) =>
    writeFileSync(join(issueDir, "events", `2026-01-01-00000${idx}-t-${fm.kind}.md`), `---\n${fm.body}\n---\n`, "utf8"),
  );
}

test("fold: an event `to:` outside the declared vocab hard-fails (typos aren't swallowed)", () => {
  const root = mkdtempSync(join(tmpdir(), "mind-badstate-"));
  try {
    handTracker(root, {
      events: [
        { kind: "open", body: 'id: 01OPEN\nkind: open\nactor: "urn:mind:local:t"\nactorKind: human\nat: 2026-01-01T00:00:00.000Z\nto: bogus-state\ntype: bug\npriority: normal' },
      ],
    });
    // The message must name the offending event file (proves the loop destructures
    // `f` — without it this path threw `ReferenceError: f is not defined`, MC-24).
    assert.throws(() => foldTracker(root), /events\/2026-01-01-000000-t-open\.md: `to: bogus-state` is not a declared state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default command: bare `mind issues` prints the board", () => {
  const bin = new URL("../bin/mind.mjs", import.meta.url).pathname;
  const cwd = mkdtempSync(join(tmpdir(), "mind-default-"));
  try {
    const env = { ...process.env, MIND_HOME: join(cwd, "home"), NO_COLOR: "1" };
    const run = (...a) => spawnSync(process.execPath, [bin, ...a], { cwd, env, encoding: "utf8" });
    assert.equal(run("issues", "init").status, 0);
    assert.equal(run("issues", "add", "Fix the thing").status, 0, "add takes no required flags");
    const bare = run("issues"); // no subcommand → the board
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /to do/, "board shows the todo lane");
    assert.match(bare.stdout, /Fix the thing/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
