// Presentation layer. Everything here auto-degrades to plain text when output
// isn't a TTY, when NO_COLOR is set, or when --json is passed — so the CLI is
// pretty for humans and clean/parseable for agents and pipes.

import pc from "picocolors";
import Table from "cli-table3";
import ora from "ora";

export const jsonMode = process.argv.includes("--json") || process.argv.includes("-j");
const COLOR =
  !jsonMode &&
  !process.env.NO_COLOR &&
  (!!process.stdout.isTTY || process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true");
// Interactive prompts only when both streams are TTYs and we're not emitting JSON.
export const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY && !jsonMode;

const wrap = (fn) => (s) => (COLOR ? fn(String(s)) : String(s));
export const dim = wrap(pc.dim);
export const bold = wrap(pc.bold);
export const green = wrap(pc.green);
export const red = wrap(pc.red);
export const cyan = wrap(pc.cyan);
export const yellow = wrap(pc.yellow);
export const gray = wrap(pc.gray);

export const sym = {
  ok: COLOR ? pc.green("✔") : "ok",
  err: COLOR ? pc.red("✖") : "x",
  active: COLOR ? pc.green("●") : "*",
  arrow: COLOR ? pc.cyan("›") : ">",
  warn: COLOR ? pc.yellow("!") : "!",
};

// Print structured JSON in --json mode, otherwise run the human printer.
export function emit(data, human) {
  if (jsonMode) console.log(JSON.stringify(data, null, 2));
  else human();
}

export function kv(pairs) {
  const w = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) console.log(`  ${dim((k + ":").padEnd(w + 1))} ${v}`);
}

export function table(head, rows) {
  const t = new Table({ head: head.map((h) => bold(h)), style: { head: [], border: [] } });
  rows.forEach((r) => t.push(r));
  console.log(t.toString());
}

export function fail(e) {
  const m = e && e.message ? e.message : String(e);
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: m }));
  else console.error(`${sym.err} ${red(m)}`);
  process.exitCode = 1;
}

// Spinner on stderr so stdout/--json stays clean; a silent no-op when not a TTY.
export function spin(text) {
  if (!COLOR) return { succeed() {}, fail() {}, stop() {}, update() {} };
  const s = ora({ text, stream: process.stderr }).start();
  return {
    succeed: (t) => s.succeed(t && dim(t)),
    fail: (t) => s.fail(t && red(t)),
    stop: () => s.stop(),
    update: (t) => (s.text = t),
  };
}

// Wrap a citty run() so any throw becomes a clean fail() + non-zero exit.
export const guard = (fn) => async (ctx) => {
  try {
    await fn(ctx);
  } catch (e) {
    fail(e);
  }
};

export { pc };
