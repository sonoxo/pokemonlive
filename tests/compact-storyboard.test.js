import test from "node:test";
import assert from "node:assert/strict";
import { buildDeepSeekMessages, normalizeCompactStoryboard } from "../src/compact-storyboard.js";
import { buildAttackRecords, createRealtimeStoryboard, sanitizeAttackRecords } from "../src/attack-storyboard.js";
import { createBattle, createPokemon, resolveTurn } from "../src/battle-engine.js";

function records(configure = () => {}, playerMove = 0, opponentMove = 0, rng = () => 0.5) {
  const battle = createBattle();
  configure(battle);
  const result = resolveTurn(battle, { type: "move", moveIndex: playerMove }, rng, { type: "move", moveIndex: opponentMove });
  return sanitizeAttackRecords(structuredClone(buildAttackRecords(result.events)));
}

function compact(attacks) {
  return { sequence: createRealtimeStoryboard(attacks).turn.sequence.map((beat, index) => attacks[index].blockedReason ? null : {
    impactAt: beat.impactAt,
    cuts: beat.shots.slice(0, 2).map(shot => shot.endAt),
    sizes: beat.shots.map(shot => shot.shotSize),
    moves: beat.shots.map(shot => shot.cameraMovement),
  }) };
}

function roundTrip(attacks) {
  const normalized = normalizeCompactStoryboard(compact(attacks), attacks);
  const final = createRealtimeStoryboard(attacks, normalized, true);
  assert.deepEqual(final, createRealtimeStoryboard(attacks, null, true));
  return final;
}

test("精简输出删除重复结构字段，展开后保留同样的完整实时提示词", () => {
  const attacks = records();
  const short = compact(attacks);
  const long = { version: 2, sequence: createRealtimeStoryboard(attacks).turn.sequence.map(beat => ({
    attackId: beat.attackId, purpose: beat.purpose, startAnchor: beat.startAnchor, endAnchor: beat.endAnchor,
    camera: beat.camera, motionStyle: beat.motionStyle, energyLevel: beat.energyLevel,
    cameraMovement: beat.cameraMovement, shots: beat.shots, impactAt: beat.impactAt,
  })) };
  assert(Buffer.byteLength(JSON.stringify(short)) < Buffer.byteLength(JSON.stringify(long)) * 0.35);
  roundTrip(attacks);
  const messages = buildDeepSeekMessages(attacks);
  const example = JSON.parse(messages[1].content.split("\n")[1]);
  assert.deepEqual(Object.keys(example.sequence[0]), ["impactAt", "cuts", "sizes", "moves"]);
  assert.deepEqual(JSON.parse(messages[1].content.split("Immutable attack records:\n")[1]), attacks);
});

test("真实导演的切点、景别和运动在归一化及实时再编排后不会被覆盖", () => {
  const attacks = records(), candidate = compact(attacks);
  Object.assign(candidate.sequence[0], {
    impactAt: 2.2, cuts: [0.6, 3.6],
    sizes: ["extreme_close_up", "extreme_wide", "close_up"],
    moves: ["locked", "impact_push", "slow_push"],
    attackId: attacks[1].id, subject: "move_effect", damage: 99999, motionPrompt: "EVIL_PROMPT",
  });
  const normalized = normalizeCompactStoryboard(candidate, attacks);
  const beat = createRealtimeStoryboard(attacks, normalized, true).turn.sequence[0];
  assert.equal(beat.attackId, attacks[0].id);
  assert.equal(beat.impactAt, 2.2);
  assert.deepEqual(beat.shots.map(shot => shot.endAt), [0.6, 3.6, 5]);
  assert.deepEqual(beat.shots.map(shot => shot.shotSize), candidate.sequence[0].sizes);
  assert.deepEqual(beat.shots.map(shot => shot.cameraMovement), candidate.sequence[0].moves);
  assert.deepEqual(beat.shots.map(shot => shot.subject), ["actor", "both", "target"]);
  assert.doesNotMatch(beat.motionPrompt, /EVIL_PROMPT|99999/);
  assert.deepEqual(normalized.turn.attacks, attacks);
});

test("拒绝丢失位置、非法切点、无特写、错误枚举和落在切点上的结算", () => {
  const attacks = records();
  for (const mutate of [
    p => p.sequence.pop(), p => p.sequence.push(p.sequence[0]), p => { p.sequence[0] = null; },
    p => { p.sequence[0].cuts = [0.3, 3]; }, p => { p.sequence[0].cuts = [2.9, 2]; },
    p => { p.sequence[0].cuts = [0.8, 4.8]; }, p => { p.sequence[0].cuts = [NaN, 3.3]; },
    p => { p.sequence[0].cuts = ["0.8", 3.3]; }, p => { p.sequence[0].cuts.push(4); },
    p => { p.sequence[0].impactAt = 3.3; }, p => { p.sequence[0].impactAt = 0.9; },
    p => { p.sequence[0].impactAt = 4.2; }, p => { p.sequence[0].impactAt = "2.6"; },
    p => { p.sequence[0].impactAt = Infinity; }, p => { p.sequence[0].sizes = ["wide", "wide", "wide"]; },
    p => { p.sequence[0].sizes[1] = "close_up"; }, p => { p.sequence[0].sizes[2] = "invalid"; },
    p => { p.sequence[0].moves[0] = "invalid"; }, p => { p.sequence[0].moves.pop(); },
  ]) {
    const candidate = compact(attacks); mutate(candidate);
    assert.throws(() => normalizeCompactStoryboard(candidate, attacks), { code: "INVALID_STORYBOARD" });
  }
});

test("麻痹、睡眠、冰冻、混乱的先后手独立分镜原样保留，不能改为空攻击", () => {
  for (const status of ["paralysis", "sleep", "freeze", "confusion"]) for (const first of [false, true]) {
    const attacks = records(b => {
      const p = b.opponent.team[0];
      if (status === "confusion") p.volatile.confusedTurns = 3;
      else { p.status = status; p.statusTurns = 2; }
      if (first) p.stages.speed = 6;
    }, first ? 2 : 1, 0, () => status === "freeze" ? 0.5 : 0.1);
    const index = first ? 0 : 1;
    assert.equal(attacks[index].blockedReason, status);
    const beat = roundTrip(attacks).turn.sequence[index];
    assert.equal(beat.purpose, "blocked");
    assert.equal(beat.impactAt, status === "confusion" ? 2.4 : null);
    const example = JSON.parse(buildDeepSeekMessages(attacks)[1].content.split("\n")[1]);
    assert.equal(example.sequence[index], null);
    example.sequence[index] = example.sequence[1 - index];
    assert.throws(() => normalizeCompactStoryboard(example, attacks), { code: "INVALID_STORYBOARD" });
  }
  const both = records(b => {
    b.player.team[0].status = "sleep"; b.player.team[0].statusTurns = 2;
    b.opponent.team[0].status = "freeze";
  });
  assert.deepEqual(compact(both).sequence, [null, null]);
  assert.deepEqual(roundTrip(both).turn.sequence.map(beat => beat.purpose), ["blocked", "blocked"]);
});

test("属性、状态持续、自我强化、反伤和击倒的最终提示词不因压缩改变", () => {
  const cases = [
    records(),
    records(b => { b.player.active = 1; }), // super-effective
    records(b => { b.player.active = 2; }), // resisted
    records(b => { b.opponent.team[1] = createPokemon("geodude", 50, "opponent-1-geodude"); b.opponent.active = 1; b.opponent.team[1].status = "poison"; }), // immune
    records(b => { b.opponent.team[0].status = "poison"; }, 3, 0, () => 0.99), // miss
    records(() => {}, 2), // paralysis persists into successful next action
    records(b => { b.player.active = 2; }, 3), // self stat
    records(b => { b.player.active = 1; }, 2), // foe stat
    records(b => { b.player.active = 1; }, 3, 2, () => 0), // freeze
    records(b => { b.player.active = 2; b.player.team[2].stages.speed = 6; }, 2, 0, () => 0.1), // sleep
    records(b => { b.player.team[0].status = "burn"; b.player.team[0].volatile.confusedTurns = 3; }),
    records(b => { b.opponent.team[0].hp = 1; }), // KO
    records(b => { b.opponent.team[0].hp = 1; b.player.team[0].hp = 1; b.player.team[0].moves.forEach(m => { m.pp = 0; }); }), // recoil + double KO
    records(b => { b.opponent.team[0].hp = 1; b.opponent.team[0].stages.speed = 6; b.opponent.team[0].volatile.confusedTurns = 3; }, 2, 0, () => 0.1), // confusion KO
  ];
  for (const attacks of cases) roundTrip(attacks);
  const self = cases[6], selfIndex = self.findIndex(a => a.move.id === "growth");
  assert.equal(roundTrip(self).turn.sequence[selfIndex].shots.at(-1).subject, "actor");
  assert.equal(cases[12][0].outcome.actorFainted, true);
  assert.equal(roundTrip(cases[12]).turn.sequence[0].shots.at(-1).subject, "both");
});
