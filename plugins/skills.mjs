// `mind skills …` — install/update the workspace-wide mind-* skills into a
// project's .claude/skills/ from the `mind-skills` source bundle.
//
// Pull-based, BMAD/mattpocock-style: one source package, an installer each
// consumer runs, re-run to update. Copies are real files (committed per repo →
// self-contained clone), tracked by a lockfile so we can tell drift from updates.
//
// A plugin default-exports a citty command; its filename becomes the group name.

import { defineCommand } from "citty";
import { createHash } from "node:crypto";
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, rmSync, cpSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { emit, table, guard, sym, green, red, dim, cyan, yellow, bold } from "../src/ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK = ".mind-skills.json"; // lives in <target>/.claude/skills/
const J = { json: { type: "boolean", description: "machine-readable JSON output" } };
const DIR = { dir: { type: "string", description: "target project dir (default: cwd)" } };

// ── source resolution ────────────────────────────────────────────────────────
// 1) $MIND_SKILLS_SRC  2) sibling of the CLI (mind-cli/../mind-skills)
// 3) walk up from cwd looking for mind-skills/skills
function resolveSource() {
  const cands = [];
  if (process.env.MIND_SKILLS_SRC) cands.push(process.env.MIND_SKILLS_SRC);
  cands.push(join(HERE, "..", "..", "mind-skills"));
  let d = process.cwd();
  for (let i = 0; i < 8; i++) { cands.push(join(d, "mind-skills")); d = dirname(d); }
  for (const c of cands) {
    const skills = join(c, "skills");
    if (existsSync(skills) && statSync(skills).isDirectory()) {
      let manifest = {};
      try { manifest = JSON.parse(readFileSync(join(c, "manifest.json"), "utf8")); } catch {}
      return { root: resolve(c), skillsDir: skills, manifest };
    }
  }
  throw new Error(
    "cannot find the mind-skills source bundle. Set MIND_SKILLS_SRC, or run from inside the mind-prototypes workspace.",
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function frontmatter(skillMd) {
  const m = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k) out[k] = v;
  }
  return out;
}

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, base, acc);
    else acc.push(relative(base, p));
  }
  return acc;
}

// content hash of a skill dir: stable over file paths + bytes
function hashSkill(dir) {
  if (!existsSync(dir)) return null;
  const h = createHash("sha256");
  for (const rel of walk(dir)) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(dir, rel)));
    h.update("\0");
  }
  return "sha256:" + h.digest("hex").slice(0, 16);
}

function listSource() {
  const { skillsDir } = resolveSource();
  return readdirSync(skillsDir)
    .filter((n) => existsSync(join(skillsDir, n, "SKILL.md")))
    .sort()
    .map((name) => {
      const fm = frontmatter(readFileSync(join(skillsDir, name, "SKILL.md"), "utf8"));
      return { name, description: fm.description || "", hash: hashSkill(join(skillsDir, name)) };
    });
}

function targetDir(args) {
  return join(resolve(args.dir || process.cwd()), ".claude", "skills");
}
function readLock(target) {
  try { return JSON.parse(readFileSync(join(target, LOCK), "utf8")); }
  catch { return { source: "mind-skills", bundleVersion: null, skills: {} }; }
}
function writeLock(target, lock) {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, LOCK), JSON.stringify(lock, null, 2) + "\n");
}

// install one skill dir from source → target, return its installed hash
function installOne(name, target) {
  const { skillsDir } = resolveSource();
  const src = join(skillsDir, name);
  if (!existsSync(join(src, "SKILL.md"))) throw new Error(`unknown skill: ${name}`);
  const dest = join(target, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  return hashSkill(dest);
}

// ── subcommands ──────────────────────────────────────────────────────────────
const list = defineCommand({
  meta: { name: "list", description: "list available skills + install state for this project" },
  args: { ...DIR, ...J },
  run: guard(async ({ args }) => {
    const src = listSource();
    const target = targetDir(args);
    const lock = readLock(target);
    const rows = src.map((s) => {
      const installedHash = hashSkill(join(target, s.name));
      const lockHash = lock.skills?.[s.name];
      let state;
      if (!installedHash) state = "—";
      else if (installedHash !== lockHash) state = "modified";
      else if (s.hash !== lockHash) state = "outdated";
      else state = "installed";
      return { ...s, state };
    });
    emit({ source: resolveSource().root, bundleVersion: resolveSource().manifest.version ?? null, skills: rows }, () => {
      const paint = { installed: green, outdated: yellow, modified: cyan, "—": dim };
      table(
        ["skill", "state", "description"],
        rows.map((r) => [
          bold(r.name),
          (paint[r.state] || dim)(r.state),
          dim((r.description || "").slice(0, 72) + ((r.description || "").length > 72 ? "…" : "")),
        ]),
      );
    });
  }),
});

const install = defineCommand({
  meta: { name: "install", description: "install all (or named) skills into ./.claude/skills" },
  args: {
    names: { type: "positional", required: false, description: "skill names (default: all)" },
    force: { type: "boolean", description: "reinstall even if unchanged" },
    ...DIR, ...J,
  },
  run: guard(async ({ args, rawArgs }) => {
    const src = listSource();
    const wanted = (rawArgs || []).filter((a) => !a.startsWith("-"));
    const names = wanted.length ? wanted : src.map((s) => s.name);
    const unknown = names.filter((n) => !src.some((s) => s.name === n));
    if (unknown.length) throw new Error(`unknown skill(s): ${unknown.join(", ")}`);

    const target = targetDir(args);
    const lock = readLock(target);
    const done = [];
    for (const name of names) {
      const hash = installOne(name, target);
      lock.skills[name] = hash;
      done.push(name);
    }
    lock.source = "mind-skills";
    lock.bundleVersion = resolveSource().manifest.version ?? null;
    lock.installedAt = new Date().toISOString();
    writeLock(target, lock);
    emit({ ok: true, installed: done, target, bundleVersion: lock.bundleVersion }, () => {
      console.log(`${sym.ok} installed ${green(done.length)} skill(s) → ${dim(relative(process.cwd(), target) || ".")}`);
      done.forEach((n) => console.log(`  ${sym.arrow} ${n}`));
    });
  }),
});

const update = defineCommand({
  meta: { name: "update", description: "refresh installed skills to the latest source" },
  args: { ...DIR, ...J },
  run: guard(async ({ args }) => {
    const target = targetDir(args);
    const lock = readLock(target);
    const installed = Object.keys(lock.skills || {});
    if (!installed.length) throw new Error("nothing installed here — run `mind skills install` first");
    const src = listSource();
    const changed = [];
    for (const name of installed) {
      if (!src.some((s) => s.name === name)) continue; // dropped from source — leave as-is
      const before = lock.skills[name];
      const after = installOne(name, target);
      lock.skills[name] = after;
      if (before !== after) changed.push(name);
    }
    lock.bundleVersion = resolveSource().manifest.version ?? null;
    lock.installedAt = new Date().toISOString();
    writeLock(target, lock);
    emit({ ok: true, refreshed: installed, changed, bundleVersion: lock.bundleVersion }, () => {
      console.log(`${sym.ok} refreshed ${green(installed.length)} skill(s), ${changed.length ? yellow(changed.length) : "0"} changed`);
      changed.forEach((n) => console.log(`  ${sym.arrow} ${n} ${dim("updated")}`));
    });
  }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "uninstall managed skill(s) from this project" },
  args: {
    names: { type: "positional", required: true, description: "skill names to remove" },
    ...DIR, ...J,
  },
  run: guard(async ({ args, rawArgs }) => {
    const names = (rawArgs || []).filter((a) => !a.startsWith("-"));
    if (!names.length) throw new Error("name at least one skill to remove");
    const target = targetDir(args);
    const lock = readLock(target);
    const gone = [];
    for (const name of names) {
      rmSync(join(target, name), { recursive: true, force: true });
      if (lock.skills) delete lock.skills[name];
      gone.push(name);
    }
    writeLock(target, lock);
    emit({ ok: true, removed: gone }, () => {
      console.log(`${sym.ok} removed ${gone.length} skill(s)`);
      gone.forEach((n) => console.log(`  ${sym.arrow} ${n}`));
    });
  }),
});

const status = defineCommand({
  meta: { name: "status", description: "show drift between installed skills and the source" },
  args: { ...DIR, ...J },
  run: guard(async ({ args }) => {
    const src = listSource();
    const target = targetDir(args);
    const lock = readLock(target);
    const rows = [];
    for (const name of Object.keys(lock.skills || {})) {
      const s = src.find((x) => x.name === name);
      const installedHash = hashSkill(join(target, name));
      const lockHash = lock.skills[name];
      let state;
      if (!installedHash) state = "missing";
      else if (installedHash !== lockHash) state = "modified-locally";
      else if (!s) state = "gone-from-source";
      else if (s.hash !== lockHash) state = "update-available";
      else state = "up-to-date";
      rows.push({ name, state });
    }
    const notInstalled = src.filter((s) => !(lock.skills || {})[s.name]).map((s) => ({ name: s.name, state: "available" }));
    const all = [...rows, ...notInstalled];
    emit({ bundleVersion: resolveSource().manifest.version ?? null, lockVersion: lock.bundleVersion ?? null, skills: all }, () => {
      const paint = {
        "up-to-date": green, "update-available": yellow, "modified-locally": cyan,
        "missing": red, "gone-from-source": red, "available": dim,
      };
      table(["skill", "state"], all.map((r) => [bold(r.name), (paint[r.state] || dim)(r.state)]));
    });
  }),
});

const manifest = defineCommand({
  meta: { name: "manifest", description: "(maintainer) regenerate mind-skills/manifest.json from the source" },
  args: { version: { type: "string", description: "bundle version to stamp" }, ...J },
  run: guard(async ({ args }) => {
    const { root, manifest: prev } = resolveSource();
    const skills = listSource().map(({ name, description }) => ({ name, description }));
    const out = {
      name: "mind-skills",
      version: args.version || prev.version || "0.1.0",
      skills,
    };
    writeFileSync(join(root, "manifest.json"), JSON.stringify(out, null, 2) + "\n");
    emit({ ok: true, ...out, path: join(root, "manifest.json") }, () => {
      console.log(`${sym.ok} wrote manifest.json (${green(out.skills.length)} skills, v${out.version})`);
    });
  }),
});

export default defineCommand({
  meta: { name: "skills", description: "install/update the workspace-wide mind-* skills into a project" },
  subCommands: { list, install, update, remove, status, manifest },
});
