// `mind issues …` — manage a local `.mind/` event-sourced issue tracker.
//
// Operates on the `.mind/` of the current repo (walks up from cwd like git).
// Issues are markdown folders; state is the FOLD of an append-only events/ log.
// This plugin is the thin citty surface; the work lives in ../src/tracker/*:
//   fold/render (a faithful port of codespaces's tracker build), author
//   (local-FS writes), scaffold (init), actor (who authors an event).

import { defineCommand } from "citty";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { emit, table, kv, guard, sym, green, red, cyan, yellow, gray, dim, bold, interactive } from "../src/ui.mjs";
import { requireTrackerRoot } from "../src/tracker/root.mjs";
import { loadConfig } from "../src/tracker/config.mjs";
import { foldTracker, frontmatter, handleNumber } from "../src/tracker/fold.mjs";
import { resolveActor, displayName } from "../src/tracker/actor.mjs";
import { agentQueue } from "../src/tracker/queue.mjs";
import {
  createIssue,
  createEpic,
  appendEvent,
  resolveIssue,
  writeBuildTrio,
  assertClaimable,
  assertClosable,
  assertReleasable,
  addDuration,
} from "../src/tracker/author.mjs";
import { initTracker } from "../src/tracker/scaffold.mjs";

const J = { json: { type: "boolean", description: "machine-readable JSON output" } };
const DIR = { dir: { type: "string", description: "tracker root (default: search up from cwd)" } };
const ACTOR = {
  author: { type: "string", description: "author WebID or name (default: active identity / $MIND_AUTHOR / local user)" },
  agent: { type: "boolean", description: "act as an agent (actorKind: agent; enforces gates + no self-close)" },
};
const MSG = { message: { type: "string", alias: "m", description: "event note (markdown body)" } };

const csv = (v) => (v == null ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));

function load(args) {
  const root = requireTrackerRoot(args.dir);
  const { cfg, epics } = foldTracker(root);
  return { root, cfg, epics };
}

function requireState(cfg, to, { closedOnly = false } = {}) {
  const s = cfg.states.find((x) => x.id === to);
  if (!s) throw new Error(`unknown state "${to}" (expected one of: ${cfg.states.map((x) => x.id).join(", ")})`);
  if (closedOnly && s.open)
    throw new Error(`"${to}" is an open state; close needs a closed state (${cfg.states.filter((x) => !x.open).map((x) => x.id).join(", ")})`);
  return s;
}

// Color function for a state id (so callers can pad raw text, then color it).
// Open lanes: todo = yellow (waiting), doing = cyan (active), review/other =
// green (ready for a look). Closed: wontfix = gray, done = dim. Falls back
// sensibly for any custom vocab (e.g. a legacy needs-triage/blocked tracker).
function stateColor(cfg, id) {
  const s = cfg.states.find((x) => x.id === id);
  if (!s) return yellow;
  if (!s.open) return id === "wontfix" ? gray : dim;
  if (id === "todo" || id === "needs-triage" || id === "blocked") return yellow;
  if (id === "doing" || id === "in-progress") return cyan;
  return green;
}
function paintState(cfg, id) {
  return stateColor(cfg, id)(id);
}

// Priority gutter: one glyph so a busy/urgent issue stands out without a column.
const priMark = (p) =>
  p === "urgent" ? red("‼") : p === "high" ? yellow("↑") : p === "low" ? dim("↓") : " ";

const handle = (i) => `MC-${i.number ?? "?"}`;
const staleMark = (i) => (i.expiresAt && new Date(i.expiresAt).getTime() <= Date.now() ? " ⏱" : "");

// ── list ──────────────────────────────────────────────────────────────────────
// Shared issue filter for list/board — honors --state/--type/--priority/--label/--mine/--open/--closed.
function makeMatch(cfg, args, actor) {
  return (i) => {
    const st = cfg.states.find((s) => s.id === i.state);
    if (args.state && i.state !== args.state) return false;
    if (args.type && i.category !== args.type) return false;
    if (args.priority && i.priority !== args.priority) return false;
    if (args.label && !i.labels.includes(args.label)) return false;
    if (args.mine && i.assignee !== actor.webId) return false;
    if (args.open && st && !st.open) return false;
    if (args.closed && st && st.open) return false;
    return true;
  };
}

const PRI_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function runList(args) {
  const { cfg, epics } = load(args);
  const actor = resolveActor(args);
  const match = makeMatch(cfg, args, actor);

  const groups = epics
    .map((e) => ({ epic: e, issues: e.issues.filter(match) }))
    .filter((g) => g.issues.length);

  emit(
    {
      epics: groups.map((g) => ({
        slug: g.epic.slug,
        number: g.epic.number,
        title: g.epic.title,
        status: g.epic.status,
        isGeneral: !!g.epic.isGeneral,
        issues: g.issues.map((i) => ({
          id: i.id,
          number: i.number,
          slug: i.slug,
          title: i.title,
          type: i.category,
          state: i.state,
          priority: i.priority,
          holder: i.assignee,
          expiresAt: i.expiresAt,
          labels: i.labels,
          afk: i.afk,
          blocks: i.blocks,
          blockedBy: i.blockedBy,
        })),
      })),
    },
    () => {
      if (!groups.length) return console.log(dim('no issues yet — `mind issues add "<title>"`'));

      // One aligned line per issue, no box drawing. Widths are global across all
      // groups so columns line up the whole way down. A leading glyph flags
      // priority; trailing dim text carries holder + labels (only when present).
      const all = groups.flatMap((g) => g.issues);
      const wId = Math.max(...all.map((i) => handle(i).length));
      const wState = Math.max(...all.map((i) => i.state.length));
      const wType = Math.max(...all.map((i) => (i.category ?? "").length));
      const total = all.length;

      for (const g of groups) {
        const label = g.epic.isGeneral ? "General" : g.epic.title;
        console.log(`\n${bold(label)} ${dim(`· ${g.issues.length}`)}`);
        for (const i of g.issues) {
          const meta = [
            i.assignee ? dim(lastSeg(i.assignee) + staleMark(i)) : "",
            i.labels.length ? dim(i.labels.join(" ")) : "",
          ].filter(Boolean).join("  ");
          console.log(
            `  ${priMark(i.priority)} ${cyan(handle(i).padEnd(wId))}  ` +
              `${stateColor(cfg, i.state)(i.state.padEnd(wState))}  ` +
              `${dim((i.category ?? "").padEnd(wType))}  ` +
              `${i.title}${meta ? "   " + meta : ""}`,
          );
        }
      }
      console.log(dim(`\n${total} issue${total === 1 ? "" : "s"}`));
    },
  );
}

const lastSeg = (w) => displayName(w);

const list = defineCommand({
  meta: { name: "list", description: "list issues, grouped by epic, with folded state" },
  args: {
    state: { type: "string", description: "filter by state id" },
    type: { type: "string", description: "filter by category" },
    priority: { type: "string", description: "filter by priority" },
    epic: { type: "string", description: "filter by epic slug" },
    label: { type: "string", description: "filter by label" },
    mine: { type: "boolean", description: "only issues you hold" },
    open: { type: "boolean", description: "only open states" },
    closed: { type: "boolean", description: "only closed states" },
    ...ACTOR,
    ...DIR,
    ...J,
  },
  run: guard(async ({ args }) => runList(args)),
});

// ── board ─────────────────────────────────────────────────────────────────────
// Same fold + filters as `list`, but grouped by STATE (kanban lanes) instead of
// by epic. Lanes follow tracker.config state order (the workflow left→right);
// each issue carries its epic as a dim trailing tag so context isn't lost.
function runBoard(args) {
  const { cfg, epics } = load(args);
  const actor = resolveActor(args);
  const match = makeMatch(cfg, args, actor);

  const all = epics.flatMap((e) =>
    e.issues.filter(match).map((i) => ({ ...i, epicLabel: e.isGeneral ? null : e.title })),
  );
  // One lane per state that has issues, in config (workflow) order.
  const lanes = cfg.states
    .map((s) => ({
      state: s,
      issues: all
        .filter((i) => i.state === s.id)
        .sort((a, b) => (PRI_RANK[a.priority] ?? 2) - (PRI_RANK[b.priority] ?? 2) || (a.number ?? 0) - (b.number ?? 0)),
    }))
    .filter((l) => l.issues.length);

  emit(
    {
      board: lanes.map((l) => ({
        state: l.state.id,
        open: !!l.state.open,
        count: l.issues.length,
        issues: l.issues.map((i) => ({
          id: i.id, number: i.number, slug: i.slug, title: i.title,
          type: i.category, priority: i.priority, holder: i.assignee,
          epic: i.epicLabel, labels: i.labels,
        })),
      })),
    },
    () => {
      if (!lanes.length) return console.log(dim('no issues yet — `mind issues add "<title>"`'));
      const wId = Math.max(...all.map((i) => handle(i).length));
      const total = all.length;
      // Open lanes (todo/doing/review) are shown in full; closed lanes
      // (done/wontfix) are noise on a working board, so collapse them into one
      // summary line unless --all. `done` is where finished work goes to rest.
      const openLanes = lanes.filter((l) => l.state.open);
      const closedLanes = lanes.filter((l) => !l.state.open);
      for (const l of openLanes) {
        const color = stateColor(cfg, l.state.id);
        console.log(`\n${color(bold(l.state.label ?? l.state.id))} ${dim(`· ${l.issues.length}`)}`);
        for (const i of l.issues) {
          const meta = [
            i.epicLabel ? dim(i.epicLabel) : "",
            i.assignee ? dim(lastSeg(i.assignee) + staleMark(i)) : "",
            i.labels.length ? dim(i.labels.join(" ")) : "",
          ].filter(Boolean).join("  ");
          console.log(
            `  ${priMark(i.priority)} ${cyan(handle(i).padEnd(wId))}  ${i.title}${meta ? "   " + meta : ""}`,
          );
        }
      }
      if (closedLanes.length) {
        const closedTotal = closedLanes.reduce((n, l) => n + l.issues.length, 0);
        if (args.all) {
          for (const l of closedLanes) {
            console.log(`\n${dim(bold(l.state.label ?? l.state.id))} ${dim(`· ${l.issues.length}`)}`);
            for (const i of l.issues)
              console.log(`  ${priMark(i.priority)} ${cyan(handle(i).padEnd(wId))}  ${dim(i.title)}`);
          }
        } else {
          console.log(dim(`\nDone · ${closedTotal}  ${dim("(--all to show)")}`));
        }
      }
      if (!openLanes.length && !args.all)
        console.log(dim("\nnothing open — nice. `mind issues add \"<title>\"` to file the next one."));
    },
  );
}

// Shared filter/view args for the board (and the bare `mind issues` default).
const BOARD_ARGS = {
  all: { type: "boolean", description: "include the collapsed Done lane" },
  state: { type: "string", description: "filter by state id" },
  type: { type: "string", description: "filter by category" },
  priority: { type: "string", description: "filter by priority" },
  epic: { type: "string", description: "filter by epic slug" },
  label: { type: "string", description: "filter by label" },
  mine: { type: "boolean", description: "only issues you hold" },
  open: { type: "boolean", description: "only open states" },
  closed: { type: "boolean", description: "only closed states" },
  ...ACTOR,
  ...DIR,
  ...J,
};

const board = defineCommand({
  meta: { name: "board", description: "the board: issues grouped into lanes (todo · doing · review · done)" },
  args: BOARD_ARGS,
  run: guard(async ({ args }) => runBoard(args)),
});

// ── next (agent work-queue picker) ──────────────────────────────────────────────
// The single most useful verb for an AFK agent loop: surface the issue an agent
// should pick up next. The queue is open issues handed to agents (state.handoff
// === "agent") or explicitly marked --afk, minus gate-labelled ones and minus
// issues a *different* actor holds under a live claim. Ranked by priority, then
// lowest ULID (config.coordination.tieBreak). `--claim` claims it in one step.
function runNext(args) {
  const { root, cfg, epics } = load(args);
  const actor = resolveActor(args);
  const queue = agentQueue({ cfg, epics, actorWebId: actor.webId });
  const pick = queue[0] ?? null;

  if (pick && args.claim) {
    assertClaimable(cfg, pick, actor, { force: args.force });
    const ttl = cfg.claimTtl || "PT2H";
    appendEvent(
      root,
      pick,
      { kind: "claim", to: "doing", extra: { ttl, expiresAt: addDuration(new Date(), ttl).toISOString() } },
      actor,
      "Claimed.",
    );
    pick.state = "doing";
    pick.assignee = actor.webId;
  }

  const row = (i, c) => ({ id: i.id, number: i.number, handle: handle(i), title: i.title, type: i.category, state: i.state, priority: i.priority, epic: i.epicLabel, labels: i.labels, afk: i.afk, claimed: !!c });
  emit(
    {
      pick: pick && row(pick, args.claim),
      // --all surfaces the full ranked order (priority, then lowest-ULID) so a
      // human or agent can see the upcoming backlog, not just the head.
      ...(args.all ? { queue: queue.map((i) => row(i, args.claim && i.id === pick.id)) } : {}),
      queueDepth: queue.length,
    },
    () => {
      if (!pick) return console.log(dim("no claimable agent work — queue is empty"));
      const where = pick.epicLabel;
      console.log(`${args.claim ? sym.ok + " claimed " : ""}${cyan(handle(pick))} ${paintState(cfg, pick.state)} ${dim(`[${pick.priority}]`)} ${pick.title}`);
      console.log(`  ${dim("type")} ${pick.category}  ${dim("epic")} ${where}${pick.labels.length ? `  ${dim("labels")} ${pick.labels.join(",")}` : ""}`);
      if (args.all && queue.length > 1) {
        console.log(`  ${dim("then:")}`);
        for (const i of queue.slice(1))
          console.log(`    ${cyan(handle(i))} ${dim(`[${i.priority}]`)} ${i.title}`);
      }
      console.log(`  ${dim(`${queue.length} issue${queue.length === 1 ? "" : "s"} in the agent queue` + (args.claim ? "" : ` — claim with: mind issues claim ${handle(pick)} --agent`))}`);
    },
  );
}

const next = defineCommand({
  meta: { name: "next", description: "pick the next claimable issue for an agent (ranked queue)" },
  args: {
    claim: { type: "boolean", description: "claim the picked issue immediately (→ doing)" },
    force: { type: "boolean", description: "with --claim: steal a live claim" },
    all: { type: "boolean", description: "show the whole ranked queue, not just the top pick (read-only)" },
    ...ACTOR,
    ...DIR,
    ...J,
  },
  run: guard(async ({ args }) => runNext({ ...args, agent: true })),
});

// ── show ──────────────────────────────────────────────────────────────────────
function readEvents(absDir) {
  const eventsDir = join(absDir, "events");
  if (!existsSync(eventsDir)) return [];
  return readdirSync(eventsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const { data, body } = frontmatter(readFileSync(join(eventsDir, f), "utf8"), f);
      return { file: f, ...data, body };
    });
}

// One plain-English line for an event, for the `show` activity feed. Turns the
// raw kind/to into something a person reads as a changelog. Legacy state ids in
// historical events are shown verbatim (that's what actually happened).
function eventPhrase(e) {
  const arrow = (s) => `${dim("→")} ${cyan(s)}`;
  switch (e.kind) {
    case "open": return dim(`filed this${e.type ? ` (${e.type})` : ""}`);
    case "triage": return e.to ? `triaged ${arrow(e.to)}` : dim("triaged it");
    case "claim": return `started work${e.to ? " " + arrow(e.to) : ""}`;
    case "release": return dim("released the claim");
    case "handoff": return `handed back${e.to ? " " + arrow(e.to) : ""}`;
    case "state": return e.to ? `moved ${arrow(e.to)}` : dim("changed state");
    case "link": return `linked ${cyan(e.pr ?? "a PR")}`;
    case "comment": {
      const first = (e.body ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      return dim("commented:") + (first ? " " + first : "");
    }
    case "close": return `marked it ${cyan(e.to ?? "done")}`;
    default: return dim(e.kind) + (e.to ? " " + arrow(e.to) : "");
  }
}

const show = defineCommand({
  meta: { name: "show", description: "show one issue: facts, body, and a plain activity feed" },
  args: {
    ref: { type: "positional", required: true, description: "issue ULID, MC-NNNN, or slug" },
    ...DIR,
    ...J,
  },
  run: guard(async ({ args }) => {
    const { cfg, epics } = load(args);
    const i = resolveIssue(epics, args.ref);
    const events = readEvents(i.absDir);
    emit({ issue: { ...i, absDir: undefined, epic: i.epic?.isGeneral ? "general" : i.epic?.slug }, events }, () => {
      // Headline: handle · title · state. The raw ULID stays in --json only —
      // a human never types it (they use MC-N / the slug), so it's just noise here.
      console.log(`${cyan(handle(i))}  ${bold(i.title)}  ${paintState(cfg, i.state)}`);
      const facts = [
        ["type", i.category],
        ["priority", i.priority ?? "—"],
        ["epic", i.epic?.isGeneral ? "general" : i.epic?.slug ?? "—"],
      ];
      if (i.assignee) facts.push(["holder", lastSeg(i.assignee) + (staleMark(i) ? " (stale)" : "")]);
      if (i.labels.length) facts.push(["labels", i.labels.join(", ")]);
      if (i.blocks.length) facts.push(["blocks", i.blocks.map((b) => "MC-" + handleNumber(b)).join(", ")]);
      if (i.blockedBy.length) facts.push(["blockedBy", i.blockedBy.map((b) => "MC-" + handleNumber(b)).join(", ")]);
      kv(facts);
      if (i.body) console.log(`\n${i.body}\n`);

      // Activity: the event log as a plain-English changelog, not a kind→state dump.
      console.log(bold("activity:"));
      for (const e of events) {
        const when = String(e.at ?? "").slice(0, 16).replace("T", " "); // YYYY-MM-DD HH:MM
        const who = lastSeg(e.actor ?? "?");
        console.log(`  ${dim(when)}  ${who} ${eventPhrase(e)}`);
        // comment bodies are already inlined into the phrase; for other kinds,
        // show a non-boilerplate note indented under the line.
        const note = (e.body ?? "").trim();
        if (note && e.kind !== "comment" && note !== "Opened via the mind CLI.")
          console.log(note.split("\n").map((l) => "    " + dim(l)).join("\n"));
      }
    });
  }),
});

// ── new (create issue) ──────────────────────────────────────────────────────────
const create = defineCommand({
  meta: { name: "add", description: "file a new issue — title only; --type optional (→ todo)" },
  args: {
    title: { type: "positional", required: false, description: "issue title (omit for interactive)" },
    type: { type: "string", description: "category (default chore; feature/bug/refactor/chore/docs)" },
    priority: { type: "string", description: "urgent|high|normal|low (default normal)" },
    epic: { type: "string", description: "epic slug (default: general lane)" },
    body: { type: "string", description: "markdown body" },
    afk: { type: "boolean", description: "safe for an AFK agent to pick up" },
    ...ACTOR,
    ...DIR,
    ...J,
  },
  run: guard(async ({ args }) => {
    const root = requireTrackerRoot(args.dir);
    const cfg = loadConfig(join(root, ".mind", "issues"), root);
    const actor = resolveActor(args);

    let { title, type, priority, epic, body } = args;

    if (!title && interactive) {
      const { text, select, isCancel } = await import("@clack/prompts");
      title = await text({ message: "Issue title", validate: (v) => (v?.trim() ? undefined : "required") });
      if (isCancel(title)) return;
      type = await select({ message: "Type", options: cfg.categories.map((c) => ({ value: c.id, label: c.id })) });
      if (isCancel(type)) return;
      priority = await select({
        message: "Priority",
        options: cfg.priorities.map((p) => ({ value: p, label: p })),
        initialValue: "normal",
      });
      if (isCancel(priority)) return;
      const { epics } = foldTracker(root);
      const epicOpts = [{ value: "general", label: "General (un-epic'd)" }, ...epics.filter((e) => !e.isGeneral).map((e) => ({ value: e.slug, label: e.title }))];
      epic = await select({ message: "Epic", options: epicOpts, initialValue: "general" });
      if (isCancel(epic)) return;
      const b = await text({ message: "Body (optional)", defaultValue: "" });
      if (isCancel(b)) return;
      body = b;
    }

    if (!title) throw new Error('title is required (e.g. mind issues add "Fix the thing")');
    // --type is optional on the everyday path: default to `chore` (the neutral
    // catch-all), or the first declared category if a custom vocab lacks it.
    if (!type) type = cfg.categories.some((c) => c.id === "chore") ? "chore" : cfg.categories[0].id;

    const res = createIssue(
      root,
      { title, type, epicSlug: epic, priority: priority || "normal", body: body || "", afk: !!args.afk },
      actor,
      cfg,
    );
    emit({ ok: true, ...res }, () => {
      console.log(`${sym.ok} created ${cyan("MC-" + res.number)} ${dim(res.id)}`);
      console.log(`  ${dim("dir")} .mind/issues/${res.dir}`);
    });
  }),
});

// ── epic ──────────────────────────────────────────────────────────────────────
const epic = defineCommand({
  meta: { name: "epic", description: "(advanced) create an epic (a goal grouping issues)" },
  args: {
    title: { type: "positional", required: true, description: "epic title" },
    status: { type: "string", description: "planned|active|done|parked (default planned)" },
    body: { type: "string", description: "markdown goal narrative" },
    ...DIR,
    ...J,
  },
  run: guard(async ({ args }) => {
    const root = requireTrackerRoot(args.dir);
    const res = createEpic(root, { title: args.title, status: args.status || "planned", body: args.body || "" });
    emit({ ok: true, ...res }, () => console.log(`${sym.ok} epic ${green(res.slug)} ${dim("#" + res.number)}`));
  }),
});

// ── event commands ────────────────────────────────────────────────────────────
function eventCmd({ name, description, build, extraArgs = {} }) {
  return defineCommand({
    meta: { name, description },
    args: {
      ref: { type: "positional", required: true, description: "issue ULID, MC-NNNN, or slug" },
      ...extraArgs,
      ...MSG,
      ...ACTOR,
      ...DIR,
      ...J,
    },
    run: guard(async ({ args }) => {
      const { root, cfg, epics } = load(args);
      const actor = resolveActor(args);
      const issue = resolveIssue(epics, args.ref);
      const spec = build({ args, cfg, issue, actor, epics }); // { kind, from?, to?, extra?, message? }
      const res = appendEvent(root, issue, spec, actor, spec.message ?? args.message ?? defaultMsg(spec.kind));
      emit({ ok: true, id: res.id, ref: handle(issue), kind: spec.kind, to: spec.to ?? null }, () => {
        const move = spec.to ? dim(` → ${spec.to}`) : "";
        // `verb` lets a friendly wrapper (start/done) say what the user typed,
        // not the underlying event kind (claim/close).
        console.log(`${sym.ok} ${spec.verb ?? spec.kind} ${cyan(handle(issue))}${move} ${dim(res.id)}`);
      });
    }),
  });
}

function defaultMsg(kind) {
  return { open: "Opened.", triage: "Triaged.", claim: "Claimed.", release: "Released.", state: "State changed.", link: "Linked.", comment: "", handoff: "Handing back.", close: "Closed." }[kind] ?? "";
}

const triage = eventCmd({
  name: "triage",
  description: "(advanced) triage an issue (set state/labels/blocks)",
  extraArgs: {
    to: { type: "string", description: "target state (e.g. review)" },
    labels: { type: "string", description: "comma-separated labels (e.g. area:io,security)" },
    blocks: { type: "string", description: "comma-separated issue ULIDs this blocks" },
  },
  build: ({ args, cfg, epics }) => {
    if (args.to) requireState(cfg, args.to);
    // Resolve each --blocks ref (ULID, MC-N, #N, N, or slug) to its canonical
    // ULID and reject anything that doesn't match a real issue. Without this an
    // unresolved ref is accepted, then silently dropped by the fold (fold.mjs
    // filters blocks to known ids) — a confusing no-op link. resolveIssue throws
    // with candidates when a ref is ambiguous/unknown.
    const blocks = args.blocks ? csv(args.blocks).map((ref) => resolveIssue(epics, ref).id) : undefined;
    return {
      kind: "triage",
      to: args.to,
      extra: { labels: args.labels ? csv(args.labels) : undefined, blocks },
    };
  },
});

const claim = eventCmd({
  name: "claim",
  description: "(advanced) claim an issue (→ doing, with a ttl)",
  extraArgs: {
    ttl: { type: "string", description: "ISO-8601 duration (default from config.coordination.claimTtl)" },
    force: { type: "boolean", description: "steal a live claim held by someone else" },
  },
  build: ({ args, cfg, issue, actor }) => {
    assertClaimable(cfg, issue, actor, { force: args.force });
    const ttl = args.ttl || cfg.claimTtl || "PT2H";
    const at = new Date();
    return { kind: "claim", to: "doing", extra: { ttl, expiresAt: addDuration(at, ttl).toISOString() } };
  },
});

const release = eventCmd({
  name: "release",
  description: "(advanced) release your claim on an issue",
  extraArgs: { force: { type: "boolean", description: "record a release even with no active claim" } },
  build: ({ args, issue, actor }) => {
    assertReleasable(issue, actor, { force: args.force });
    return { kind: "release" };
  },
});

const state = eventCmd({
  name: "state",
  description: "(advanced) generic state transition",
  extraArgs: { to: { type: "string", required: true, description: "target state" } },
  build: ({ args, cfg }) => {
    requireState(cfg, args.to);
    return { kind: "state", to: args.to };
  },
});

const handoff = eventCmd({
  name: "handoff",
  description: "(advanced) hand back to a human (→ review)",
  build: ({ issue }) => ({ kind: "handoff", from: issue.state, to: "review" }),
});

const comment = eventCmd({
  name: "comment",
  description: "(advanced) add a comment event",
  build: ({ args }) => {
    if (!args.message) throw new Error("comment needs --message/-m");
    return { kind: "comment" };
  },
});

const link = eventCmd({
  name: "link",
  description: "(advanced) record a PR / branch link",
  extraArgs: { pr: { type: "string", required: true, description: "PR branch or URL" } },
  build: ({ args }) => ({ kind: "link", extra: { pr: args.pr } }),
});

const close = eventCmd({
  name: "close",
  description: "(advanced) close an issue (→ done|wontfix; humans only)",
  extraArgs: {
    to: { type: "string", description: "done|wontfix (default done)" },
    resolution: { type: "string", description: "resolution note (e.g. fixed)" },
    force: { type: "boolean", description: "override the agents-never-self-close rule" },
  },
  build: ({ args, cfg, issue, actor }) => {
    const to = args.to || "done";
    requireState(cfg, to, { closedOnly: true });
    assertClosable(issue, actor, { to, force: args.force });
    return { kind: "close", from: issue.state, to, extra: { resolution: args.resolution || (to === "done" ? "fixed" : undefined) } };
  },
});

// ── start / done (the everyday human verbs) ─────────────────────────────────────
// `start` and `done` wrap the claim→close ceremony so a person never has to know
// about claims, ttls, actorKind, or handoff for the common case. Both reuse the
// same guards + appendEvent the advanced verbs do — they are sugar, not a second
// code path. Actor is auto-resolved (default kind: human).
const start = eventCmd({
  name: "start",
  description: "start work on an issue (→ doing)",
  build: ({ cfg, issue, actor }) => {
    assertClaimable(cfg, issue, actor, {});
    const ttl = cfg.claimTtl || "PT2H";
    return { kind: "claim", verb: "started", to: "doing", extra: { ttl, expiresAt: addDuration(new Date(), ttl).toISOString() } };
  },
});

const finish = eventCmd({
  name: "done",
  description: "mark an issue done (→ done)",
  extraArgs: { force: { type: "boolean", description: "override the no-op / self-close guard" } },
  build: ({ args, cfg, issue, actor }) => {
    requireState(cfg, "done", { closedOnly: true });
    assertClosable(issue, actor, { to: "done", force: args.force });
    return { kind: "close", verb: "done", from: issue.state, to: "done", extra: { resolution: "fixed" } };
  },
});

// ── init ──────────────────────────────────────────────────────────────────────
const init = defineCommand({
  meta: { name: "init", description: "(advanced) scaffold a fresh .mind/ tracker here" },
  args: {
    title: { type: "string", description: "tracker title" },
    namespace: { type: "string", description: "RDF namespace IRI (default https://mindpods.org/ns/<slug>#)" },
    force: { type: "boolean", description: "overwrite an existing tracker's config + docs" },
    ...DIR,
    ...J,
  },
  run: guard(async ({ args }) => {
    const target = args.dir || process.cwd();
    const res = initTracker(target, { title: args.title, namespace: args.namespace, force: args.force });
    writeBuildTrio(target); // emit an (empty) valid trio
    emit({ ok: true, ...res }, () => {
      console.log(`${sym.ok} initialised tracker at ${dim(res.mind)}`);
      console.log(`  ${dim("title")}     ${res.title}`);
      console.log(`  ${dim("namespace")} ${res.namespace}`);
      console.log(`\n  ${dim("next:")} mind issues add "Your first issue"`);
    });
  }),
});

// ── build ──────────────────────────────────────────────────────────────────────
const build = defineCommand({
  meta: { name: "build", description: "(advanced) regenerate build/{tracker,epics,state}.ttl from the fold" },
  args: {
    check: { type: "boolean", description: "diff vs committed build/ and exit 1 on drift (no write)" },
    ...DIR,
    ...J,
  },
  run: guard(async ({ args }) => {
    const root = requireTrackerRoot(args.dir);
    const { buildTrackerOutputs } = await import("../src/tracker/fold.mjs");
    const { outputs, epicCount, issueCount } = buildTrackerOutputs(root);
    const buildDir = join(root, ".mind", "build");

    if (args.check) {
      const { unifiedDiff } = await import("../src/tracker/diff.mjs");
      const drift = [];
      for (const [name, content] of Object.entries(outputs)) {
        const p = join(buildDir, name);
        const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
        if (cur !== content) drift.push({ name, diff: unifiedDiff(cur, content) });
      }
      if (drift.length) {
        emit({ ok: false, drift: drift.map((d) => ({ name: d.name, diff: d.diff })) }, () => {
          console.error(`${sym.err} ${red("out of date:")} ${drift.map((d) => d.name).join(", ")} — run \`mind issues build\``);
          for (const { name, diff } of drift) {
            console.error(`\n${bold(name)} ${dim("(committed → folded)")}`);
            for (const line of (diff || "  (file missing)").split("\n")) {
              if (line.startsWith("-")) console.error(red(line));
              else if (line.startsWith("+")) console.error(green(line));
              else console.error(dim(line));
            }
          }
        });
        process.exitCode = 1;
        return;
      }
      emit({ ok: true, upToDate: true, epicCount, issueCount }, () => console.log(`${sym.ok} build/ up to date ${dim(`(${epicCount} epics, ${issueCount} issues)`)}`));
      return;
    }

    const written = writeBuildTrio(root);
    emit({ ok: true, ...written }, () => console.log(`${sym.ok} wrote build trio ${dim(`(${written.epicCount} epics, ${written.issueCount} issues)`)}`));
  }),
});

export default defineCommand({
  meta: { name: "issues", description: "a local issue tracker: add · start · done (bare `mind issues` shows the board)" },
  // Bare `mind issues` (no subcommand) runs the board. citty runs this parent
  // `run` on EVERY invocation — even after dispatching a subcommand — so we must
  // bow out when a subcommand token is present (it already handled the call). A
  // non-dash arg at this level is always a subcommand name (issues has no
  // positional of its own); an unknown one is rejected by citty before we get
  // here. The board args are mirrored so `mind issues --all`/`--mine` still work.
  args: BOARD_ARGS,
  run: guard(async ({ args, rawArgs }) => {
    if ((rawArgs ?? []).some((a) => !a.startsWith("-"))) return; // a subcommand ran
    return runBoard(args);
  }),
  // Common verbs first, advanced (coordination/setup) last — citty lists these
  // in insertion order, so this IS the Common/More split (reinforced by the
  // "(advanced)" prefixes in their descriptions).
  subCommands: {
    add: create,
    start,
    done: finish,
    list,
    show,
    board,
    next,
    // advanced — multi-agent coordination + setup
    new: create,
    create,
    triage,
    claim,
    release,
    state,
    handoff,
    comment,
    link,
    close,
    epic,
    init,
    build,
    fold: build,
  },
});
