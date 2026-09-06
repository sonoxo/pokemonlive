// A presentation cursor, never a second rules simulation. Each engine event is
// applied at most once, including partial video failures and skips.
export function isCinematicActionEvent(event) {
  return event.type === "move" || (Boolean(event.actor && event.target && event.move)
    && ((event.type === "skip" && ["paralysis", "sleep", "freeze"].includes(event.reason))
      || (event.type === "damage" && event.source === "confusion")));
}

export function createCinemaEventCursor(events, attacks, apply) {
  let cursor = 0;
  const moveIndices = events.flatMap((event, index) => isCinematicActionEvent(event) ? [index] : []);
  function through(end) {
    while (cursor < end && cursor < events.length) apply(events[cursor++]);
  }
  return {
    async before(attackId, beforeApply = async () => {}) {
      const index = attacks.findIndex(attack => attack.id === attackId);
      if (index < 0) return;
      while (cursor < moveIndices[index]) {
        await beforeApply(events[cursor]);
        apply(events[cursor++]);
      }
    },
    start(attackId) {
      const index = attacks.findIndex(attack => attack.id === attackId);
      if (index >= 0) through(moveIndices[index] + (attacks[index].blockedReason === "confusion" ? 0 : 1));
    },
    impact(attackId) {
      const index = attacks.findIndex(attack => attack.id === attackId);
      if (index < 0) return;
      // Residual poison/burn and next-turn messages are settled after playback,
      // not misrepresented as this attack's impact.
      let end = moveIndices[index] + 1;
      const move = events[moveIndices[index]];
      if (move.type === "skip") { through(end); return; }
      const limit = moveIndices[index + 1] ?? events.length;
      while (end < limit && !["burn", "poison", "confusion"].includes(events[end].source)
        && !["switch", "result", "skip"].includes(events[end].type)
        && (!events[end].actionSide || events[end].actionSide === move.actorSide)) end += 1;
      through(end);
    },
    finish() { through(events.length); },
    async finishAsync(beforeApply = async () => {}) {
      while (cursor < events.length) {
        await beforeApply(events[cursor]);
        apply(events[cursor++]);
      }
    },
    get appliedCount() { return cursor; },
  };
}
