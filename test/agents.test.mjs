// Tests for the agents plugin's pure helpers (plugins/agents.mjs):
// persona parsing + per-backend argv/env building. No spawning, no model calls.
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsePersona, readPersonas, BACKENDS, issueTask } from "../plugins/agents.mjs";

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

test("readPersonas: carries model frontmatter through", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mind-personas-"));
  const agentsDir = join(cwd, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "coder.md"),
    `---\ndescription: "writes code"\nbackend: codex\nmodel: gpt-5.5\n---\nYou are coder.`,
  );
  writeFileSync(join(agentsDir, "reviewer.md"), `---\ndescription: "reviews code"\n---\nYou are reviewer.`);

  assert.deepEqual(readPersonas(agentsDir), [
    { name: "coder", description: "writes code", backend: "codex", model: "gpt-5.5" },
    { name: "reviewer", description: "reviews code", backend: null, model: null },
  ]);
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

test("codex backend: no persona emits only the task prompt", () => {
  const headless = BACKENDS.codex.build({ personaText: undefined, task: "echo hi", interactive: false });
  assert.deepEqual(headless.args, ["exec", "echo hi"]);
});

test("claude backend: persona as string, headless uses -p", () => {
  const interactive = BACKENDS.claude.build({ personaText: "be coder", interactive: true });
  assert.deepEqual(interactive.args, ["--append-system-prompt", "be coder", "--add-dir", "."]);
  const headless = BACKENDS.claude.build({ personaText: "be coder", task: "ship it", interactive: false });
  assert.deepEqual(headless.args, ["--append-system-prompt", "be coder", "--add-dir", ".", "-p", "ship it"]);
});

test("claude backend: no persona omits append-system-prompt", () => {
  const headless = BACKENDS.claude.build({ personaText: undefined, task: "ship it", interactive: false });
  assert.deepEqual(headless.args, ["--add-dir", ".", "-p", "ship it"]);
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

  const bare = BACKENDS.gemini.build({ personaFile: undefined, task: "go", interactive: false });
  assert.deepEqual(bare.env, {});
  assert.deepEqual(bare.args, ["-p", "go"]);
});

test("agents start --no-persona dry-run launches bare codex and does not read a persona file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mind-agents-"));
  mkdirSync(join(cwd, ".mind"), { recursive: true });

  const r = spawnSync(
    process.execPath,
    [new URL("../bin/mind.mjs", import.meta.url).pathname, "agents", "start", "coder", "--no-persona", "-p", "echo hi", "--dry-run"],
    {
      cwd,
      env: { ...process.env, MIND_HOME: join(cwd, "home"), NO_COLOR: "1" },
      encoding: "utf8",
    },
  );

  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = r.stdout + r.stderr;
  assert.match(out, /\$ codex exec echo hi/);
  assert.doesNotMatch(out, /SYSTEM PERSONA|--append-system-prompt|GEMINI_SYSTEM_MD/);
});
