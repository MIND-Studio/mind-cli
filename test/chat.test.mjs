// Tests for the chat plugin's pure, network-free helpers (plugins/chat.mjs).
// node:test, no deps.
//   node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayFileUrl,
  dayContainerUrl,
  handleOf,
  ttlString,
  unescapeTtl,
  parseMessages,
} from "../plugins/chat.mjs";

test("dayFileUrl/dayContainerUrl: UTC-partitioned path, room trailing slash stripped", () => {
  const d = new Date("2026-06-05T20:03:47.436Z");
  const room = "https://pods.mindpods.org/testuser/chat/general";
  assert.equal(dayContainerUrl(room, d), `${room}/2026/06/05/`);
  assert.equal(dayFileUrl(room, d), `${room}/2026/06/05/chat.ttl`);
  // Single-digit month/day are zero-padded; uses UTC, not local time.
  const jan = new Date("2026-01-09T00:30:00.000Z");
  assert.equal(dayFileUrl(room, jan), `${room}/2026/01/09/chat.ttl`);
});

test("handleOf: first WebID path segment is the handle", () => {
  assert.equal(handleOf("https://pods.mindpods.org/mind-agent-01/profile/card#me"), "mind-agent-01");
  assert.equal(handleOf("http://localhost:3031/alice/profile/card#me"), "alice");
  assert.equal(handleOf(""), "?");
});

test("ttlString → unescapeTtl: round-trips quotes, backslashes, newlines", () => {
  for (const s of ['plain', 'has "quotes"', "back\\slash", "two\nlines", 'mix: "a"\\b\nc']) {
    assert.equal(unescapeTtl(ttlString(s)), s, `round-trip failed for ${JSON.stringify(s)}`);
  }
  // \r is dropped on the way out (CRLF normalised to LF), so test that explicitly.
  assert.equal(unescapeTtl(ttlString("a\r\nb")), "a\nb");
});

test("unescapeTtl: decodes turtle \\uXXXX / \\UXXXXXXXX (how CSS serialises non-ASCII)", () => {
  assert.equal(unescapeTtl("\\U0001f44b"), "👋");
  assert.equal(unescapeTtl("\\u00e4\\u00f6\\u00fc"), "äöü");
  assert.equal(unescapeTtl("emoji \\U0001f680 here"), "emoji 🚀 here");
});

test("parseMessages: extracts messages, sorts by created, skips incomplete", () => {
  const dayUrl = "https://pods.mindpods.org/testuser/chat/general/2026/06/05/chat.ttl";
  const ttl = `
<#this> <http://www.w3.org/ns/pim/meeting#message> <#msg-b>, <#msg-a> .
<#msg-b> <http://rdfs.org/sioc/ns#content> "second \\U0001f44b" ;
  <http://xmlns.com/foaf/0.1/maker> <https://pods.mindpods.org/huhn/profile/card#me> ;
  <http://purl.org/dc/terms/created> "2026-06-05T20:04:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
<#msg-a> <http://rdfs.org/sioc/ns#content> "first" ;
  <http://xmlns.com/foaf/0.1/maker> <https://pods.mindpods.org/alice/profile/card#me> ;
  <http://purl.org/dc/terms/created> "2026-06-05T20:03:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
<#msg-broken> <http://rdfs.org/sioc/ns#content> "no maker or date" .
`;
  const msgs = parseMessages(dayUrl, ttl);
  assert.equal(msgs.length, 2, "the message missing maker/created is dropped");
  assert.deepEqual(
    msgs.map((m) => m.body),
    ["first", "second 👋"],
    "sorted by created ascending; unicode decoded",
  );
  assert.equal(msgs[0].url, `${dayUrl}#msg-a`);
  assert.equal(msgs[1].author, "https://pods.mindpods.org/huhn/profile/card#me");
});

test("parseMessages: empty / no-message turtle → []", () => {
  const dayUrl = "https://pod.example/u/chat/general/2026/06/05/chat.ttl";
  assert.deepEqual(parseMessages(dayUrl, ""), []);
  assert.deepEqual(parseMessages(dayUrl, "<#this> a <http://www.w3.org/ns/pim/meeting#LongChat> ."), []);
});
