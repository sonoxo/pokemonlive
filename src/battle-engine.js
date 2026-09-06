import { ITEMS, MOVES, SPECIES, STAT_NAMES, STATUS_NAMES } from "./data.js";
import { visualScene } from "./visual-battle-state.js";

export const TYPE_CHART = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

const STAGED_STATS = ["attack", "defense", "specialAttack", "specialDefense", "speed", "accuracy", "evasion"];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rollInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function createSequenceRng(values, fallback = 0.5) {
  let index = 0;
  return () => (index < values.length ? values[index++] : fallback);
}

export function typeEffectiveness(moveType, defenderTypes) {
  return defenderTypes.reduce((total, type) => total * (TYPE_CHART[moveType]?.[type] ?? 1), 1);
}

export function stageMultiplier(stage) {
  const value = clamp(stage, -6, 6);
  return value >= 0 ? (2 + value) / 2 : 2 / (2 - value);
}

export function accuracyMultiplier(stage) {
  const value = clamp(stage, -6, 6);
  return value >= 0 ? (3 + value) / 3 : 3 / (3 - value);
}

export function calculateStats(baseStats, level = 50) {
  const iv = 31;
  const stats = {};
  for (const [stat, base] of Object.entries(baseStats)) {
    const common = Math.floor(((2 * base + iv) * level) / 100);
    stats[stat] = stat === "hp" ? common + level + 10 : common + 5;
  }
  return stats;
}

export function createPokemon(speciesId, level = 50, uid = speciesId) {
  const species = SPECIES[speciesId];
  if (!species) throw new Error(`Unknown species: ${speciesId}`);
  const stats = calculateStats(species.baseStats, level);
  return {
    uid,
    speciesId,
    name: species.name,
    dex: species.dex,
    level,
    types: [...species.types],
    stats,
    hp: stats.hp,
    status: null,
    statusTurns: 0,
    volatile: { confusedTurns: 0 },
    stages: Object.fromEntries(STAGED_STATS.map((stat) => [stat, 0])),
    moves: species.moveIds.map((id) => ({ id, pp: MOVES[id].maxPp })),
    sprite: species.sprite,
    accent: species.accent,
  };
}

function createTrainer(name, side, speciesIds) {
  return {
    name,
    active: 0,
    team: speciesIds.map((id, index) => createPokemon(id, 50, `${side}-${index}-${id}`)),
    items: side === "player"
      ? Object.fromEntries(Object.values(ITEMS).map((item) => [item.id, item.initialCount]))
      : {},
  };
}

export function createBattle() {
  return {
    version: 1,
    generation: 9,
    mode: "single-trainer",
    turn: 1,
    phase: "action",
    result: null,
    player: createTrainer("青叶", "player", ["pikachu", "squirtle", "bulbasaur"]),
    opponent: createTrainer("露营少年 阿岚", "opponent", ["charmander", "charizard", "gengar"]),
    log: ["露营少年 阿岚 向你发起了挑战！", "去吧，皮卡丘！"],
  };
}

export function getActive(state, side) {
  const trainer = state[side];
  return trainer.team[trainer.active];
}

export function hasUsablePokemon(trainer) {
  return trainer.team.some((pokemon) => pokemon.hp > 0);
}

function resetStages(pokemon) {
  for (const stat of STAGED_STATS) pokemon.stages[stat] = 0;
  pokemon.volatile.confusedTurns = 0;
  pokemon.volatile.wasConfused = false;
}

export function getModifiedStat(pokemon, stat, options = {}) {
  let stage = pokemon.stages[stat] ?? 0;
  if (options.critical && options.attacker && stage < 0) stage = 0;
  if (options.critical && !options.attacker && stage > 0) stage = 0;
  let value = Math.floor(pokemon.stats[stat] * stageMultiplier(stage));
  if (stat === "speed" && pokemon.status === "paralysis") value = Math.floor(value * 0.5);
  return Math.max(1, value);
}

function criticalChance(stage) {
  if (stage < 0) return 0;
  if (stage >= 3) return 1;
  if (stage === 2) return 0.5;
  if (stage === 1) return 1 / 8;
  return 1 / 24;
}

export function calculateDamage(attacker, defender, move, rng = Math.random, options = {}) {
  if (!move.power) return { damage: 0, critical: false, effectiveness: 1, random: 100 };

  const effectiveness = typeEffectiveness(move.type, defender.types);
  if (effectiveness === 0) return { damage: 0, critical: false, effectiveness, random: 100 };

  const critical = options.forceCritical ?? (rng() < criticalChance(move.critStage ?? 0));
  const attackStat = move.category === "physical" ? "attack" : "specialAttack";
  const defenseStat = move.category === "physical" ? "defense" : "specialDefense";
  const attack = getModifiedStat(attacker, attackStat, { critical, attacker: true });
  const defense = getModifiedStat(defender, defenseStat, { critical, attacker: false });

  let damage = Math.floor((2 * attacker.level) / 5 + 2);
  damage = Math.floor((damage * move.power * attack) / defense);
  damage = Math.floor(damage / 50) + 2;

  if (critical) damage = Math.floor(damage * 1.5);
  const random = options.randomPercent ?? rollInt(rng, 85, 100);
  damage = Math.floor((damage * random) / 100);
  if (attacker.types.includes(move.type)) damage = Math.floor(damage * 1.5);
  damage = Math.floor(damage * effectiveness);
  if (attacker.status === "burn" && move.category === "physical") damage = Math.floor(damage * 0.5);

  return { damage: Math.max(1, damage), critical, effectiveness, random };
}

function effectivenessText(multiplier) {
  if (multiplier === 0) return "没有效果……";
  if (multiplier > 1) return "效果绝佳！";
  if (multiplier < 1) return "效果不理想……";
  return "";
}

function canReceiveStatus(pokemon, status) {
  if (pokemon.status) return { ok: false, reason: `${pokemon.name}已经处于异常状态。` };
  if (status === "burn" && pokemon.types.includes("fire")) return { ok: false, reason: `${pokemon.name}不会被灼伤！` };
  if (status === "paralysis" && pokemon.types.includes("electric")) return { ok: false, reason: `${pokemon.name}不会陷入麻痹！` };
  if (status === "freeze" && pokemon.types.includes("ice")) return { ok: false, reason: `${pokemon.name}不会被冰冻！` };
  if (status === "poison" && (pokemon.types.includes("poison") || pokemon.types.includes("steel"))) {
    return { ok: false, reason: `${pokemon.name}不会中毒！` };
  }
  return { ok: true };
}

function applyStatus(pokemon, status, rng, events, targetSide) {
  const eligibility = canReceiveStatus(pokemon, status);
  if (!eligibility.ok) {
    events.push({ type: "message", text: eligibility.reason });
    return false;
  }
  pokemon.status = status;
  pokemon.statusTurns = status === "sleep" ? rollInt(rng, 1, 3) : 0;
  events.push({
    type: "status",
    targetSide,
    status,
    text: status === "sleep"
      ? `${pokemon.name}睡着了！`
      : `${pokemon.name}陷入了${STATUS_NAMES[status]}状态！`,
  });
  return true;
}

function changeStage(pokemon, stat, amount, events, targetSide) {
  const before = pokemon.stages[stat];
  const after = clamp(before + amount, -6, 6);
  if (before === after) {
    events.push({
      type: "message",
      text: `${pokemon.name}的${STAT_NAMES[stat]}已经${amount > 0 ? "无法再提高" : "无法再降低"}了！`,
    });
    return false;
  }
  pokemon.stages[stat] = after;
  const actual = after - before;
  const degree = Math.abs(actual) >= 2 ? "大幅" : "";
  events.push({
    type: "stat",
    targetSide,
    stat,
    delta: actual,
    text: `${pokemon.name}的${STAT_NAMES[stat]}${degree}${actual > 0 ? "提高" : "降低"}了！`,
  });
  return true;
}

export function confusionDamage(pokemon, rng) {
  const pseudoMove = { power: 40, category: "physical", type: "typeless", critStage: -1 };
  const attack = getModifiedStat(pokemon, "attack");
  const defense = getModifiedStat(pokemon, "defense");
  let damage = Math.floor((2 * pokemon.level) / 5 + 2);
  damage = Math.floor((damage * pseudoMove.power * attack) / defense);
  damage = Math.floor(damage / 50) + 2;
  damage = Math.floor((damage * rollInt(rng, 85, 100)) / 100);
  return Math.max(1, damage);
}

function checkCanAct(pokemon, rng, events, side) {
  if (pokemon.status === "sleep") {
    if (pokemon.statusTurns <= 0) {
      pokemon.status = null;
      events.push({ type: "status", targetSide: side, status: null, text: `${pokemon.name}醒来了！` });
    } else {
      pokemon.statusTurns -= 1;
      events.push({ type: "skip", actorSide: side, reason: "sleep", text: `${pokemon.name}正在熟睡。` });
      return false;
    }
  }

  if (pokemon.status === "freeze") {
    if (rng() < 0.2) {
      pokemon.status = null;
      events.push({ type: "status", targetSide: side, status: null, text: `${pokemon.name}身上的冰融化了！` });
    } else {
      events.push({ type: "skip", actorSide: side, reason: "freeze", text: `${pokemon.name}被冻住，无法行动！` });
      return false;
    }
  }

  if (pokemon.volatile.confusedTurns > 0) {
    pokemon.volatile.confusedTurns -= 1;
    if (pokemon.volatile.confusedTurns <= 0) {
      pokemon.volatile.wasConfused = false;
      events.push({ type: "message", targetSide: side, clearedCondition: "confusion", text: `${pokemon.name}的混乱解除了！` });
    } else {
      events.push({ type: "message", text: `${pokemon.name}混乱了！` });
      if (rng() < 1 / 3) {
        const amount = Math.min(pokemon.hp, confusionDamage(pokemon, rng));
        pokemon.hp -= amount;
        events.push({
          type: "damage",
          targetSide: side,
          amount,
          currentHp: pokemon.hp,
          maxHp: pokemon.stats.hp,
          critical: false,
          effectiveness: 1,
          source: "confusion",
          text: `${pokemon.name}攻击了自己！`,
        });
        return false;
      }
    }
  } else if (pokemon.volatile.confusedTurns === 0 && pokemon.volatile.wasConfused) {
    pokemon.volatile.wasConfused = false;
    events.push({ type: "message", targetSide: side, clearedCondition: "confusion", text: `${pokemon.name}的混乱解除了！` });
  }

  if (pokemon.status === "paralysis" && rng() < 0.25) {
    events.push({ type: "skip", actorSide: side, reason: "paralysis", text: `${pokemon.name}身体麻痹，无法行动！` });
    return false;
  }

  return true;
}

function checkAccuracy(attacker, defender, move, rng) {
  if (move.accuracy == null) return true;
  const combinedStage = clamp(attacker.stages.accuracy - defender.stages.evasion, -6, 6);
  const chance = Math.min(100, Math.floor(move.accuracy * accuracyMultiplier(combinedStage)));
  return rng() * 100 < chance;
}

function applyEffects(move, attacker, defender, rng, events, actorSide, targetSide) {
  for (const effect of move.effects ?? []) {
    if (rng() >= effect.chance) continue;
    const target = effect.target === "self" ? attacker : defender;
    const side = effect.target === "self" ? actorSide : targetSide;
    if (effect.kind === "status") applyStatus(target, effect.status, rng, events, side);
    if (effect.kind === "stat") changeStage(target, effect.stat, effect.stages, events, side);
    if (effect.kind === "confusion") {
      if (target.volatile.confusedTurns > 0) {
        events.push({ type: "message", text: `${target.name}已经混乱了。` });
      } else {
        target.volatile.confusedTurns = rollInt(rng, 2, 5);
        target.volatile.wasConfused = true;
        events.push({ type: "status", targetSide: side, status: "confusion", text: `${target.name}混乱了！` });
      }
    }
  }
}

function combatantSnapshot(pokemon, side) {
  return {
    side, uid: pokemon.uid, speciesId: pokemon.speciesId, dex: pokemon.dex, name: pokemon.name,
    stages: Object.fromEntries(STAGED_STATS.map((stat) => [stat, pokemon.stages[stat]])),
    status: pokemon.status, confused: pokemon.volatile.confusedTurns > 0,
    speedStage: pokemon.stages.speed, paralyzed: pokemon.status === "paralysis",
    modifiedSpeed: getModifiedStat(pokemon, "speed"), currentHp: pokemon.hp, maxHp: pokemon.stats.hp,
  };
}

function moveSnapshot(move) {
  return {
    id: move.id, name: move.name, type: move.type, category: move.category,
    power: move.power ?? 0, priority: move.priority ?? 0,
    targetMode: move.power > 0 ? "foe"
      : (move.effects ?? []).every(effect => effect.target === "self") && move.effects?.length ? "self" : "foe",
    effectKinds: [...new Set((move.effects ?? []).map(effect => effect.kind))],
  };
}

function useMove(state, side, moveIndex, rng, events) {
  const otherSide = side === "player" ? "opponent" : "player";
  const attacker = getActive(state, side);
  const defender = getActive(state, otherSide);
  if (!attacker || attacker.hp <= 0 || !defender || defender.hp <= 0) return;
  if (!checkCanAct(attacker, rng, events, side)) {
    const blocked = events.at(-1);
    if ((blocked?.type === "skip" && ["paralysis", "sleep", "freeze"].includes(blocked.reason))
      || (blocked?.type === "damage" && blocked.source === "confusion")) {
      // Presentation facts only. The failed action consumes no PP and does
      // not run accuracy, damage or move effects, exactly as before.
      const move = attacker.moves.every(entry => entry.pp <= 0) ? MOVES.struggle : MOVES[attacker.moves[moveIndex]?.id];
      if (move) {
        const actor = combatantSnapshot(attacker, side);
        if (blocked.source === "confusion") actor.currentHp += blocked.amount;
        Object.assign(blocked, { actorSide: side, actor, target: combatantSnapshot(defender, otherSide), move: moveSnapshot(move) });
      }
    }
    if (attacker.hp <= 0) events.push({ type: "faint", targetSide: side, text: `${attacker.name}倒下了！` });
    return;
  }

  const usableMoves = attacker.moves.filter((entry) => entry.pp > 0);
  const usingStruggle = usableMoves.length === 0;
  const moveEntry = usingStruggle ? { id: "struggle", pp: 1 } : attacker.moves[moveIndex];
  if (!moveEntry || (!usingStruggle && moveEntry.pp <= 0)) {
    events.push({ type: "message", text: `${attacker.name}无法使出这个招式！` });
    return;
  }
  const move = MOVES[moveEntry.id];
  if (!usingStruggle) moveEntry.pp -= 1;

  const actorSnapshot = combatantSnapshot(attacker, side);
  const targetSnapshot = combatantSnapshot(defender, otherSide);

  events.push({
    type: "move",
    actorSide: side,
    targetSide: otherSide,
    moveId: move.id,
    moveType: move.type,
    category: move.category,
    move: moveSnapshot(move),
    actor: actorSnapshot,
    target: targetSnapshot,
    text: `${attacker.name}使用了${move.name}！`,
  });

  if (move.powder && defender.types.includes("grass")) {
    events.push({ type: "message", text: `粉末对${defender.name}没有效果！` });
    return;
  }

  const immune = typeEffectiveness(move.type, defender.types) === 0;
  if ((move.power > 0 || move.checksTypeImmunity) && immune) {
    events.push({ type: "message", text: `对${defender.name}没有效果……` });
    return;
  }

  if (!checkAccuracy(attacker, defender, move, rng)) {
    events.push({ type: "miss", targetSide: otherSide, text: `${defender.name}避开了攻击！` });
    return;
  }

  if (move.power > 0) {
    const result = calculateDamage(attacker, defender, move, rng);
    if (result.effectiveness === 0) {
      events.push({ type: "message", text: `对${defender.name}没有效果……` });
      return;
    }
    const amount = Math.min(defender.hp, result.damage);
    defender.hp -= amount;
    events.push({
      type: "damage",
      targetSide: otherSide,
      amount,
      currentHp: defender.hp,
      maxHp: defender.stats.hp,
      critical: result.critical,
      effectiveness: result.effectiveness,
      source: move.id,
      text: `${defender.name}受到了 ${amount} 点伤害！`,
    });
    if (result.critical) events.push({ type: "message", text: "击中了要害！" });
    const effectivenessMessage = effectivenessText(result.effectiveness);
    if (effectivenessMessage) events.push({ type: "message", text: effectivenessMessage });
    if (move.type === "fire" && defender.status === "freeze" && defender.hp > 0) {
      defender.status = null;
      events.push({ type: "status", targetSide: otherSide, status: null, text: `${defender.name}身上的冰融化了！` });
    }
  }

  if (defender.hp <= 0) {
    events.push({ type: "faint", targetSide: otherSide, text: `${defender.name}倒下了！` });
  } else {
    applyEffects(move, attacker, defender, rng, events, side, otherSide);
  }

  if (move.recoil && attacker.hp > 0) {
    const recoil = Math.max(1, Math.round(attacker.stats.hp * move.recoil));
    const amount = Math.min(attacker.hp, recoil);
    attacker.hp -= amount;
    events.push({
      type: "damage",
      targetSide: side,
      amount,
      currentHp: attacker.hp,
      maxHp: attacker.stats.hp,
      critical: false,
      effectiveness: 1,
      source: "recoil",
      text: `${attacker.name}受到了反作用力伤害！`,
    });
    if (attacker.hp <= 0) {
      events.push({ type: "faint", targetSide: side, text: `${attacker.name}倒下了！` });
      if (!hasUsablePokemon(state[side]) && !hasUsablePokemon(state[otherSide])) state.tiebreakWinner = side;
    }
  }
}

function performSwitch(state, side, teamIndex, events, forced = false) {
  const trainer = state[side];
  const incoming = trainer.team[teamIndex];
  if (!incoming || incoming.hp <= 0 || (!forced && teamIndex === trainer.active)) {
    events.push({ type: "message", text: "现在无法替换为这只宝可梦。" });
    return false;
  }
  const outgoing = trainer.team[trainer.active];
  const sceneBefore = visualScene(state);
  if (outgoing) resetStages(outgoing);
  trainer.active = teamIndex;
  events.push({
    type: "switch",
    targetSide: side,
    teamIndex,
    forced,
    outgoingUid: outgoing.uid,
    incoming: clone(incoming),
    sceneBefore,
    sceneAfter: visualScene(state),
    text: side === "player" ? `回来吧，${outgoing.name}！去吧，${incoming.name}！` : `${trainer.name}派出了${incoming.name}！`,
  });
  return true;
}

function useItem(state, side, action, events) {
  if (side !== "player") return false;
  const trainer = state.player;
  const item = ITEMS[action.itemId];
  const pokemon = trainer.team[action.teamIndex ?? trainer.active];
  if (!item || !pokemon || pokemon.hp <= 0 || (trainer.items[item.id] ?? 0) <= 0) {
    events.push({ type: "message", text: "这个道具现在无法使用。" });
    return false;
  }
  if (item.heal && pokemon.hp >= pokemon.stats.hp) {
    events.push({ type: "message", text: `${pokemon.name}的体力已经是满的。` });
    return false;
  }
  if (item.cure && !pokemon.status && pokemon.volatile.confusedTurns <= 0) {
    events.push({ type: "message", text: `${pokemon.name}没有需要治愈的异常状态。` });
    return false;
  }

  trainer.items[item.id] -= 1;
  events.push({ type: "item", actorSide: side, itemId: item.id, text: `青叶使用了${item.name}！` });
  if (item.heal) {
    const amount = Math.min(item.heal, pokemon.stats.hp - pokemon.hp);
    pokemon.hp += amount;
    events.push({
      type: "heal",
      targetSide: side,
      teamIndex: action.teamIndex ?? trainer.active,
      amount,
      currentHp: pokemon.hp,
      maxHp: pokemon.stats.hp,
      text: `${pokemon.name}回复了 ${amount} 点 HP！`,
    });
  }
  if (item.cure) {
    pokemon.status = null;
    pokemon.statusTurns = 0;
    pokemon.volatile.confusedTurns = 0;
    pokemon.volatile.wasConfused = false;
    events.push({ type: "status", targetSide: side, status: null, text: `${pokemon.name}恢复了健康！` });
  }
  return true;
}

function actionPriority(state, side, action) {
  if (action.type === "switch") return 10;
  if (action.type === "item") return 9;
  if (action.type === "move") {
    const pokemon = getActive(state, side);
    const entry = pokemon.moves[action.moveIndex];
    const noPp = pokemon.moves.every((move) => move.pp <= 0);
    const move = noPp ? MOVES.struggle : MOVES[entry?.id];
    return move?.priority ?? 0;
  }
  return 0;
}

function orderActions(state, playerAction, opponentAction, rng) {
  const actions = [
    { side: "player", action: playerAction, actorUid: getActive(state, "player").uid },
    { side: "opponent", action: opponentAction, actorUid: getActive(state, "opponent").uid },
  ];
  return actions.sort((a, b) => {
    const priorityDifference = actionPriority(state, b.side, b.action) - actionPriority(state, a.side, a.action);
    if (priorityDifference) return priorityDifference;
    const aSpeed = getModifiedStat(getActive(state, a.side), "speed");
    const bSpeed = getModifiedStat(getActive(state, b.side), "speed");
    if (aSpeed !== bSpeed) return bSpeed - aSpeed;
    return rng() < 0.5 ? -1 : 1;
  });
}

function executeAction(state, plan, rng, events) {
  const active = getActive(state, plan.side);
  if (!active || active.hp <= 0) return;
  if (plan.action.type === "move" && active.uid !== plan.actorUid) return;
  const eventStart = events.length;
  if (plan.action.type === "move") useMove(state, plan.side, plan.action.moveIndex, rng, events);
  if (plan.action.type === "switch") performSwitch(state, plan.side, plan.action.teamIndex, events);
  if (plan.action.type === "item") useItem(state, plan.side, plan.action, events);
  // Presentation metadata only: distinguish this action's effects from the
  // next actor's wake-up/confusion/skip events without parsing localized text.
  for (const event of events.slice(eventStart)) event.actionSide = plan.side;
}

function processResidual(state, side, events) {
  const pokemon = getActive(state, side);
  if (!pokemon || pokemon.hp <= 0) return;
  let amount = 0;
  if (pokemon.status === "burn") amount = Math.max(1, Math.floor(pokemon.stats.hp / 16));
  if (pokemon.status === "poison") amount = Math.max(1, Math.floor(pokemon.stats.hp / 8));
  if (!amount) return;
  amount = Math.min(pokemon.hp, amount);
  pokemon.hp -= amount;
  events.push({
    type: "damage",
    targetSide: side,
    amount,
    currentHp: pokemon.hp,
    maxHp: pokemon.stats.hp,
    critical: false,
    effectiveness: 1,
    source: pokemon.status,
    text: pokemon.status === "burn" ? `${pokemon.name}受到了灼伤伤害！` : `${pokemon.name}受到了毒素伤害！`,
  });
  if (pokemon.hp <= 0) events.push({ type: "faint", targetSide: side, text: `${pokemon.name}倒下了！` });
}

function concludeOrPrepareNext(state, events) {
  const playerOut = !hasUsablePokemon(state.player);
  const opponentOut = !hasUsablePokemon(state.opponent);
  if (playerOut && opponentOut && state.tiebreakWinner) {
    state.phase = "complete";
    state.result = state.tiebreakWinner === "player" ? "player_won" : "opponent_won";
    events.push({
      type: "result",
      result: state.result,
      text: state.result === "player_won"
        ? "双方同时倒下；依据反作用力判定，你赢得了对战！"
        : "双方同时倒下；依据反作用力判定，对手赢得了对战。",
    });
    return;
  }
  if (playerOut && opponentOut) {
    state.phase = "complete";
    state.result = "draw";
    events.push({ type: "result", result: state.result, text: "双方已经没有可战斗的宝可梦，本场对战平局。" });
    return;
  }
  if (opponentOut) {
    state.phase = "complete";
    state.result = "player_won";
    events.push({ type: "result", result: state.result, text: "露营少年 阿岚 已经没有可战斗的宝可梦了。你赢得了对战！" });
    return;
  }
  if (playerOut) {
    state.phase = "complete";
    state.result = "opponent_won";
    events.push({ type: "result", result: state.result, text: "你的宝可梦全部倒下了……" });
    return;
  }

  const opponentActive = getActive(state, "opponent");
  if (opponentActive.hp <= 0) {
    const nextIndex = state.opponent.team.findIndex((pokemon) => pokemon.hp > 0);
    performSwitch(state, "opponent", nextIndex, events, true);
  }

  const playerActive = getActive(state, "player");
  if (playerActive.hp <= 0) {
    state.phase = "must-switch";
    events.push({ type: "message", text: "请选择下一只能够战斗的宝可梦。" });
  } else {
    state.phase = "action";
  }
  state.turn += 1;
}

function validateAction(state, action) {
  if (!action || !["move", "switch", "item"].includes(action.type)) return false;
  if (action.type === "move") {
    const pokemon = getActive(state, "player");
    if (pokemon.moves.every((entry) => entry.pp <= 0)) return true;
    return Boolean(pokemon.moves[action.moveIndex]?.pp > 0);
  }
  if (action.type === "switch") {
    return action.teamIndex !== state.player.active && state.player.team[action.teamIndex]?.hp > 0;
  }
  if (action.type === "item") {
    const item = ITEMS[action.itemId];
    const pokemon = state.player.team[action.teamIndex ?? state.player.active];
    if (!item || !pokemon || pokemon.hp <= 0 || (state.player.items[action.itemId] ?? 0) <= 0) return false;
    return Boolean(item.heal || item.cure);
  }
  return false;
}

function moveScore(attacker, defender, entry, index) {
  const move = MOVES[entry.id];
  if (entry.pp <= 0) return { index, score: -Infinity };
  if (!move.power) {
    let score = 8;
    if (move.effects?.some((effect) => effect.kind === "status") && !defender.status) score += 12;
    if (move.effects?.some((effect) => effect.kind === "confusion") && defender.volatile.confusedTurns <= 0) score += 9;
    if (move.effects?.some((effect) => effect.kind === "stat" && effect.target === "self")) score += 5;
    return { index, score };
  }
  const effectiveness = typeEffectiveness(move.type, defender.types);
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const attackStat = move.category === "physical" ? attacker.stats.attack : attacker.stats.specialAttack;
  const defenseStat = move.category === "physical" ? defender.stats.defense : defender.stats.specialDefense;
  return { index, score: move.power * effectiveness * stab * (attackStat / Math.max(1, defenseStat)) };
}

export function chooseAiAction(state, rng = Math.random) {
  const attacker = getActive(state, "opponent");
  const defender = getActive(state, "player");
  if (attacker.moves.every((entry) => entry.pp <= 0)) return { type: "move", moveIndex: 0 };
  const ranked = attacker.moves
    .map((entry, index) => moveScore(attacker, defender, entry, index))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score);
  const choicePool = rng() < 0.78 ? ranked.slice(0, 1) : ranked.slice(0, Math.min(3, ranked.length));
  const choice = choicePool[Math.floor(rng() * choicePool.length)] ?? ranked[0];
  return { type: "move", moveIndex: choice.index };
}

export function resolveTurn(originalState, playerAction, rng = Math.random, forcedOpponentAction = null) {
  if (originalState.phase !== "action") throw new Error(`Cannot resolve a turn during phase: ${originalState.phase}`);
  if (!validateAction(originalState, playerAction)) throw new Error("Invalid player action");
  const state = clone(originalState);
  const events = [];
  const opponentAction = forcedOpponentAction ?? chooseAiAction(state, rng);
  const orderedActions = orderActions(state, playerAction, opponentAction, rng);

  state.phase = "resolving";
  for (const plan of orderedActions) {
    executeAction(state, plan, rng, events);
    if (!hasUsablePokemon(state.player) || !hasUsablePokemon(state.opponent)) break;
  }

  if (hasUsablePokemon(state.player) && hasUsablePokemon(state.opponent)) {
    const residualOrder = ["player", "opponent"].sort((a, b) => {
      const speedDifference = getModifiedStat(getActive(state, b), "speed") - getModifiedStat(getActive(state, a), "speed");
      return speedDifference || (rng() < 0.5 ? -1 : 1);
    });
    for (const side of residualOrder) {
      processResidual(state, side, events);
      if (!hasUsablePokemon(state[side])) break;
    }
  }
  concludeOrPrepareNext(state, events);
  state.log.push(...events.map((event) => event.text).filter(Boolean));
  return { state, events, opponentAction };
}

export function resolveForcedSwitch(originalState, teamIndex) {
  if (originalState.phase !== "must-switch") throw new Error(`Cannot force switch during phase: ${originalState.phase}`);
  const state = clone(originalState);
  const events = [];
  const switched = performSwitch(state, "player", teamIndex, events, true);
  if (!switched) throw new Error("Invalid forced switch");
  state.phase = "action";
  state.log.push(...events.map((event) => event.text).filter(Boolean));
  return { state, events };
}

export function getMoveChoices(pokemon) {
  if (pokemon.moves.every((entry) => entry.pp <= 0)) {
    return [{ entry: { id: "struggle", pp: 1 }, index: 0, forced: true }];
  }
  return pokemon.moves.map((entry, index) => ({ entry, index, forced: false }));
}
