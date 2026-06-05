// Locate a `.mind` tracker the way git locates a repo: walk up from the cwd
// until we find one. The tracker "root" is the directory that *contains* `.mind/`
// (so `<root>/.mind/issues/tracker.config.md` exists) — matching the codespaces
// fold, which is always pointed at a repo root and reads `<root>/.mind/...`.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** `<root>/.mind/issues` — the dir holding tracker.config.md + epic/issue dirs. */
export function trackerIssuesDir(root) {
  return join(root, ".mind", "issues");
}

/** `<root>/.mind` */
export function mindDir(root) {
  return join(root, ".mind");
}

/**
 * Walk up from `start` (default cwd) looking for a directory whose
 * `.mind/issues/tracker.config.md` exists. Returns that directory (the root the
 * fold runs against), or null if none is found before the filesystem root.
 */
export function findTrackerRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    const cfg = join(dir, ".mind", "issues", "tracker.config.md");
    if (existsSync(cfg) && statSync(cfg).isFile()) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Like {@link findTrackerRoot} but throws a friendly error when absent. */
export function requireTrackerRoot(start = process.cwd()) {
  const root = findTrackerRoot(start);
  if (!root)
    throw new Error(
      `no .mind tracker found from ${resolve(start)} upward. Run \`mind issues init\` here first.`,
    );
  return root;
}
