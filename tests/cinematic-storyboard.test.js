import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBattle, createPokemon, resolveTurn } from "../src/battle-engine.js";
import { buildAttackRecords, sanitizeAttackRecords, createRealtimeStoryboard, normalizeStoryboardPlan } from "../src/attack-storyboard.js";

function records(configure = () => {}, playerMove = 0, opponentMove = 0, rng = () => 0.5) {
  const battle = createBattle();
  configure(battle);
  const result = resolveTurn(battle, { type: "move", moveIndex: playerMove }, rng, { type: "move", moveIndex: opponentMove });
  return { attacks: sanitizeAttackRecords(structuredClone(buildAttackRecords(result.events))), result };
}
function prompt(attacks, index = 0) { return createRealtimeStoryboard(attacks, null, true).turn.sequence[index].motionPrompt; }

test("实时多机位经过服务端往返后保留景别、移动、命中时刻和真实状态", () => {
  const { attacks } = records();
  const first = createRealtimeStoryboard(attacks, null, true);
  const normalized = normalizeStoryboardPlan({ version: 2, sequence: first.turn.sequence }, attacks);
  const second = createRealtimeStoryboard(attacks, normalized, true);
  assert.deepEqual(first, second);
  for (const beat of second.turn.sequence) {
    assert.deepEqual(beat.shots.map(s => s.shotSize), ["close_up", "wide", "medium"]);
    assert(beat.impactAt > beat.shots[1].startAt && beat.impactAt < beat.shots[1].endAt);
    assert.match(beat.motionPrompt, /low three-quarter angle/);
    assert.match(beat.motionPrompt, /oblique over-the-shoulder angle/);
    assert.match(beat.motionPrompt, /high three-quarter reaction angle/);
    assert.match(beat.motionPrompt, /track laterally.*foreground grass parallax/);
    assert.match(beat.motionPrompt, /FIRST rendered frame only/);
    assert.doesNotMatch(beat.motionPrompt, /No opening close-up|first 0.5 seconds|settle into a shared wide/);
  }
});

test("普通、抵抗、克制采用不同接触强调但不伪造伤害和倒下", () => {
  const normal = records();
  assert.equal(normal.attacks[0].outcome.effectiveness, 1);
  assert.match(prompt(normal.attacks), /Normally effective \(1x\)/);
  const superHit = records(b => { b.player.active = 1; });
  const water = superHit.attacks.find(a => a.move.id === "waterGun");
  assert.equal(water.outcome.effectiveness, 2);
  assert.match(prompt([water]), /Super-effective \(2x\)/);
  const resisted = records(b => { b.player.active = 2; });
  const grass = resisted.attacks.find(a => a.actor.side === "player");
  assert.equal(grass.outcome.effectiveness, 0.5);
  assert.match(prompt([grass]), /Not very effective \(0.5x\)/);
  for (const { attacks } of [normal, superHit, resisted]) {
    for (const attack of attacks) {
      assert.match(prompt([attack]), new RegExp(`Actual damage is ${attack.outcome.damage} HP`));
      assert.equal(prompt([attack]).includes("stays down through the last frame"), attack.outcome.fainted || attack.outcome.actorFainted);
    }
  }
});

test("电磁波有麻痹状态但没有伤害冲击，麻痹者仍可执行记录中的下一招", () => {
  const { attacks } = records(() => {}, 2);
  assert.equal(attacks[0].outcome.status, "paralysis");
  assert.match(prompt(attacks), /intermittent thin yellow static/);
  assert.match(prompt(attacks), /does not imply a skipped turn/);
  assert.match(prompt(attacks), /No damage pose, hit flash, hit-stop/);
  assert.doesNotMatch(prompt(attacks), /Sound: acceleration whoosh/);
  assert.equal(attacks[1].actor.status, "paralysis");
  assert.match(prompt(attacks, 1), /already has paralysis/);
});

test("既有中毒在攻击和未命中后保留，不附加毒伤、不全身变色", () => {
  const { attacks } = records(b => { b.opponent.team[0].status = "poison"; }, 3, 0, () => 0.99);
  assert.equal(attacks[0].outcome.missed, true);
  for (const attack of attacks) {
    const text = prompt([attack]);
    assert.match(text, /violet poison bubbles/);
    assert.match(text, /retain canonical skin colors/);
    assert.match(text, /no extra poison damage or collapse/);
    assert.equal(attack.outcome.status, null);
  }
  assert.match(prompt(attacks), /evades before contact/);
});

test("属性免疫不伪造打击和新状态，也不会清除原有中毒", () => {
  const { attacks } = records(b => { b.opponent.team[1] = createPokemon("geodude", 50, "opponent-1-geodude"); b.opponent.active = 1; b.opponent.team[1].status = "poison"; }, 0, 1);
  const immune = attacks.find(a => a.actor.side === "player");
  assert.equal(immune.outcome.effectiveness, 0);
  const text = prompt([immune]);
  assert.match(text, /harmlessly dissipates/);
  assert.match(text, /violet poison bubbles/);
  assert.doesNotMatch(text, /A single 2-frame impact drawing/);
});

test("直接击倒与挣扎反伤双倒保持终态，不强迫回到待机", () => {
  for (const both of [false, true]) {
    const { attacks } = records(b => {
      b.opponent.team[0].hp = 1;
      if (both) {
        b.player.team[0].hp = 1;
        b.player.team[0].moves.forEach(move => { move.pp = 0; });
      }
    });
    const attack = attacks[0];
    assert.equal(attack.outcome.fainted, true);
    assert.equal(attack.outcome.actorFainted, both);
    const text = prompt(attacks);
    assert.equal((text.match(/stays down through the last frame/g) ?? []).length, both ? 2 : 1);
    assert.match(text, /fainting, not death/);
    if (both) assert.match(text, new RegExp(`${attack.outcome.recoilDamage} HP recoil`));
    assert.equal(createRealtimeStoryboard(attacks).turn.sequence.length, 1);
  }
});

test("睡眠、冰冻、灼伤与混乱使用独立视觉，不冒充昏厥或额外行动", () => {
  const asleep = records(b => { b.opponent.active = 2; b.player.team[0].stages.speed = -6; }, 0, 2, () => 0);
  assert.equal(asleep.attacks[0].outcome.status, "sleep");
  assert.match(prompt(asleep.attacks), /alive and asleep rather than fainted/);
  const frozen = records(b => { b.player.active = 1; }, 3, 2, () => 0);
  const ice = frozen.attacks.find(a => a.move.id === "iceBeam");
  assert.equal(ice.outcome.status, "freeze");
  assert.match(prompt([ice]), /translucent pale-blue ice shell/);
  // An existing state is preserved even when the new move does not apply it.
  const existing = records(b => { b.player.team[0].status = "burn"; b.player.team[0].volatile.confusedTurns = 3; });
  assert.match(prompt(existing.attacks), /persistent tiny ember motes/);
  assert.match(prompt(existing.attacks), /no invented self-attack/);
});

test("伤害命中不能只拍攻击者或孤立特效", () => {
  const { attacks } = records();
  for (const subject of ["actor", "move_effect"]) {
    const plan = createRealtimeStoryboard(attacks);
    plan.turn.sequence[0].shots[0].subject = "both";
    plan.turn.sequence[0].shots[1].subject = subject;
    assert.throws(() => normalizeStoryboardPlan({ version: 2, sequence: plan.turn.sequence }, attacks), /伤害命中镜头必须展示目标/);
  }
});

test("边界时间的旧远景方案会安全重排且不再约束待机末帧", async () => {
  const { attacks } = records();
  for (const impactAt of [0.1, 0.6, 4.9]) {
    const plan = createRealtimeStoryboard(attacks);
    const beat = plan.turn.sequence[0];
    beat.impactAt = impactAt;
    beat.shots = [
      { index: 0, startAt: 0, endAt: 2, shotSize: "wide", subject: "both", cameraMovement: "locked" },
      { index: 1, startAt: 2, endAt: 5, shotSize: "wide", subject: "both", cameraMovement: "locked" },
    ];
    const normalized = normalizeStoryboardPlan({ version: 2, sequence: plan.turn.sequence }, attacks);
    const realtime = createRealtimeStoryboard(attacks, normalized);
    assert.doesNotThrow(() => normalizeStoryboardPlan({ version: 2, sequence: realtime.turn.sequence }, attacks));
  }
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(server, /closingFrame\s*=/);
});
