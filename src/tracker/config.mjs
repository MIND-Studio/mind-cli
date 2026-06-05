// Load + validate `.mind/issues/tracker.config.md`. The YAML frontmatter is the
// authoritative vocab (states, categories, axes, coordination). This mirrors the
// codespaces fold's loadConfig() but ALSO surfaces the axes + coordination keys
// the authoring layer needs (priority values, claim ttl, gate labels) — the fold
// itself ignores those, the CLI's author/validation path does not.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { frontmatter } from "./fold.mjs";

export function loadConfig(issuesDir, rootDir = issuesDir) {
  const configFile = join(issuesDir, "tracker.config.md");
  if (!existsSync(configFile)) throw new Error(`missing ${relative(rootDir, configFile)}`);
  const { data } = frontmatter(readFileSync(configFile, "utf8"), "tracker.config.md");

  for (const k of ["title", "namespace", "initialState", "states", "categories"]) {
    if (data[k] == null) throw new Error(`tracker.config.md: missing required key "${k}"`);
  }

  const states = data.states.map((s) => ({ ...s, label: s.label ?? s.id }));
  const categories = data.categories.map((c) => ({ ...c, label: c.label ?? c.id }));

  if (!states.length) throw new Error("tracker.config.md: at least one state required");
  if (!categories.length) throw new Error("tracker.config.md: at least one category required");
  if (!states.some((s) => s.id === data.initialState))
    throw new Error(`tracker.config.md: initialState "${data.initialState}" is not a declared state`);

  const axes = data.axes ?? {};
  const coordination = data.coordination ?? {};

  return {
    title: data.title,
    description: data.description,
    namespace: data.namespace,
    initialState: data.initialState,
    defaultView: data.defaultView ?? "TableView",
    assigneeClass: data.assigneeClass ?? "foaf:Person",
    allowSubIssues: Boolean(data.allowSubIssues ?? false),
    states,
    categories,
    properties: data.properties ?? [],
    // Author-side vocab (not read by the fold):
    priorities: Array.isArray(axes.priority) ? axes.priority.map(String) : ["urgent", "high", "normal", "low"],
    claimTtl: coordination.claimTtl ?? "PT2H",
    queueGateLabels: Array.isArray(coordination.queueGateLabels)
      ? coordination.queueGateLabels.map(String)
      : [],
  };
}
