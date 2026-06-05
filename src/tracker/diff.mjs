// Minimal, dependency-free line-level diff for `mind issues build --check`.
// Standard LCS over lines, emitted unified-style with a few lines of context so
// a drift report points at *what* changed, not just *which file* changed.

/** LCS length matrix (dp[i][j] = LCS of a[i..], b[j..]). */
function lcsMatrix(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp;
}

/** Sequence of {t: eq|del|add, line} ops turning `a` into `b`. */
function diffOps(a, b) {
  const dp = lcsMatrix(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ t: "eq", line: a[i++], j: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "del", line: a[i++] });
    else ops.push({ t: "add", line: b[j++] });
  }
  while (i < a.length) ops.push({ t: "del", line: a[i++] });
  while (j < b.length) ops.push({ t: "add", line: b[j++] });
  return ops;
}

/**
 * Unified-style diff of two strings. Returns "" when equal. `context` lines of
 * unchanged text flank each change; collapsed runs are marked with "…".
 */
export function unifiedDiff(aText, bText, { context = 2 } = {}) {
  const a = aText.length ? aText.split("\n") : [];
  const b = bText.length ? bText.split("\n") : [];
  const ops = diffOps(a, b);
  if (ops.every((o) => o.t === "eq")) return "";

  // Keep every change plus `context` unchanged lines on either side.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.t === "eq") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });

  const out = [];
  let prevKept = -2;
  ops.forEach((o, idx) => {
    if (!keep[idx]) return;
    if (out.length && idx !== prevKept + 1) out.push("  …");
    prevKept = idx;
    const sign = o.t === "del" ? "-" : o.t === "add" ? "+" : " ";
    out.push(`${sign} ${o.line}`);
  });
  return out.join("\n");
}
