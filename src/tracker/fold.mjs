// Fold the Markdown-authored, event-sourced `.mind/issues/` tree into the
// in-memory model + the canonical `build/*.ttl` trio.
//
// PORT of mind-codespaces-v0/src/lib/tracker/build.ts (the authoritative fold)
// at the v0.1 tracker layout. Kept byte-faithful so `mind issues build` produces
// the same trio as that repo's `npm run tracker:build`; the golden test in
// test/ diffs against its committed build/*.ttl. When build.ts changes, re-sync
// this file + render.mjs and re-run that test.
//
// Differences from the original: pure ESM (.mjs), throws plain Error instead of
// TrackerBuildError, and foldEvents additionally surfaces holder/expiresAt/
// priority/labels for the CLI's list/show/gate logic (render ignores those).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./config.mjs";
import { renderTracker, renderEpics, renderState } from "./render.mjs";

export const ENTRY_DIR_RE = /^\d{8,}_[a-z0-9]{4}$/;
export const GENERAL_DIR = "00_general_issues";
export const EPIC_STATUSES = new Set(["planned", "active", "done", "parked"]);

function fail(msg) {
  throw new Error(msg);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function frontmatter(text, file) {
  if (!text.startsWith("---")) fail(`${file}: missing YAML frontmatter (must start with '---')`);
  const end = text.indexOf("\n---", 3);
  if (end === -1) fail(`${file}: unterminated YAML frontmatter (no closing '---')`);
  const yaml = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "").trimEnd();
  let data;
  try {
    data = parseYaml(yaml) ?? {};
  } catch (e) {
    fail(`${file}: invalid YAML frontmatter — ${e.message}`);
  }
  return { data, body };
}

export function ymd(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/);
  if (!m) fail(`date "${s}" is not YYYY-MM-DD (or an ISO datetime)`);
  return m[1];
}

/**
 * Display handle number (MC-NNNN) from a canonical ULID — the trailing decimal
 * run (…OPEN0142 → 142). undefined when the id ends in no digits.
 */
export function handleNumber(id) {
  const m = String(id).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : undefined;
}

// ── Fold ──────────────────────────────────────────────────────────────────────
function foldEvents(cfg, eventsDir, rel) {
  if (!existsSync(eventsDir)) return null;
  const names = readdirSync(eventsDir).filter((f) => f.endsWith(".md")).sort();
  if (!names.length) return null;
  const stateIds = new Set(cfg.states.map((s) => s.id));

  // Order by event time (frontmatter `at`, ms precision), tie-broken by filename.
  // The reference fold sorts by filename alone — which agrees with `at` order for
  // minute-spaced events, but the CLI can append several events within one
  // second, where the filename's <hhmmss> ties and an alphabetical-by-kind sort
  // would be wrong. `at` carries the true order; filename is the stable tiebreak.
  const events = names
    .map((f) => ({ f, ...frontmatter(readFileSync(join(eventsDir, f), "utf8"), `${rel}/events/${f}`) }))
    .map((e) => ({ ...e, t: e.data.at != null ? new Date(e.data.at).getTime() : 0 }))
    .sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));

  let state = cfg.initialState;
  let holder;
  let expiresAt;
  let priority;
  let labels = [];
  let blocks = [];
  let lastAt;
  // States a claim enters that therefore KEEP the holder when a non-claim event
  // transitions into them. Covers this CLI's `doing` and the codespaces tracker's
  // `in-progress` (the golden fold), so the holder-clear rule is correct for both.
  const WORKING = new Set(["in-progress", "doing"]);
  for (const { f, data } of events) {
    if (data.at != null) lastAt = data.at;
    if (data.priority != null) priority = String(data.priority);
    if (Array.isArray(data.labels)) labels = data.labels.map(String);
    const to = data.to != null ? String(data.to) : null;
    if (to != null) {
      if (!stateIds.has(to)) fail(`${rel}/events/${f}: \`to: ${data.to}\` is not a declared state`);
      state = to;
    }
    if (Array.isArray(data.blocks)) blocks = data.blocks.map(String);
    if (data.kind === "claim") {
      holder = data.actor != null ? String(data.actor) : holder;
      expiresAt = data.expiresAt != null ? String(data.expiresAt) : undefined;
    } else if (data.kind === "release") {
      holder = undefined;
      expiresAt = undefined;
    } else if (to != null && !WORKING.has(to)) {
      holder = undefined;
      expiresAt = undefined;
    }
  }
  return {
    state,
    holder,
    expiresAt,
    priority,
    labels,
    blocks,
    modified: lastAt != null ? ymd(lastAt) : undefined,
  };
}

function loadIssuesIn(cfg, groupDir, groupRel) {
  const catIds = new Set(cfg.categories.map((c) => c.id));
  const issueDirs = readdirSync(groupDir)
    .filter((name) => ENTRY_DIR_RE.test(name) && statSync(join(groupDir, name)).isDirectory())
    .sort();
  const issues = [];
  for (const name of issueDirs) {
    const dir = join(groupDir, name);
    const rel = `${groupRel}/${name}`;
    const issueFile = join(dir, "issue.md");
    if (!existsSync(issueFile)) fail(`${rel}/: missing issue.md`);
    const { data, body } = frontmatter(readFileSync(issueFile, "utf8"), `${rel}/issue.md`);
    for (const k of ["id", "title", "type"]) {
      if (data[k] == null) fail(`${rel}/issue.md: missing required key "${k}"`);
    }
    if (data.state != null)
      fail(`${rel}/issue.md: must NOT carry a \`state:\` field — state is the fold of events/`);
    const category = String(data.type);
    if (!catIds.has(category)) fail(`${rel}/issue.md: type "${category}" not in tracker.config.md categories`);

    const folded = foldEvents(cfg, join(dir, "events"), rel);
    if (!folded) fail(`${rel}/: no events/ — an issue needs at least an \`open\` event to have a state`);

    issues.push({
      id: String(data.id),
      number: handleNumber(String(data.id)),
      slug: data.slug != null ? String(data.slug) : undefined,
      title: String(data.title),
      category,
      state: folded.state,
      created: data.created != null ? ymd(data.created) : undefined,
      modified: folded.modified ?? (data.created != null ? ymd(data.created) : undefined),
      assignee: folded.holder,
      expiresAt: folded.expiresAt,
      priority: folded.priority,
      labels: folded.labels,
      afk: data.afk != null ? Boolean(data.afk) : undefined,
      blocks: folded.blocks,
      blockedBy: [],
      body,
      dir: rel,
      absDir: dir,
    });
  }
  return issues;
}

function loadEpics(cfg, issuesDir, rootDir) {
  if (!existsSync(issuesDir)) fail(`missing ${relative(rootDir, issuesDir)}/`);
  const epics = [];
  const slugs = new Set();

  const generalDir = join(issuesDir, GENERAL_DIR);
  if (existsSync(generalDir) && statSync(generalDir).isDirectory()) {
    const issues = loadIssuesIn(cfg, generalDir, GENERAL_DIR);
    if (issues.length)
      epics.push({ slug: GENERAL_DIR, number: 0, title: "General", status: "active", body: "", issues, isGeneral: true });
  }

  const epicDirs = readdirSync(issuesDir)
    .filter((name) => ENTRY_DIR_RE.test(name) && statSync(join(issuesDir, name)).isDirectory())
    .sort();
  let number = 0;
  for (const name of epicDirs) {
    const dir = join(issuesDir, name);
    const epicFile = join(dir, "epic.md");
    if (!existsSync(epicFile)) fail(`${name}/: missing epic.md`);
    const { data, body } = frontmatter(readFileSync(epicFile, "utf8"), `${name}/epic.md`);
    if (data.title == null) fail(`${name}/epic.md: missing required key "title"`);
    if (data.id == null) fail(`${name}/epic.md: missing required key "id"`);
    const status = String(data.status ?? "planned");
    if (!EPIC_STATUSES.has(status))
      fail(`${name}/epic.md: status "${status}" not in {${[...EPIC_STATUSES].join(", ")}}`);
    const slug = String(data.id);
    if (slugs.has(slug)) fail(`duplicate epic id "${slug}" (${name}/epic.md)`);
    slugs.add(slug);
    epics.push({
      slug,
      number: ++number,
      title: String(data.title),
      status,
      created: data.created != null ? ymd(data.created) : undefined,
      body,
      dirName: name,
      issues: loadIssuesIn(cfg, dir, name),
    });
  }
  return epics;
}

function linkDependencies(epics) {
  const all = epics.flatMap((e) => e.issues);
  const byId = new Map(all.map((i) => [i.id, i]));
  for (const i of all) {
    i.blocks = i.blocks.filter((ref) => byId.has(ref));
    for (const ref of i.blocks) byId.get(ref).blockedBy.push(i.id);
  }
}

/**
 * Fold `<rootDir>/.mind/issues/**` into the in-memory model. Returns the config
 * + epics (each with its issues, current state already folded). Throws Error on
 * malformed input.
 */
export function foldTracker(rootDir) {
  const issuesDir = join(rootDir, ".mind", "issues");
  const cfg = loadConfig(issuesDir, rootDir);
  const epics = loadEpics(cfg, issuesDir, rootDir);
  linkDependencies(epics);
  return { cfg, epics };
}

/**
 * Fold + render the canonical `{tracker,epics,state}.ttl` trio (returned as
 * strings). The caller writes them under `<rootDir>/.mind/build/`.
 */
export function buildTrackerOutputs(rootDir) {
  const { cfg, epics } = foldTracker(rootDir);
  const issueCount = epics.reduce((n, e) => n + e.issues.length, 0);
  const epicCount = epics.filter((e) => !e.isGeneral).length;
  return {
    outputs: {
      "tracker.ttl": renderTracker(cfg),
      "epics.ttl": renderEpics(cfg, epics),
      "state.ttl": renderState(cfg, epics),
    },
    epicCount,
    issueCount,
    config: { states: cfg.states.length, categories: cfg.categories.length },
  };
}
