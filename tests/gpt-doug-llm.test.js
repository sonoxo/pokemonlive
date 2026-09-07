import test from "node:test";
import assert from "node:assert/strict";

import {
  GPT_DOUG_MODULE_ID,
  assertGptDougAction,
  createGptDougContext,
  gptDougHealth,
} from "../src/gpt-doug-llm.js";

test("GPT-DOUG context is read-only and preserves rules-engine authority", () => {
  const source = { turn: 4, player: { hp: 31 }, winner: null };
  const context = createGptDougContext({ battle: source, events: [{ type: "move-resolved" }] });

  assert.equal(context.moduleId, GPT_DOUG_MODULE_ID);
  assert.equal(context.authority.battleOutcome, "rules-engine");
  assert.equal(context.authority.readOnly, true);
  assert.deepEqual(context.battle, source);

  context.battle.player.hp = 1;
  assert.equal(source.player.hp, 31);
});

test("GPT-DOUG denies battle-outcome mutations", () => {
  assert.throws(
    () => assertGptDougAction({ type: "declare-winner", side: "player" }),
    error => error?.code === "GPT_DOUG_ACTION_DENIED",
  );
  assert.deepEqual(assertGptDougAction({ type: "request-storyboard", turn: 2 }), {
    type: "request-storyboard",
    turn: 2,
  });
});

test("GPT-DOUG health advertises the integration boundary", () => {
  assert.deepEqual(gptDougHealth(), {
    ok: true,
    moduleId: GPT_DOUG_MODULE_ID,
    mode: "read-only-battle-context",
    battleAuthority: "rules-engine",
  });
});
