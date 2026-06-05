// Resolve the WebID + kind that authors an event. The tracker is local files,
// but every event records an `actor` (a WebID) and `actorKind` (human|agent).
// Resolution order: --author flag → $MIND_AUTHOR → active mind identity (guarded,
// since getActive() throws when none is set) → a stable local urn from $USER.

import { userInfo } from "node:os";
import { getActive } from "../store.mjs";

/** The bare name from our local fallback urn (`urn:mind:local:<name>`), else null. */
function localUrnName(webId) {
  const m = String(webId).match(/^urn:mind:local:(.+)$/);
  return m ? m[1] : null;
}

/**
 * The human label for a WebID — the account/pod name, not the literal path tail.
 *
 * Solid WebIDs almost universally end in `/profile/card#me`
 * (e.g. `https://pod.mindpods.org/mind-agent-01/profile/card#me`), so a naive
 * "last path segment" collapses *every* identity to `card`. We strip the
 * canonical card location first, then take the remaining last path segment
 * (`mind-agent-01`); if the card sat at the host root (`https://alice.example/
 * profile/card#me`), we fall back to the host's first label (`alice`).
 */
function webIdLabel(webId) {
  const local = localUrnName(webId);
  if (local) return local;

  let s = String(webId).replace(/#.*$/, "").replace(/\/+$/, "");
  s = s.replace(/\/profile\/card$/i, "").replace(/\/profile$/i, "");

  const path = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i)?.[1];
  if (path) {
    const seg = path.split("/").filter(Boolean).pop();
    if (seg) return seg;
  }

  const host = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/:]+)/i)?.[1];
  if (host) {
    const label = host.split(".")[0];
    return label && label !== "www" ? label : host;
  }

  return s.split("/").filter(Boolean).pop() || "mind-user";
}

/** Short [a-z0-9] tag for event filenames — the account label, lowercased. */
export function actorTag(webId) {
  const tag = webIdLabel(webId).toLowerCase().replace(/[^a-z0-9]/g, "");
  return tag || "user";
}

/** Human-readable name for a WebID (the account/pod name, or local fallback). */
export function displayName(webId) {
  return webIdLabel(webId) || "mind-user";
}

function looksLikeUrl(s) {
  return /^[a-z][a-z0-9+.-]*:/i.test(s); // http(s):, urn:, did:, …
}

function localUrn() {
  let user = "user";
  try {
    user = userInfo().username || process.env.USER || "user";
  } catch {
    user = process.env.USER || "user";
  }
  const slug = String(user).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
  return `urn:mind:local:${slug}`;
}

/**
 * Resolve { webId, kind, tag, name }. `author` may be a WebID/URN or a plain
 * display name (synthesized into a local urn). `agent` flips kind to "agent".
 */
export function resolveActor({ author, agent } = {}) {
  let webId;

  const flag = author ?? process.env.MIND_AUTHOR;
  if (flag) {
    webId = looksLikeUrl(flag)
      ? flag
      : `urn:mind:local:${String(flag).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user"}`;
  } else {
    try {
      webId = getActive().webId || null;
    } catch {
      webId = null;
    }
    if (!webId) webId = localUrn();
  }

  return {
    webId,
    kind: agent ? "agent" : "human",
    tag: actorTag(webId),
    name: displayName(webId),
  };
}
