// `mind issues …` — manage a local `.mind/` event-sourced issue tracker.
//
// Operates on the `.mind/` of the current repo (walks up from cwd like git).
// Issues are markdown folders; state is the FOLD of an append-only events/ log.
// This plugin is the thin citty surface; the work lives in ../src/tracker/*:
//   fold/render (a faithful port of mind-codespaces-v0's tracker build), author
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

function paintState(cfg, id) {
  const s = cfg.states.find((x) => x.id === id);
  if (!s) return yellow(id);
  if (!s.open) return id === "wontfix" ? gray(id) : dim(id);
  if (id === "needs-triage" || id === "blocked") return yellow(id);
  if (id === "in-progress") return cyan(id);
  return green(id);
}

const handle = (i) => `MC-${i.number ?? "?"}`;
const staleMark = (i) => (i.expiresAt && new Date(i.expiresAt).getTime() <= Date.now() ? " ⏱" : "");

// ── list ──────────────────────────────────────────────────────────────────────
function runList(args) {
  const { cfg, epics } = load(args);
  const actor = resolveActor(args);

  const match = (i) => {
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
      if (!groups.length) return console.log(dim('no issues yet — `mind issues new "<title>"`'));
      for (const g of groups) {
        const label = g.epic.isGeneral ? "General (un-epic'd)" : g.epic.title;
        console.log(`\n${bold(label)} ${dim(`[${g.epic.status}, ${g.issues.length} issue${g.issues.length === 1 ? "" : "s"}]`)}`);
        table(
          ["#", "state", "pri", "type", "title", "holder", "labels"],
          g.issues.map((i) => [
            cyan(handle(i)),
            paintState(cfg, i.state),
            i.priority ?? dim("—"),
            i.category,
            i.title.length > 48 ? i.title.slice(0, 47) + "…" : i.title,
            i.assignee ? dim(lastSeg(i.assignee) + staleMark(i)) : dim("—"),
            i.labels.length ? dim(i.labels.join(",")) : "",
          ]),
        );
      }
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
      { kind: "claim", to: "in-progress", extra: { ttl, expiresAt: addDuration(new Date(), ttl).toISOString() } },
      actor,
      "Claimed.",
    );
    pick.state = "in-progress";
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
    claim: { type: "boolean", description: "claim the picked issue immediately (→ in-progress)" },
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

const show = defineCommand({
  meta: { name: "show", description: "show one issue: folded facts, body, and event timeline" },
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
      kv([
        ["handle", cyan(handle(i))],
        ["id", i.id],
        ["title", bold(i.title)],
        ["type", i.category],
        ["state", paintState(cfg, i.state)],
        ["priority", i.priority ?? "—"],
        ["epic", i.epic?.isGeneral ? "general" : i.epic?.slug ?? "—"],
        ["holder", i.assignee ? lastSeg(i.assignee) + (staleMark(i) ? " (stale)" : "") : "—"],
        ["labels", i.labels.length ? i.labels.join(", ") : "—"],
        ["blocks", i.blocks.map((b) => "MC-" + handleNumber(b)).join(", ") || "—"],
        ["blockedBy", i.blockedBy.map((b) => "MC-" + handleNumber(b)).join(", ") || "—"],
        ["afk", i.afk == null ? "—" : String(i.afk)],
        ["created", i.created ?? "—"],
        ["modified", i.modified ?? "—"],
      ]);
      if (i.body) console.log(`\n${i.body}\n`);
      console.log(bold("events:"));
      for (const e of events) {
        const when = String(e.at ?? "").slice(0, 16).replace("T", " "); // YYYY-MM-DD HH:MM
        const move = e.to ? dim(` → ${e.to}`) : "";
        console.log(`  ${dim(when)} ${cyan(e.kind)} ${dim(lastSeg(e.actor ?? "?"))}${move}`);
        if (e.body) console.log(e.body.split("\n").map((l) => "    " + dim(l)).join("\n"));
      }
    });
  }),
});

// ── new (create issue) ──────────────────────────────────────────────────────────
const create = defineCommand({
  meta: { name: "new", description: "create an issue (writes issue.md + an open event)" },
  args: {
    title: { type: "positional", required: false, description: "issue title (omit for interactive)" },
    type: { type: "string", description: "category (feature/bug/refactor/chore/docs)" },
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

    if (!title) throw new Error('title is required (e.g. mind issues new "Fix the thing" --type bug)');
    if (!type) throw new Error(`--type is required (one of: ${cfg.categories.map((c) => c.id).join(", ")})`);

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
  meta: { name: "epic", description: "create an epic (a goal grouping issues)" },
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
        console.log(`${sym.ok} ${spec.kind} ${cyan(handle(issue))}${move} ${dim(res.id)}`);
      });
    }),
  });
}

function defaultMsg(kind) {
  return { open: "Opened.", triage: "Triaged.", claim: "Claimed.", release: "Released.", state: "State changed.", link: "Linked.", comment: "", handoff: "Handing back.", close: "Closed." }[kind] ?? "";
}

const triage = eventCmd({
  name: "triage",
  description: "triage an issue (set state/labels/blocks)",
  extraArgs: {
    to: { type: "string", description: "target state (e.g. ready-for-agent)" },
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
  description: "claim an issue (→ in-progress, with a ttl)",
  extraArgs: {
    ttl: { type: "string", description: "ISO-8601 duration (default from config.coordination.claimTtl)" },
    force: { type: "boolean", description: "steal a live claim held by someone else" },
  },
  build: ({ args, cfg, issue, actor }) => {
    assertClaimable(cfg, issue, actor, { force: args.force });
    const ttl = args.ttl || cfg.claimTtl || "PT2H";
    const at = new Date();
    return { kind: "claim", to: "in-progress", extra: { ttl, expiresAt: addDuration(at, ttl).toISOString() } };
  },
});

const release = eventCmd({
  name: "release",
  description: "release your claim on an issue",
  extraArgs: { force: { type: "boolean", description: "record a release even with no active claim" } },
  build: ({ args, issue, actor }) => {
    assertReleasable(issue, actor, { force: args.force });
    return { kind: "release" };
  },
});

const state = eventCmd({
  name: "state",
  description: "generic state transition",
  extraArgs: { to: { type: "string", required: true, description: "target state" } },
  build: ({ args, cfg }) => {
    requireState(cfg, args.to);
    return { kind: "state", to: args.to };
  },
});

const handoff = eventCmd({
  name: "handoff",
  description: "hand back to a human (→ ready-for-human)",
  build: ({ issue }) => ({ kind: "handoff", from: issue.state, to: "ready-for-human" }),
});

const comment = eventCmd({
  name: "comment",
  description: "add a comment event",
  build: ({ args }) => {
    if (!args.message) throw new Error("comment needs --message/-m");
    return { kind: "comment" };
  },
});

const link = eventCmd({
  name: "link",
  description: "record a PR / branch link",
  extraArgs: { pr: { type: "string", required: true, description: "PR branch or URL" } },
  build: ({ args }) => ({ kind: "link", extra: { pr: args.pr } }),
});

const close = eventCmd({
  name: "close",
  description: "close an issue (→ done|wontfix)",
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

// ── init ──────────────────────────────────────────────────────────────────────
const init = defineCommand({
  meta: { name: "init", description: "scaffold a fresh .mind/ tracker here" },
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
      console.log(`\n  ${dim("next:")} mind issues new "Your first issue" --type chore`);
    });
  }),
});

// ── build ──────────────────────────────────────────────────────────────────────
const build = defineCommand({
  meta: { name: "build", description: "regenerate build/{tracker,epics,state}.ttl from the fold" },
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
  meta: { name: "issues", description: "manage a local .mind event-sourced issue tracker" },
  subCommands: {
    init,
    epic,
    new: create,
    create,
    list,
    board: list,
    next,
    show,
    triage,
    claim,
    release,
    state,
    handoff,
    comment,
    link,
    close,
    build,
    fold: build,
  },
});
