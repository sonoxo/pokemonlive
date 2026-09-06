import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateDamage,
  calculateStats,
  chooseAiAction,
  createBattle,
  createPokemon,
  createSequenceRng,
  getActive,
  getMoveChoices,
  resolveForcedSwitch,
  resolveTurn,
  stageMultiplier,
  typeEffectiveness,
} from "../src/battle-engine.js";
import { MOVES } from "../src/data.js";

test("等级 50 的能力值使用固定 IV 31、EV 0、中性性格", () => {
  const stats = calculateStats({ hp: 35, attack: 55, defense: 40, specialAttack: 50, specialDefense: 50, speed: 90 }, 50);
  assert.deepEqual(stats, { hp: 110, attack: 75, defense: 60, specialAttack: 70, specialDefense: 70, speed: 110 });
});

test("双属性相克会叠乘，免疫优先得到 0", () => {
  assert.equal(typeEffectiveness("grass", ["rock", "ground"]), 4);
  assert.equal(typeEffectiveness("electric", ["water", "flying"]), 4);
  assert.equal(typeEffectiveness("electric", ["water", "ground"]), 0);
  assert.equal(typeEffectiveness("normal", ["ghost", "poison"]), 0);
});

test("现代能力阶级被限制在 -6 至 +6", () => {
  assert.equal(stageMultiplier(0), 1);
  assert.equal(stageMultiplier(2), 2);
  assert.equal(stageMultiplier(-2), 0.5);
  assert.equal(stageMultiplier(99), 4);
  assert.equal(stageMultiplier(-99), 0.25);
});

test("伤害公式应用等级、威力、攻防、随机数、STAB 与属性相克", () => {
  const pikachu = createPokemon("pikachu");
  const charmander = createPokemon("charmander");
  const waterTarget = createPokemon("charmander");
  waterTarget.types = ["water"];
  const neutral = calculateDamage(pikachu, charmander, MOVES.thunderbolt, () => 0.5, {
    forceCritical: false,
    randomPercent: 100,
  });
  const superEffective = calculateDamage(pikachu, waterTarget, MOVES.thunderbolt, () => 0.5, {
    forceCritical: false,
    randomPercent: 100,
  });
  assert.equal(neutral.damage, 61);
  assert.equal(superEffective.damage, 122);
  assert.equal(superEffective.effectiveness, 2);
});

test("要害会忽略攻击方负阶级和防守方正阶级", () => {
  const attacker = createPokemon("pikachu");
  const defender = createPokemon("charmander");
  const neutralCritical = calculateDamage(attacker, defender, MOVES.quickAttack, () => 0.5, {
    forceCritical: true,
    randomPercent: 100,
  });
  attacker.stages.attack = -6;
  defender.stages.defense = 6;
  const stagedCritical = calculateDamage(attacker, defender, MOVES.quickAttack, () => 0.5, {
    forceCritical: true,
    randomPercent: 100,
  });
  assert.equal(stagedCritical.damage, neutralCritical.damage);
});

test("优先度高的招式先于速度更快的对手", () => {
  const battle = createBattle();
  battle.player.active = 1;
  battle.player.team[1].moves[0] = { id: "quickAttack", pp: MOVES.quickAttack.maxPp };
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 0 },
    createSequenceRng([0, 0.5, 0.5, 0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  const moveEvents = result.events.filter((event) => event.type === "move");
  assert.equal(moveEvents[0].actorSide, "player");
  assert.equal(moveEvents[0].moveId, "quickAttack");
});

test("主动换人先结算，换入者承受对手本回合攻击，换出者阶级清空", () => {
  const battle = createBattle();
  battle.player.team[0].stages.attack = 3;
  const incomingHp = battle.player.team[1].hp;
  const result = resolveTurn(
    battle,
    { type: "switch", teamIndex: 1 },
    createSequenceRng([0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  assert.equal(result.state.player.active, 1);
  assert.equal(result.state.player.team[0].stages.attack, 0);
  assert.ok(result.state.player.team[1].hp < incomingHp);
});

test("伤药回复 20 HP、消耗库存，并先于敌方招式执行", () => {
  const battle = createBattle();
  battle.player.team[0].hp -= 40;
  const startHp = battle.player.team[0].hp;
  const result = resolveTurn(
    battle,
    { type: "item", itemId: "potion", teamIndex: 0 },
    createSequenceRng([0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  const itemEventIndex = result.events.findIndex((event) => event.type === "item");
  const enemyMoveIndex = result.events.findIndex((event) => event.type === "move" && event.actorSide === "opponent");
  assert.equal(result.state.player.items.potion, 1);
  assert.ok(result.events.some((event) => event.type === "heal" && event.amount === 20));
  assert.ok(itemEventIndex < enemyMoveIndex);
  assert.ok(result.state.player.team[0].hp > startHp - 30);
});

test("灼伤在回合结束造成最大 HP 的 1/16 伤害", () => {
  const battle = createBattle();
  const player = getActive(battle, "player");
  player.status = "burn";
  const expected = Math.floor(player.stats.hp / 16);
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 1 },
    createSequenceRng([0, 0.5, 0.5, 0, 0.5, 0.5]),
    { type: "move", moveIndex: 2 },
  );
  const residual = result.events.find((event) => event.type === "damage" && event.source === "burn");
  assert.equal(residual.amount, expected);
});

test("濒死后必须替换，强制替换本身不触发敌方行动", () => {
  const battle = createBattle();
  battle.player.team[1].hp = 1;
  const turn = resolveTurn(
    battle,
    { type: "switch", teamIndex: 1 },
    createSequenceRng([0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  assert.equal(turn.state.phase, "must-switch");
  assert.equal(turn.state.player.team[1].hp, 0);

  const switched = resolveForcedSwitch(turn.state, 2);
  assert.equal(switched.state.phase, "action");
  assert.equal(switched.state.player.active, 2);
  assert.equal(switched.events.filter((event) => event.type === "move").length, 0);
});

test("AI 永远选择仍有 PP 的招式", () => {
  const battle = createBattle();
  battle.opponent.team[0].moves[0].pp = 0;
  const action = chooseAiAction(battle, createSequenceRng([0, 0]));
  assert.notEqual(action.moveIndex, 0);
  assert.ok(battle.opponent.team[0].moves[action.moveIndex].pp > 0);
});

test("AI 在随机探索分支也不会选择 0 PP 招式", () => {
  const battle = createBattle();
  battle.opponent.team[0].moves.forEach((move, index) => { move.pp = index === 3 ? 1 : 0; });
  const action = chooseAiAction(battle, createSequenceRng([0.99, 0.99]));
  assert.equal(action.moveIndex, 3);
});

test("第七世代起无效果道具会消耗回合但不消耗库存", () => {
  const fullHp = createBattle();
  const potionResult = resolveTurn(
    fullHp,
    { type: "item", itemId: "potion", teamIndex: 0 },
    createSequenceRng([0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  assert.equal(potionResult.state.turn, 2);
  assert.equal(potionResult.state.player.items.potion, 2);
  assert.ok(potionResult.events.some((event) => event.text?.includes("体力已经是满的")));
  assert.ok(potionResult.events.some((event) => event.type === "move" && event.actorSide === "opponent"));

  const healthy = createBattle();
  const fullHealResult = resolveTurn(
    healthy,
    { type: "item", itemId: "fullHeal", teamIndex: 0 },
    createSequenceRng([0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  assert.equal(fullHealResult.state.turn, 2);
  assert.equal(fullHealResult.state.player.items.fullHeal, 1);
  assert.ok(fullHealResult.events.some((event) => event.text?.includes("没有需要治愈")));
});

test("不存在的道具、越界目标与濒死目标仍会在回合前被拒绝", () => {
  const battle = createBattle();
  assert.throws(() => resolveTurn(battle, { type: "item", itemId: "missing", teamIndex: 0 }), /Invalid player action/);
  assert.throws(() => resolveTurn(battle, { type: "item", itemId: "potion", teamIndex: 99 }), /Invalid player action/);
  battle.player.team[1].hp = 0;
  assert.throws(() => resolveTurn(battle, { type: "item", itemId: "potion", teamIndex: 1 }), /Invalid player action/);
  assert.equal(battle.turn, 1);
});

test("换出会立即清除混乱及其提示标记", () => {
  const battle = createBattle();
  const player = getActive(battle, "player");
  player.volatile.confusedTurns = 3;
  player.volatile.wasConfused = true;
  const result = resolveTurn(
    battle,
    { type: "switch", teamIndex: 1 },
    createSequenceRng([0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  assert.equal(result.state.player.team[0].volatile.confusedTurns, 0);
  assert.equal(result.state.player.team[0].volatile.wasConfused, false);
});

test("挣扎造成无属性伤害，可命中幽灵，并按最大 HP 四舍五入扣除 1/4 反伤", () => {
  const battle = createBattle();
  battle.opponent.team[2] = createPokemon("gastly", 50, "opponent-2-gastly");
  battle.opponent.active = 2;
  battle.player.team[0].moves.forEach((move) => { move.pp = 0; });
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 0 },
    createSequenceRng([0.5, 0.5, 0, 0, 0.5]),
    { type: "move", moveIndex: 3 },
  );
  const hit = result.events.find((event) => event.type === "damage" && event.source === "struggle");
  const recoil = result.events.find((event) => event.type === "damage" && event.source === "recoil");
  assert.equal(hit.targetSide, "opponent");
  assert.ok(hit.amount > 0);
  assert.equal(hit.critical, false);
  assert.equal(recoil.amount, 28);
});

test("全部招式 PP 为 0 时，界面模型只提供可提交的挣扎选项", () => {
  const pokemon = createPokemon("pikachu");
  pokemon.moves.forEach((move) => { move.pp = 0; });
  assert.deepEqual(getMoveChoices(pokemon), [
    { entry: { id: "struggle", pp: 1 }, index: 0, forced: true },
  ]);
});

test("最后一击由挣扎造成双方倒下时，使用挣扎的一方获胜", () => {
  const battle = createBattle();
  battle.opponent.team[2] = createPokemon("gastly", 50, "opponent-2-gastly");
  battle.opponent.active = 2;
  battle.player.team.slice(1).forEach((pokemon) => { pokemon.hp = 0; });
  battle.opponent.team.slice(0, 2).forEach((pokemon) => { pokemon.hp = 0; });
  const player = getActive(battle, "player");
  const opponent = getActive(battle, "opponent");
  player.moves.forEach((move) => { move.pp = 0; });
  player.hp = 28;
  opponent.hp = 1;

  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 0 },
    createSequenceRng([0.5, 0.5]),
    { type: "move", moveIndex: 0 },
  );
  assert.equal(result.state.player.team[0].hp, 0);
  assert.equal(result.state.opponent.team[2].hp, 0);
  assert.equal(result.state.result, "player_won");
});

test("回合末伤害按速度顺序结算，并在一方全灭时立即结束", () => {
  const battle = createBattle();
  battle.player.team.slice(1).forEach((pokemon) => { pokemon.hp = 0; });
  battle.opponent.team.slice(1).forEach((pokemon) => { pokemon.hp = 0; });
  const player = getActive(battle, "player");
  const opponent = getActive(battle, "opponent");
  player.status = "burn";
  opponent.status = "burn";
  player.hp = 1;
  opponent.hp = 1;

  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 2 },
    createSequenceRng([0, 0, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  assert.equal(result.state.result, "opponent_won");
  assert.equal(result.state.player.team[0].hp, 0);
  assert.equal(result.state.opponent.team[0].hp, 1);
});

test("混乱先于完全麻痹结算", () => {
  const battle = createBattle();
  const player = getActive(battle, "player");
  player.status = "paralysis";
  player.volatile.confusedTurns = 2;
  player.volatile.wasConfused = true;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 1 },
    createSequenceRng([0, 0, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  assert.ok(result.events.some((event) => event.type === "damage" && event.source === "confusion"));
  assert.ok(!result.events.some((event) => event.type === "skip" && event.reason === "paralysis"));
});

test("混乱计数归零时先解除并可正常出招", () => {
  const battle = createBattle();
  const player = getActive(battle, "player");
  player.volatile.confusedTurns = 1;
  player.volatile.wasConfused = true;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 1 },
    createSequenceRng([0, 0.5, 0.5, 0, 0]),
    { type: "move", moveIndex: 2 },
  );
  assert.ok(result.events.some((event) => event.text?.includes("混乱解除了")));
  assert.ok(result.events.some((event) => event.type === "move" && event.actorSide === "player"));
});

test("属性与粉末免疫先于命中判定", () => {
  const battle = createBattle();
  battle.opponent.active = 2;
  getActive(battle, "player").stages.accuracy = -6;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 1 },
    createSequenceRng([0.99, 0.99, 0.5]),
    { type: "move", moveIndex: 3 },
  );
  assert.ok(result.events.some((event) => event.text?.includes("没有效果")));
  assert.ok(!result.events.some((event) => event.type === "miss" && event.targetSide === "opponent"));
});

test("冰冻光束有 10% 几率造成冰冻", () => {
  const battle = createBattle();
  battle.player.active = 1;
  const result = resolveTurn(
    battle,
    { type: "move", moveIndex: 3 },
    createSequenceRng([0, 0, 0, 0.5, 0.5, 0]),
    { type: "move", moveIndex: 2 },
  );
  assert.equal(getActive(result.state, "opponent").status, "freeze");
});
