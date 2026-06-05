// Tests for the agents plugin's pure helpers (plugins/agents.mjs):
// persona parsing + per-backend argv/env building. No spawning, no model calls.
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePersona, BACKENDS } from "../plugins/agents.mjs";

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

test("codex backend: persona via -c, headless adds exec, model + task ordered", () => {
  const interactive = BACKENDS.codex.build({ personaFile: "/p/coder.md", interactive: true });
  assert.deepEqual(interactive, {
    bin: "codex",
    env: {},
    args: ["-c", "experimental_instructions_file=/p/coder.md"],
  });
  const headless = BACKENDS.codex.build({ personaFile: "/p/coder.md", task: "fix bug", model: "o3", interactive: false });
  assert.deepEqual(headless.args, [
    "exec",
    "-c",
    "experimental_instructions_file=/p/coder.md",
    "-m",
    "o3",
    "fix bug",
  ]);
});

test("claude backend: persona as string, headless uses -p", () => {
  const interactive = BACKENDS.claude.build({ personaText: "be coder", interactive: true });
  assert.deepEqual(interactive.args, ["--append-system-prompt", "be coder", "--add-dir", "."]);
  const headless = BACKENDS.claude.build({ personaText: "be coder", task: "ship it", interactive: false });
  assert.deepEqual(headless.args, ["--append-system-prompt", "be coder", "--add-dir", ".", "-p", "ship it"]);
});

test("gemini backend: persona via env var", () => {
  const r = BACKENDS.gemini.build({ personaFile: "/p/coder.md", task: "go", interactive: false });
  assert.deepEqual(r.env, { GEMINI_SYSTEM_MD: "/p/coder.md" });
  assert.deepEqual(r.args, ["-p", "go"]);
});
