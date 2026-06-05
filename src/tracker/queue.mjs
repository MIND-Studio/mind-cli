// The agent work-queue: which open issues an agent may pick up next, and in
// what order. Pure (no IO) so it is unit-testable and shared by `mind issues
// next`. An issue is a candidate when it is open AND handed to agents
// (state.handoff === "agent") or explicitly afk-safe, and is NOT:
//   - carrying a queueGateLabels label (human-only/needs-design/blocked),
//   - blockedBy an issue that is still open (its blocker isn't done),
//   - held under a live claim by a different actor.
// Survivors are ranked by priority, then the config tieBreak (lowest-ULID).

export function agentQueue({ cfg, epics, actorWebId = null, now = Date.now() }) {
  const prRank = new Map((cfg.priorities ?? []).map((p, idx) => [p, idx]));
  const gates = new Set(cfg.queueGateLabels ?? []);
  const stateOf = (id) => cfg.states.find((s) => s.id === id);

  // Fold every issue's state by ULID so we can tell whether a blocker is done.
  const stateById = new Map(epics.flatMap((e) => e.issues).map((i) => [i.id, i.state]));
  const blockerOpen = (id) => {
    const st = stateOf(stateById.get(id));
    return !!st && st.open; // resolvable + open → still blocking (dangling ref → not blocking)
  };

  return epics
    .flatMap((e) => e.issues.map((i) => ({ ...i, epicLabel: e.isGeneral ? "general" : e.slug })))
    .filter((i) => {
      const st = stateOf(i.state);
      if (!st || !st.open) return false; // skip closed
      if (!(st.handoff === "agent" || i.afk === true)) return false; // not for agents
      if (i.labels.some((l) => gates.has(l))) return false; // gated → human-only
      if ((i.blockedBy ?? []).some(blockerOpen)) return false; // blocker not yet done
      const liveOther =
        i.assignee && i.assignee !== actorWebId && i.expiresAt && new Date(i.expiresAt).getTime() > now;
      if (liveOther) return false; // someone else holds a live claim
      return true;
    })
    .sort(
      (a, b) =>
        (prRank.get(a.priority) ?? 99) - (prRank.get(b.priority) ?? 99) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0), // tieBreak: lowest-ulid
    );
}
