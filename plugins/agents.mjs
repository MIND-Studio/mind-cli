// `mind agents …` — launch a *local* CLI coding agent (codex / claude / gemini)
// with a per-repo persona (a specialized system prompt) and the current repo as
// its working directory.
//
//   mind agents start coder            # interactive: hands over the backend TUI
//   mind agents start coder -p "task"  # headless: run the task, print, exit
//   mind agents list                   # personas in .mind/agents + backends on PATH
//
// Personas live in `<repo>/.mind/agents/<name>.md` (YAML frontmatter + a markdown
// body that IS the system prompt). Backends are pluggable: a small interface maps
// a common { personaFile, personaText, task?, model?, interactive } to per-CLI
// argv/env. This is the first mind plugin to shell out — it uses
// `node:child_process.spawn` with stdio:"inherit" so the child owns the terminal.

import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  accessSync,
  constants as FS,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { getActive } from "../src/store.mjs";
import { foldTracker } from "../src/tracker/fold.mjs";
import { resolveIssue } from "../src/tracker/author.mjs";
import { agentQueue } from "../src/tracker/queue.mjs";
import { emit, table, guard, sym, green, red, cyan, yellow, dim, bold } from "../src/ui.mjs";

const J = { json: { type: "boolean", description: "machine-readable JSON output" } };

// ── persona files ───────────────────────────────────────────────────────────

/** Parse `---\nfront\n---\nbody` into { meta, prompt }. Flat `key: value` only. */
export function parsePersona(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, prompt: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, prompt: m[2].trim() };
}

/** Walk up from `start` for a directory containing `.mind/`. Returns its path or null. */
export function findMindDir(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    const m = join(dir, ".mind");
    if (existsSync(m) && statSync(m).isDirectory()) return m;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function locateAgents({ optional = false } = {}) {
  const mind = findMindDir();
  if (!mind) {
    if (optional) return null;
    throw new Error(
      "no .mind/ found from cwd upward. Create `.mind/agents/<name>.md`, or run `mind issues init` here.",
    );
  }
  return { mind, root: dirname(mind), agentsDir: join(mind, "agents") };
}

function readPersonas(agentsDir) {
  if (!agentsDir || !existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { meta } = parsePersona(readFileSync(join(agentsDir, f), "utf8"));
      const name = f.replace(/\.md$/, "");
      return { name, description: meta.description ?? "", backend: meta.backend ?? null, model: meta.model ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── backends (pluggable) ──────────────────────────────────────────────────────
// Each backend maps the common shape to its own argv/env. codex is the default.
// Persona injection differs per CLI: codex has no system-prompt flag (we point it
// at the persona file via a config override); claude takes the prompt as a string;
// gemini reads it from an env var.

/** codex has no system-prompt channel — fold the persona into the prompt itself. */
export function composeCodexPrompt(personaText, task, interactive) {
  const parts = [];
  if (personaText)
    parts.push(`[SYSTEM PERSONA — follow these instructions for the whole session]\n${personaText}`);
  if (task) parts.push(task);
  else if (personaText && interactive) parts.push("Acknowledge your role in one line, then wait for my instructions.");
  return parts.join("\n\n---\n\n");
}

export const BACKENDS = {
  codex: {
    bin: "codex",
    install: "npm i -g @openai/codex  (https://github.com/openai/codex)",
    // codex [PROMPT] (interactive) / codex exec [PROMPT] (headless). codex has no
    // system-prompt flag, and `-c experimental_instructions_file` is silently
    // ignored in 0.135.x — so we PREPEND the persona to the prompt (verified to
    // actually steer the model). Interactive with no task gets a benign ack line so
    // the session starts in-persona and then waits for you.
    build({ personaText, task, model, interactive }) {
      const args = [];
      if (!interactive) args.push("exec");
      if (model) args.push("-m", model);
      const prompt = composeCodexPrompt(personaText, task, interactive);
      if (prompt) args.push(prompt);
      return { bin: "codex", args, env: {} };
    },
  },
  claude: {
    bin: "claude",
    install: "npm i -g @anthropic-ai/claude-code",
    // claude (interactive) / claude -p "<task>" (headless). Persona is appended to
    // the system prompt as a string (the always-present `--append-system-prompt`).
    build({ personaText, task, model, interactive }) {
      const args = [];
      if (personaText) args.push("--append-system-prompt", personaText);
      if (model) args.push("--model", model);
      args.push("--add-dir", ".");
      if (interactive) {
        if (task) args.push(task);
      } else {
        args.push("-p", task ?? "");
      }
      return { bin: "claude", args, env: {} };
    },
  },
  gemini: {
    bin: "gemini",
    install: "npm i -g @google/gemini-cli",
    // gemini (interactive) / gemini -p "<task>" (headless). Persona via env var.
    build({ personaFile, task, model, interactive }) {
      const args = [];
      if (model) args.push("-m", model);
      if (!interactive && task) args.push("-p", task);
      return { bin: "gemini", args, env: personaFile ? { GEMINI_SYSTEM_MD: personaFile } : {} };
    },
  },
};

const DEFAULT_BACKEND = "codex";

/** First executable named `bin` on PATH, or null. */
export function onPath(bin) {
  for (const d of (process.env.PATH || "").split(":")) {
    if (!d) continue;
    const p = join(d, bin);
    try {
      accessSync(p, FS.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

const rel = (p) => relative(process.cwd(), p) || p;

/** Build a task prompt from a folded tracker issue (title + body + a marching order). */
export function issueTask(i) {
  const handle = `MC-${i.number ?? "?"}`;
  return [
    `Work on tracker issue ${handle} (${i.category ?? "issue"}, state: ${i.state}): ${i.title}`,
    i.body ? `\n\n${i.body}` : "",
    `\n\nImplement this in the current repo. Keep the change small, tested, and idiomatic.`,
    ` When done, summarize what changed. Do not close or hand off the issue yourself.`,
  ].join("");
}

/**
 * Resolve an issue ref against the repo's tracker fold. The literal `next` picks
 * the top of the agent queue (same ranking as `mind issues next`); anything else
 * is a ULID / MC-N / #N / slug. `actorWebId` lets a claim the agent already holds
 * count as claimable. Read-only — picking `next` here does not claim the issue.
 */
function loadIssue(root, ref, actorWebId = null) {
  const { cfg, epics } = foldTracker(root);
  if (String(ref).toLowerCase() === "next") {
    const queue = agentQueue({ cfg, epics, actorWebId });
    if (!queue.length)
      throw new Error("no claimable agent work — queue is empty (see `mind issues next --all`).");
    return queue[0];
  }
  return resolveIssue(epics, ref); // throws a friendly error if unresolved
}

// ── list ──────────────────────────────────────────────────────────────────────

const list = defineCommand({
  meta: { name: "list", description: "personas in .mind/agents + which backends are installed" },
  args: { ...J },
  run: guard(async () => {
    const loc = locateAgents({ optional: true });
    const personas = loc ? readPersonas(loc.agentsDir) : [];
    const backends = Object.entries(BACKENDS).map(([name, b]) => ({
      name,
      bin: b.bin,
      installed: !!onPath(b.bin),
      default: name === DEFAULT_BACKEND,
    }));
    emit({ agentsDir: loc?.agentsDir ?? null, personas, backends }, () => {
      if (!personas.length) {
        console.log(dim(loc ? `no personas in ${rel(loc.agentsDir)}/ — create <name>.md (frontmatter + system prompt)` : "no .mind/ here — nothing to launch"));
      } else {
        table(
          ["persona", "backend", "description"],
          personas.map((p) => [
            cyan(p.name),
            dim(p.backend ?? DEFAULT_BACKEND),
            p.description || dim("—"),
          ]),
        );
      }
      const line = backends
        .map((b) => `${b.installed ? green(sym.ok) : red(sym.err)} ${b.name}${b.default ? dim(" (default)") : ""}`)
        .join("   ");
      console.log(`\n${dim("backends:")} ${line}`);
    });
  }),
});

// ── start ───────────────────────────────────────────────────────────────────

const start = defineCommand({
  meta: { name: "start", description: "launch a backend with a persona (interactive; -p for headless)" },
  args: {
    persona: { type: "positional", required: true, description: "persona name (file in .mind/agents/)" },
    task: { type: "string", alias: "p", description: "run this task headless and exit (omit for interactive)" },
    issue: { type: "string", alias: "i", description: "load a tracker issue as the task (ULID/MC-N/slug, or `next` for the top of the agent queue)" },
    backend: { type: "string", alias: "b", description: `codex|claude|gemini (default: persona's or ${DEFAULT_BACKEND})` },
    model: { type: "string", alias: "m", description: "model override" },
    "no-persona": { type: "boolean", description: "launch the backend bare without injecting or reading the persona prompt" },
    "dry-run": { type: "boolean", description: "print the resolved backend/argv/task and exit (no spawn)" },
  },
  run: guard(async ({ args, rawArgs }) => {
    const { agentsDir, root } = locateAgents();
    const file = join(agentsDir, `${args.persona}.md`);
    const noPersona = !!args["no-persona"] || rawArgs.includes("--no-persona");
    if (!noPersona && !existsSync(file))
      throw new Error(`no persona "${args.persona}" at ${rel(file)}. List them: mind agents list`);

    const { meta, prompt } = noPersona ? { meta: {}, prompt: undefined } : parsePersona(readFileSync(file, "utf8"));
    const backendName = args.backend || meta.backend || DEFAULT_BACKEND;
    const backend = BACKENDS[backendName];
    if (!backend)
      throw new Error(`unknown backend "${backendName}" (have: ${Object.keys(BACKENDS).join(", ")})`);

    // Active Solid identity (if any) — used both to resolve `--issue next` against
    // the agent's own claims and to pass $MIND_* context to the child below.
    let actorWebId = null;
    try {
      actorWebId = getActive().webId;
    } catch {
      /* no active identity — fine */
    }

    // --issue seeds the task from the repo's tracker fold (loosely coupled: we read
    // the issue body, we don't claim/close it). `--issue next` takes the top of the
    // agent queue. An explicit --task takes precedence.
    let task = args.task;
    let issueRef = null;
    if (args.issue && !task) {
      const i = loadIssue(root, args.issue, actorWebId);
      issueRef = `MC-${i.number ?? "?"}`;
      task = issueTask(i);
    }

    const interactive = !task;
    const model = args.model || meta.model || undefined;
    const { bin, args: argv, env } = backend.build({
      personaFile: noPersona ? undefined : file,
      personaText: noPersona ? undefined : prompt,
      task,
      model,
      interactive,
    });

    if (args["dry-run"]) {
      emit({ backend: backendName, bin, args: argv, env, cwd: root, interactive, issue: issueRef, task }, () => {
        console.log(`${dim("backend")} ${cyan(backendName)}  ${dim("cwd")} ${rel(root) || "."}  ${dim(interactive ? "(interactive)" : "(headless)")}${issueRef ? "  " + dim("issue ") + issueRef : ""}`);
        console.log(`${dim("$")} ${bin} ${argv.join(" ")}`);
        if (task) console.log(`\n${dim("task:")}\n${task}`);
      });
      return;
    }

    if (!onPath(backend.bin))
      throw new Error(`backend "${backendName}" not found on PATH (${backend.bin}). Install: ${backend.install}`);

    // Expose the active Solid identity to the child as context (the backend still
    // authenticates with its own creds — codex/claude login ≠ the mind identity).
    const idEnv = {};
    if (actorWebId) {
      idEnv.MIND_WEBID = actorWebId;
      idEnv.MIND_AUTHOR = actorWebId;
      try {
        const podRoot = getActive().podRoot;
        if (podRoot) idEnv.MIND_POD_ROOT = podRoot;
      } catch {
        /* identity vanished between reads — ignore */
      }
    }

    process.stderr.write(
      `${sym.arrow} ${cyan(backendName)} · ${bold(args.persona)}${issueRef ? " · " + issueRef : ""} ${dim(interactive ? "(interactive)" : "(headless)")} ${dim("in " + (rel(root) || "."))}\n`,
    );

    await new Promise((res) => {
      const child = spawn(bin, argv, {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, ...env, ...idEnv },
      });
      child.on("error", (e) => {
        process.stderr.write(`${sym.err} ${red(`failed to launch ${bin}: ${e.message}`)}\n`);
        process.exitCode = 1;
        res();
      });
      child.on("exit", (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
        res();
      });
    });
  }),
});

export default defineCommand({
  meta: { name: "agents", description: "launch local CLI coding agents (codex/claude/gemini) with per-repo personas" },
  subCommands: { start, list },
});
