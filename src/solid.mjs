// Solid layer for the mind CLI: resolves the @inrupt auth lib, logs in as a
// stored identity via client-credentials (no browser), does raw pod I/O, mints
// new identities (the CSS v7 account-API dance), and writes WAC grants.
//
// The auth lib is resolved from the CLI's own node_modules if installed,
// otherwise borrowed from a sibling prototype that already has it — so the
// tool works before `npm install` and stays install-free in this workspace.

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "..", ".."); // mind-prototypes/
// Candidate roots that own @inrupt/solid-client-authn-node, in priority order.
const DEP_ROOTS = [
  join(HERE, ".."), // mind-cli itself (after npm install)
  join(WORKSPACE, "mind-codespaces-v0"),
  join(WORKSPACE, "mind-hermes-v0"),
  join(WORKSPACE, "mind-agents-v0"),
];

let _Session = null;
export function getSession() {
  if (_Session) return _Session;
  for (const root of DEP_ROOTS) {
    const pkg = join(root, "package.json");
    const mod = join(root, "node_modules", "@inrupt", "solid-client-authn-node");
    if (existsSync(mod) && existsSync(pkg)) {
      const require = createRequire(pkg);
      _Session = require("@inrupt/solid-client-authn-node").Session;
      return _Session;
    }
  }
  throw new Error(
    "could not find @inrupt/solid-client-authn-node. Run `npm install` in mind-cli/, " +
      "or keep a sibling prototype (mind-codespaces-v0) with its deps installed.",
  );
}

export async function loginAs(identity) {
  const Session = getSession();
  const session = new Session();
  await session.login({
    oidcIssuer: identity.issuer,
    clientId: identity.clientId,
    clientSecret: identity.clientSecret,
    tokenType: "DPoP",
  });
  if (!session.info.isLoggedIn) {
    throw new Error(
      `login failed for ${identity.name} — is CSS up at ${identity.issuer}? (creds may be stale if .css-data was wiped)`,
    );
  }
  return session;
}

export function resolvePodPath(identity, path) {
  if (!path || path === "/" || path === ".") return identity.podRoot;
  if (/^https?:\/\//.test(path)) return path;
  return identity.podRoot.replace(/\/$/, "/") + String(path).replace(/^\//, "");
}

export function parseContainer(ttl) {
  // CSS serialises members as the object list of `ldp:contains` (often
  // relative IRIs, comma-separated): `<> ldp:contains <a>, <b/>, <c>.`
  // Grab the whole object list (up to the statement terminator) then pull
  // every <…> from it — so multi-member lists aren't truncated.
  const out = new Set();
  // Match the contains predicate, then the comma-separated <iri> object list
  // itself (so a '.' inside a filename like manifest.json can't terminate it).
  const pred = /(?:ldp:contains|<http:\/\/www\.w3\.org\/ns\/ldp#contains>)\s+((?:<[^>]+>\s*,?\s*)+)/g;
  let m;
  while ((m = pred.exec(ttl))) {
    for (const u of m[1].matchAll(/<([^>]+)>/g)) out.add(u[1]);
  }
  return [...out].filter(Boolean);
}

// ── identity creation (CSS v7 "version 0.5" account API) ──────────────────
function pick(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return typeof cur === "string" ? cur : undefined;
}
function cookieFrom(res, name) {
  const get = res.headers.getSetCookie?.bind(res.headers);
  for (const line of get ? get() : []) {
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
    const rest = line.slice(eq + 1);
    const semi = rest.indexOf(";");
    return `${name}=${(semi < 0 ? rest : rest.slice(0, semi)).trim()}`;
  }
  return null;
}
async function jget(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

export async function createIdentity({ issuer, handle, email, password, credName }) {
  issuer = issuer.replace(/\/?$/, "/");
  email ??= `${handle}@mind.local`;
  password ??= randomBytes(18).toString("base64url");
  credName ??= `${handle}-cli`;

  const idx = await jget(`${issuer}.account/`);
  const createUrl = pick(idx, ["controls", "account", "create"]);
  if (!createUrl) throw new Error("CSS did not advertise account.create");
  const r1 = await fetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  if (!r1.ok) throw new Error(`account create -> ${r1.status}`);
  const cookie = cookieFrom(r1, "css-account");
  if (!cookie) throw new Error("no css-account cookie returned");

  const ctrl = await jget(`${issuer}.account/`, { Cookie: cookie });
  const pwCreate = pick(ctrl, ["controls", "password", "create"]);
  const podCreate = pick(ctrl, ["controls", "account", "pod"]);
  const loginUrl = pick(ctrl, ["controls", "password", "login"]);
  if (!pwCreate || !podCreate || !loginUrl) throw new Error("missing password/pod controls");

  const r2 = await fetch(pwCreate, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: cookie },
    body: JSON.stringify({ email, password }),
  });
  if (!r2.ok) throw new Error(`password.create -> ${r2.status} ${await r2.text()}`);

  const r3 = await fetch(podCreate, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: cookie },
    body: JSON.stringify({ name: handle }),
  });
  if (!r3.ok) throw new Error(`account.pod -> ${r3.status} ${await r3.text()}`);
  const podBody = await r3.json();
  const webId = podBody.webId ?? `${issuer}${handle}/profile/card#me`;
  const podRoot = podBody.pod ?? `${issuer}${handle}/`;

  const lr = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!lr.ok) throw new Error(`password login -> ${lr.status}`);
  const { authorization } = await lr.json();

  const authed = await jget(`${issuer}.account/`, { Authorization: `CSS-Account-Token ${authorization}` });
  const ccUrl = pick(authed, ["controls", "account", "clientCredentials"]);
  if (!ccUrl) throw new Error("CSS did not advertise account.clientCredentials");
  const cr = await fetch(ccUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `CSS-Account-Token ${authorization}`,
    },
    body: JSON.stringify({ name: credName, webId }),
  });
  if (!cr.ok) throw new Error(`clientCredentials -> ${cr.status} ${await cr.text()}`);
  const { id, secret } = await cr.json();

  return { issuer, webId, podRoot, email, password, clientId: id, clientSecret: secret, credName };
}

// ── WAC grant ─────────────────────────────────────────────────────────────
export async function grant(session, resourceUrl, ownerWebId, granteeWebId, modes) {
  const aclUrl = resourceUrl.replace(/\/?$/, "/") + ".acl";
  const modeStr = modes.map((m) => `acl:${m}`).join(", ");
  // Owner keeps full control (scoped to the owner's WebID, never a broad
  // agentClass); the grantee gets exactly the requested modes.
  const body = `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#owner> a acl:Authorization ;
    acl:agent <${ownerWebId}> ;
    acl:accessTo <./> ; acl:default <./> ;
    acl:mode acl:Read, acl:Write, acl:Control .
<#grant> a acl:Authorization ;
    acl:agent <${granteeWebId}> ;
    acl:accessTo <./> ; acl:default <./> ;
    acl:mode ${modeStr} .
`;
  const res = await session.fetch(aclUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/turtle" },
    body,
  });
  if (!res.ok) throw new Error(`grant PUT ${aclUrl} -> ${res.status} ${await res.text()}`);
  return aclUrl;
}
