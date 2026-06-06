// Author the local `.mind/issues/` tree directly on disk — the filesystem mirror
// of codespaces/src/lib/tracker/author.ts (which does the same writes but
// into a hosted bare git repo via checkout/commit/push). No git here: we write
// the markdown into the working tree, then re-fold + rewrite the build trio.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTrackerOutputs, foldTracker, frontmatter, handleNumber, ENTRY_DIR_RE, GENERAL_DIR } from "./fold.mjs";
import { displayName } from "./actor.mjs";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ── Identity / addresses (mirror author.ts) ────────────────────────────────────

/** 4 lowercase base36 chars — the random half of an on-disk address. */
function rand4() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = randomBytes(4);
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[b[i] % 36];
  return s;
}

/** `<unix-seconds>_<rand4>` — stable on-disk address for an epic or issue dir. */
export function entryDirName() {
  return `${Math.floor(Date.now() / 1000)}_${rand4()}`;
}

function crockfordTime(ms) {
  let t = ms;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time;
}

function crockfordRand(n) {
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += CROCKFORD[b[i] % 32];
  return s;
}

/** A ULID-ish id ending in `OPEN<NNNN>` so the fold derives the display number. */
export function mintIssueId(number) {
  return `${crockfordTime(Date.now())}${crockfordRand(6)}OPEN${String(number).padStart(4, "0")}`;
}

/**
 * A ULID-ish id for a non-open event. Cosmetic — the fold never reads an event's
 * id for state — but kept unique + display-number-suffixed for consistency.
 */
function mintEventId(kind, number) {
  const tag = String(kind).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "EVENT";
  return `${crockfordTime(Date.now())}${crockfordRand(6)}${tag}${String(number).padStart(4, "0")}`;
}

export function slugify(input) {
  const s = String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return /^[a-z0-9]/.test(s) ? s : `issue-${s}`.replace(/-+$/g, "") || "issue";
}

// ── Time ────────────────────────────────────────────────────────────────────
/** Add an ISO-8601 duration (PnDTnHnMnS subset) to a Date, returning a new Date. */
export function addDuration(date, iso) {
  const m = String(iso).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) throw new Error(`invalid ISO-8601 duration "${iso}" (e.g. PT2H, PT30M, P1D)`);
  const [, d, h, min, s] = m.map((x) => (x ? parseInt(x, 10) : 0));
  return new Date(date.getTime() + ((d * 24 + h) * 60 + min) * 60_000 + s * 1000);
}

// Event filename time stamp. The convention is `<date>-<hhmm>-…`, but the CLI
// drives a full lifecycle (many events can land in one minute), and the fold
// orders events by FILENAME. Minute precision would then sort same-minute events
// alphabetically by kind, not chronologically — so we use `<hhmmss>` to keep the
// filename sort chronological. (author.ts only ever writes one `open` event, so
// it never hit this; the fold doesn't parse the time token, only sorts on it.)
function eventStamp(now) {
  const date = now.toISOString().slice(0, 10);
  const hhmmss =
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0");
  return `${date}-${hhmmss}`;
}

// ── Frontmatter builders ──────────────────────────────────────────────────────
function issueFrontmatter(opts) {
  const lines = [
    "---",
    `id: ${opts.id}`,
    `slug: ${opts.slug}`,
    `type: ${opts.type}`,
    `title: ${JSON.stringify(opts.title)}`,
    `author: ${JSON.stringify(opts.authorWebId)}`,
    `authorKind: ${opts.authorKind}`,
    `created: ${opts.createdIso}`,
  ];
  if (opts.epicSlug) lines.push(`epic: ${opts.epicSlug}`);
  lines.push(`afk: ${opts.afk ? "true" : "false"}`);
  lines.push("---");
  return lines.join("\n") + "\n";
}

function openEventFrontmatter(opts) {
  const lines = [
    "---",
    `id: ${opts.id}`,
    "kind: open",
    `actor: ${JSON.stringify(opts.authorWebId)}`,
    `actorKind: ${opts.authorKind}`,
    `at: ${opts.atIso}`,
    "to: todo",
    `type: ${opts.type}`,
    `priority: ${opts.priority}`,
  ];
  if (opts.epicSlug) lines.push(`epic: ${opts.epicSlug}`);
  lines.push("---");
  return lines.join("\n") + "\n";
}

function epicFrontmatter(opts) {
  return (
    [
      "---",
      `id: ${opts.slug}`,
      `title: ${JSON.stringify(opts.title)}`,
      `status: ${opts.status}`,
      `created: ${opts.createdYmd}`,
      "---",
    ].join("\n") + "\n"
  );
}

/** Build a non-open event's frontmatter. `extra` carries kind-specific keys. */
function eventFrontmatter({ id, kind, actor, at, from, to, prev, extra = {} }) {
  const lines = ["---", `id: ${id}`, `kind: ${kind}`, `actor: ${JSON.stringify(actor.webId)}`, `actorKind: ${actor.kind}`, `at: ${at}`];
  if (from != null) lines.push(`from: ${from}`);
  if (to != null) lines.push(`to: ${to}`);
  if (prev != null) lines.push(`prev: ${prev}`);
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// ── Build trio ────────────────────────────────────────────────────────────────
export function writeBuildTrio(rootDir) {
  const { outputs, epicCount, issueCount } = buildTrackerOutputs(rootDir);
  const buildDir = join(rootDir, ".mind", "build");
  mkdirSync(buildDir, { recursive: true });
  for (const [file, content] of Object.entries(outputs)) {
    writeFileSync(join(buildDir, file), content, "utf8");
  }
  return { epicCount, issueCount };
}

// ── Lookup helpers ──────────────────────────────────────────────────────────
function issuesDirOf(rootDir) {
  return join(rootDir, ".mind", "issues");
}

function readEpicId(issuesDir, dirName) {
  const epicFile = join(issuesDir, dirName, "epic.md");
  if (!existsSync(epicFile)) return null;
  const m = readFileSync(epicFile, "utf8").match(/^id:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

function findEpicDirName(issuesDir, slug) {
  if (!existsSync(issuesDir)) return null;
  for (const name of readdirSync(issuesDir)) {
    if (!ENTRY_DIR_RE.test(name)) continue;
    if (!statSync(join(issuesDir, name)).isDirectory()) continue;
    if (readEpicId(issuesDir, name) === slug) return name;
  }
  return null;
}

function listEpicSlugs(issuesDir) {
  if (!existsSync(issuesDir)) return [];
  const out = [];
  for (const name of readdirSync(issuesDir)) {
    if (!ENTRY_DIR_RE.test(name)) continue;
    if (!statSync(join(issuesDir, name)).isDirectory()) continue;
    const id = readEpicId(issuesDir, name);
    if (id) out.push(id);
  }
  return out;
}

/** Last event's `id` in an issue's events/ — the `prev` for the next event. */
function lastEventId(issueAbsDir) {
  const eventsDir = join(issueAbsDir, "events");
  if (!existsSync(eventsDir)) return null;
  const files = readdirSync(eventsDir).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) return null;
  const { data } = frontmatter(readFileSync(join(eventsDir, files[files.length - 1]), "utf8"), files[files.length - 1]);
  return data.id != null ? String(data.id) : null;
}

/**
 * Resolve a CLI ref (ULID, MC-NNNN/#NNNN/NNNN, slug, or title) to one folded
 * issue. Throws on no/ambiguous match (listing candidates).
 */
export function resolveIssue(epics, ref) {
  const all = epics.flatMap((e) => e.issues.map((i) => ({ ...i, epic: e })));
  const raw = String(ref).trim();
  const num = raw.replace(/^MC-/i, "").replace(/^#/, "");

  // exact ULID — case-insensitive: the ULID alphabet (Crockford base32) is
  // case-insensitive by spec, and stored ids are uppercase, but a copy-pasted
  // ULID is often lowercased. Compare upper-vs-upper so either form resolves.
  const rawUpper = raw.toUpperCase();
  let hits = all.filter((i) => i.id === rawUpper);
  // display number
  if (!hits.length && /^\d+$/.test(num)) hits = all.filter((i) => i.number === parseInt(num, 10));
  // slug exact
  if (!hits.length) hits = all.filter((i) => i.slug && i.slug === raw.toLowerCase());
  // title/slug contains
  if (!hits.length) {
    const q = raw.toLowerCase();
    hits = all.filter((i) => (i.slug && i.slug.includes(q)) || i.title.toLowerCase().includes(q));
  }

  if (!hits.length) throw new Error(`no issue matches "${ref}". Try \`mind issues list\`.`);
  if (hits.length > 1) {
    const cands = hits.map((i) => `MC-${i.number} ${i.title}`).join("; ");
    throw new Error(`"${ref}" is ambiguous — matches: ${cands}. Use the MC-NNNN handle or ULID.`);
  }
  return hits[0];
}

// ── Create issue ──────────────────────────────────────────────────────────────
/**
 * Create an issue: write issue.md + an `open` event into a fresh `<ts>_<rand4>/`
 * dir (under its epic or the general lane), then re-fold + rewrite the trio.
 */
export function createIssue(rootDir, { title, type, epicSlug, priority = "normal", body = "", afk = false }, actor, cfg) {
  const t = String(title).trim();
  if (!t) throw new Error("title is required");

  const catIds = new Set(cfg.categories.map((c) => c.id));
  if (!catIds.has(type))
    throw new Error(`unknown type "${type}" (expected one of: ${cfg.categories.map((c) => c.id).join(", ")})`);
  if (!cfg.priorities.includes(priority))
    throw new Error(`unknown priority "${priority}" (expected one of: ${cfg.priorities.join(", ")})`);

  const issuesDir = issuesDirOf(rootDir);
  const { epics } = foldTracker(rootDir);
  const allIssues = epics.flatMap((e) => e.issues);
  const nextNumber = allIssues.reduce((max, i) => Math.max(max, i.number ?? 0), 0) + 1;

  let groupRel = GENERAL_DIR;
  if (epicSlug && epicSlug !== "general") {
    const found = findEpicDirName(issuesDir, epicSlug);
    if (!found) {
      const slugs = listEpicSlugs(issuesDir);
      throw new Error(`unknown epic "${epicSlug}" (have: ${slugs.length ? slugs.join(", ") : "none"}, or "general")`);
    }
    groupRel = found;
  }

  let entry = entryDirName();
  while (existsSync(join(issuesDir, groupRel, entry))) entry = entryDirName();
  const issueDir = join(issuesDir, groupRel, entry);
  const eventsDir = join(issueDir, "events");
  mkdirSync(eventsDir, { recursive: true });

  const id = mintIssueId(nextNumber);
  const slug = slugify(t);
  const now = new Date();
  const stamp = eventStamp(now);
  const epicOut = groupRel === GENERAL_DIR ? undefined : epicSlug;

  writeFileSync(
    join(issueDir, "issue.md"),
    issueFrontmatter({
      id,
      slug,
      type,
      title: t,
      authorWebId: actor.webId,
      authorKind: actor.kind,
      createdIso: now.toISOString(),
      epicSlug: epicOut,
      afk,
    }) + (body.trim() ? `\n${body.trim()}\n` : ""),
    "utf8",
  );
  writeFileSync(
    join(eventsDir, `${stamp}-${actor.tag}-open.md`),
    openEventFrontmatter({
      id,
      authorWebId: actor.webId,
      authorKind: actor.kind,
      atIso: now.toISOString(),
      type,
      priority,
      epicSlug: epicOut,
    }) + "\nOpened via the mind CLI.\n",
    "utf8",
  );

  const { epicCount, issueCount } = writeBuildTrio(rootDir);
  return { id, number: nextNumber, slug, dir: join(groupRel, entry), epicCount, issueCount };
}

// ── Create epic ─────────────────────────────────────────────────────────────
const EPIC_STATUSES = new Set(["planned", "active", "done", "parked"]);

export function createEpic(rootDir, { title, status = "planned", body = "" }) {
  const t = String(title).trim();
  if (!t) throw new Error("title is required");
  if (!EPIC_STATUSES.has(status))
    throw new Error(`unknown epic status "${status}" (expected one of: ${[...EPIC_STATUSES].join(", ")})`);

  const issuesDir = issuesDirOf(rootDir);
  const existing = listEpicSlugs(issuesDir);
  const nextNumber = existing.length + 1;

  let slug = slugify(t);
  if (existing.includes(slug)) slug = `${slug}-${nextNumber}`;

  let dir = entryDirName();
  while (existsSync(join(issuesDir, dir))) dir = entryDirName();
  const epicDir = join(issuesDir, dir);
  mkdirSync(epicDir, { recursive: true });

  const now = new Date();
  writeFileSync(
    join(epicDir, "epic.md"),
    epicFrontmatter({ slug, title: t, status, createdYmd: now.toISOString().slice(0, 10) }) +
      (body.trim() ? `\n${body.trim()}\n` : ""),
    "utf8",
  );

  writeBuildTrio(rootDir);
  return { slug, number: nextNumber, dir };
}

// ── Append an event ───────────────────────────────────────────────────────────
/**
 * Append one event to an issue's events/ log, then re-fold + rewrite the trio.
 * `issue` is a folded issue (from resolveIssue). `to`/`from`/`extra` are
 * kind-specific. Returns { id, file }.
 */
export function appendEvent(rootDir, issue, { kind, from, to, extra }, actor, message) {
  const eventsDir = join(issue.absDir, "events");
  mkdirSync(eventsDir, { recursive: true });
  const prev = lastEventId(issue.absDir);
  const id = mintEventId(kind, issue.number ?? 0);
  const now = new Date();
  const stamp = eventStamp(now);

  const fm = eventFrontmatter({ id, kind, actor, at: now.toISOString(), from, to, prev, extra });
  const file = join(eventsDir, `${stamp}-${actor.tag}-${kind}.md`);
  const bodyText = (message ?? "").trim();
  writeFileSync(file, fm + (bodyText ? `\n${bodyText}\n` : ""), "utf8");

  writeBuildTrio(rootDir);
  return { id, file };
}

// ── Guards ────────────────────────────────────────────────────────────────────
/** Throw if `actor` may not claim `issue` (gate labels, non-open state, live claim). */
export function assertClaimable(cfg, issue, actor, { force = false } = {}) {
  const state = cfg.states.find((s) => s.id === issue.state);
  if (state && !state.open) throw new Error(`cannot claim a closed issue (state: ${issue.state})`);

  if (actor.kind === "agent") {
    const gates = (cfg.queueGateLabels ?? []).filter((l) => issue.labels.includes(l));
    if (gates.length)
      throw new Error(`issue is gated by label${gates.length > 1 ? "s" : ""} \`${gates.join(", ")}\` — agents must not claim it`);
  }

  if (issue.assignee && issue.assignee !== actor.webId && !force) {
    const live = issue.expiresAt && new Date(issue.expiresAt).getTime() > Date.now();
    if (live)
      throw new Error(
        `held by ${displayName(issue.assignee)} until ${issue.expiresAt}. Wait for the ttl, or pass --force to steal the claim.`,
      );
  }
}

/**
 * Throw if a close would be a no-op or breaks policy: agents never self-close
 * (AGENTS.md), and closing an issue to the state it's already in just writes a
 * misleading second CLOSE event into the immutable log. done→wontfix (a genuine
 * re-close to a *different* terminus) is still allowed. `--force` overrides both.
 */
export function assertClosable(issue, actor, { to, force = false } = {}) {
  if (actor.kind === "agent" && !force)
    throw new Error(
      "agents never self-close — hand back with `mind issues handoff <ref>` (→ review). Pass --force to override policy.",
    );
  if (issue.state === to && !force)
    throw new Error(`already ${to} — nothing to close. Pass --force to record another close event.`);
}

/** Throw if there is no live claim to release (would write a no-op RELEASE event). */
export function assertReleasable(issue, _actor, { force = false } = {}) {
  if (!issue.assignee && !force)
    throw new Error("no active claim to release. Pass --force to record a release event anyway.");
}
