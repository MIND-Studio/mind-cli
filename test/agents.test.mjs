// Tests for the agents plugin's pure helpers (plugins/agents.mjs):
// persona parsing + per-backend argv/env building. No spawning, no model calls.
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePersona, BACKENDS, issueTask } from "../plugins/agents.mjs";

test("parsePersona: frontmatter → meta, body → prompt", () => {
  const { meta, prompt } = parsePersona(
    `---\nname: coder\ndescription: "does things"\nbackend: codex\n---\nYou are coder.\nBe terse.`,
  );
  assert.deepEqual(meta, { name: "coder", description: "does things", backend: "codex" });
  assert.equal(prompt, "You are coder.\nBe terse.");
});

test("parsePersona: no frontmatter → whole text is the prompt", () => {
  const { meta, prompt } = parsePersona("just a system prompt");
  assert.deepEqual(meta, {});
  assert.equal(prompt, "just a system prompt");
});

test("codex backend: persona is prepended to the prompt (no system-prompt flag)", () => {
  // Interactive, no task → persona block + an ack line so the session starts in-persona.
  const interactive = BACKENDS.codex.build({ personaText: "be coder", interactive: true });
  assert.equal(interactive.bin, "codex");
  assert.deepEqual(interactive.env, {});
  assert.equal(interactive.args.length, 1); // just the composed prompt, no `exec`
  assert.match(interactive.args[0], /SYSTEM PERSONA[\s\S]*be coder[\s\S]*Acknowledge your role/);

  // Headless → `exec`, model flag, then the persona+task prompt as the final arg.
  const headless = BACKENDS.codex.build({ personaText: "be coder", task: "fix bug", model: "o3", interactive: false });
  assert.deepEqual(headless.args.slice(0, 3), ["exec", "-m", "o3"]);
  assert.match(headless.args[3], /SYSTEM PERSONA[\s\S]*be coder[\s\S]*---[\s\S]*fix bug/);
});

test("claude backend: persona as string, headless uses -p", () => {
  const interactive = BACKENDS.claude.build({ personaText: "be coder", interactive: true });
  assert.deepEqual(interactive.args, ["--append-system-prompt", "be coder", "--add-dir", "."]);
  const headless = BACKENDS.claude.build({ personaText: "be coder", task: "ship it", interactive: false });
  assert.deepEqual(headless.args, ["--append-system-prompt", "be coder", "--add-dir", ".", "-p", "ship it"]);
});

test("issueTask: folds handle, title, body and a marching order into a prompt", () => {
  const t = issueTask({ number: 20, category: "feature", state: "needs-triage", title: "do the thing", body: "details here" });
  assert.match(t, /MC-20 \(feature, state: needs-triage\): do the thing/);
  assert.match(t, /details here/);
  assert.match(t, /Do not close or hand off the issue yourself\./);
  // body-less issue still produces a usable prompt
  assert.match(issueTask({ number: 7, title: "x" }), /MC-7 .*: x/);
});

test("gemini backend: persona via env var", () => {
  const r = BACKENDS.gemini.build({ personaFile: "/p/coder.md", task: "go", interactive: false });
  assert.deepEqual(r.env, { GEMINI_SYSTEM_MD: "/p/coder.md" });
  assert.deepEqual(r.args, ["-p", "go"]);
});
