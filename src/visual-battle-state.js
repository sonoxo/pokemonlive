import { SPECIES } from "./data.js";

export const VISUAL_STATE_VERSION = "pine-state-v2";
const SIDES = ["player", "opponent"];
const STATUSES = new Set([null, "sleep", "freeze", "paralysis", "poison", "burn"]);

export const STATUS_ACTING = Object.freeze({
  paralysis: "intermittent thin yellow static around the limbs and momentary muscle stiffness; still conscious, not frozen solid; this does not imply a skipped turn",
  poison: "a few violet poison bubbles beside the body and a strained breathing posture; retain canonical skin colors; no extra poison damage or collapse in this action",
  burn: "a few persistent tiny ember motes and a pained guarded posture, not a body engulfed in flames; no extra burn damage in this action",
  sleep: "closed eyelids, slow breathing and a relaxed sleeping posture, alive and asleep rather than fainted; NO spiral eyes; never open the eyes, dodge, brace, stand alert or wake from an ordinary hit",
  freeze: "a translucent pale-blue ice shell holding the body immobile, face recognizable through the ice; no voluntary dodging, footwork or fighting stance while frozen",
  confusion: "small disorienting lights circling the head and an unfocused gaze; no spiral knockout eyes, no invented self-attack or skipped action",
});

export const FAINT_ACTING = "loses balance and drops limp to the ground; BOTH eyes visibly become bold black spiral / swirl eyes (the classic anime knockout eyes, like mosquito coils), not merely closed eyelids. Hold a readable face reaction, then keep the spirals visible and the body down through the last frame. This is fainting, not death; never stand back up or reset to idle";

export function visualPokemon(pokemon) {
  return {
    speciesId: pokemon.speciesId,
    status: pokemon.status ?? null,
    confused: pokemon.confused ?? Boolean(pokemon.volatile?.confusedTurns > 0),
    fainted: pokemon.fainted ?? (pokemon.hp ?? pokemon.currentHp) <= 0,
  };
}

export function visualScene(battle) {
  return Object.fromEntries(SIDES.map(side => [side, visualPokemon(battle[side].team[battle[side].active])]));
}

export function sanitizeVisualScene(value) {
  return Object.fromEntries(SIDES.map(side => {
    const subject = value?.[side];
    const species = SPECIES[subject?.speciesId];
    if (!species || !STATUSES.has(subject.status) || typeof subject.confused !== "boolean"
      || typeof subject.fainted !== "boolean") throw new TypeError("动画阵容或状态无效");
    if ((subject.status === "burn" && species.types.includes("fire"))
      || (subject.status === "paralysis" && species.types.includes("electric"))
      || (subject.status === "poison" && species.types.some(type => ["poison", "steel"].includes(type)))
      || (subject.status === "freeze" && species.types.includes("ice"))) throw new TypeError("动画状态与属性免疫冲突");
    return [side, visualPokemon(subject)];
  }));
}

// HP changes do not buy a new idle video. Identity, side, conditions and KO do.
export function visualSceneKey(scene) {
  return [VISUAL_STATE_VERSION, ...SIDES.map(side => {
    const p = scene[side];
    return `${side}:${p.speciesId}:${p.status ?? "healthy"}:${p.confused ? "confused" : "clear"}:${p.fainted ? "fainted" : "alive"}`;
  })].join("|");
}

export function attackVisualScene(attack, after = false) {
  const scene = Object.fromEntries([attack.actor, attack.target].map(p => [p.side, visualPokemon(p)]));
  if (after) {
    const target = scene[attack.target.side];
    target.fainted = attack.outcome.fainted;
    scene[attack.actor.side].fainted = attack.outcome.actorFainted;
    if (attack.outcome.clearedStatus) target.status = null;
    if (attack.outcome.status === "confusion") target.confused = true;
    else if (attack.outcome.status) target.status = attack.outcome.status;
  }
  return scene;
}

export function conditionDirection(subject) {
  if (subject.fainted) return `${subject.speciesId} ${FAINT_ACTING}.`;
  const states = [subject.status, subject.confused ? "confusion" : null].filter(Boolean);
  return states.length
    ? `${subject.speciesId}: ${states.map(status => `${status}: ${STATUS_ACTING[status]}`).join("; ")}.`
    : `${subject.speciesId} remains conscious and able to battle; no unrecorded status or collapse.`;
}

export function sceneConditionDirection(scene) {
  return SIDES.map(side => `${side} side ${conditionDirection(scene[side])}`).join(" ");
}

export function validateSwitch(before, after) {
  const changed = SIDES.filter(side => before[side].speciesId !== after[side].speciesId);
  if (changed.length !== 1) throw new TypeError("替换动画一次只能替换一方");
  const side = changed[0];
  const other = side === "player" ? "opponent" : "player";
  if (after[side].fainted || JSON.stringify(before[other]) !== JSON.stringify(after[other])) {
    throw new TypeError("替换不能派出倒下的宝可梦或改变另一方状态");
  }
  return side;
}
