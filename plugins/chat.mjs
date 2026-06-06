// `mind chat …` — post to and tail a Solid long-chat room as the active
// identity. Same `~/.mind` WebID you drive with `mind ls / put / grant`, so the
// CLI's chat voice and its pod are one identity.
//
// Self-contained raw fetch + turtle (no @inrupt/solid-client) to match the rest
// of the CLI (src/solid.mjs). The room is a SolidOS long-chat: messages live in
// day files at <room>/<yyyy>/<MM>/<dd>/chat.ttl using the meeting/sioc/foaf/dct
// vocab. Mirrors chat/scripts/chat-agent.ts and src/lib/solid/chat.ts.
//
// A plugin default-exports a citty command; its filename becomes the group name.

import { defineCommand } from "citty";
import { randomBytes } from "node:crypto";
import { statSync, openSync, readSync, closeSync, watch as fsWatch, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getActive, STORE_ROOT } from "../src/store.mjs";
import { loginAs } from "../src/solid.mjs";
import { emit, table, spin, guard, sym, green, dim, cyan, yellow } from "../src/ui.mjs";

const DEFAULT_ROOM = "https://pod.mindpods.org/testuser/chat/general";
const ROOM_ARG = { room: { type: "string", description: "room container URL (default: testuser/general)" } };
const J = { json: { type: "boolean", description: "machine-readable JSON output" } };

const POLL_INTERVAL_MS = Number(process.env.MIND_CHAT_POLL_MS) || 5_000;

// ── long-chat addressing & vocab (mirror src/lib/solid/chat.ts) ─────────────
const MEETING_LONG_CHAT = "http://www.w3.org/ns/pim/meeting#LongChat";
const MEETING_MESSAGE = "http://www.w3.org/ns/pim/meeting#message";
const SIOC_CONTENT = "http://rdfs.org/sioc/ns#content";
const FOAF_MAKER = "http://xmlns.com/foaf/0.1/maker";
const DCT_CREATED = "http://purl.org/dc/terms/created";
const SCHEMA_DATE_DELETED = "http://schema.org/dateDeleted";
const XSD_DATETIME = "http://www.w3.org/2001/XMLSchema#dateTime";

function roomUrl(args) {
  return String(args.room || process.env.MIND_CHAT_ROOM || DEFAULT_ROOM).replace(/\/$/, "");
}

function utcParts(d) {
  return {
    y: String(d.getUTCFullYear()),
    m: String(d.getUTCMonth() + 1).padStart(2, "0"),
    day: String(d.getUTCDate()).padStart(2, "0"),
  };
}
function dayContainerUrl(room, d = new Date()) {
  const { y, m, day } = utcParts(d);
  return `${room}/${y}/${m}/${day}/`;
}
function dayFileUrl(room, d = new Date()) {
  return `${dayContainerUrl(room, d)}chat.ttl`;
}

// First path segment of a WebID is the handle: https://pod/<handle>/profile/card#me
function handleOf(webId) {
  const m = String(webId || "").match(/^https?:\/\/[^/]+\/([^/]+)\//);
  return m ? m[1] : String(webId || "?");
}

// ── turtle helpers (read: copied from chat-agent.ts; write: sparql-update) ──
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Decode turtle string escapes in one pass: \uXXXX / \UXXXXXXXX (CSS emits
// non-ASCII this way, e.g. emoji) plus the usual \" \\ \n \r \t.
function unescapeTtl(s) {
  return s.replace(/\\(U[0-9A-Fa-f]{8}|u[0-9A-Fa-f]{4}|.)/g, (_, esc) => {
    const c = esc[0];
    if (c === "u" || c === "U") return String.fromCodePoint(parseInt(esc.slice(1), 16));
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    return c; // \" \\ \' and any other escaped char → the char itself
  });
}
function extractString(block, iri) {
  const re = new RegExp(`<${escapeRe(iri)}>\\s+"((?:\\\\.|[^"\\\\])*)"`, "m");
  const m = re.exec(block);
  if (m?.[1] == null) return null;
  return unescapeTtl(m[1]);
}
function extractObject(block, iri) {
  const re = new RegExp(`<${escapeRe(iri)}>\\s+<([^>]+)>`, "m");
  return re.exec(block)?.[1] ?? null;
}
function extractDatetime(block, iri) {
  const re = new RegExp(`<${escapeRe(iri)}>\\s+"([^"]+)"\\^\\^`, "m");
  return re.exec(block)?.[1] ?? null;
}

// Escape a JS string for a turtle/SPARQL double-quoted literal.
function ttlString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

// Parse a day file's raw turtle into messages, oldest first.
function parseMessages(dayUrl, text) {
  const out = [];
  for (const chunk of text.split(/(?=<#msg-)/)) {
    if (!chunk.startsWith("<#msg-")) continue;
    const fragEnd = chunk.indexOf(">");
    if (fragEnd < 0) continue;
    const url = `${dayUrl}${chunk.slice(1, fragEnd)}`;
    const body = extractString(chunk, SIOC_CONTENT);
    const author = extractObject(chunk, FOAF_MAKER);
    const createdAt = extractDatetime(chunk, DCT_CREATED);
    if (!body || !author || !createdAt) continue;
    if (extractDatetime(chunk, SCHEMA_DATE_DELETED)) continue; // soft-deleted (mind chat rm)
    out.push({ url, body, author, createdAt });
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

// Raw turtle GET of today's day file; [] on 404/empty.
async function fetchToday(session, room) {
  const dayUrl = dayFileUrl(room);
  const res = await session.fetch(dayUrl, { headers: { accept: "text/turtle" } });
  if (res.status === 404) return { dayUrl, messages: [] };
  if (!res.ok) throw new Error(`GET ${dayUrl} -> ${res.status}`);
  return { dayUrl, messages: parseMessages(dayUrl, await res.text()) };
}

// Idempotently create today's empty channel doc (CSS auto-makes parent dirs on PUT).
async function ensureTodayFile(session, room) {
  const dayUrl = dayFileUrl(room);
  const head = await session.fetch(dayUrl, { method: "HEAD" });
  if (head.ok) return dayUrl;
  const body = `<#this> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${MEETING_LONG_CHAT}> .\n`;
  const res = await session.fetch(dayUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/turtle" },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${dayUrl} -> ${res.status} ${await res.text()}`);
  return dayUrl;
}

function newMsgId() {
  return `${Date.now().toString(16)}-${randomBytes(6).toString("hex")}`;
}

// Append one message to today's day file on an already-authenticated session.
// Returns the message URL. Caller owns login + ensureTodayFile lifecycle.
async function postOne(session, room, webId, body) {
  const dayUrl = dayFileUrl(room);
  const msgId = newMsgId();
  const createdAt = new Date().toISOString();
  const patch =
    `INSERT DATA {\n` +
    `  <#this> <${MEETING_MESSAGE}> <#msg-${msgId}> .\n` +
    `  <#msg-${msgId}> <${SIOC_CONTENT}> "${ttlString(body)}" ;\n` +
    `    <${FOAF_MAKER}> <${webId}> ;\n` +
    `    <${DCT_CREATED}> "${createdAt}"^^<${XSD_DATETIME}> .\n` +
    `}\n`;
  const res = await session.fetch(dayUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/sparql-update" },
    body: patch,
  });
  if (!res.ok) throw new Error(`PATCH ${dayUrl} -> ${res.status} ${await res.text()}`);
  return `${dayUrl}#msg-${msgId}`;
}

// Subscribe to the day file via WebSocketChannel2023 and call onMsg on each
// push. Returns the WebSocket (or null). Logs state to stderr so stdout stays a
// clean event stream. Poll is always the fallback at the call site.
async function openWs(session, dayUrl, onMsg) {
  if (typeof WebSocket !== "function") return null;
  try {
    const origin = new URL(dayUrl).origin;
    const subRes = await session.fetch(`${origin}/.notifications/WebSocketChannel2023/`, {
      method: "POST",
      headers: { "content-type": "application/ld+json" },
      body: JSON.stringify({
        "@context": ["https://www.w3.org/ns/solid/notification/v1"],
        type: "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023",
        topic: dayUrl,
      }),
    });
    if (!subRes.ok) {
      process.stderr.write(`${sym.warn} ${yellow(`ws subscribe -> ${subRes.status}, poll only`)}\n`);
      return null;
    }
    const { receiveFrom } = await subRes.json();
    if (!receiveFrom) return null;
    const ws = new WebSocket(receiveFrom);
    ws.addEventListener("open", () => process.stderr.write(`${sym.arrow} ${dim("ws push connected")}\n`));
    ws.addEventListener("message", () => void onMsg());
    ws.addEventListener("error", () => process.stderr.write(`${sym.warn} ${yellow("ws error — falling back to poll")}\n`));
    return ws;
  } catch {
    return null; // WS optional — polling covers it.
  }
}

// Live inbound engine shared by `watch` and `connect`: seeds quietly, prints
// each new message via onLine, holds a WebSocket push, and — crucially —
// re-subscribes when the UTC day rolls over (the day file changes at midnight).
// getSession() returns the current session (connect rotates it). Call tick() on
// the poll interval: it rolls the day if needed, then polls as the WS fallback.
function createInbound(getSession, room, onLine) {
  const seen = new Set();
  let dayUrl = dayFileUrl(room);
  let ws = null;

  async function pollOnce(quiet = false) {
    let messages;
    try {
      ({ messages } = await fetchToday(getSession(), room));
    } catch (e) {
      process.stderr.write(`${sym.warn} ${yellow(`poll error: ${e.message}`)}\n`);
      return;
    }
    for (const m of messages) {
      if (seen.has(m.url)) continue;
      seen.add(m.url);
      if (!quiet) onLine(m);
    }
  }

  // (Re)open the WS for the current day file — also used after a session rotation.
  async function subscribe() {
    try { ws?.close(); } catch {}
    ws = await openWs(getSession(), dayUrl, pollOnce);
  }

  async function tick() {
    const d = dayFileUrl(room);
    if (d !== dayUrl) {
      dayUrl = d; // UTC midnight rollover → new day file
      await ensureTodayFile(getSession(), room).catch(() => {});
      await subscribe();
      process.stderr.write(`${sym.arrow} ${dim(`rolled to ${dayUrl}`)}\n`);
    }
    await pollOnce();
  }

  return {
    get dayUrl() { return dayUrl; },
    pollOnce,
    subscribe,
    tick,
  };
}

// ── commands ────────────────────────────────────────────────────────────────

const whoami = defineCommand({
  meta: { name: "whoami", description: "show the active identity and resolved room" },
  args: { ...ROOM_ARG, ...J },
  run: guard(async ({ args }) => {
    const id = getActive();
    const room = roomUrl(args);
    emit(
      { ok: true, identity: id.name, webId: id.webId, handle: handleOf(id.webId), room, dayFile: dayFileUrl(room) },
      () => {
        console.log(`${sym.active} ${green(id.name)} ${dim(`@${handleOf(id.webId)}`)}`);
        console.log(`  ${dim("webId")} ${id.webId}`);
        console.log(`  ${dim("room ")} ${cyan(room)}`);
        console.log(`  ${dim("today")} ${dim(dayFileUrl(room))}`);
      },
    );
  }),
});

const say = defineCommand({
  meta: { name: "say", description: "post a message to the room" },
  args: {
    message: { type: "positional", required: true, description: "message text" },
    ...ROOM_ARG,
    ...J,
  },
  run: guard(async ({ args }) => {
    // citty collects every positional into args._; rejoin so an unquoted
    // multi-word message (`chat say hello there`) works as well as a quoted one.
    const body = (Array.isArray(args._) && args._.length ? args._.join(" ") : String(args.message || "")).trim();
    if (!body) throw new Error('usage: mind chat say "your message"');

    const id = getActive();
    const room = roomUrl(args);
    const s = spin(`posting as ${id.name} …`);
    let session;
    try {
      session = await loginAs(id);
      await ensureTodayFile(session, room);
      const url = await postOne(session, room, id.webId, body);
      s.succeed("posted");
      emit({ ok: true, url, room }, () => {
        console.log(`${sym.ok} ${dim(handleOf(id.webId))} ${green(body)}`);
        console.log(`  ${dim(url)}`);
      });
    } catch (e) {
      s.fail("post failed");
      throw e;
    } finally {
      if (session) await session.logout();
    }
  }),
});

function renderMessages(messages, selfWebId) {
  if (!messages.length) return console.log(dim("no messages today"));
  table(
    ["time", "who", "message"],
    messages.map((m) => {
      const t = m.createdAt.slice(11, 19);
      const h = handleOf(m.author);
      const who = m.author === selfWebId ? green(h) : cyan(h);
      return [dim(t), who, m.body.replace(/\n/g, " ")];
    }),
  );
}

const read = defineCommand({
  meta: { name: "read", description: "list today's messages" },
  args: { ...ROOM_ARG, ...J },
  run: guard(async ({ args }) => {
    const id = getActive();
    const room = roomUrl(args);
    const s = spin("reading …");
    let session;
    try {
      session = await loginAs(id);
      const { messages } = await fetchToday(session, room);
      s.stop();
      emit({ room, messages }, () => renderMessages(messages, id.webId));
    } catch (e) {
      s.fail("read failed");
      throw e;
    } finally {
      if (session) await session.logout();
    }
  }),
});

const watch = defineCommand({
  meta: { name: "watch", description: "live-tail the room (Ctrl-C to stop)" },
  args: { ...ROOM_ARG },
  run: guard(async ({ args }) => {
    const id = getActive();
    const room = roomUrl(args);
    const me = id.webId;
    const session = await loginAs(id);

    const printLine = (m) => {
      const t = m.createdAt.slice(11, 19);
      const h = handleOf(m.author);
      const who = m.author === me ? green(h) : cyan(h);
      console.log(`${dim(t)} ${who} ${m.body.replace(/\n/g, " ")}`);
    };
    const inbound = createInbound(() => session, room, printLine);

    // Seed quietly so we don't replay history, then announce + tail.
    await inbound.pollOnce(true);
    console.log(`${sym.arrow} ${dim(`watching ${inbound.dayUrl} as @${handleOf(me)} — Ctrl-C to stop`)}`);

    await inbound.subscribe(); // WS push; tick() is the poll + day-rollover fallback
    setInterval(() => void inbound.tick(), POLL_INTERVAL_MS);
    await new Promise(() => {}); // run until Ctrl-C
  }),
});

const ROTATE_SESSION_MS = 10 * 60_000; // re-login under the CSS token TTL
const OUTBOX_POLL_MS = 250;

const connect = defineCommand({
  meta: {
    name: "connect",
    description: "hold one session: stream inbound to stdout, post lines appended to an outbox file (low-latency agent loop)",
  },
  args: {
    ...ROOM_ARG,
    outbox: { type: "string", description: "file to read outgoing messages from (one per line); default ~/.mind/chat-outbox" },
  },
  run: guard(async ({ args }) => {
    const id = getActive();
    const room = roomUrl(args);
    const me = id.webId;
    const outbox = args.outbox || join(STORE_ROOT, "chat-outbox");

    // One login, reused for both directions — no per-message OIDC round-trip.
    let session = await loginAs(id);
    await ensureTodayFile(session, room);

    // Inbound prints plain lines (parseable by a monitor); getSession() lets the
    // engine follow session rotation below.
    const printLine = (m) =>
      console.log(`${m.createdAt.slice(11, 19)} ${handleOf(m.author)} ${m.body.replace(/\n/g, " ")}`);
    const inbound = createInbound(() => session, room, printLine);

    // Outbound: tail the outbox file by byte offset; each complete line is one
    // message posted on the held session. Appending a line == an instant send.
    if (!existsSync(outbox)) writeFileSync(outbox, "");
    let outOffset = statSync(outbox).size; // skip pre-existing content
    let partial = "";
    let draining = false;
    async function drainOutbox() {
      if (draining) return;
      draining = true;
      try {
        let size;
        try { size = statSync(outbox).size; } catch { return; }
        if (size < outOffset) { outOffset = 0; partial = ""; } // truncated/rotated
        if (size === outOffset) return;
        const fd = openSync(outbox, "r");
        const len = size - outOffset;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, outOffset);
        closeSync(fd);
        outOffset = size;
        partial += buf.toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop() ?? ""; // keep any trailing partial line
        for (const line of lines) {
          const body = line.trim();
          if (!body) continue;
          try {
            const url = await postOne(session, room, me, body);
            process.stderr.write(`${sym.ok} ${dim(`sent ${url}`)}\n`);
          } catch (e) {
            process.stderr.write(`${sym.warn} ${yellow(`send failed: ${e.message}`)}\n`);
          }
        }
      } finally {
        draining = false;
      }
    }

    // Keep the held session under the CSS token TTL; re-login + reopen WS on the
    // new session (the inbound engine subscribes via getSession()).
    async function rotate() {
      try {
        const next = await loginAs(id);
        const old = session;
        session = next;
        await old.logout().catch(() => {});
        await inbound.subscribe();
        process.stderr.write(`${sym.arrow} ${dim("session rotated")}\n`);
      } catch (e) {
        process.stderr.write(`${sym.warn} ${yellow(`rotate failed: ${e.message}`)}\n`);
      }
    }

    await inbound.pollOnce(true); // seed quietly
    process.stderr.write(`${sym.arrow} ${dim(`connected to ${inbound.dayUrl} as @${handleOf(me)} — outbox ${outbox}`)}\n`);

    await inbound.subscribe();
    try { fsWatch(outbox, () => void drainOutbox()); } catch {} // best-effort instant pickup
    setInterval(() => void inbound.tick(), POLL_INTERVAL_MS); // inbound poll + day rollover
    setInterval(() => void drainOutbox(), OUTBOX_POLL_MS); // outbound fallback
    setInterval(() => void rotate(), ROTATE_SESSION_MS);
    await new Promise(() => {}); // run until killed
  }),
});

const rm = defineCommand({
  meta: { name: "rm", description: "delete a message by its URL (soft-delete: marks it as removed)" },
  args: {
    url: { type: "positional", required: true, description: "message URL, e.g. …/chat.ttl#msg-…" },
    ...J,
  },
  run: guard(async ({ args }) => {
    const url = String(args.url || "");
    const hash = url.indexOf("#msg-");
    if (hash < 0) throw new Error("expected a message URL like …/chat.ttl#msg-…");
    const dayUrl = url.slice(0, hash);
    const frag = url.slice(hash); // #msg-…  (relative IRI, resolved against dayUrl)
    const id = getActive();
    let session;
    try {
      session = await loginAs(id);
      // Soft-delete: append a schema:dateDeleted marker (matches the web app and,
      // unlike removing triples, only needs acl:Append — which shared rooms grant).
      // `read` then hides marked messages. Hard delete needs acl:Write (room owner).
      const patch =
        `INSERT DATA { <${frag}> <${SCHEMA_DATE_DELETED}> "${new Date().toISOString()}"^^<${XSD_DATETIME}> . }\n`;
      const res = await session.fetch(dayUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/sparql-update" },
        body: patch,
      });
      if (!res.ok) throw new Error(`PATCH ${dayUrl} -> ${res.status} ${await res.text()}`);
      emit({ ok: true, deleted: url }, () => console.log(`${sym.ok} ${dim("marked deleted")} ${dim(url)}`));
    } finally {
      if (session) await session.logout();
    }
  }),
});

export default defineCommand({
  meta: { name: "chat", description: "post to and tail a Solid long-chat room as the active identity" },
  subCommands: { whoami, say, read, watch, connect, rm },
});

// Named exports for unit tests — the pure, network-free helpers.
export { dayFileUrl, dayContainerUrl, handleOf, ttlString, unescapeTtl, parseMessages };
