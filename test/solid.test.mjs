import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePodPath } from "../src/solid.mjs";

// Pure string-join tests — no network. `resolvePodPath` must emit exactly one
// separator between the pod root and a relative path, regardless of whether the
// root carries a trailing slash (MC-25).

test("resolvePodPath: podRoot WITHOUT trailing slash joins with a single slash", () => {
  const id = { podRoot: "https://example.com/alice" };
  assert.equal(resolvePodPath(id, "foo"), "https://example.com/alice/foo");
});

test("resolvePodPath: podRoot WITH trailing slash does not double the slash", () => {
  const id = { podRoot: "https://example.com/alice/" };
  assert.equal(resolvePodPath(id, "foo"), "https://example.com/alice/foo");
});

test("resolvePodPath: a leading slash on the path still yields one separator", () => {
  assert.equal(resolvePodPath({ podRoot: "https://example.com/alice" }, "/foo"), "https://example.com/alice/foo");
  assert.equal(resolvePodPath({ podRoot: "https://example.com/alice/" }, "/foo"), "https://example.com/alice/foo");
});

test("resolvePodPath: an absolute http(s) path is returned as-is", () => {
  const id = { podRoot: "https://example.com/alice/" };
  assert.equal(resolvePodPath(id, "https://other.example/bar"), "https://other.example/bar");
  assert.equal(resolvePodPath(id, "http://other.example/bar"), "http://other.example/bar");
});

test("resolvePodPath: empty / '/' / '.' resolves to the pod root unchanged", () => {
  const id = { podRoot: "https://example.com/alice/" };
  assert.equal(resolvePodPath(id, ""), id.podRoot);
  assert.equal(resolvePodPath(id, "/"), id.podRoot);
  assert.equal(resolvePodPath(id, "."), id.podRoot);
  assert.equal(resolvePodPath(id, undefined), id.podRoot);
});
