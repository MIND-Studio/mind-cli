// Assemble the `mind` root command: core commands + auto-loaded plugins.
// Each plugin in ../plugins/*.mjs default-exports a citty command; its filename
// (sans .mjs) becomes the command group name (e.g. plugins/codespaces.mjs → `mind codespaces`).

import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { coreCommands } from "./commands.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

async function loadPlugins() {
  const dir = join(HERE, "..", "plugins");
  const map = {};
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".mjs"));
  } catch {
    return map;
  }
  for (const f of files) {
    const cmd = (await import(join(dir, f))).default;
    if (cmd?.run || cmd?.subCommands) map[f.replace(/\.mjs$/, "")] = cmd;
  }
  return map;
}

export async function buildMain() {
  const plugins = await loadPlugins();
  return defineCommand({
    meta: {
      name: "mind",
      version: PKG.version,
      description: "Solid identities + pod ops + Mind prototypes, from the terminal",
    },
    subCommands: { ...coreCommands, ...plugins },
  });
}
