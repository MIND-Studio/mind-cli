#!/usr/bin/env node
import { runMain } from "citty";
import { buildMain, diagnoseUnknown } from "../src/cli.mjs";

const main = await buildMain();

// Friendly "did you mean?" before citty's verbose unknown-command dump. Skipped
// for --help/-h/--version so those keep citty's normal output.
const rawArgs = process.argv.slice(2);
const passthrough = rawArgs.includes("--help") || rawArgs.includes("-h") || (rawArgs.length === 1 && rawArgs[0] === "--version");
if (!passthrough) {
  const bad = await diagnoseUnknown(main, rawArgs);
  if (bad) {
    const where = bad.path.join(" ");
    process.stderr.write(`error: unknown command \`${where} ${bad.token}\`\n`);
    if (bad.suggestion) process.stderr.write(`did you mean \`${where} ${bad.suggestion}\`?\n`);
    process.stderr.write(`run \`${where} --help\` to list commands\n`);
    process.exit(1);
  }
}

runMain(main);
