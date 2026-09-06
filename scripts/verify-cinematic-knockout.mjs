// Explicit opt-in: one paid five-second clip through the running local server.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createBattle, resolveTurn } from "../src/battle-engine.js";
import { buildAttackRecords, sanitizeAttackRecords, createRealtimeStoryboard } from "../src/attack-storyboard.js";

if (!process.argv.includes("--paid")) throw new Error("This generates one paid fal clip. Run with --paid to opt in.");
const battle = createBattle();
battle.opponent.team[0].hp = 20;
const result = resolveTurn(battle, { type: "move", moveIndex: 0 }, () => 0.5, { type: "move", moveIndex: 0 });
const attacks = sanitizeAttackRecords(structuredClone(buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 })));
assert.equal(attacks.length, 1);
assert.equal(attacks[0].outcome.fainted, true);
const plan = createRealtimeStoryboard(attacks);
const base = "http://localhost:4173/api/attack-videos";
const response = await fetch(base, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ version: 2, battleEpoch: 0, turn: 1, presentation: "inline-command-v1", commandBridge: true, attacks, sequence: plan.turn.sequence }),
});
const body = await response.json();
assert(response.ok, body.error);
const id = body.session.id;
console.log(JSON.stringify({ sessionId: id, outcome: attacks[0].outcome }));
try {
  for (let count = 0; count < 120; count++) {
    await delay(500);
    const status = await fetch(`${base}/${id}`, { signal: AbortSignal.timeout(5000) });
    const { session } = await status.json();
    if (session.status === "ready") {
      console.log(JSON.stringify({ status: session.status, clips: session.clips.map(c => ({ index: c.index, generationMs: c.generationMs })) }));
      break;
    }
    assert.equal(session.status, "generating", session.error);
    if (count === 119) throw new Error("Local verification deadline exceeded");
  }
} finally {
  await fetch(`${base}/${id}`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
}
