import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAttackRecords,
  createFallbackStoryboard,
  normalizeStoryboardPlan,
  sanitizeAttackRecords,
} from "../src/attack-storyboard.js";
import { createBattle, createPokemon, createSequenceRng, resolveTurn } from "../src/battle-engine.js";

function resolvedTurn(playerAction = { type: "move", moveIndex: 0 }, opponentAction = { type: "move", moveIndex: 1 }) {
  return resolveTurn(
    createBattle(),
    playerAction,
    createSequenceRng([0, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0.5]),
    opponentAction,
  );
}

test("攻击记录锁定技能、实际伤害和双方修正后速度", () => {
  const result = resolvedTurn();
  const records = buildAttackRecords(result.events, { battleEpoch: 3, turn: 1 });
  assert.equal(records.length, 2);
  assert.equal(records[0].move.name, "十万伏特");
  assert.equal(records[0].actor.name, "皮卡丘");
  assert.equal(records[0].target.name, "小火龙");
  assert.equal(records[0].tempo.actorSpeed, 110);
  assert.equal(records[0].tempo.targetSpeed, 85);
  assert.ok(records[0].outcome.damage > 0);
  assert.equal(records[0].outcome.damageTier, "decisive");
  assert.ok(Object.isFrozen(records[0]));
  assert.ok(Object.isFrozen(records[0].outcome));
});

test("主动换人后，攻击记录中的目标是实际承伤的换入者", () => {
  const result = resolvedTurn({ type: "switch", teamIndex: 1 });
  const [record] = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  assert.equal(record.actor.name, "小火龙");
  assert.equal(record.target.name, "杰尼龟");
  assert.equal(record.target.speciesId, "squirtle");
  assert.equal(record.outcome.damage, result.events.find((event) => event.type === "damage" && event.source === record.move.id).amount);
  const prompt = createFallbackStoryboard([record]).turn.sequence[0].motionPrompt;
  assert.match(prompt, /Image 1 is the player-side squirtle \(杰尼龟\); Image 2 is the opponent-side charmander \(小火龙\)/);
});

test("本地降级分镜把双方攻击合成单一连续时间线", () => {
  const records = buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 });
  const fallback = createFallbackStoryboard(records, "test");
  assert.equal(fallback.version, 2);
  assert.equal(fallback.turn.attacks.length, 2);
  assert.equal(fallback.turn.sequence.length, 2);
  assert.equal(fallback.turn.title, "皮卡丘 ⇄ 小火龙");
  assert.deepEqual(fallback.turn.sequence.map((beat) => beat.attackId), [
    records[0].id,
    records[1].id,
  ]);
  for (const beat of fallback.turn.sequence) {
    assert.equal(beat.durationSeconds, 5);
    assert.equal(beat.purpose, "complete");
    assert.equal(beat.startAnchor, "idle");
    assert.equal(beat.endAnchor, "recovery");
    assert.equal(beat.impactAt, 2.8);
    assert.ok(beat.shots.length >= 2 && beat.shots.length <= 3);
    assert.equal(beat.shots[0].startAt, 0);
    assert.equal(beat.shots.at(-1).endAt, 5);
    beat.shots.slice(1).forEach((shot, shotIndex) => {
      assert.equal(shot.startAt, beat.shots[shotIndex].endAt);
    });
  }
  assert.ok(fallback.turn.sequence.every((beat) => /Keep both Pokémon inside/.test(beat.motionPrompt)));
  assert.match(fallback.turn.sequence[0].motionPrompt, /fresh hand-drawn establishing first frame/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /pine clearing with grass-capped ochre rock ledges/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /Reference-image identity contract: Image 1 is the player-side pikachu \(皮卡丘\); Image 2 is the opponent-side charmander \(小火龙\)/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /do not preserve the source pixel grid, low resolution, white reference background or sprite-game rendering style/);
  assert.match(fallback.turn.sequence[1].motionPrompt, /exact final frame of the preceding five-second clip/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /2D Japanese television-animation Pokémon battle/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /cheek sacs glow as branching yellow electricity/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /jagged branching lightning discharge/);
  assert.match(fallback.turn.sequence[1].motionPrompt, /raises one foreclaw.*sharp glint/);
  assert.match(fallback.turn.sequence[1].motionPrompt, /fast close-range claw swipe/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /exactly 3 authored animation shots/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /0\.0-1\.1s: close up.*1\.1-3\.4s: wide.*3\.4-5\.0s: close up/);
  assert.match(fallback.turn.sequence[0].motionPrompt, /complete attack in this single five-second clip/);
  assert.doesNotMatch(fallback.turn.sequence[0].motionPrompt, /supplied first frame/);
});

test("无伤害状态招式不会被误记为属性免疫", () => {
  const result = resolvedTurn({ type: "move", moveIndex: 2 }, { type: "move", moveIndex: 2 });
  const records = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  const thunderWave = records.find((record) => record.move.id === "thunderWave");
  assert.equal(thunderWave.outcome.damage, 0);
  assert.equal(thunderWave.outcome.effectiveness, null);
  assert.equal(thunderWave.outcome.status, "paralysis");
  assert.equal(thunderWave.outcome.damageTier, "tactical");
});

test("落空与免疫的招式专属演出不会伪造接触或异常状态", () => {
  const missBattle = createBattle();
  const missResult = resolveTurn(
    missBattle,
    { type: "move", moveIndex: 3 },
    createSequenceRng([0.99, 0, 0, 0, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  const ironTail = buildAttackRecords(missResult.events, { battleEpoch: 0, turn: 1 })
    .find((record) => record.move.id === "ironTail");
  assert.equal(ironTail.outcome.missed, true);
  const missedBeats = createFallbackStoryboard([ironTail]).turn.sequence;
  assert.equal(missedBeats.length, 1);
  assert.match(missedBeats[0].motionPrompt, /target visibly evades before contact/);
  assert.match(missedBeats[0].motionPrompt, /no contact flash/);
  assert.doesNotMatch(missedBeats[0].motionPrompt, /crescent-shaped close-range swing with a crisp silver contact flash/);
  assert.doesNotMatch(missedBeats[0].motionPrompt, /actual contact moment/);

  const immuneBattle = createBattle();
  immuneBattle.opponent.team[1] = createPokemon("geodude", 50, "opponent-1-geodude");
  immuneBattle.opponent.active = 1;
  const immuneResult = resolveTurn(
    immuneBattle,
    { type: "move", moveIndex: 2 },
    createSequenceRng([0, 0, 0, 0, 0, 0]),
    { type: "move", moveIndex: 1 },
  );
  const thunderWave = buildAttackRecords(immuneResult.events, { battleEpoch: 0, turn: 1 })
    .find((record) => record.move.id === "thunderWave");
  assert.equal(thunderWave.outcome.effectiveness, 0);
  const immuneBeats = createFallbackStoryboard([thunderWave]).turn.sequence;
  assert.equal(immuneBeats.length, 1);
  assert.match(immuneBeats[0].motionPrompt, /dissipates harmlessly/);
  assert.match(immuneBeats[0].motionPrompt, /remains entirely unharmed and unaffected/);
  assert.doesNotMatch(immuneBeats[0].motionPrompt, /communicate paralysis/);
});

test("自我强化招式记录实际能力变化且不会生成对敌命中文案", () => {
  const battle = createBattle();
  battle.player.active = 2;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 3 },
    createSequenceRng([0, 0, 0, 0, 0, 0]),
    { type: "move", moveIndex: 3 },
  );
  const records = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  const growth = records.find((record) => record.move.id === "growth");
  assert.equal(growth.outcome.effectMode, "self_stat");
  assert.equal(growth.outcome.damage, 0);
  assert.equal(growth.outcome.damageTier, "tactical");
  assert.deepEqual(growth.outcome.statChanges, [
    { targetSide: "player", stat: "attack", delta: 1 },
    { targetSide: "player", stat: "specialAttack", delta: 1 },
  ]);
  const plan = createFallbackStoryboard([growth]).turn;
  assert.match(plan.directorNote, /不造成伤害/);
  assert.equal(plan.sequence.length, 1);
  assert.match(plan.sequence[0].motionPrompt, /without targeting charmander/);
  assert.doesNotMatch(plan.sequence[0].motionPrompt, /hits charmander/);
  assert.match(plan.sequence[0].motionPrompt, /holds the strengthened battle stance/);
});

test("能力完全封顶时仍保留自我强化目标且明确没有实际变化", () => {
  const battle = createBattle();
  battle.player.active = 2;
  battle.player.team[2].stages.attack = 6;
  battle.player.team[2].stages.specialAttack = 6;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 3 },
    createSequenceRng([0, 0, 0, 0, 0, 0]),
    { type: "move", moveIndex: 3 },
  );
  const records = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  const growth = records.find((record) => record.move.id === "growth");
  assert.equal(growth.move.targetMode, "self");
  assert.equal(growth.outcome.effectMode, "self_stat");
  assert.deepEqual(growth.outcome.statChanges, []);
  const plan = createFallbackStoryboard([growth]).turn;
  assert.match(plan.directorNote, /实际能力阶级没有变化/);
  assert.match(plan.sequence[0].motionPrompt, /without targeting charmander/);
  assert.match(plan.sequence[0].motionPrompt, /already at their limit and do not change/);
  assert.match(plan.sequence[0].motionPrompt, /no projectile, contact, or damage reaction/);
  assert.doesNotMatch(plan.sequence[0].motionPrompt, /green light pulses inward.*strengthen/);
  assert.doesNotMatch(plan.sequence[0].motionPrompt, /firmer, more confident stance/);
  assert.doesNotMatch(plan.sequence[0].motionPrompt, /takes effect on charmander/);
  const sanitizedGrowth = sanitizeAttackRecords(JSON.parse(JSON.stringify(records)))
    .find((record) => record.move.id === "growth");
  assert.equal(sanitizedGrowth.outcome.effectMode, "self_stat");
});

test("对敌能力变化招式记录目标与实际阶级，不生成伤害反应", () => {
  const battle = createBattle();
  battle.player.active = 1;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 2 },
    createSequenceRng([0, 0, 0, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  const tailWhip = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 })
    .find((record) => record.move.id === "tailWhip");
  assert.equal(tailWhip.outcome.effectMode, "foe_stat");
  assert.deepEqual(tailWhip.outcome.statChanges, [
    { targetSide: "opponent", stat: "defense", delta: -1 },
  ]);
  const plan = createFallbackStoryboard([tailWhip]).turn;
  assert.match(plan.directorNote, /小火龙的防御降低 1 级/);
  assert.match(plan.sequence[0].motionPrompt, /causes no damage impact/);
  assert.match(plan.sequence[0].motionPrompt, /without a hit reaction/);
});

test("对敌能力已降至下限时，收势分镜明确目标没有变化", () => {
  const battle = createBattle();
  battle.player.active = 1;
  battle.opponent.team[0].stages.defense = -6;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 2 },
    createSequenceRng([0, 0, 0, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  const tailWhip = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 })
    .find((record) => record.move.id === "tailWhip");
  assert.equal(tailWhip.outcome.effectMode, "foe_stat");
  assert.deepEqual(tailWhip.outcome.statChanges, []);
  const plan = createFallbackStoryboard([tailWhip]).turn;
  assert.match(plan.directorNote, /实际能力阶级没有变化/);
  assert.match(plan.sequence[0].motionPrompt, /already at their limit and do not change/);
  assert.match(plan.sequence[0].motionPrompt, /remains unchanged/);
  assert.doesNotMatch(plan.sequence[0].motionPrompt, /shows the stat change/);
});

test("回合末异常伤害导致的濒死不会归给之前的直接攻击", () => {
  const move = resolvedTurn().events.find((event) => event.type === "move");
  const events = [
    move,
    { type: "damage", targetSide: move.targetSide, amount: 12, currentHp: 1, maxHp: move.target.maxHp, source: move.move.id, critical: false, effectiveness: 1 },
    { type: "damage", targetSide: move.targetSide, amount: 1, currentHp: 0, maxHp: move.target.maxHp, source: "burn" },
    { type: "faint", targetSide: move.targetSide },
  ];
  const [record] = buildAttackRecords(events, { battleEpoch: 0, turn: 1 });
  assert.equal(record.outcome.fainted, false);
  assert.equal(record.outcome.damage, 12);
});

test("只有招式直接伤害把 HP 降为 0 时才记录直接击倒", () => {
  const move = resolvedTurn().events.find((event) => event.type === "move");
  const events = [
    move,
    { type: "damage", targetSide: move.targetSide, amount: 12, currentHp: 0, maxHp: move.target.maxHp, source: move.move.id, critical: false, effectiveness: 1 },
    { type: "faint", targetSide: move.targetSide },
  ];
  const [record] = buildAttackRecords(events, { battleEpoch: 0, turn: 1 });
  assert.equal(record.outcome.fainted, true);
});

test("直接击倒的收势只让攻击方站稳，目标保持倒地", () => {
  const battle = createBattle();
  battle.player.active = 1;
  battle.opponent.team[0].hp = 1;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 1 },
    createSequenceRng([0, 0.5, 0.5, 0, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  const tackle = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 })
    .find((record) => record.move.id === "tackle");
  assert.equal(tackle.outcome.fainted, true);
  const plan = createFallbackStoryboard([tackle]).turn;
  assert.deepEqual(plan.sequence.map((beat) => beat.purpose), ["setup", "payoff"]);
  const aftermath = plan.sequence[1].motionPrompt;
  assert.match(aftermath, /target completes the faint reaction and remains down/);
  assert.match(aftermath, /only the attacker settles back/);
  assert.doesNotMatch(aftermath, /both bodies.*recover their footing/);

  const compressed = {
    version: 2,
    sequence: [{
      ...plan.sequence[1],
      purpose: "complete",
      startAnchor: "idle",
      endAnchor: "recovery",
    }],
  };
  const normalized = normalizeStoryboardPlan(compressed, [tackle]);
  assert.deepEqual(normalized.turn.sequence.map((beat) => beat.purpose), ["complete"]);
  assert.match(normalized.turn.sequence[0].motionPrompt, /complete attack in this single five-second clip/);

  const brokenSetupTail = {
    version: 2,
    sequence: plan.sequence.map((beat) => structuredClone(beat)),
  };
  brokenSetupTail.sequence[0].shots[0].subject = "both";
  brokenSetupTail.sequence[0].shots.at(-1).subject = "target";
  assert.throws(() => normalizeStoryboardPlan(brokenSetupTail, [tackle]), /最后镜头必须保留已蓄势的攻击方/);
});

test("挣扎反伤与双方倒下会进入不可变记录和收势分镜", () => {
  const battle = createBattle();
  battle.opponent.team[2] = createPokemon("gastly", 50, "opponent-2-gastly");
  battle.player.team[0].moves.forEach((move) => { move.pp = 0; });
  battle.player.team[0].hp = 28;
  battle.opponent.active = 2;
  battle.opponent.team[2].hp = 1;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 0 },
    createSequenceRng([0.5, 0.5, 0, 0, 0.5]),
    { type: "move", moveIndex: 0 },
  );
  const [struggle] = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  assert.equal(struggle.move.id, "struggle");
  assert.equal(struggle.outcome.fainted, true);
  assert.equal(struggle.outcome.recoilDamage, 28);
  assert.equal(struggle.outcome.actorFainted, true);
  assert.equal(sanitizeAttackRecords([JSON.parse(JSON.stringify(struggle))])[0].outcome.actorFainted, true);
  const plan = createFallbackStoryboard([struggle]).turn;
  assert.match(plan.directorNote, /反作用力并倒下/);
  assert.deepEqual(plan.sequence.map((beat) => beat.purpose), ["setup", "payoff"]);
  assert.match(plan.sequence[1].motionPrompt, /both remain fainted/);
  assert.match(plan.sequence[1].motionPrompt, /neither combatant recovers its footing/);
  assert.doesNotMatch(plan.sequence[1].motionPrompt, /only the attacker settles back/);

  const missingRecoil = JSON.parse(JSON.stringify(struggle));
  missingRecoil.outcome.recoilDamage = 0;
  missingRecoil.outcome.actorFainted = false;
  assert.throws(() => sanitizeAttackRecords([missingRecoil]), /反作用力结果/);

  const forgedRecoil = JSON.parse(JSON.stringify(
    buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 })[0],
  ));
  forgedRecoil.outcome.recoilDamage = 1;
  forgedRecoil.outcome.actorFainted = true;
  assert.throws(() => sanitizeAttackRecords([forgedRecoil]), /非反作用力结果/);
});

test("挣扎击倒目标但反伤后存活时会演出反伤并保持站立", () => {
  const battle = createBattle();
  battle.opponent.team[2] = createPokemon("gastly", 50, "opponent-2-gastly");
  battle.player.team[0].moves.forEach((move) => { move.pp = 0; });
  battle.opponent.active = 2;
  battle.opponent.team[2].hp = 1;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 0 },
    createSequenceRng([0.5, 0.5, 0, 0, 0.5]),
    { type: "move", moveIndex: 0 },
  );
  const [struggle] = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  assert.equal(struggle.actor.currentHp, 110);
  assert.equal(struggle.outcome.fainted, true);
  assert.equal(struggle.outcome.recoilDamage, 28);
  assert.equal(struggle.outcome.actorFainted, false);
  const aftermath = createFallbackStoryboard([struggle]).turn.sequence[1].motionPrompt;
  assert.match(aftermath, /authoritative 28 HP recoil/);
  assert.match(aftermath, /then remains standing/);
  assert.doesNotMatch(aftermath, /only the attacker settles back/);

  const forgedFaint = JSON.parse(JSON.stringify(struggle));
  forgedFaint.outcome.actorFainted = true;
  assert.throws(() => sanitizeAttackRecords([forgedFaint]), /反作用力结果/);
});

test("挣扎反伤令攻击方倒下时以双方终态收尾，不会错误只拍目标", () => {
  const battle = createBattle();
  battle.opponent.team[2] = createPokemon("gastly", 50, "opponent-2-gastly");
  battle.player.team[0].moves.forEach((move) => { move.pp = 0; });
  battle.player.team[0].hp = 28;
  battle.opponent.active = 2;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 0 },
    createSequenceRng([0.5, 0.5, 0, 0, 0.5]),
    { type: "move", moveIndex: 0 },
  );
  const [struggle] = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  assert.equal(struggle.outcome.fainted, false);
  assert.equal(struggle.outcome.actorFainted, true);
  const plan = createFallbackStoryboard([struggle]).turn;
  assert.deepEqual(plan.sequence.map((beat) => beat.purpose), ["setup", "payoff"]);
  assert.equal(plan.sequence[1].shots.at(-1).subject, "both");
  assert.match(plan.sequence[1].motionPrompt, /attacker.*collapses and remains fainted/);
});

test("火系伤害解除冰冻会进入记录、提示词与跨行动 HP 状态核验", () => {
  const battle = createBattle();
  battle.player.active = 1;
  battle.player.team[1].status = "freeze";
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 0 },
    createSequenceRng([0, 0.5, 0.5, 0.5, 0, 0.5, 0.5]),
    { type: "move", moveIndex: 0 },
  );
  const records = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  const ember = records.find((record) => record.move.id === "ember");
  assert.equal(ember.target.status, "freeze");
  assert.equal(ember.outcome.clearedStatus, "freeze");
  assert.equal(sanitizeAttackRecords(JSON.parse(JSON.stringify(records)))[0].outcome.clearedStatus, "freeze");
  const plan = createFallbackStoryboard([ember]).turn;
  assert.match(plan.directorNote, /解除了杰尼龟的 freeze/);
  assert.match(plan.sequence[0].motionPrompt, /melts and clears.*existing freeze/);
  assert.match(plan.sequence[0].motionPrompt, /visibly free of the previous freeze/);

  const brokenHpTransition = JSON.parse(JSON.stringify(records));
  brokenHpTransition[1].actor.currentHp += 1;
  assert.throws(() => sanitizeAttackRecords(brokenHpTransition), /跨行动当前 HP 不连续/);
});

test("下一位行动者自然醒来不会被误归因成上一招解除状态", () => {
  const battle = createBattle();
  battle.opponent.team[0].status = "sleep";
  battle.opponent.team[0].statusTurns = 0;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 1 },
    createSequenceRng([0, 0.5, 0.5, 0, 0.5, 0.5]),
    { type: "move", moveIndex: 0 },
  );
  const records = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 });
  assert.equal(records.length, 2);
  assert.equal(records[0].move.id, "quickAttack");
  assert.equal(records[0].outcome.clearedStatus, null);
  assert.equal(records[1].actor.status, null);
  assert.equal(sanitizeAttackRecords(JSON.parse(JSON.stringify(records))).length, 2);
});

test("伤害招式附带的新异常状态会贯穿命中与收势分镜", () => {
  const result = resolvedTurn(
    { type: "move", moveIndex: 0 },
    { type: "move", moveIndex: 2 },
  );
  const thunderbolt = buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 })
    .find((record) => record.move.id === "thunderbolt");
  assert.equal(thunderbolt.outcome.status, "paralysis");
  assert.equal(sanitizeAttackRecords([JSON.parse(JSON.stringify(thunderbolt))])[0].outcome.status, "paralysis");
  const plan = createFallbackStoryboard([thunderbolt]).turn;
  assert.match(plan.directorNote, /paralysis/);
  assert.match(plan.sequence[0].motionPrompt, /enters the continuing paralysis state/);
  assert.match(plan.sequence[0].motionPrompt, /retains the continuing paralysis state/);
});

test("DeepSeek 分镜只接收镜头字段，战斗事实由本地记录回填", () => {
  const records = buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 });
  const fallback = createFallbackStoryboard(records);
  const candidate = {
    version: 2,
    sequence: fallback.turn.sequence.map((beat) => ({
      ...beat,
      title: "模型提供的标题",
      directorNote: "实际造成 99999 点伤害",
      motionPrompt: "小火龙反过来击倒皮卡丘",
      outcome: { damage: 99999 },
    })),
  };
  const normalized = normalizeStoryboardPlan(candidate, records);
  assert.equal(normalized.turn.attacks[0].outcome.damage, records[0].outcome.damage);
  assert.notEqual(normalized.turn.attacks[0].outcome.damage, 99999);
  assert.equal(normalized.turn.title, "皮卡丘 ⇄ 小火龙");
  assert.doesNotMatch(normalized.turn.directorNote, /99999/);
  assert.doesNotMatch(normalized.turn.sequence[0].motionPrompt, /反过来击倒/);
  assert.match(normalized.turn.sequence[0].motionPrompt, /pikachu \(皮卡丘\).*charmander \(小火龙\)/);
  assert.match(normalized.turn.sequence[0].motionPrompt, /no game UI.*text.*logos.*extra creatures/);
});

test("不连续锚点的模型响应会被拒绝", () => {
  const records = buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 });
  const fallback = createFallbackStoryboard(records);
  const candidate = {
    version: 2,
    sequence: fallback.turn.sequence.map((beat) => ({ ...beat })),
  };
  candidate.sequence[0].startAnchor = "charged";
  assert.throws(() => normalizeStoryboardPlan(candidate, records), /精简连续模板/);
});

test("分镜内镜头必须以 2 至 3 镜无缝覆盖完整 5 秒", () => {
  const records = buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 });
  const fallback = createFallbackStoryboard(records);

  const gap = { version: 2, sequence: fallback.turn.sequence.map((beat) => structuredClone(beat)) };
  gap.sequence[0].shots[1].startAt = 1.4;
  assert.throws(() => normalizeStoryboardPlan(gap, records), /连续覆盖/);

  const epsilonGaps = { version: 2, sequence: fallback.turn.sequence.map((beat) => structuredClone(beat)) };
  epsilonGaps.sequence[0].shots[0].startAt = 0.0009;
  epsilonGaps.sequence[0].shots[1].startAt = 1.2009;
  epsilonGaps.sequence[0].shots.at(-1).endAt = 4.9991;
  assert.throws(() => normalizeStoryboardPlan(epsilonGaps, records), /连续覆盖/);

  const oneShot = { version: 2, sequence: fallback.turn.sequence.map((beat) => structuredClone(beat)) };
  oneShot.sequence[0].shots = [{ index: 0, startAt: 0, endAt: 5, shotSize: "wide", subject: "both", cameraMovement: "locked" }];
  assert.throws(() => normalizeStoryboardPlan(oneShot, records), /2 至 3 个镜头/);

  const cutOnImpact = { version: 2, sequence: fallback.turn.sequence.map((beat) => structuredClone(beat)) };
  cutOnImpact.sequence[0].shots = [
    { index: 0, startAt: 0, endAt: 2.8, shotSize: "wide", subject: "both", cameraMovement: "lateral_track" },
    { index: 1, startAt: 2.8, endAt: 5, shotSize: "close_up", subject: "target", cameraMovement: "impact_push" },
  ];
  assert.throws(() => normalizeStoryboardPlan(cutOnImpact, records), /同步点必须落在一个镜头内部/);

  const tooMany = { version: 2, sequence: fallback.turn.sequence.map((beat) => structuredClone(beat)) };
  tooMany.sequence[0].shots = [
    { index: 0, startAt: 0, endAt: 1, shotSize: "close_up", subject: "actor", cameraMovement: "locked" },
    { index: 1, startAt: 1, endAt: 2, shotSize: "medium", subject: "actor", cameraMovement: "locked" },
    { index: 2, startAt: 2, endAt: 3, shotSize: "wide", subject: "both", cameraMovement: "locked" },
    { index: 3, startAt: 3, endAt: 5, shotSize: "extreme_wide", subject: "both", cameraMovement: "locked" },
  ];
  assert.throws(() => normalizeStoryboardPlan(tooMany, records), /2 至 3 个镜头/);

  const effectsOnly = { version: 2, sequence: fallback.turn.sequence.map((beat) => structuredClone(beat)) };
  effectsOnly.sequence[0].shots = effectsOnly.sequence[0].shots.map((shot) => ({
    ...shot,
    shotSize: "extreme_close_up",
    subject: "move_effect",
  }));
  assert.throws(() => normalizeStoryboardPlan(effectsOnly, records), /开场必须展示攻击方或双方/);

  const noSharedGeography = { version: 2, sequence: fallback.turn.sequence.map((beat) => structuredClone(beat)) };
  noSharedGeography.sequence[0].shots = noSharedGeography.sequence[0].shots.map((shot, index) => ({
    ...shot,
    subject: index === 0 ? "actor" : "target",
  }));
  assert.throws(() => normalizeStoryboardPlan(noSharedGeography, records), /至少包含一个双方同场镜头/);
});

test("联合时间线缺少任一镜头或打乱攻击顺序都会被拒绝", () => {
  const records = buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 });
  const fallback = createFallbackStoryboard(records);
  const missing = { version: 2, sequence: fallback.turn.sequence.slice(0, -1) };
  assert.throws(() => normalizeStoryboardPlan(missing, records), /每次攻击提供 1 个完整分镜/);

  const reordered = { version: 2, sequence: fallback.turn.sequence.map((beat) => ({ ...beat })) };
  reordered.sequence[0].attackId = records[1].id;
  assert.throws(() => normalizeStoryboardPlan(reordered, records), /攻击顺序与战斗记录不一致/);

  const duplicatedRoutine = {
    version: 2,
    sequence: [
      { ...fallback.turn.sequence[0], purpose: "setup", startAnchor: "idle", endAnchor: "charged", impactAt: null },
      { ...fallback.turn.sequence[0], purpose: "payoff", startAnchor: "charged", endAnchor: "recovery" },
      fallback.turn.sequence[1],
    ],
  };
  assert.throws(() => normalizeStoryboardPlan(duplicatedRoutine, records), /普通攻击必须在单个 5 秒分镜内完整表现/);
});

test("网关会清洗攻击输入并限制每回合最多两次攻击", () => {
  const records = buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 });
  const sanitized = sanitizeAttackRecords(JSON.parse(JSON.stringify(records)));
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].move.name, records[0].move.name);
  assert.throws(() => sanitizeAttackRecords([...records, records[0]]), /1 至 2/);
});

test("网关拒绝伪造能力名、零级变化及 self/foe 矛盾事实", () => {
  const battle = createBattle();
  battle.player.active = 2;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 3 },
    createSequenceRng([0, 0, 0, 0, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  const record = JSON.parse(JSON.stringify(
    buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 }).find((entry) => entry.move.id === "growth"),
  ));

  const invalidStat = structuredClone(record);
  invalidStat.outcome.statChanges[0].stat = "ignore_previous_instructions";
  assert.throws(() => sanitizeAttackRecords([invalidStat]), /能力名称无效/);

  const zeroDelta = structuredClone(record);
  zeroDelta.outcome.statChanges[0].delta = 0;
  assert.throws(() => sanitizeAttackRecords([zeroDelta]), /能力变化级数无效/);

  const contradictoryTarget = structuredClone(record);
  contradictoryTarget.outcome.statChanges[0].targetSide = "opponent";
  assert.throws(() => sanitizeAttackRecords([contradictoryTarget]), /矛盾的能力变化目标/);

  const contradictoryMode = structuredClone(record);
  contradictoryMode.outcome.effectMode = "foe_stat";
  assert.throws(() => sanitizeAttackRecords([contradictoryMode]), /effectMode 与攻击事实不一致/);

  const wrongCanonicalStat = structuredClone(record);
  wrongCanonicalStat.outcome.statChanges[0].stat = "evasion";
  assert.throws(() => sanitizeAttackRecords([wrongCanonicalStat]), /能力变化与招式定义或变化前阶级不一致/);

  const wrongDirection = structuredClone(record);
  wrongDirection.outcome.statChanges[0].delta = -1;
  assert.throws(() => sanitizeAttackRecords([wrongDirection]), /能力变化与招式定义或变化前阶级不一致/);

  const excessiveStages = structuredClone(record);
  excessiveStages.outcome.statChanges[0].delta = 2;
  assert.throws(() => sanitizeAttackRecords([excessiveStages]), /能力变化与招式定义或变化前阶级不一致/);

  const impossibleMove = structuredClone(record);
  impossibleMove.actor.speciesId = "pikachu";
  impossibleMove.actor.name = "皮卡丘";
  impossibleMove.actor.dex = 25;
  assert.throws(() => sanitizeAttackRecords([impossibleMove]), /该物种不能使用此招式/);

  const impossibleStatus = structuredClone(record);
  impossibleStatus.outcome.status = "burn";
  impossibleStatus.outcome.effectMode = "status";
  assert.throws(() => sanitizeAttackRecords([impossibleStatus]), /异常状态与招式定义或目标原状态不一致/);

  const impossibleGrowthMiss = structuredClone(record);
  impossibleGrowthMiss.outcome.missed = true;
  impossibleGrowthMiss.outcome.statChanges = [];
  impossibleGrowthMiss.outcome.effectMode = "miss";
  impossibleGrowthMiss.outcome.damageTier = "none";
  assert.throws(() => sanitizeAttackRecords([impossibleGrowthMiss]), /必中的招式不能标记落空/);
});

test("网关拒绝落空或免疫后夹带效果以及非布尔战斗标记", () => {
  const base = JSON.parse(JSON.stringify(
    buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 })
      .find((entry) => entry.move.id === "thunderbolt"),
  ));

  const missedWithStatus = structuredClone(base);
  Object.assign(missedWithStatus.outcome, {
    damage: 0,
    damageRatio: 0,
    critical: false,
    effectiveness: null,
    missed: true,
    fainted: false,
    status: "paralysis",
    statChanges: [],
    effectMode: "miss",
    damageTier: "none",
  });
  assert.throws(() => sanitizeAttackRecords([missedWithStatus]), /落空或免疫不能附带/);

  const immuneWithStat = structuredClone(base);
  Object.assign(immuneWithStat.outcome, {
    damage: 0,
    damageRatio: 0,
    critical: false,
    effectiveness: 0,
    missed: false,
    fainted: false,
    status: null,
    statChanges: [{ targetSide: "opponent", stat: "defense", delta: -1 }],
    effectMode: "immune",
    damageTier: "none",
  });
  immuneWithStat.move.id = "ironTail";
  immuneWithStat.move.name = "铁尾";
  immuneWithStat.move.type = "steel";
  immuneWithStat.move.category = "physical";
  immuneWithStat.move.power = 100;
  immuneWithStat.move.priority = 0;
  assert.throws(() => sanitizeAttackRecords([immuneWithStat]), /落空或免疫不能附带/);

  const stringBoolean = structuredClone(base);
  stringBoolean.outcome.missed = "false";
  assert.throws(() => sanitizeAttackRecords([stringBoolean]), /missed 必须是布尔值/);

  const zeroDamageCritical = structuredClone(base);
  Object.assign(zeroDamageCritical.outcome, {
    damage: 0,
    damageRatio: 0,
    critical: true,
    effectiveness: null,
    missed: false,
    fainted: false,
    status: null,
    statChanges: [],
    effectMode: "no_effect",
    damageTier: "none",
  });
  assert.throws(() => sanitizeAttackRecords([zeroDamageCritical]), /零伤害不能标记要害或直接击倒/);
});

test("网关把伤害结果绑定到招式威力及目标属性", () => {
  const records = buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 });
  const thunderbolt = JSON.parse(JSON.stringify(records.find((entry) => entry.move.id === "thunderbolt")));
  const growlRecords = buildAttackRecords(
    resolvedTurn({ type: "move", moveIndex: 0 }, { type: "move", moveIndex: 2 }).events,
    { battleEpoch: 0, turn: 1 },
  );
  const growl = JSON.parse(JSON.stringify(growlRecords.find((entry) => entry.move.id === "growl")));

  Object.assign(growl.outcome, {
    damage: 1,
    damageRatio: Number((1 / growl.target.maxHp).toFixed(4)),
    critical: false,
    effectiveness: 1,
    missed: false,
    fainted: false,
    status: null,
    statChanges: [],
    effectMode: "damage",
    damageTier: "light",
  });
  assert.throws(() => sanitizeAttackRecords([growl]), /变化招式不能造成直接伤害/);

  Object.assign(thunderbolt.outcome, {
    damage: 0,
    damageRatio: 0,
    critical: false,
    effectiveness: 1,
    missed: false,
    fainted: false,
    status: null,
    statChanges: [],
    effectMode: "no_effect",
    damageTier: "none",
  });
  assert.throws(() => sanitizeAttackRecords([thunderbolt]), /伤害结果与招式威力及目标属性不一致/);

  const wrongMatchup = JSON.parse(JSON.stringify(records.find((entry) => entry.move.id === "thunderbolt")));
  wrongMatchup.outcome.effectiveness = 0.5;
  assert.throws(() => sanitizeAttackRecords([wrongMatchup]), /伤害结果与招式威力及目标属性不一致/);
});

test("网关从角色快照核验速度节奏、最大 HP 与记录顺序", () => {
  const records = JSON.parse(JSON.stringify(
    buildAttackRecords(resolvedTurn().events, { battleEpoch: 0, turn: 1 }),
  ));
  const base = records[0];

  const fakeTempo = structuredClone(base);
  Object.assign(fakeTempo.tempo, {
    actorSpeed: 1,
    targetSpeed: 10_000,
    speedDelta: 0,
    speedRatio: 1,
    tier: "even",
  });
  assert.throws(() => sanitizeAttackRecords([fakeTempo]), /节奏速度与角色实际速度不一致/);

  const fakeMaxHp = structuredClone(base);
  fakeMaxHp.target.maxHp += 1;
  fakeMaxHp.outcome.damageRatio = Number((fakeMaxHp.outcome.damage / fakeMaxHp.target.maxHp).toFixed(4));
  assert.throws(() => sanitizeAttackRecords([fakeMaxHp]), /最大 HP 与物种数据不一致/);

  const impossibleSurvival = structuredClone(base);
  impossibleSurvival.outcome.damage = impossibleSurvival.target.maxHp;
  impossibleSurvival.outcome.damageRatio = 1;
  impossibleSurvival.outcome.fainted = false;
  impossibleSurvival.outcome.damageTier = "decisive";
  assert.throws(() => sanitizeAttackRecords([impossibleSurvival]), /当前 HP 或击倒结果不一致/);

  const fakeSequence = structuredClone(base);
  fakeSequence.sequenceIndex = 1;
  assert.throws(() => sanitizeAttackRecords([fakeSequence]), /攻击记录标识与回合顺序不一致/);

  assert.throws(() => sanitizeAttackRecords([...records].reverse()), /数组顺序与 sequenceIndex 不一致/);
  assert.throws(() => sanitizeAttackRecords([records[1]]), /数组顺序与 sequenceIndex 不一致/);

  const renumberedReverse = [...records].reverse().map((record, sequenceIndex) => {
    const rewritten = structuredClone(record);
    rewritten.sequenceIndex = sequenceIndex;
    rewritten.id = `${rewritten.battleEpoch}-${rewritten.turn}-${sequenceIndex}-${rewritten.actor.uid}-${rewritten.move.id}`;
    return rewritten;
  });
  assert.throws(() => sanitizeAttackRecords(renumberedReverse), /顺序违反修正后速度/);

  const priorityRecords = JSON.parse(JSON.stringify(buildAttackRecords(
    resolvedTurn({ type: "move", moveIndex: 1 }, { type: "move", moveIndex: 1 }).events,
    { battleEpoch: 0, turn: 1 },
  )));
  const forgedCrossBeatSpeed = structuredClone(priorityRecords);
  forgedCrossBeatSpeed[1].actor.modifiedSpeed = 999;
  forgedCrossBeatSpeed[1].tempo.actorSpeed = 999;
  forgedCrossBeatSpeed[1].tempo.speedDelta = 999 - forgedCrossBeatSpeed[1].target.modifiedSpeed;
  forgedCrossBeatSpeed[1].tempo.speedRatio = Number(
    (999 / forgedCrossBeatSpeed[1].target.modifiedSpeed).toFixed(3),
  );
  forgedCrossBeatSpeed[1].tempo.tier = "rapid";
  assert.throws(
    () => sanitizeAttackRecords(forgedCrossBeatSpeed),
    /修正后速度与物种、阶级及麻痹状态不一致/,
  );

  const phantomPoison = structuredClone(priorityRecords);
  phantomPoison[1].actor.status = "poison";
  assert.throws(() => sanitizeAttackRecords(phantomPoison), /跨行动主异常状态不连续/);

  const phantomConfusion = structuredClone(priorityRecords);
  phantomConfusion[1].actor.confused = true;
  assert.throws(() => sanitizeAttackRecords(phantomConfusion), /跨行动混乱状态不连续/);

  const impossibleQuickAttackMiss = structuredClone(priorityRecords[0]);
  Object.assign(impossibleQuickAttackMiss.outcome, {
    damage: 0,
    damageRatio: 0,
    critical: false,
    effectiveness: null,
    missed: true,
    fainted: false,
    status: null,
    statChanges: [],
    effectMode: "miss",
    damageTier: "none",
  });
  assert.throws(
    () => sanitizeAttackRecords([impossibleQuickAttackMiss]),
    /当前命中与闪避阶级下招式不可能落空/,
  );

  const impossibleQuickAttackDamage = structuredClone(priorityRecords[0]);
  impossibleQuickAttackDamage.outcome.damage = 1;
  impossibleQuickAttackDamage.outcome.damageRatio = Number(
    (1 / impossibleQuickAttackDamage.target.maxHp).toFixed(4),
  );
  impossibleQuickAttackDamage.outcome.fainted = false;
  impossibleQuickAttackDamage.outcome.damageTier = "light";
  assert.throws(
    () => sanitizeAttackRecords([impossibleQuickAttackDamage]),
    /伤害值不在本地公式的可达范围内/,
  );

  const immuneParalysisSnapshot = structuredClone(priorityRecords[0]);
  immuneParalysisSnapshot.actor.status = "paralysis";
  immuneParalysisSnapshot.actor.paralyzed = true;
  immuneParalysisSnapshot.actor.modifiedSpeed = 55;
  immuneParalysisSnapshot.tempo.actorSpeed = 55;
  immuneParalysisSnapshot.tempo.speedDelta = 55 - immuneParalysisSnapshot.target.modifiedSpeed;
  immuneParalysisSnapshot.tempo.speedRatio = Number(
    (55 / immuneParalysisSnapshot.target.modifiedSpeed).toFixed(3),
  );
  immuneParalysisSnapshot.tempo.tier = "deliberate";
  assert.throws(
    () => sanitizeAttackRecords([immuneParalysisSnapshot]),
    /主异常快照与物种属性免疫不一致/,
  );

  for (const impossibleActorStatus of ["sleep", "freeze"]) {
    const unableToAct = structuredClone(priorityRecords[0]);
    unableToAct.actor.status = impossibleActorStatus;
    assert.throws(
      () => sanitizeAttackRecords([unableToAct]),
      /睡眠或冰冻中的攻击者不可能产生招式记录/,
    );
  }

  const struggleBattle = createBattle();
  struggleBattle.player.team[0].moves.forEach((move) => { move.pp = 0; });
  const struggleRecord = JSON.parse(JSON.stringify(buildAttackRecords(
    resolveTurn(
      struggleBattle,
      { type: "move", moveIndex: 0 },
      createSequenceRng([0, 0.5, 0.5, 0.5, 0.5]),
      { type: "move", moveIndex: 1 },
    ).events,
    { battleEpoch: 0, turn: 1 },
  ).find((entry) => entry.move.id === "struggle")));
  assert.equal(struggleRecord.outcome.critical, true);
  assert.doesNotThrow(() => sanitizeAttackRecords([struggleRecord]));

  const priorityReversed = priorityRecords.reverse().map((record, sequenceIndex) => {
    record.sequenceIndex = sequenceIndex;
    record.id = `${record.battleEpoch}-${record.turn}-${sequenceIndex}-${record.actor.uid}-${record.move.id}`;
    return record;
  });
  assert.throws(() => sanitizeAttackRecords(priorityReversed), /顺序违反招式优先度/);

  const mixedTurn = structuredClone(records);
  mixedTurn[1].turn = 2;
  mixedTurn[1].id = `${mixedTurn[1].battleEpoch}-2-${mixedTurn[1].sequenceIndex}-${mixedTurn[1].actor.uid}-${mixedTurn[1].move.id}`;
  assert.throws(() => sanitizeAttackRecords(mixedTurn), /必须属于同一批次与回合/);

  const duplicateActor = [structuredClone(records[0]), structuredClone(records[0])];
  duplicateActor[1].sequenceIndex = 1;
  duplicateActor[1].id = `${duplicateActor[1].battleEpoch}-${duplicateActor[1].turn}-1-${duplicateActor[1].actor.uid}-${duplicateActor[1].move.id}`;
  assert.throws(() => sanitizeAttackRecords(duplicateActor), /同一对战双方交替执行/);

  const actionAfterFaint = structuredClone(records);
  actionAfterFaint[0].target.currentHp = actionAfterFaint[0].outcome.damage;
  actionAfterFaint[0].outcome.fainted = true;
  actionAfterFaint[0].outcome.status = null;
  actionAfterFaint[0].outcome.damageTier = "decisive";
  assert.throws(() => sanitizeAttackRecords(actionAfterFaint), /首击任一行动者倒下后不能存在第二次行动/);

  const sleepBattle = createBattle();
  sleepBattle.opponent.active = 2;
  sleepBattle.player.team[0].stages.speed = -6;
  const hypnosisRecord = buildAttackRecords(
    resolveTurn(
      sleepBattle,
      { type: "move", moveIndex: 0 },
      createSequenceRng([0, 0, 0, 0, 0]),
      { type: "move", moveIndex: 2 },
    ).events,
    { battleEpoch: 0, turn: 1 },
  )[0];
  assert.equal(hypnosisRecord.outcome.status, "sleep");

  const actingBattle = createBattle();
  actingBattle.opponent.active = 2;
  actingBattle.player.team[0].stages.speed = -6;
  const thunderboltAfterGastly = buildAttackRecords(
    resolveTurn(
      actingBattle,
      { type: "move", moveIndex: 0 },
      createSequenceRng([0, 0.5, 0.5, 0.5, 0.5, 0.5]),
      { type: "move", moveIndex: 0 },
    ).events,
    { battleEpoch: 0, turn: 1 },
  )[1];
  assert.equal(thunderboltAfterGastly.actor.speciesId, "pikachu");
  assert.throws(
    () => sanitizeAttackRecords(JSON.parse(JSON.stringify([hypnosisRecord, thunderboltAfterGastly]))),
    /首击施加睡眠后不能存在第二次攻击/,
  );

  const alternateBattle = createBattle();
  alternateBattle.player.active = 1;
  alternateBattle.opponent.active = 1;
  const alternateRecords = JSON.parse(JSON.stringify(buildAttackRecords(
    resolveTurn(
      alternateBattle,
      { type: "move", moveIndex: 1 },
      createSequenceRng([0, 0.5, 0.5, 0, 0.5, 0.5]),
      { type: "move", moveIndex: 1 },
    ).events,
    { battleEpoch: 0, turn: 1 },
  )));
  const mixedCombatants = [structuredClone(records[0]), structuredClone(alternateRecords[1])];
  assert.throws(() => sanitizeAttackRecords(mixedCombatants), /同一对战双方交替执行/);

  const bulldozeBattle = createBattle();
  bulldozeBattle.opponent.team[1] = createPokemon("geodude", 50, "opponent-1-geodude");
  bulldozeBattle.player.active = 1;
  bulldozeBattle.opponent.active = 1;
  bulldozeBattle.opponent.team[1].stages.speed = 6;
  const bulldozeRecords = JSON.parse(JSON.stringify(buildAttackRecords(
    resolveTurn(
      bulldozeBattle,
      { type: "move", moveIndex: 1 },
      createSequenceRng([0, 0.5, 0.5, 0, 0.5, 0.5]),
      { type: "move", moveIndex: 3 },
    ).events,
    { battleEpoch: 0, turn: 1 },
  )));
  assert.equal(bulldozeRecords[0].move.id, "bulldoze");
  assert.equal(bulldozeRecords[0].target.modifiedSpeed, 63);
  assert.equal(bulldozeRecords[1].actor.speedStage, -1);
  assert.equal(bulldozeRecords[1].actor.modifiedSpeed, 42);
  assert.doesNotThrow(() => sanitizeAttackRecords(bulldozeRecords));

  const omittedBulldozeDrop = structuredClone(bulldozeRecords);
  omittedBulldozeDrop[0].outcome.statChanges = [];
  omittedBulldozeDrop[1].actor.stages.speed = 0;
  omittedBulldozeDrop[1].actor.speedStage = 0;
  omittedBulldozeDrop[1].actor.modifiedSpeed = 63;
  omittedBulldozeDrop[1].tempo.actorSpeed = 63;
  omittedBulldozeDrop[1].tempo.speedDelta = 63 - omittedBulldozeDrop[1].target.modifiedSpeed;
  omittedBulldozeDrop[1].tempo.speedRatio = Number(
    (63 / omittedBulldozeDrop[1].target.modifiedSpeed).toFixed(3),
  );
  omittedBulldozeDrop[1].tempo.tier = "deliberate";
  assert.throws(
    () => sanitizeAttackRecords(omittedBulldozeDrop),
    /缺少必定发生的能力变化/,
  );

  const impossibleLowerAtFloor = structuredClone(bulldozeRecords[0]);
  impossibleLowerAtFloor.target.stages.speed = -6;
  impossibleLowerAtFloor.target.speedStage = -6;
  impossibleLowerAtFloor.target.modifiedSpeed = 15;
  impossibleLowerAtFloor.tempo.targetSpeed = 15;
  impossibleLowerAtFloor.tempo.speedDelta = impossibleLowerAtFloor.actor.modifiedSpeed - 15;
  impossibleLowerAtFloor.tempo.speedRatio = Number(
    (impossibleLowerAtFloor.actor.modifiedSpeed / 15).toFixed(3),
  );
  impossibleLowerAtFloor.tempo.tier = "rapid";
  assert.throws(
    () => sanitizeAttackRecords([impossibleLowerAtFloor]),
    /能力变化与招式定义或变化前阶级不一致/,
  );

  const forgedBulldozeSpeed = structuredClone(bulldozeRecords);
  forgedBulldozeSpeed[1].actor.modifiedSpeed = 252;
  forgedBulldozeSpeed[1].tempo.actorSpeed = 252;
  forgedBulldozeSpeed[1].tempo.speedDelta = 252 - forgedBulldozeSpeed[1].target.modifiedSpeed;
  forgedBulldozeSpeed[1].tempo.speedRatio = Number(
    (252 / forgedBulldozeSpeed[1].target.modifiedSpeed).toFixed(3),
  );
  forgedBulldozeSpeed[1].tempo.tier = "rapid";
  assert.throws(
    () => sanitizeAttackRecords(forgedBulldozeSpeed),
    /修正后速度与物种、阶级及麻痹状态不一致/,
  );

  const forgedReversedSpeed = [...records].reverse().map((record, sequenceIndex) => {
    const rewritten = structuredClone(record);
    rewritten.sequenceIndex = sequenceIndex;
    rewritten.id = `${rewritten.battleEpoch}-${rewritten.turn}-${sequenceIndex}-${rewritten.actor.uid}-${rewritten.move.id}`;
    rewritten.actor.modifiedSpeed = sequenceIndex === 0 ? 999 : 1;
    rewritten.target.modifiedSpeed = sequenceIndex === 0 ? 1 : 999;
    rewritten.tempo.actorSpeed = rewritten.actor.modifiedSpeed;
    rewritten.tempo.targetSpeed = rewritten.target.modifiedSpeed;
    rewritten.tempo.speedDelta = rewritten.actor.modifiedSpeed - rewritten.target.modifiedSpeed;
    rewritten.tempo.speedRatio = Number(
      (rewritten.actor.modifiedSpeed / rewritten.target.modifiedSpeed).toFixed(3),
    );
    rewritten.tempo.tier = sequenceIndex === 0 ? "rapid" : "deliberate";
    return rewritten;
  });
  assert.throws(
    () => sanitizeAttackRecords(forgedReversedSpeed),
    /修正后速度与物种、阶级及麻痹状态不一致/,
  );

  const duplicateParalysis = structuredClone(records[0]);
  duplicateParalysis.target.status = "paralysis";
  duplicateParalysis.target.paralyzed = true;
  duplicateParalysis.target.modifiedSpeed = 42;
  duplicateParalysis.tempo.targetSpeed = 42;
  duplicateParalysis.tempo.speedDelta = duplicateParalysis.actor.modifiedSpeed - 42;
  duplicateParalysis.tempo.speedRatio = Number((duplicateParalysis.actor.modifiedSpeed / 42).toFixed(3));
  duplicateParalysis.tempo.tier = "rapid";
  assert.equal(duplicateParalysis.outcome.status, "paralysis");
  assert.throws(
    () => sanitizeAttackRecords([duplicateParalysis]),
    /异常状态与招式定义或目标原状态不一致/,
  );

  const burnBattle = createBattle();
  burnBattle.player.active = 1;
  const burnRecords = JSON.parse(JSON.stringify(buildAttackRecords(
    resolveTurn(
      burnBattle,
      { type: "move", moveIndex: 0 },
      createSequenceRng([0, 0, 0, 0, 0, 0, 0, 0]),
      { type: "move", moveIndex: 0 },
    ).events,
    { battleEpoch: 0, turn: 1 },
  )));
  assert.equal(burnRecords[0].move.id, "ember");
  assert.equal(burnRecords[0].outcome.status, "burn");
  assert.equal(burnRecords[1].actor.status, "burn");
  assert.doesNotThrow(() => sanitizeAttackRecords(burnRecords));

  const vanishedBurn = structuredClone(burnRecords);
  vanishedBurn[1].actor.status = null;
  assert.throws(() => sanitizeAttackRecords(vanishedBurn), /跨行动主异常状态不连续/);
});
