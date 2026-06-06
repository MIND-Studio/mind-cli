// `mind codespaces …` — drives the mind-codespaces bridge (the Solid Git
// bridge) as the active identity, via the dev-auth header (X-Mind-Dev-WebId),
// honoured by the bridge when not in production.
//
// A plugin default-exports a citty command; its filename becomes the group name.

import { defineCommand } from "citty";
import { getActive } from "../src/store.mjs";
import { emit, table, spin, guard, sym, green, dim, cyan, yellow } from "../src/ui.mjs";

const BRIDGE = process.env.BRIDGE_URL || "http://localhost:3010";
const J = { json: { type: "boolean", description: "machine-readable JSON output" } };

// The bridge only honours the dev-auth header (X-Mind-Dev-WebId) outside
// production, so codespaces authenticates only against a *local* bridge. A
// non-local BRIDGE_URL (e.g. codespaces.mindpods.org) will reject these calls
// until real OIDC is wired — warn once (to stderr, so --json stdout stays clean)
// rather than letting it fail with a cryptic 401/403.
export function isLocalBridge(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local");
  } catch {
    return false;
  }
}
let warnedRemote = false;
function warnIfRemoteBridge() {
  if (warnedRemote || isLocalBridge(BRIDGE)) return;
  warnedRemote = true;
  process.stderr.write(
    `${sym.warn} ${yellow("codespaces uses dev-auth")} (X-Mind-Dev-WebId), which a production bridge does not honour.\n` +
      `  ${dim(BRIDGE)} will likely reject these calls until real OIDC is wired.\n` +
      `  This command currently works only against a local bridge ${dim("(BRIDGE_URL=http://localhost:3010)")}.\n`,
  );
}

function ownerOf(id) {
  const m = id.webId.match(/^https?:\/\/[^/]+\/([^/]+)\//);
  if (!m) throw new Error(`cannot derive owner slug from WebID ${id.webId}`);
  return m[1];
}

async function api(path, id, init = {}) {
  warnIfRemoteBridge();
  const res = await fetch(`${BRIDGE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Mind-Dev-WebId": id.webId,
      ...(init.headers || {}),
    },
  }).catch((e) => {
    throw new Error(`bridge unreachable at ${BRIDGE} (${e.message}). Start it: cd codespaces && npm run dev`);
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${(body && body.error) || text}`);
  return body;
}

const repos = defineCommand({
  meta: { name: "repos", description: "list your repos" },
  args: { ...J },
  run: guard(async () => {
    const id = getActive();
    const owner = ownerOf(id);
    const s = spin("fetching repos …");
    let list;
    try {
      list = await api("/api/repos", id);
      s.stop();
    } catch (e) {
      s.fail("bridge error");
      throw e;
    }
    const all = (Array.isArray(list) ? list : list?.repos ?? []).filter((r) => (r.owner ?? owner) === owner);
    emit({ repos: all }, () => {
      if (!all.length) return console.log(dim(`no repos for ${owner} — mind codespaces new <name>`));
      table(
        ["repo", "visibility"],
        all.map((r) => [`${green(owner)}/${r.name}`, r.visibility === "private" ? cyan(r.visibility) : dim(r.visibility ?? "?")]),
      );
    });
  }),
});

const create = defineCommand({
  meta: { name: "new", description: "create a repo (returns the git clone URL)" },
  args: {
    name: { type: "positional", required: true, description: "repo name" },
    private: { type: "boolean", description: "make it private" },
    ...J,
  },
  run: guard(async ({ args }) => {
    const id = getActive();
    const owner = ownerOf(id);
    const visibility = args.private ? "private" : "public";
    const s = spin(`creating ${owner}/${args.name} …`);
    let created;
    try {
      created = await api("/api/repos", id, {
        method: "POST",
        body: JSON.stringify({ owner, name: args.name, ownerWebId: id.webId, ownerPodRoot: id.podRoot, visibility }),
      });
      s.succeed(`created ${owner}/${args.name}`);
    } catch (e) {
      s.fail("create failed");
      throw e;
    }
    emit({ ok: true, owner, name: args.name, visibility, cloneUrl: created?.cloneUrl }, () => {
      console.log(`${sym.ok} ${green(`${owner}/${args.name}`)} ${dim(`[${visibility}]`)}`);
      if (created?.cloneUrl) console.log(`  ${dim("clone")} ${created.cloneUrl}`);
    });
  }),
});

const token = defineCommand({
  meta: { name: "token", description: "mint a git push token for a repo" },
  args: {
    repo: { type: "positional", required: true, description: "repo name" },
    label: { type: "string", description: "token label" },
    ...J,
  },
  run: guard(async ({ args }) => {
    const id = getActive();
    const owner = ownerOf(id);
    const out = await api(`/api/repos/${owner}/${args.repo}/tokens`, id, {
      method: "POST",
      body: JSON.stringify({ label: args.label || `${id.name ?? owner}-cli` }),
    });
    const tok = typeof out === "string" ? out : out?.token ?? out?.secret;
    const u = new URL(BRIDGE);
    const pushUrl = `${u.protocol}//x:${tok ?? "<token>"}@${u.host}/api/git/${owner}/${args.repo}.git`;
    emit({ ok: true, token: tok, pushUrl }, () => {
      console.log(tok ?? JSON.stringify(out));
      console.log(dim(`# git push ${pushUrl} main`));
    });
  }),
});

export default defineCommand({
  meta: { name: "codespaces", description: "drive the Solid Git bridge — list/create repos, mint push tokens" },
  subCommands: { repos, new: create, token },
});
