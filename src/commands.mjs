// Core mind commands as citty command definitions (identity + pod I/O + WAC).
// citty gives us typed args, auto-generated --help, and nested subcommands.

import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  listIdentities,
  getIdentity,
  saveIdentity,
  removeIdentity,
  getActiveName,
  setActive,
  getActive,
} from "./store.mjs";
import { loginAs, resolvePodPath, parseContainer, createIdentity, grant as wacGrant } from "./solid.mjs";
import { emit, kv, table, spin, guard, sym, green, dim, cyan, interactive } from "./ui.mjs";

// `--json` is declared on every command so it shows in help; actual behaviour
// is driven by ui.jsonMode (which reads argv), so it works anywhere.
const J = { json: { type: "boolean", description: "machine-readable JSON output" } };

// The store key for an identity: a filesystem- and CLI-safe slug of the handle
// (lowercase, non-alphanumerics → "-", trimmed). Keeps `id create <h>` and
// `id use <h>` symmetric and guarantees no space ever lands in a store filename.
export function slugifyHandle(handle) {
  const slug = String(handle).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "identity";
}

// True for a localhost/loopback/.local issuer. Used to tailor failure guidance:
// a non-local issuer (e.g. the production pod) may have signup gated, so a failed
// `id create` should point at import / local-first rather than a raw error.
export function isLocalIssuer(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local");
  } catch {
    return false;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function withActive(fn) {
  const id = getActive();
  const s = spin(`authenticating as ${id.name} …`);
  let session;
  try {
    session = await loginAs(id);
    s.stop();
  } catch (e) {
    s.fail("auth failed");
    throw e;
  }
  try {
    return await fn(session, id);
  } finally {
    await session.logout();
  }
}

// ── identity subcommands ────────────────────────────────────────────────────
const idCreate = defineCommand({
  meta: { name: "create", description: "mint a WebID + pod + client-credentials" },
  args: {
    handle: { type: "positional", required: true, description: "pod/handle name (e.g. claude)" },
    issuer: { type: "string", description: "OIDC issuer URL (default: $MIND_ISSUER or :3011)" },
    name: { type: "string", description: "display label for the identity (default: handle @ host)" },
    ...J,
  },
  run: guard(async ({ args }) => {
    const issuer = args.issuer || process.env.MIND_ISSUER || "http://localhost:3011/";
    // The store KEY is always the handle (slugified) so `id create X` and
    // `id use X` are symmetric — `--name` is a human display label only, never
    // the lookup key (a label with spaces would yield an un-`use`-able key and
    // a filename with a space). See `slugifyHandle`.
    const name = slugifyHandle(args.handle);
    const s = spin(`creating "${args.handle}" on ${issuer} …`);
    let creds;
    try {
      creds = await createIdentity({ issuer, handle: args.handle });
      s.succeed(`created ${creds.webId}`);
    } catch (e) {
      s.fail("create failed");
      // `id create` assumes the issuer allows open registration. The production
      // pod may gate signup — turn a raw failure into a path forward: adopt an
      // existing creds file, or provision against a local CSS first.
      if (!isLocalIssuer(issuer)) {
        throw new Error(
          `${e.message}\n` +
            `${issuer} may have signup gated. Either:\n` +
            `  • adopt existing creds:  mind id import <creds.json> --name ${name}\n` +
            `  • provision locally first: mind id create ${args.handle} --issuer http://localhost:3011/`,
        );
      }
      throw e;
    }
    creds.label = args.name || `${args.handle} @ ${new URL(issuer).host}`;
    creds.createdAt = new Date().toISOString();
    saveIdentity(name, creds);
    const active = getActiveName() === name;
    emit({ ok: true, name, webId: creds.webId, podRoot: creds.podRoot, active }, () =>
      kv([
        ["WebID", green(creds.webId)],
        ["pod", creds.podRoot],
        ["stored", `${name}${active ? dim(" (active)") : ""}`],
      ]),
    );
  }),
});

const idLs = defineCommand({
  meta: { name: "ls", description: "list stored identities" },
  args: { ...J },
  run: guard(async () => {
    const active = getActiveName();
    const ids = listIdentities().map((n) => {
      const i = getIdentity(n);
      return { name: n, webId: i.webId, issuer: i.issuer, active: n === active };
    });
    emit({ active, identities: ids }, () => {
      if (!ids.length) return console.log(dim("(no identities) — create one: mind id create <handle>"));
      table(
        ["", "name", "webId"],
        ids.map((i) => [i.active ? sym.active : "", i.active ? green(i.name) : i.name, dim(i.webId)]),
      );
    });
  }),
});

const idUse = defineCommand({
  meta: { name: "use", description: "set the active identity" },
  args: { name: { type: "positional", required: false, description: "identity name" }, ...J },
  run: guard(async ({ args }) => {
    let name = args.name;
    if (!name) {
      if (!interactive) throw new Error("usage: mind id use <name>");
      const { select, isCancel } = await import("@clack/prompts");
      const names = listIdentities();
      if (!names.length) throw new Error("no identities yet — mind id create <handle>");
      const picked = await select({
        message: "Pick the active identity",
        options: names.map((n) => ({ value: n, label: n, hint: getIdentity(n).webId })),
        initialValue: getActiveName() ?? names[0],
      });
      if (isCancel(picked)) return;
      name = picked;
    }
    if (!getIdentity(name)) throw new Error(`no identity "${name}"`);
    setActive(name);
    emit({ ok: true, active: name }, () => console.log(`${sym.ok} active identity ${green(name)}`));
  }),
});

const idShow = defineCommand({
  meta: { name: "show", description: "print an identity (secrets redacted)" },
  args: { name: { type: "positional", required: false }, ...J },
  run: guard(async ({ args }) => {
    const id = args.name ? getIdentity(args.name) : getActive();
    if (!id) throw new Error("identity not found");
    const { clientSecret, password, ...safe } = id;
    emit(safe, () => kv(Object.entries(safe).map(([k, v]) => [k, String(v)])));
  }),
});

const idRm = defineCommand({
  meta: { name: "rm", description: "forget an identity (pod is not deleted)" },
  args: { name: { type: "positional", required: true }, ...J },
  run: guard(async ({ args }) => {
    removeIdentity(args.name);
    emit({ ok: true, removed: args.name }, () => console.log(`${sym.ok} removed ${args.name}`));
  }),
});

const idImport = defineCommand({
  meta: { name: "import", description: "adopt an existing creds.json" },
  args: { file: { type: "positional", required: true }, name: { type: "string" }, ...J },
  run: guard(async ({ args }) => {
    const obj = JSON.parse(readFileSync(args.file, "utf8"));
    const name = args.name || (String(obj.webId).match(/^https?:\/\/[^/]+\/([^/]+)\//)?.[1] ?? "identity");
    saveIdentity(name, obj);
    emit({ ok: true, name, webId: obj.webId }, () => console.log(`${sym.ok} imported ${green(name)} ${dim(obj.webId)}`));
  }),
});

const idCmd = defineCommand({
  meta: { name: "id", description: "manage Solid identities (stored in ~/.mind)" },
  subCommands: { create: idCreate, ls: idLs, use: idUse, show: idShow, rm: idRm, import: idImport },
});

// ── top-level core commands ─────────────────────────────────────────────────
const whoami = defineCommand({
  meta: { name: "whoami", description: "show the active identity" },
  args: { ...J },
  run: guard(async () => {
    const id = getActive();
    const s = spin(`authenticating as ${id.name} …`);
    let session;
    try {
      session = await loginAs(id);
      s.stop();
    } catch (e) {
      s.fail("auth failed");
      throw e;
    }
    emit(
      { name: id.name, webId: session.info.webId, podRoot: id.podRoot, issuer: id.issuer, loggedIn: true },
      () =>
        kv([
          ["name", green(id.name)],
          ["webId", session.info.webId],
          ["pod", id.podRoot],
          ["issuer", id.issuer],
        ]),
    );
    await session.logout();
  }),
});

const ls = defineCommand({
  meta: { name: "ls", description: "list a pod container (as the active identity)" },
  args: { path: { type: "positional", required: false, description: "container path or URL (default: pod root)" }, ...J },
  run: guard(({ args }) =>
    withActive(async (s, id) => {
      const url = resolvePodPath(id, args.path ?? "/");
      const res = await s.fetch(url, { headers: { Accept: "text/turtle" } });
      if (!res.ok) throw new Error(`ls ${url} -> ${res.status}`);
      const members = parseContainer(await res.text());
      emit({ container: url, members }, () => {
        if (!members.length) return console.log(dim("(empty)"));
        for (const m of members) console.log(m.endsWith("/") ? cyan(m) : m);
      });
    }),
  ),
});

const cat = defineCommand({
  meta: { name: "cat", description: "print a pod resource" },
  args: { path: { type: "positional", required: true }, ...J },
  run: guard(({ args }) =>
    withActive(async (s, id) => {
      const res = await s.fetch(resolvePodPath(id, args.path));
      if (!res.ok) throw new Error(`cat -> ${res.status}`);
      const body = await res.text();
      emit({ path: resolvePodPath(id, args.path), body }, () => process.stdout.write(body));
    }),
  ),
});

const put = defineCommand({
  meta: { name: "put", description: "write a pod resource (stdin with -, or a file)" },
  args: {
    path: { type: "positional", required: true },
    file: { type: "positional", required: false, description: "file path, or - for stdin" },
    type: { type: "string", default: "text/plain", description: "content-type" },
    ...J,
  },
  run: guard(({ args }) =>
    withActive(async (s, id) => {
      const body = !args.file || args.file === "-" ? await readStdin() : await readFile(args.file, "utf8");
      const url = resolvePodPath(id, args.path);
      const res = await s.fetch(url, { method: "PUT", headers: { "Content-Type": args.type }, body });
      if (!res.ok) throw new Error(`put -> ${res.status} ${await res.text()}`);
      emit({ ok: true, url, status: res.status }, () => console.log(`${sym.ok} PUT ${dim(url)} ${green(res.status)}`));
    }),
  ),
});

const mkdir = defineCommand({
  meta: { name: "mkdir", description: "create a pod container" },
  args: { path: { type: "positional", required: true }, ...J },
  run: guard(({ args }) =>
    withActive(async (s, id) => {
      const url = resolvePodPath(id, args.path).replace(/\/?$/, "/");
      const res = await s.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/turtle", Link: '<http://www.w3.org/ns/ldp#Container>; rel="type"' },
      });
      if (!res.ok && res.status !== 409) throw new Error(`mkdir -> ${res.status}`);
      emit({ ok: true, url, status: res.status }, () => console.log(`${sym.ok} MKDIR ${dim(url)} ${green(res.status)}`));
    }),
  ),
});

const rm = defineCommand({
  meta: { name: "rm", description: "delete a pod resource" },
  args: { path: { type: "positional", required: true }, ...J },
  run: guard(({ args }) =>
    withActive(async (s, id) => {
      const url = resolvePodPath(id, args.path);
      const res = await s.fetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error(`rm -> ${res.status}`);
      emit({ ok: true, url, status: res.status }, () => console.log(`${sym.ok} DELETE ${dim(url)} ${green(res.status)}`));
    }),
  ),
});

const grant = defineCommand({
  meta: { name: "grant", description: "share a pod resource with another WebID (WAC)" },
  args: {
    webid: { type: "positional", required: true, description: "grantee WebID" },
    path: { type: "positional", required: true, description: "pod path to share" },
    modes: { type: "string", default: "r", description: "r=read w=write c=control a=append" },
    ...J,
  },
  run: guard(({ args }) =>
    withActive(async (s, id) => {
      const modes = [...args.modes]
        .map((c) => ({ r: "Read", w: "Write", c: "Control", a: "Append" })[c])
        .filter(Boolean);
      const aclUrl = await wacGrant(s, resolvePodPath(id, args.path), id.webId, args.webid, modes);
      emit({ ok: true, grantee: args.webid, path: args.path, modes, acl: aclUrl }, () =>
        console.log(`${sym.ok} granted ${cyan(modes.join(","))} to ${dim(args.webid)} on ${args.path}`),
      );
    }),
  ),
});

export const coreCommands = { id: idCmd, whoami, ls, cat, put, mkdir, rm, grant };
