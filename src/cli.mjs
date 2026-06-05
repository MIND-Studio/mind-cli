// Assemble the `mind` root command: core commands + auto-loaded plugins.
// Each plugin in ../plugins/*.mjs default-exports a citty command; its filename
// (sans .mjs) becomes the command group name (e.g. plugins/codespaces.mjs → `mind codespaces`).

import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { coreCommands } from "./commands.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

async function loadPlugins() {
  const dir = join(HERE, "..", "plugins");
  const map = {};
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".mjs"));
  } catch {
    return map;
  }
  for (const f of files) {
    const cmd = (await import(join(dir, f))).default;
    if (cmd?.run || cmd?.subCommands) map[f.replace(/\.mjs$/, "")] = cmd;
  }
  return map;
}

// ── unknown-subcommand diagnostics ──────────────────────────────────────────
// citty answers a typo'd subcommand by dumping the full help and burying a terse
// "Unknown command `x`" at the very bottom — no suggestion. We pre-flight the same
// inputs citty would reject (an unknown token at a level that *has* subCommands)
// and print a tight "did you mean?" instead. It only fires where citty would also
// error, so it never blocks a valid command.

/**
 * Damerau edit distance (optimal string alignment) — counts an adjacent
 * transposition as one edit, so `enxt`→`next` scores 1, not 2. Transpositions
 * are the most common subcommand typo, so this is what makes "did you mean?"
 * pick the right word. Small, dependency-free.
 */
export function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prevPrev = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1); // adjacent transposition
    }
    prevPrev = prev;
    prev = cur;
  }
  return prev[n];
}

/** Closest candidate within `max` edits (or that contains/▷ the token), else null. */
export function closest(token, candidates, max = 3) {
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    // A clear prefix/substring typo (e.g. `iss` → `issues`) wins outright.
    const d = c.startsWith(token) || token.startsWith(c) ? 0 : editDistance(token, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  // Scale the tolerance to the token length so short words don't over-match.
  return bestD <= Math.min(max, Math.ceil(token.length / 2)) ? best : null;
}

/**
 * Walk the command tree against `rawArgs`. Return the first unknown subcommand as
 * `{ path, token, candidates, suggestion }`, or null if everything resolves (in
 * which case citty runs as normal). Mirrors citty's "first non-flag arg is the
 * subcommand" rule (node_modules/citty resolveSubCommand).
 */
export async function diagnoseUnknown(main, rawArgs) {
  let cmd = main;
  const path = [main.meta?.name ?? "mind"];
  let args = rawArgs.slice();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const subs = typeof cmd.subCommands === "function" ? await cmd.subCommands() : cmd.subCommands;
    if (!subs || !Object.keys(subs).length) return null; // leaf — citty owns the rest
    const idx = args.findIndex((a) => !a.startsWith("-"));
    if (idx === -1) return null; // no subcommand token (help / no-command path)
    const token = args[idx];
    if (subs[token]) {
      cmd = typeof subs[token] === "function" ? await subs[token]() : subs[token];
      path.push(token);
      args = args.slice(idx + 1);
      continue;
    }
    const candidates = Object.keys(subs);
    return { path, token, candidates, suggestion: closest(token, candidates) };
  }
}

export async function buildMain() {
  const plugins = await loadPlugins();
  return defineCommand({
    meta: {
      name: "mind",
      version: PKG.version,
      description: "Solid identities + pod ops + Mind prototypes, from the terminal",
    },
    subCommands: { ...coreCommands, ...plugins },
  });
}
