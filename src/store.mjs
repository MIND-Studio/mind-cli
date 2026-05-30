// The mind identity store: ~/.mind/identities/<name>.json + ~/.mind/config.json
// (active identity pointer). Each identity holds the long-lived
// client-credentials for one WebID so the CLI can act as it non-interactively.
//
// Secrets live in ~/.mind (chmod 600), outside any git repo — never committed.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";

const ROOT = process.env.MIND_HOME || join(homedir(), ".mind");
const IDS = join(ROOT, "identities");
const CONFIG = join(ROOT, "config.json");

function ensure() {
  mkdirSync(IDS, { recursive: true });
}

export function listIdentities() {
  if (!existsSync(IDS)) return [];
  return readdirSync(IDS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function getIdentity(name) {
  const p = join(IDS, `${name}.json`);
  if (!existsSync(p)) return null;
  const obj = JSON.parse(readFileSync(p, "utf8"));
  obj.name = name;
  return obj;
}

export function saveIdentity(name, obj) {
  ensure();
  const p = join(IDS, `${name}.json`);
  const { name: _ignore, ...rest } = obj;
  writeFileSync(p, JSON.stringify({ ...rest, savedAt: new Date().toISOString() }, null, 2) + "\n");
  chmodSync(p, 0o600);
  if (!getActiveName()) setActive(name);
  return p;
}

export function removeIdentity(name) {
  const p = join(IDS, `${name}.json`);
  if (existsSync(p)) rmSync(p);
  if (getActiveName() === name) {
    const rest = listIdentities();
    setActive(rest[0] ?? null);
  }
}

export function getActiveName() {
  if (!existsSync(CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8")).active ?? null;
  } catch {
    return null;
  }
}

export function setActive(name) {
  ensure();
  writeFileSync(CONFIG, JSON.stringify({ active: name }, null, 2) + "\n");
}

export function getActive() {
  const name = getActiveName();
  if (!name) throw new Error("no active identity. Run `mind id create <handle>` or `mind id use <name>`.");
  const id = getIdentity(name);
  if (!id) throw new Error(`active identity "${name}" not found in the store.`);
  return id;
}

export const STORE_ROOT = ROOT;
