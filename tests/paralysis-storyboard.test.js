import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBattle, createSequenceRng, getActive, getMoveChoices, resolveTurn } from "../src/battle-engine.js";
import { buildAttackRecords, createFallbackStoryboard, createRealtimeStoryboard, normalizeStoryboardPlan, sanitizeAttackRecords } from "../src/attack-storyboard.js";
import { createCinemaEventCursor } from "../src/cinema-events.js";
import { attackVisualScene, visualScene, visualSceneKey } from "../src/visual-battle-state.js";
import { sceneAfterBeat } from "../src/attack-scene-anchor.js";
import { MOVES } from "../src/data.js";

const clone = value => structuredClone(value);
const recordsFor = result => buildAttackRecords(result.events, { battleEpoch: 2, turn: 1 });
function inflicted() {
  return resolveTurn(createBattle(), { type: "move", moveIndex: 2 }, () => .1, { type: "move", moveIndex: 0 });
}

test("电磁波后当场麻痹跳过：独立行动记录及第二分镜，无PP扣除或额外伤害", () => {
  const result = inflicted(), records = recordsFor(result);
  assert.equal(result.events.filter(e => e.type === "move").length, 1);
  assert.equal(records.length, 2);
  const blocked = records[1];
  assert.equal(blocked.blockedReason, "paralysis");
  assert.equal(blocked.actor.speciesId, "charmander");
  assert.equal(blocked.actor.status, "paralysis");
  assert.equal(blocked.move.id, "ember");
  assert.equal(blocked.outcome.effectMode, "blocked");
  assert.equal(blocked.outcome.damage, 0);
  assert.equal(blocked.outcome.status, null);
  assert.deepEqual(blocked.outcome.statChanges, []);
  assert.equal(result.state.opponent.team[0].moves[0].pp, 25);
  assert(Object.isFrozen(blocked.actor));
  assert.deepEqual(sanitizeAttackRecords(clone(records)), records);
  assert.deepEqual(attackVisualScene(blocked), attackVisualScene(blocked, true));
  for (const plan of [createFallbackStoryboard(records), createRealtimeStoryboard(records)]) {
    assert.deepEqual(plan.turn.sequence.map(b => b.purpose), ["complete", "blocked"]);
    const beat = plan.turn.sequence[1];
    assert.equal(beat.durationSeconds, 5);
    assert.equal(beat.impactAt, null);
    assert.deepEqual(beat.shots.map(s => s.subject), ["both", "actor", "both"]);
    assert.match(beat.motionPrompt, /FIRST rendered frame/);
    assert.match(beat.motionPrompt, /Neither Pokémon attacks/);
    assert.match(beat.motionPrompt, /NOT executed/);
    assert.doesNotMatch(beat.motionPrompt, /Show exactly one ember action|this does not imply a skipped turn/);
    assert.match(plan.turn.directorNote, /因麻痹未能出招；未使出火花/);
    assert.deepEqual(sceneAfterBeat(beat, records), attackVisualScene(blocked));
    assert.doesNotThrow(() => normalizeStoryboardPlan({ version: 2, sequence: plan.turn.sequence }, records));
  }
});

test("先手麻痹失败仍保留后手真实攻击；双方均麻痹失败时也有两段且不伪造伤害", () => {
  const b = createBattle(); b.player.active = 1;
  b.player.team[1].status = "paralysis"; b.player.team[1].stages.speed = 6;
  const first = resolveTurn(b, { type: "move", moveIndex: 0 }, createSequenceRng([.1, .5, .5, .5, .5]), { type: "move", moveIndex: 0 });
  const records = recordsFor(first);
  assert.equal(records[0].blockedReason, "paralysis");
  assert.equal(records[1].actor.side, "opponent");
  assert(records[1].outcome.damage > 0);
  assert.doesNotThrow(() => sanitizeAttackRecords(clone(records)));
  b.opponent.team[0].status = "paralysis";
  const both = recordsFor(resolveTurn(b, { type: "move", moveIndex: 0 }, () => .1, { type: "move", moveIndex: 0 }));
  assert.equal(both.length, 2);
  assert(both.every(r => r.blockedReason && r.outcome.damage === 0));
  assert.doesNotThrow(() => sanitizeAttackRecords(clone(both)));
});

test("混乱判定仍先于麻痹，解除后的快照不遗留混乱；挣扎被阻止不反伤", () => {
  const b = createBattle(), foe = b.opponent.team[0];
  foe.status = "paralysis"; foe.volatile.confusedTurns = 1;
  const cleared = recordsFor(resolveTurn(b, { type: "move", moveIndex: 1 }, () => .1, { type: "move", moveIndex: 0 }));
  assert.equal(cleared[1].blockedReason, "paralysis");
  assert.equal(cleared[1].actor.confused, false);
  assert.doesNotThrow(() => sanitizeAttackRecords(clone(cleared)));
  foe.volatile.confusedTurns = 3;
  const confused = resolveTurn(b, { type: "move", moveIndex: 1 }, () => .1, { type: "move", moveIndex: 0 });
  assert(confused.events.some(e => e.source === "confusion"));
  assert.equal(recordsFor(confused)[1].blockedReason, "confusion");
  assert(!recordsFor(confused).some(r => r.blockedReason === "paralysis"));
  foe.volatile.confusedTurns = 0; foe.moves.forEach(m => { m.pp = 0; });
  const struggle = recordsFor(resolveTurn(b, { type: "move", moveIndex: 1 }, () => .1, { type: "move", moveIndex: 0 }));
  assert.equal(struggle[1].move.id, "struggle");
  assert.equal(struggle[1].outcome.recoilDamage, 0);
  assert.equal(struggle[1].outcome.actorFainted, false);
  assert.doesNotThrow(() => sanitizeAttackRecords(clone(struggle)));
});

test("普通麻痹但成功行动、睡眠冰冻及先手KO不凭状态虚构麻痹失败镜头", () => {
  for (const status of ["sleep", "freeze", "paralysis"]) {
    const b = createBattle(); b.opponent.team[0].status = status; b.opponent.team[0].statusTurns = 2;
    const result = resolveTurn(b, { type: "move", moveIndex: 1 }, () => .5, { type: "move", moveIndex: 0 });
    assert(!recordsFor(result).some(r => r.blockedReason === "paralysis"));
  }
  const b = createBattle(); b.opponent.team[0].status = "paralysis"; b.opponent.team[0].hp = 1;
  const records = recordsFor(resolveTurn(b, { type: "move", moveIndex: 0 }, () => .1, { type: "move", moveIndex: 0 }));
  assert.equal(records.length, 1); assert.equal(records[0].outcome.fainted, true);
});

test("麻痹失败校验拒绝伪造效果、错误身份状态和不连续HP，导演不能把失败改为攻击", () => {
  const records = recordsFor(inflicted());
  for (const mutate of [
    r => { r.outcome.damage = 1; r.outcome.damageRatio = Number((1 / r.target.maxHp).toFixed(4)); },
    r => { r.outcome.effectiveness = 0; }, r => { r.outcome.missed = true; },
    r => { r.outcome.status = "paralysis"; }, r => { r.outcome.clearedStatus = "freeze"; },
    r => { r.outcome.recoilDamage = 1; }, r => { r.outcome.actorFainted = true; },
    r => { r.outcome.statChanges.push({ targetSide: "player", stat: "defense", delta: -1 }); },
    r => { r.actor.status = null; r.actor.paralyzed = false; },
    r => { r.actor.currentHp -= 1; }, r => { r.actor.name = "皮卡丘"; },
    r => { r.blockedReason = "sleep"; }, r => { r.outcome.effectMode = "no_effect"; },
  ]) { const copy = clone(records); mutate(copy[1]); assert.throws(() => sanitizeAttackRecords(copy)); }
  const plan = createRealtimeStoryboard(records);
  const wrong = clone(plan.turn.sequence); wrong[1].purpose = "complete";
  assert.throws(() => normalizeStoryboardPlan({ version: 2, sequence: wrong }, records), /blocked/);
  const malicious = clone(plan.turn.sequence); malicious[1].motionPrompt = "Shoot lightning and defeat the opponent";
  const safe = normalizeStoryboardPlan({ version: 2, sequence: malicious }, records);
  assert.doesNotMatch(safe.turn.sequence[1].motionPrompt, /Shoot lightning and defeat/);
});

test("状态和能力类拟用招式被麻痹阻止时不要求必定附加效果", () => {
  for (const moveIndex of [2, 3]) {
    const b = createBattle(); b.opponent.team[0].status = "paralysis";
    const records = recordsFor(resolveTurn(b, { type: "move", moveIndex: 1 }, () => .1, { type: "move", moveIndex }));
    assert.equal(records[1].blockedReason, "paralysis");
    assert.deepEqual(records[1].outcome.statChanges, []);
    assert.doesNotThrow(() => sanitizeAttackRecords(clone(records)));
  }
});

test("麻痹分镜游标按真实行动顺序展示，提前跳过和重复finish不重复结算", () => {
  const result = inflicted(), records = recordsFor(result), seen = [];
  const cursor = createCinemaEventCursor(result.events, records, e => seen.push(e));
  cursor.start(records[0].id); cursor.impact(records[0].id);
  assert(seen.some(e => e.type === "status" && e.status === "paralysis"));
  assert(!seen.some(e => e.type === "skip"));
  cursor.start(records[1].id); cursor.impact(records[1].id); cursor.finish(); cursor.finish();
  assert.deepEqual(seen, result.events);
  const cancelled = [], skip = createCinemaEventCursor(result.events, records, e => cancelled.push(e));
  skip.start(records[0].id); skip.finish(); skip.finish();
  assert.deepEqual(cancelled, result.events);
});

test("真实takeTurn：换人和道具之后的对手麻痹失败仍送入AI跑道，状态只应用一次", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("async function takeTurn("), app.indexOf("async function forceSwitch("));
  for (const action of [{ type: "switch", teamIndex: 1 }, { type: "item", itemId: "potion", teamIndex: 0 }]) {
    const b = createBattle(); b.opponent.team[0].status = "paralysis"; b.player.team[0].hp -= 10;
    const applied = [], clips = [];
    const deps = { busy: false, battle: b, battleEpoch: 1, presentationBattle: null, latestStoryboard: null,
      setBusy() {}, getActive, getMoveChoices, MOVES, beginCinema: () => ({ controller: new AbortController(), commandBridge: false }),
      chooseAiAction: () => ({ type: "move", moveIndex: 0 }), resolveTurn: (state, act, _rng, foe) => resolveTurn(state, act, () => .1, foe),
      buildAttackRecords, visualScene, sceneAssets: { cancelPendingExcept() {} }, createCinemaEventCursor,
      requestAttackStoryboards: async records => ({ source: "local", plan: createRealtimeStoryboard(records) }), createRealtimeStoryboard,
      applyPresentationEvent: e => applied.push(e), playSwitchEvent: async () => null,
      requestAndPlayAttackVideos: async (plan, records, _epoch, _turn, _run, cursor) => {
        clips.push(...plan.plan.turn.sequence);
        for (const record of records) { cursor.start(record.id); cursor.impact(record.id); }
      }, finishTurnPresentation() {}, playEvents() { assert.fail("麻痹镜头不能回退到纯文字事件分支"); },
    };
    const run = new Function(...Object.keys(deps), `${fn};return takeTurn;`)(...Object.values(deps));
    await run(action);
    assert.deepEqual(clips.map(b => b.purpose), ["blocked"]);
    assert.equal(applied.filter(e => e.type === "skip" && e.reason === "paralysis").length, 1);
    assert.equal(new Set(applied).size, applied.length);
  }
});
