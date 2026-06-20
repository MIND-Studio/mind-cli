import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the real plugin end-to-end against a throwaway source bundle + target,
// so the source-resolution and arg-parsing paths both get exercised. These two
// regressed silently once (repo renamed mind-skills→skills; --dir's value was
// captured as a skill name) precisely because nothing here covered them.

const ROOT = new URL("..", import.meta.url);

function makeBundle() {
  const dir = mkdtempSync(join(tmpdir(), "mind-skills-src-"));
  const skills = join(dir, "skills");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(
      join(skills, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} test skill\n---\nbody\n`,
    );
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "mind-skills", version: "9.9.9", skills: [] }));
  return dir;
}

function run(args, srcDir) {
  return spawnSync(process.execPath, ["bin/mind.mjs", "skills", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MIND_SKILLS_SRC: srcDir },
  });
}

test("skills install --dir does not treat the --dir value as a skill name", () => {
  const src = makeBundle();
  const target = mkdtempSync(join(tmpdir(), "mind-skills-tgt-"));
  try {
    const r = run(["install", "--dir", target, "--json"], src);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.installed.sort(), ["alpha", "beta"]);
    assert.ok(existsSync(join(target, ".claude", "skills", "alpha", "SKILL.md")));
    const lock = JSON.parse(readFileSync(join(target, ".claude", "skills", ".mind-skills.json"), "utf8"));
    assert.equal(lock.bundleVersion, "9.9.9");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("skills install named selects only the named skill alongside --dir", () => {
  const src = makeBundle();
  const target = mkdtempSync(join(tmpdir(), "mind-skills-tgt-"));
  try {
    const r = run(["install", "alpha", "--dir", target, "--json"], src);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.installed, ["alpha"]);
    assert.ok(existsSync(join(target, ".claude", "skills", "alpha")));
    assert.ok(!existsSync(join(target, ".claude", "skills", "beta")));
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("skills remove --dir removes only the named skill, not the dir path", () => {
  const src = makeBundle();
  const target = mkdtempSync(join(tmpdir(), "mind-skills-tgt-"));
  try {
    run(["install", "--dir", target, "--json"], src);
    const r = run(["remove", "alpha", "--dir", target, "--json"], src);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.removed, ["alpha"]);
    assert.ok(!existsSync(join(target, ".claude", "skills", "alpha")));
    assert.ok(existsSync(join(target, ".claude", "skills", "beta")));
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("skills source resolves a sibling `skills/` bundle (post-rename name)", () => {
  // No MIND_SKILLS_SRC: must fall back to the real sibling `skills` repo.
  const r = spawnSync(process.execPath, ["bin/mind.mjs", "skills", "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MIND_SKILLS_SRC: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.source, /\/skills$/);
  assert.ok(out.skills.some((s) => s.name === "mind-deploy"));
});
