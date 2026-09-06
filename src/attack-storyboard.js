import { MOVES, SPECIES } from "./data.js";
import { isCinematicActionEvent } from "./cinema-events.js";
import { STATUS_ACTING, FAINT_ACTING, attackVisualScene, conditionDirection } from "./visual-battle-state.js";
import {
  accuracyMultiplier,
  calculateDamage,
  calculateStats,
  confusionDamage,
  stageMultiplier,
  typeEffectiveness,
} from "./battle-engine.js";

const PURPOSES = new Set(["complete", "setup", "payoff", "blocked"]);
const ANCHORS = new Set(["idle", "charged", "launch", "impact", "recovery"]);
const CAMERAS = new Set(["attacker_three_quarter", "side_tracking", "target_close", "wide_field"]);
const MOTION_STYLES = new Set(["snappy", "fluid", "weighty", "controlled"]);
const ENERGY_LEVELS = new Set(["subtle", "moderate", "intense"]);
const CAMERA_MOVEMENTS = new Set(["locked", "slow_push", "lateral_track", "impact_push"]);
const SHOT_SIZES = new Set(["extreme_close_up", "close_up", "medium", "wide", "extreme_wide"]);
const SHOT_SUBJECTS = new Set(["actor", "target", "both", "move_effect"]);
const SIDES = new Set(["player", "opponent"]);
const TEMPOS = new Set(["rapid", "even", "deliberate"]);
const DAMAGE_TIERS = new Set(["none", "tactical", "light", "heavy", "decisive"]);
const EFFECT_MODES = new Set(["damage", "miss", "immune", "status", "self_stat", "foe_stat", "mixed_stat", "no_effect", "blocked"]);
const EFFECTIVENESS_VALUES = new Set([0, 0.25, 0.5, 1, 2, 4]);
const ALLOWED_STATS = new Set(["attack", "defense", "specialAttack", "specialDefense", "speed", "accuracy", "evasion"]);
const ALLOWED_STATUSES = new Set(["burn", "poison", "paralysis", "sleep", "freeze", "confusion"]);
const PRIMARY_STATUSES = new Set(["burn", "poison", "paralysis", "sleep", "freeze"]);
export const BLOCKED_REASON_LABELS = Object.freeze({ paralysis: "麻痹", sleep: "睡眠", freeze: "冰冻", confusion: "混乱自伤" });
const ANIME_STYLE_BIBLE = "Render a polished 2D Japanese television-animation Pokémon battle in 16:9: faithful canonical species silhouettes, proportions and colors; clean cel shading and expressive hand-drawn poses; strong anticipation, readable action arcs, directional speed lines, brief smear animation, a restrained high-contrast impact frame, type-specific energy, dust and debris, then a stable readable end pose consistent with whether each combatant remains standing or has fainted. It must feel like authored character animation, never a 3D game capture, turntable, slideshow or photorealistic scene.";
const PROMPT_GUARDRAIL = "Keep both Pokémon inside one coherent outdoor grassy battle location and one continuous shared timeline. A brief character close-up may isolate one Pokémon inside that established geography, but never turn the combatants into separate storyboards, separate locations or split screens. Preserve exact identities, scale, left-right geography, lighting direction and spatial continuity across every cut; no game UI, health bars, menus, text, subtitles, logos, trainers, extra creatures, character morphing, costume changes or invented injuries. Avoid rapid full-screen flashing.";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function boundedInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}无效`);
  return value;
}

function boundedNumber(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function speedFromSnapshot(species, speedStage, paralyzed) {
  const baseSpeed = calculateStats(species.baseStats).speed;
  let speed = Math.floor(baseSpeed * stageMultiplier(speedStage));
  if (paralyzed) speed = Math.floor(speed * 0.5);
  return Math.max(1, speed);
}

function possibleDamageValues(actorSpecies, targetSpecies, actorStages, targetStages, actorStatus, move, critical) {
  const attacker = {
    level: 50,
    stats: calculateStats(actorSpecies.baseStats),
    stages: actorStages,
    types: actorSpecies.types,
    status: actorStatus,
  };
  const defender = {
    level: 50,
    stats: calculateStats(targetSpecies.baseStats),
    stages: targetStages,
    types: targetSpecies.types,
    status: null,
  };
  return new Set(Array.from({ length: 16 }, (_, index) => calculateDamage(
    attacker,
    defender,
    move,
    () => 0.5,
    { forceCritical: critical, randomPercent: 85 + index },
  ).damage));
}

function sanitizeStages(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}能力阶级快照无效`);
  return Object.fromEntries([...ALLOWED_STATS].map((stat) => [
    stat,
    boundedInteger(value[stat], -6, 6, `${label}${stat}阶级`),
  ]));
}

function sanitizePrimaryStatus(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || !PRIMARY_STATUSES.has(value)) throw new Error(`${label}主异常快照无效`);
  return value;
}

function primaryStatusAllowedForSpecies(status, species) {
  if (status === "burn" && species.types.includes("fire")) return false;
  if (status === "paralysis" && species.types.includes("electric")) return false;
  if (status === "freeze" && species.types.includes("ice")) return false;
  if (status === "poison" && (species.types.includes("poison") || species.types.includes("steel"))) return false;
  return true;
}

function canReceivePrimaryStatus(status, currentStatus, species) {
  return !currentStatus && primaryStatusAllowedForSpecies(status, species);
}

function cleanString(value, maxLength, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength) || fallback;
}

function damageTier(outcome) {
  if (outcome.missed || outcome.effectiveness === 0) return "none";
  if (outcome.fainted || outcome.damageRatio >= 0.5) return "decisive";
  if (outcome.damageRatio >= 0.25) return "heavy";
  if (outcome.damage > 0) return "light";
  return outcome.status || outcome.statChanges?.length ? "tactical" : "none";
}

function intendedTargetMode(move) {
  if (move.power > 0) return "foe";
  const targets = new Set((move.effects ?? []).map((effect) => effect.target).filter(Boolean));
  if (targets.size === 1 && targets.has("self")) return "self";
  if (targets.has("self") && targets.has("foe")) return "mixed";
  return "foe";
}

function intendedEffectKinds(move) {
  return [...new Set((move.effects ?? []).map((effect) => effect.kind).filter(Boolean))];
}

function effectMode(outcome, actorSide, move) {
  if (outcome.missed) return "miss";
  if (outcome.effectiveness === 0) return "immune";
  if (outcome.damage > 0) return "damage";
  if (outcome.status) return "status";
  if (outcome.statChanges.length) {
    if (outcome.statChanges.every((change) => change.targetSide === actorSide)) return "self_stat";
    if (outcome.statChanges.every((change) => change.targetSide !== actorSide)) return "foe_stat";
    return "mixed_stat";
  }
  if (move.effectKinds?.includes("stat")) {
    if (move.targetMode === "self") return "self_stat";
    if (move.targetMode === "mixed") return "mixed_stat";
    return "foe_stat";
  }
  return "no_effect";
}

function tempoTier(actorSpeed, targetSpeed) {
  const ratio = actorSpeed / Math.max(1, targetSpeed);
  if (ratio >= 1.25) return "rapid";
  if (ratio <= 0.8) return "deliberate";
  return "even";
}

export function buildAttackRecords(events, context = {}) {
  const records = [];
  const turn = Math.max(1, Math.trunc(finiteNumber(context.turn, 1)));
  const battleEpoch = Math.max(0, Math.trunc(finiteNumber(context.battleEpoch, 0)));

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const blockedReason = event.type === "skip" && ["paralysis", "sleep", "freeze"].includes(event.reason) ? event.reason
      : event.type === "damage" && event.source === "confusion" && event.actor ? "confusion" : null;
    if (!isCinematicActionEvent(event) || !event.actor || !event.target || !event.move) continue;

    const segment = [];
    for (let cursor = index + 1; !blockedReason && cursor < events.length && !isCinematicActionEvent(events[cursor]); cursor += 1) {
      segment.push(events[cursor]);
    }
    const directDamage = segment.find((candidate) => (
      candidate.type === "damage"
      && candidate.targetSide === event.targetSide
      && candidate.source === event.move.id
    ));
    const missed = segment.some((candidate) => candidate.type === "miss" && candidate.targetSide === event.targetSide);
    const wasImmune = segment.some((candidate) => candidate.type === "message" && candidate.text?.includes("没有效果"));
    const statusEvent = segment.find((candidate) => (
      candidate.type === "status"
      && candidate.targetSide === event.targetSide
      && candidate.status
    ));
    const clearedStatusEvent = segment.find((candidate) => (
      candidate.type === "status"
      && candidate.targetSide === event.targetSide
      && candidate.status == null
    ));
    const recoilEvent = segment.find((candidate) => (
      candidate.type === "damage"
      && candidate.targetSide === event.actorSide
      && candidate.source === "recoil"
    ));
    const statChanges = segment
      .filter((candidate) => candidate.type === "stat")
      .map((candidate) => ({ targetSide: candidate.targetSide, stat: candidate.stat, delta: candidate.delta }));
    const damage = directDamage?.amount ?? 0;
    const targetMaxHp = Math.max(1, event.target.maxHp);
    const outcome = {
      damage,
      damageRatio: Number((damage / targetMaxHp).toFixed(4)),
      critical: Boolean(directDamage?.critical),
      effectiveness: directDamage?.effectiveness ?? (wasImmune ? 0 : null),
      missed,
      fainted: directDamage?.currentHp === 0,
      recoilDamage: recoilEvent?.amount ?? 0,
      actorFainted: blockedReason === "confusion" ? event.currentHp === 0 : recoilEvent?.currentHp === 0,
      ...(blockedReason === "confusion" ? { selfDamage: event.amount } : {}),
      status: statusEvent?.status ?? null,
      clearedStatus: clearedStatusEvent
        && event.move.type === "fire"
        && directDamage?.currentHp > 0
        && event.target.status === "freeze" ? "freeze" : null,
      statChanges,
    };
    outcome.effectMode = blockedReason ? "blocked" : effectMode(outcome, event.actorSide, event.move);
    const actorSpeed = Math.max(1, Math.trunc(event.actor.modifiedSpeed));
    const targetSpeed = Math.max(1, Math.trunc(event.target.modifiedSpeed));
    const sequenceIndex = records.length;
    const record = {
      id: `${battleEpoch}-${turn}-${sequenceIndex}-${event.actor.uid}-${event.move.id}`,
      battleEpoch,
      turn,
      sequenceIndex,
      ...(blockedReason ? { blockedReason } : {}),
      move: { ...event.move },
      actor: { ...event.actor },
      target: { ...event.target },
      outcome: { ...outcome, damageTier: damageTier(outcome) },
      tempo: {
        actorSpeed,
        targetSpeed,
        speedDelta: actorSpeed - targetSpeed,
        speedRatio: Number((actorSpeed / targetSpeed).toFixed(3)),
        tier: tempoTier(actorSpeed, targetSpeed),
      },
    };
    records.push(deepFreeze(record));
  }

  return Object.freeze(records);
}

const TYPE_VISUALS = {
  electric: "bright yellow electrical arcs",
  fire: "warm orange flame and embers",
  water: "clear blue water energy",
  grass: "green leaf-shaped energy",
  ice: "pale blue frost crystals",
  rock: "compact stone fragments",
  ground: "a low wave of earth and dust",
  ghost: "violet spectral energy",
  psychic: "magenta psychic ripples",
  poison: "purple poisonous motes",
  steel: "silver metallic streaks",
  normal: "clean neutral motion trails",
  typeless: "neutral white motion trails",
};

const MOVE_VISUAL_SIGNATURES = {
  thunderbolt: {
    windup: "the attacker's cheek sacs glow as branching yellow electricity coils tightly around the crouched body",
    impact: "a jagged branching lightning discharge crosses the battlefield in one readable path, with a single white-yellow contact accent",
    aftermath: "residual sparks crawl briefly over the ground and fade while the attacker exhales and settles",
  },
  quickAttack: {
    windup: "the attacker drops into a compact sprinter stance with one sharp white speed glint and compressed anticipation",
    impact: "the attacker performs one ground-skimming straight-line body dash with clean afterimages and a physical shoulder-first contact arc, without elemental energy",
    aftermath: "the attacker skids to a controlled stop as the white afterimages collapse back into one silhouette",
  },
  thunderWave: {
    windup: "small controlled sparks pulse around the attacker's body outline in a steady rhythm rather than building an explosive blast; preserve species-specific anatomy",
    impact: "concentric low-voltage yellow electrical waves spread across the ground and wrap the target without a damaging collision",
    aftermath: "thin static arcs linger around the affected target's outline to communicate paralysis",
  },
  ironTail: {
    windup: "the attacker plants its feet, twists its torso and coats only the tail in a hard silver metallic sheen",
    impact: "the metallic tail completes one heavy crescent-shaped close-range swing with a crisp silver contact flash",
    aftermath: "the tail's silver sheen fades as the attacker follows through and regains balance",
  },
  dragonClaw: {
    windup: "the attacker draws back its foreclaws as a compact blue-green draconic glow coats only the existing claws; preserve its anatomy",
    impact: "one powerful close-range claw slash leaves short blue-green energy trails at contact, not a breath beam or ranged projectile",
    aftermath: "the claw glow and slash trails fade as the attacker completes its physical follow-through; no extra limbs or new claws",
  },
  waterGun: {
    windup: "the attacker braces low, draws breath and gathers a compact bead of clear water at the mouth",
    impact: "a focused continuous blue water jet fires from the mouth along one narrow trajectory, throwing spray only at contact",
    aftermath: "the jet cuts off cleanly and falling droplets darken a small patch of ground",
  },
  tackle: {
    windup: "the attacker leans its whole body forward and digs into the ground for one direct physical charge",
    impact: "the attacker collides once with its shoulder and torso, using body weight rather than a projectile or elemental aura",
    aftermath: "both bodies separate from the contact and recover their footing with a short dust skid",
  },
  tailWhip: {
    windup: "the attacker turns partly away and raises its tail with a playful, deliberately distracting pose",
    impact: "the tail swishes side to side in a rhythmic feint that distracts the target; there is no contact, projectile or damage impact",
    aftermath: "the target's guarded posture loosens while the attacker turns back into battle stance",
  },
  iceBeam: {
    windup: "pale cyan light and frost mist condense into a bright point at the attacker's mouth",
    impact: "one narrow blue-white freezing beam crosses the field, surrounded by angular ice crystals and cold vapor",
    aftermath: "frost crystals and glittering ice dust fall away while cold mist remains low to the ground",
  },
  razorLeaf: {
    windup: "the attacker's leaves flare outward as wind gathers a compact halo of bright green razor-edged leaves",
    impact: "a curved volley of spinning leaf blades slices across the field in a clearly readable arc",
    aftermath: "spent leaves spiral down naturally as the wind drops and both silhouettes become readable again",
  },
  sleepPowder: {
    windup: "the attacker gently shakes its plant growth as a soft cloud of pale blue-green luminous spores gathers above it",
    impact: "the weightless powder cloud drifts around the target and settles without a collision, flash or damage reaction",
    aftermath: "a few spores continue floating as the affected target's eyelids and posture become visibly heavy",
  },
  growth: {
    windup: "the attacker roots its stance as warm sunlight and soft green energy rise upward through its body",
    impact: "the green light pulses inward through the attacker's silhouette to strengthen it, with no attack launched at the opponent",
    aftermath: "the inward aura stabilizes into a firmer, more confident stance and then fades",
  },
  ember: {
    windup: "the attacker draws breath as a small orange flame and glowing embers gather inside the open mouth",
    impact: "a compact burst of several small orange fire embers travels from the mouth and scatters at contact, never becoming a huge flamethrower",
    aftermath: "tiny embers and wisps of smoke drift upward and extinguish quickly",
  },
  scratch: {
    windup: "the attacker raises one foreclaw close to the body with a small sharp glint and a coiled step forward",
    impact: "one fast close-range claw swipe draws two or three cream-white slash streaks across the contact plane without firing a projectile",
    aftermath: "the claw completes its follow-through as the slash streaks vanish and both bodies separate",
  },
  growl: {
    windup: "the attacker expands its chest and fixes the target with a firm expression before vocalizing",
    impact: "visible translucent sound-pressure rings travel from the open mouth toward the target without physical contact or damage",
    aftermath: "the sound rings dissipate as the target's aggressive posture visibly softens",
  },
  smokescreen: {
    windup: "the attacker inhales and lowers its head as dark gray smoke begins curling at the mouth",
    impact: "a dense charcoal smoke cloud billows outward and obscures the target's sightline without a damaging hit",
    aftermath: "the smoke thins unevenly but leaves the target blinking and struggling to aim",
  },
  rockThrow: {
    windup: "the attacker scoops up and lifts a compact rough stone with a visible weight shift",
    impact: "the stone is hurled in one ballistic arc and breaks into a few fragments with a grounded dust burst at contact",
    aftermath: "small rock fragments bounce and settle while the dust falls back to the ground",
  },
  defenseCurl: {
    windup: "the attacker draws in its limbs and begins curling its body into a tight defensive ball",
    impact: "the curled body locks into place with a brief stone-like sheen and one subtle defensive ring, without targeting the opponent",
    aftermath: "the sheen fades while the attacker remains compact and visibly better braced",
  },
  bulldoze: {
    windup: "the attacker raises its weight and braces to drive force straight down into the terrain",
    impact: "a heavy ground slam sends one low circular earth shockwave, cracked soil and rolling dust toward the target",
    aftermath: "the ground stops heaving as dust settles around the target's unsteady, slowed footing",
  },
  shadowBall: {
    windup: "violet-black spectral wisps spiral inward and condense into one dense shadow sphere beside the attacker",
    impact: "the single shadow sphere launches along a curved path and blooms into a dark violet spectral splash at contact",
    aftermath: "the dark splash fragments into fading ghostly motes without leaving a physical wound",
  },
  lick: {
    windup: "the attacker leans close as its tongue extends with an eerie purple spectral sheen",
    impact: "the tongue makes one unmistakable physical sweep across the target, leaving only a brief static-like ghost shimmer",
    aftermath: "the tongue retracts fully as the spectral shimmer fades from the target",
  },
  hypnosis: {
    windup: "the attacker's eyes brighten as slow concentric magenta psychic rings form around its gaze",
    impact: "the evenly spaced hypnotic rings travel toward and surround the target without collision, recoil or damage",
    aftermath: "the rings fade slowly as the affected target's eyelids droop and body relaxes into sleep",
  },
  confuseRay: {
    windup: "an eerie violet-white will-o'-wisp orb forms in front of the attacker and rotates with an irregular rhythm",
    impact: "the ghostly orb circles the target's head and splits into a few disorienting lights without a damaging impact",
    aftermath: "the false lights orbit briefly as the target looks unfocused and loses its sense of direction",
  },
  struggle: {
    windup: "the exhausted attacker gathers itself into an unstable desperate full-body lunge with no elemental energy",
    impact: "the attacker makes one uncontrolled neutral body collision that visibly jars both combatants",
    aftermath: "the target recoils while the attacker is thrown back by its own recoil and struggles to stand",
  },
};

function moveVisualSignature(attack, purpose) {
  const signature = MOVE_VISUAL_SIGNATURES[attack.move.id]?.[purpose]
    ?? `the move uses ${TYPE_VISUALS[attack.move.type] ?? "clean readable energy"} with a distinct preparation, delivery and recovery`;
  const move = readableId(attack.move.id);
  const visual = TYPE_VISUALS[attack.move.type] ?? "the move's characteristic visual effect";
  if (purpose === "windup") return signature;
  if (purpose === "impact" && attack.outcome.missed) {
    return `the already prepared ${move} completes its recognizable delivery path using ${visual}, but ${["sleep", "freeze"].includes(attack.target.status) ? "it passes beside the immobile target, without any dodge or waking" : "the target visibly evades before contact"}; there is no contact flash, hit reaction or applied effect`;
  }
  if (purpose === "impact" && attack.outcome.effectiveness === 0) {
    return `the recognizable ${move} delivery using ${visual} reaches the target and dissipates harmlessly; there is no contact flash, hit reaction, status or stat change`;
  }
  if (purpose === "impact" && attack.outcome.damage === 0
    && !attack.outcome.status && attack.outcome.statChanges.length === 0) {
    return `the recognizable ${move} motion and ${visual} are performed, but visibly produce no change in either combatant's condition or posture`;
  }
  if (purpose === "impact" && attack.outcome.damage === 0) {
    return `${signature}; communicate only the authoritative status or stat effect below, never a damaging collision`;
  }
  if (purpose === "aftermath" && attack.outcome.fainted && attack.outcome.actorFainted) {
    return `residual ${visual} from ${move} fades while the target remains down from the direct hit and the attacker also collapses from recoil; neither combatant recovers its footing`;
  }
  if (purpose === "aftermath" && attack.outcome.actorFainted) {
    return `residual ${visual} from ${move} fades as the attacker collapses from recoil and remains down while the target stays able to battle`;
  }
  if (purpose === "aftermath" && attack.outcome.fainted && attack.outcome.recoilDamage) {
    return `residual ${visual} from ${move} fades while the target remains down; the attacker is thrown back by the authoritative recoil, visibly absorbs it, then stays standing`;
  }
  if (purpose === "aftermath" && attack.outcome.fainted) {
    return `residual ${visual} from ${move} fades while the target completes the faint reaction and remains down; only the attacker settles back into a stable battle stance`;
  }
  if (purpose === "aftermath" && attack.outcome.missed) {
    return `residual ${visual} from the missed ${move} fades away while the target remains entirely unharmed and unaffected`;
  }
  if (purpose === "aftermath" && attack.outcome.effectiveness === 0) {
    return `residual ${visual} from the ineffective ${move} vanishes while the target remains entirely unharmed and unaffected`;
  }
  if (purpose === "aftermath" && attack.outcome.damage === 0
    && !attack.outcome.status && attack.outcome.statChanges.length === 0) {
    return `the characteristic ${visual} of ${move} fades without changing either combatant's condition or posture`;
  }
  if (purpose === "aftermath" && (attack.target.status || attack.outcome.status)) {
    return `only transient ${visual} dissipates; preserve the recorded continuing condition and posture: ${conditionDirection(attackVisualScene(attack, true)[attack.target.side])}`;
  }
  return signature;
}

const STAT_LABELS = {
  attack: "攻击",
  defense: "防御",
  specialAttack: "特攻",
  specialDefense: "特防",
  speed: "速度",
  accuracy: "命中",
  evasion: "闪避",
};

const SINGLE_BEAT = { purpose: "complete", startAnchor: "idle", endAnchor: "recovery" };
const EXPANDED_BEATS = [
  { purpose: "setup", startAnchor: "idle", endAnchor: "charged" },
  { purpose: "payoff", startAnchor: "charged", endAnchor: "recovery" },
];

function canExpandAttack(attack) {
  return !attack.blockedReason && Boolean(attack.outcome.fainted || attack.outcome.actorFainted);
}

// This is a failed action, not an executed move or a miss. Keep
// its acting and facts deterministic even when the director changes coverage.
function createBlockedBeat(attack, index, anchored = false) {
  const player = attack.actor.side === "player" ? attack.actor : attack.target;
  const opponent = attack.actor.side === "opponent" ? attack.actor : attack.target;
  const reason = attack.blockedReason;
  const acting = {
    paralysis: "A few thin yellow static arcs stay LOCAL to its body, muscles lock and tremble once, expression tightens in frustrated effort. No traveling electricity or projectile. The attempted action stops here; paralysis persists.",
    sleep: "It is still ASLEEP. Closed eyelids, relaxed sleeping posture and slow breathing throughout. A small sleep breath shows time passing, but no attentive response, wake-up, attack anticipation, voluntary dodge or spiral knockout eyes. It remains asleep through the tail frame.",
    freeze: "It is still FROZEN. Show the recognizable face through a translucent pale-blue ice shell, body immobile inside. Restrained glints on the ice communicate the failed turn. No thawing, cracking free, fire, voluntary movement or newly inflicted ice. The intact ice shell persists in the tail frame.",
    confusion: `Confusion interrupts the intended move. Unfocused gaze and unsteady body acting lead to ONE small self-directed stumble/bump at 2.4s, causing exactly ${attack.outcome.selfDamage} HP self-damage. No move effect or opponent contact. This is NOT recoil from a released move. ${attack.outcome.actorFainted ? `This real self-damage knocks the actor out: ${FAINT_ACTING}.` : "A restrained self-hit flinch; it stays conscious, no spiral knockout eyes or fainting. Confusion persists."}`,
  }[reason];
  const rules = reason === "confusion"
    ? `Only the actor takes the recorded ${attack.outcome.selfDamage} HP self-damage${attack.outcome.actorFainted ? " and faints" : " without fainting"}; opponent HP and conditions do not change. No move damage, recoil, healing or stat change.`
    : "No damage, recoil, healing, stat changes or newly inflicted conditions; all HP and conditions remain unchanged. Neither Pokémon faints.";
  const shots = [
    { index: 0, startAt: 0, endAt: 1.1, shotSize: "medium", subject: "both", cameraMovement: "locked" },
    { index: 1, startAt: 1.1, endAt: 3.5, shotSize: "close_up", subject: "actor", cameraMovement: "slow_push" },
    { index: 2, startAt: 3.5, endAt: 5, shotSize: "wide", subject: "both", cameraMovement: "locked" },
  ];
  return {
    index, phaseIndex: 0, attackId: attack.id, attackSequenceIndex: attack.sequenceIndex,
    purpose: "blocked", blockedReason: reason, durationSeconds: 5,
    startAnchor: "idle", endAnchor: "recovery", camera: "attacker_three_quarter",
    motionStyle: "controlled", energyLevel: "subtle", cameraMovement: "slow_push", shots, impactAt: reason === "confusion" ? 2.4 : null,
    motionPrompt: [
      index === 0 && !anchored
        ? `Image 1 identifies player ${player.speciesId}; Image 2 identifies opponent ${opponent.speciesId}. Re-establish the low shared battle view on level grass in a pine clearing with grass-capped ochre rock ledges and a rounded tree on the right. Player left foreground, opponent right middle distance. Redraw both identity references as hand-drawn animation, not pixel art.`
        : "Match the supplied preceding tail frame on the FIRST rendered frame, preserving species, poses, conditions, arena and screen direction, then cut into this next chronological action. Never replay the preceding strike or reset either character.",
      "Polished hand-drawn 2D Pokémon TV anime: expressive faces, clean ink outlines, flat cel colors and painted grassland. Natural chronological cuts, never 3D, a game capture or a slideshow.",
      `AUTHORITATIVE ACTION FAILURE: it is ${attack.actor.speciesId}'s turn, but existing ${reason} prevents the intended move ${readableId(attack.move.id)} (${attack.move.name}). That move is NOT executed. This is NOT a miss or immunity, NOT a fresh ${reason} infliction. Neither Pokémon attacks the other in this clip. ${rules}`,
      `[0-1.1s] Medium shared view establishes ${attack.actor.speciesId}'s existing ${reason}. ${["sleep", "freeze"].includes(reason) ? "Do not show a conscious attempt to begin an attack." : "A tiny effort to initiate the turn, without charging or forward attack travel."}`,
      `[1.1-3.5s] Cut to a close-up of ${attack.actor.speciesId}'s face and limbs. ${acting} No projectile, opponent hit reaction or attack replay.`,
      `[3.5-5s] Cut back to a shared wide view. Hold the recorded outcome; do not cure the blocking condition or reset the actor to a healthy battle stance. ${attack.target.speciesId} stays at its position with its existing condition, without counterattacking. Both identities remain recognizable in the tail frame. ${rules}`,
      `CONTINUITY SHEET: before=${JSON.stringify(attackVisualScene(attack))}; after=${JSON.stringify(attackVisualScene(attack, true))}. Preserve these conditions in every shot, including off-screen continuity.`,
      `Untouched opponent continuity: ${conditionDirection(attackVisualScene(attack)[attack.target.side])}`,
      `Sound: soft outdoor ambience with ${reason === "paralysis" ? "faint local static and restrained effort" : reason === "sleep" ? "slow sleeping breaths, no waking cry" : reason === "freeze" ? "a subtle ice shimmer, no cracking or thawing" : "one small dry self-bump exactly at 2.4s"}. No move release sound, music or dialogue.`,
      PROMPT_GUARDRAIL,
    ].join(" "),
  };
}

function readableId(value) {
  return String(value || "creature").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();
}

function statChangeNote(attack) {
  return attack.outcome.statChanges.map((change) => {
    const subject = change.targetSide === attack.actor.side ? attack.actor.name : attack.target.name;
    return `${subject}的${STAT_LABELS[change.stat] ?? change.stat}${change.delta > 0 ? "提高" : "降低"} ${Math.abs(change.delta)} 级`;
  }).join("，");
}

function statChangeAction(attack) {
  return attack.outcome.statChanges.map((change) => {
    const subject = change.targetSide === attack.actor.side
      ? `${readableId(attack.actor.speciesId)} (${attack.actor.name})`
      : `${readableId(attack.target.speciesId)} (${attack.target.name})`;
    return `${subject}'s ${readableId(change.stat)} ${change.delta > 0 ? "rises" : "falls"} by ${Math.abs(change.delta)} stage${Math.abs(change.delta) === 1 ? "" : "s"}`;
  }).join("; ");
}

function authoritativeNote(attack) {
  if (attack.outcome.missed) return `${attack.move.name}落空，${attack.target.name}不承受伤害。`;
  if (attack.outcome.effectiveness === 0) return `${attack.move.name}对${attack.target.name}无效，实际伤害为 0。`;
  if (attack.outcome.status && attack.outcome.damage === 0) {
    return `${attack.move.name}造成 ${attack.outcome.status}，实际伤害为 0。`;
  }
  if (["self_stat", "foe_stat", "mixed_stat"].includes(attack.outcome.effectMode)) {
    if (!attack.outcome.statChanges.length) {
      const subject = attack.outcome.effectMode === "self_stat" ? attack.actor.name : attack.target.name;
      return `${attack.move.name}尝试改变${subject}的能力，但实际能力阶级没有变化；不造成伤害。`;
    }
    return `${attack.move.name}不造成伤害；${statChangeNote(attack)}。`;
  }
  const recoil = attack.outcome.recoilDamage
    ? `；${attack.actor.name}承受 ${attack.outcome.recoilDamage} 点反作用力${attack.outcome.actorFainted ? "并倒下" : "但仍可战斗"}`
    : "";
  const critical = attack.outcome.critical ? "，命中要害" : "";
  const effectiveness = attack.outcome.effectiveness > 1 ? "，效果绝佳"
    : attack.outcome.effectiveness > 0 && attack.outcome.effectiveness < 1 ? "，效果不佳" : "";
  const cleared = attack.outcome.clearedStatus ? `，并解除了${attack.target.name}的 ${attack.outcome.clearedStatus}` : "";
  if (attack.outcome.fainted) return `${attack.move.name}造成 ${attack.outcome.damage} 点直接伤害${critical}${effectiveness}并令${attack.target.name}倒下${recoil}。`;
  const status = attack.outcome.status ? `，并造成 ${attack.outcome.status}` : "";
  const stats = attack.outcome.statChanges.length ? `，并使${statChangeNote(attack)}` : "";
  return `${attack.move.name}造成 ${attack.outcome.damage} 点实际伤害${critical}${effectiveness}${cleared}${status}${stats}，${attack.target.name}仍可战斗${recoil}。`;
}

function authoritativeAction(attack, purpose) {
  const actor = `${readableId(attack.actor.speciesId)} (${attack.actor.name})`;
  const target = `${readableId(attack.target.speciesId)} (${attack.target.name})`;
  const move = `${readableId(attack.move.id)} (${attack.move.name})`;
  const visual = TYPE_VISUALS[attack.move.type] ?? `${readableId(attack.move.type)}-type energy`;
  if (purpose === "windup") {
    if (attack.outcome.effectMode === "self_stat") {
      return `${actor} prepares ${move} by focusing ${visual} inward; ${target} remains in the opposing position and no attack is launched toward the target`;
    }
    return `${actor} prepares the ${move} move while ${visual} gathers around the attacker; ${target} remains in the existing opposing position`;
  }
  if (purpose === "impact") {
    if (attack.outcome.missed) return `${actor} releases ${move}, but ${["sleep", "freeze"].includes(attack.target.status) ? `the move passes beside the immobile ${target} without contact; the target does not dodge or wake` : `${target} clearly evades before contact and takes no hit`}`;
    if (attack.outcome.effectiveness === 0) return `${actor} releases ${move} toward ${target}; ${visual} reaches the target and harmlessly dissipates with no damage reaction`;
    if (attack.outcome.status && attack.outcome.damage === 0) return `${actor} releases ${move}; ${visual} reaches ${target} and clearly applies ${readableId(attack.outcome.status)} without a damage impact`;
    if (attack.outcome.effectMode === "self_stat") {
      const change = statChangeAction(attack) || `${actor}'s relevant stats are already at their limit and do not change`;
      return `${actor} completes ${move} without targeting ${target}; ${change}; no projectile, contact, or damage reaction occurs`;
    }
    if (["foe_stat", "mixed_stat"].includes(attack.outcome.effectMode)) {
      const change = statChangeAction(attack) || `${target}'s relevant stats are already at their limit and do not change`;
      return `${actor} performs ${move} toward ${target}; ${change}; the move causes no damage impact`;
    }
    if (attack.outcome.effectMode === "no_effect") return `${actor} performs ${move}, but no damage, status, or stat change takes effect on ${target}`;
    const critical = attack.outcome.critical ? "; emphasize that this is a precise critical hit" : "";
    const effectiveness = attack.outcome.effectiveness > 1 ? "; show a visibly amplified super-effective response"
      : attack.outcome.effectiveness > 0 && attack.outcome.effectiveness < 1 ? "; keep the not-very-effective reaction deliberately restrained" : "";
    const quality = `${critical}${effectiveness}`;
    const cleared = attack.outcome.clearedStatus
      ? `; the hit visibly melts and clears ${target}'s existing ${readableId(attack.outcome.clearedStatus)}`
      : "";
    const status = attack.outcome.status
      ? `; after contact, ${target} clearly enters the continuing ${readableId(attack.outcome.status)} state`
      : "";
    const stats = attack.outcome.statChanges.length ? `; ${statChangeAction(attack)}` : "";
    return `${actor} releases ${move}; ${visual} hits ${target}, producing a ${attack.outcome.damageTier} reaction proportional to the authoritative ${attack.outcome.damage} HP damage${quality}${cleared}${status}${stats}`;
  }
  if (attack.outcome.missed || attack.outcome.effectiveness === 0) {
    return `${actor} and ${target} remain in their original positions and retain their recorded conditions; neither creature shows a damage reaction. ${persistentConditionDirection(attack)}`;
  }
  if (attack.outcome.fainted && attack.outcome.actorFainted) {
    return `${target} stays down from the direct hit while ${actor} takes the authoritative ${attack.outcome.recoilDamage} HP recoil and also collapses; both remain fainted`;
  }
  if (attack.outcome.actorFainted) {
    return `${target} completes the ${attack.outcome.damageTier} hit reaction and remains able to battle while ${actor} takes the authoritative ${attack.outcome.recoilDamage} HP recoil, collapses and remains fainted`;
  }
  if (attack.outcome.fainted && attack.outcome.recoilDamage) {
    return `${target} stays down from the direct hit while ${actor} takes the authoritative ${attack.outcome.recoilDamage} HP recoil, staggers backward, then remains standing`;
  }
  if (attack.outcome.fainted) return `${target} completes the faint reaction and stays down while ${actor} settles back into the original battle stance`;
  if (attack.outcome.status && attack.outcome.damage === 0) return `${target} shows the continuing ${readableId(attack.outcome.status)} state while ${actor} returns to the original battle stance`;
  if (attack.outcome.effectMode === "self_stat") {
    const result = attack.outcome.statChanges.length ? "holds the strengthened battle stance" : "returns to the unchanged battle stance";
    return `${actor} ${result} after ${move}; ${target} remains unharmed in the original position`;
  }
  if (["foe_stat", "mixed_stat"].includes(attack.outcome.effectMode)) {
    const result = attack.outcome.statChanges.length
      ? `${target} shows the stat change from ${move} without a hit reaction`
      : `${target} remains unchanged after the attempted ${move}, with no hit reaction`;
    return `${result} while ${actor} returns to the original stance`;
  }
  if (attack.outcome.effectMode === "no_effect") return `${actor} and ${target} remain unchanged and return to their original battle stances`;
  if (attack.outcome.status) {
    const cleared = attack.outcome.clearedStatus ? ` after the prior ${readableId(attack.outcome.clearedStatus)} has fully melted` : "";
    return `${target} completes a ${attack.outcome.damageTier} hit reaction and clearly retains the continuing ${readableId(attack.outcome.status)} state${cleared} while ${actor} returns to the original battle stance`;
  }
  if (attack.outcome.clearedStatus) {
    return `${target} completes a ${attack.outcome.damageTier} hit reaction and is visibly free of the previous ${readableId(attack.outcome.clearedStatus)} while ${actor} returns to the original battle stance`;
  }
  return `${target} completes a ${attack.outcome.damageTier} hit reaction but remains able to battle while ${actor} returns to the original battle stance`;
}

function composeMotionPrompt(attack, beat, sequenceIndex, anchored = false) {
  const continuity = sequenceIndex === 0 && !anchored
    ? "Create a fresh hand-drawn establishing first frame, not pixel rendering. Establish both Pokémon facing each other on level grass in a pine clearing with grass-capped ochre rock ledges and a rounded tree on the right. Start from a low battle viewpoint with the player in the left foreground and the opponent grounded in the right middle distance, then move into this opening beat's cinematic coverage"
    : "The supplied image is the exact final frame of the preceding five-second clip. Match it on the first rendered frame without reframing, redesigning, resetting poses or changing the background, then continue the motion forward as the next chronological beat";
  const player = attack.actor.side === "player" ? attack.actor : attack.target;
  const opponent = attack.actor.side === "opponent" ? attack.actor : attack.target;
  const referenceIdentity = sequenceIndex === 0 && !anchored
    ? `Reference-image identity contract: Image 1 is the player-side ${readableId(player.speciesId)} (${player.name}); Image 2 is the opponent-side ${readableId(opponent.speciesId)} (${opponent.name}). Use both images only to lock each species' silhouette, body proportions, primary colors, face, appendages and iconic markings. Redraw both characters as polished, consistent 2D Japanese television animation; do not preserve the source pixel grid, low resolution, white reference background or sprite-game rendering style.`
    : "";
  const shotPlan = beat.shots.map((shot) => (
    `${shot.startAt.toFixed(1)}-${shot.endAt.toFixed(1)}s: ${shot.shotSize.replace(/_/g, " ")} of ${shot.subject.replace(/_/g, " ")} with ${shot.cameraMovement.replace(/_/g, " ")}`
  )).join("; ");
  const includesImpact = beat.purpose !== "setup";
  const phaseDirections = beat.purpose === "complete"
    ? [
      `Opening anticipation: ${moveVisualSignature(attack, "windup")}; ${authoritativeAction(attack, "windup")}.`,
      `Action and contact: ${moveVisualSignature(attack, "impact")}; ${authoritativeAction(attack, "impact")}.`,
      `Resolution: ${moveVisualSignature(attack, "aftermath")}; ${authoritativeAction(attack, "aftermath")}.`,
    ]
    : beat.purpose === "setup"
      ? [`Setup only: ${moveVisualSignature(attack, "windup")}; ${authoritativeAction(attack, "windup")}. End fully charged and ready to release.`]
      : [
        `Release and contact: ${moveVisualSignature(attack, "impact")}; ${authoritativeAction(attack, "impact")}.`,
        `Resolution: ${moveVisualSignature(attack, "aftermath")}; ${authoritativeAction(attack, "aftermath")}.`,
      ];
  const impactDirection = !includesImpact
    ? "Build anticipation cleanly and reserve every impact accent for the following payoff clip."
    : attack.outcome.missed || attack.outcome.effectiveness === 0 || attack.outcome.damage === 0
      ? "Do not use impact shake, a contact flash, damaging recoil or hit-stop; communicate the authoritative non-damaging outcome through the move path, expression and posture only."
      : "Reserve the strongest shake, smear and one very brief hit-stop-like impact frame for the actual contact moment only.";
  return [
    `${continuity}.`,
    referenceIdentity,
    ANIME_STYLE_BIBLE,
    beat.purpose === "complete"
      ? "Tell the complete attack in this single five-second clip: anticipation, move execution, impact or authoritative non-impact result, then a concise readable recovery. Do not repeat the attack or restart its windup."
      : beat.purpose === "setup"
        ? "This is the first half of a deliberately expanded decisive attack; build once toward the release without showing the final result yet."
        : "This is the second and final half of the expanded decisive attack; continue directly from the charged pose, release once, show the result, and finish the action without a second windup.",
    ...phaseDirections,
    persistentConditionDirection(attack, beat.purpose === "setup"),
    includesImpact ? `The single decisive result happens at ${beat.impactAt.toFixed(1)} seconds. Before contact show a clear directional attack path; at contact show the target's body responding, not just an effect floating between stationary characters. ${attack.outcome.damage > 0 ? "Use a brief compressed impact pose, then a readable stagger proportional to damage. Synchronize the attack sound and contact sound with their visible actions." : "Respect the recorded non-damaging outcome; no fabricated stagger or injury."}` : "",
    `Authoritative timing: ${readableId(attack.actor.speciesId)} has ${attack.tempo.actorSpeed} modified Speed versus ${attack.target.name}'s ${attack.tempo.targetSpeed}; pace this as a ${attack.tempo.tier} action without changing the recorded outcome.`,
    `Cut this five-second beat into exactly ${beat.shots.length} authored animation shots at these hard timings: ${shotPlan}. The cuts must stay chronological and each new angle must preserve screen direction and spatial continuity.`,
    `Use ${beat.motionStyle} motion with eased acceleration, ${beat.energyLevel} effect intensity, and the prescribed ${beat.camera.replace(/_/g, " ")} primary composition. ${impactDirection}`,
    PROMPT_GUARDRAIL,
  ].filter(Boolean).join(" ");
}

function finalizeBeat(attack, beat, phaseIndex, sequenceIndex) {
  return {
    index: sequenceIndex,
    phaseIndex,
    attackId: attack.id,
    attackSequenceIndex: attack.sequenceIndex,
    purpose: beat.purpose,
    durationSeconds: 5,
    startAnchor: beat.startAnchor,
    endAnchor: beat.endAnchor,
    camera: beat.camera,
    motionStyle: beat.motionStyle,
    energyLevel: beat.energyLevel,
    cameraMovement: beat.cameraMovement,
    shots: beat.shots,
    motionPrompt: composeMotionPrompt(attack, beat, sequenceIndex),
    impactAt: beat.impactAt,
  };
}

function fallbackShots(attack, purpose) {
  if (purpose === "setup") {
    return [
      { index: 0, startAt: 0, endAt: 1.8, shotSize: "close_up", subject: "actor", cameraMovement: "slow_push" },
      { index: 1, startAt: 1.8, endAt: 5, shotSize: "medium", subject: "both", cameraMovement: "locked" },
    ];
  }
  if (purpose === "payoff") {
    const finalSubject = resultShotSubject(attack);
    return [
      { index: 0, startAt: 0, endAt: 1, shotSize: "close_up", subject: "actor", cameraMovement: "lateral_track" },
      { index: 1, startAt: 1, endAt: 3.1, shotSize: "wide", subject: "both", cameraMovement: "impact_push" },
      { index: 2, startAt: 3.1, endAt: 5, shotSize: "close_up", subject: finalSubject, cameraMovement: "locked" },
    ];
  }
  const finalSubject = resultShotSubject(attack);
  return [
    { index: 0, startAt: 0, endAt: 1.1, shotSize: "close_up", subject: "actor", cameraMovement: "slow_push" },
    { index: 1, startAt: 1.1, endAt: 3.4, shotSize: "wide", subject: "both", cameraMovement: "lateral_track" },
    { index: 2, startAt: 3.4, endAt: 5, shotSize: "close_up", subject: finalSubject, cameraMovement: "locked" },
  ];
}

function resultShotSubject(attack) {
  if (attack.outcome.actorFainted || attack.outcome.recoilDamage > 0) return "both";
  if (attack.outcome.effectMode === "self_stat") return "actor";
  if (attack.outcome.missed || attack.outcome.effectiveness === 0 || attack.outcome.effectMode === "no_effect") return "both";
  return "target";
}

function normalizeShots(value, purpose, impactAt, attack) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    throw storyboardError("每个 5 秒分镜必须包含 2 至 3 个镜头");
  }
  let cursor = 0;
  const shots = value.map((shot, index) => {
    if (shot?.index !== index) throw storyboardError("分镜内镜头顺序无效");
    const startAt = shot.startAt;
    const endAt = shot.endAt;
    if (!Number.isFinite(startAt) || startAt < 0 || startAt > 5
      || !Number.isFinite(endAt) || endAt < 0 || endAt > 5) {
      throw storyboardError("分镜内镜头时间无效");
    }
    if (startAt !== cursor || endAt - startAt < 0.5) {
      throw storyboardError("分镜内镜头必须连续覆盖且每镜至少 0.5 秒");
    }
    const shotSize = cleanString(shot.shotSize, 32);
    const subject = cleanString(shot.subject, 24);
    const cameraMovement = cleanString(shot.cameraMovement, 32);
    if (!SHOT_SIZES.has(shotSize) || !SHOT_SUBJECTS.has(subject) || !CAMERA_MOVEMENTS.has(cameraMovement)) {
      throw storyboardError("分镜内镜头包含未允许的枚举值");
    }
    cursor = endAt;
    return { index, startAt, endAt, shotSize, subject, cameraMovement };
  });
  if (cursor !== 5) throw storyboardError("分镜内镜头必须无缝覆盖完整 5 秒");
  const requiresImpact = purpose === "complete" || purpose === "payoff";
  if (requiresImpact) {
    const impactShot = shots.find((shot) => impactAt > shot.startAt && impactAt < shot.endAt);
    if (!impactShot || !["actor", "target", "both", "move_effect"].includes(impactShot.subject)) {
      throw storyboardError("命中同步点必须落在一个镜头内部");
    }
  }
  if (!["actor", "both"].includes(shots[0].subject)) {
    throw storyboardError("分镜开场必须展示攻击方或双方，不能只展示特效或目标");
  }
  if (!shots.some((shot) => shot.subject === "both")) {
    throw storyboardError("每个分镜必须至少包含一个双方同场镜头以维持战斗空间连续性");
  }
  if (purpose === "setup" && !["actor", "both"].includes(shots.at(-1).subject)) {
    throw storyboardError("铺垫分镜的最后镜头必须保留已蓄势的攻击方，供下一段尾帧续接");
  }
  if (requiresImpact) {
    const requiredSubject = resultShotSubject(attack);
    const allowedFinalSubjects = requiredSubject === "both" ? ["both"] : [requiredSubject, "both"];
    if (!allowedFinalSubjects.includes(shots.at(-1).subject)) {
      throw storyboardError("完整或收束分镜的最后镜头必须展示实际结算对象");
    }
    const impactShot = shots.find(shot => impactAt > shot.startAt && impactAt < shot.endAt);
    if (attack.outcome.damage > 0 && !["target", "both"].includes(impactShot.subject)) {
      throw storyboardError("伤害命中镜头必须展示目标身体或双方，不能只展示攻击者或特效");
    }
  }
  return shots;
}

function createTurnPlan(attacks, sequence) {
  const combatants = {};
  for (const attack of attacks) {
    combatants[attack.actor.side] ??= attack.actor;
    combatants[attack.target.side] ??= attack.target;
  }
  const playerName = combatants.player?.name ?? attacks[0]?.actor.name ?? "我方";
  const opponentName = combatants.opponent?.name ?? attacks[0]?.target.name ?? "对手";
  return {
    title: `${playerName} ⇄ ${opponentName}`,
    directorNote: `双方共用一条连续时间线。${attacks.map((attack, index) => attack.blockedReason
      ? `${index + 1}. 轮到${attack.actor.name}行动，但因${BLOCKED_REASON_LABELS[attack.blockedReason]}未能出招；未使出${attack.move.name}，${attack.blockedReason === "confusion" ? `自伤 ${attack.outcome.selfDamage} HP${attack.outcome.actorFainted ? "并倒下" : "但仍可战斗"}，对方不受伤` : "双方 HP 和状态不变"}。`
      : `${index + 1}. ${attack.actor.name}使用${authoritativeNote(attack)}`).join(" ")}`,
    combatants,
    attacks,
    sequence,
  };
}

export function createFallbackStoryboard(attacks, warning = "") {
  let sequenceIndex = 0;
  const sequence = attacks.flatMap((attack) => {
    if (attack.blockedReason) return [createBlockedBeat(attack, sequenceIndex++)];
    const motionStyle = attack.tempo.tier === "rapid" ? "snappy" : attack.tempo.tier === "deliberate" ? "weighty" : "controlled";
    const energyLevel = ["heavy", "decisive"].includes(attack.outcome.damageTier) ? "intense" : attack.outcome.damageTier === "none" ? "subtle" : "moderate";
    const beats = canExpandAttack(attack)
      ? [
        { ...EXPANDED_BEATS[0], camera: "attacker_three_quarter", motionStyle, energyLevel, cameraMovement: "slow_push", shots: fallbackShots(attack, "setup"), impactAt: null },
        { ...EXPANDED_BEATS[1], camera: "side_tracking", motionStyle, energyLevel, cameraMovement: "impact_push", shots: fallbackShots(attack, "payoff"), impactAt: 2.8 },
      ]
      : [
        { ...SINGLE_BEAT, camera: "side_tracking", motionStyle, energyLevel, cameraMovement: "lateral_track", shots: fallbackShots(attack, "complete"), impactAt: 2.8 },
      ];
    return beats.map((beat, phaseIndex) => finalizeBeat(attack, beat, phaseIndex, sequenceIndex++));
  });
  return deepFreeze({ version: 2, warning, turn: createTurnPlan(attacks, sequence) });
}

function persistentConditionDirection(attack, setupOnly = false) {
  return [attack.actor, attack.target].map((subject) => {
    const isTarget = subject.side === attack.target.side;
    const fainted = !setupOnly && (isTarget ? attack.outcome.fainted : attack.outcome.actorFainted);
    const before = [subject.status, subject.confused ? "confusion" : null].filter(Boolean);
    const after = before.filter(status => !(!setupOnly && isTarget && status === attack.outcome.clearedStatus));
    if (!setupOnly && isTarget && attack.outcome.status && !after.includes(attack.outcome.status)) after.push(attack.outcome.status);
    const opening = before.length ? `FROM FRAME ONE ${subject.speciesId} already has ${before.join(" and ")}: ${before.map(status => STATUS_ACTING[status]).join("; ")}. Preserve these cues in EVERY shot, including off-screen continuity and when receiving a hit; only an explicitly recorded cure or knockout can change them.` : "";
    const ending = fainted
      ? `${subject.speciesId} ${FAINT_ACTING}; stays down through the last frame.`
      : after.length
        ? `At the ending ${subject.speciesId}: ${after.map(status => `${status}: ${STATUS_ACTING[status]}`).join("; ")}. Keep these continuing condition cues after the move particles fade.`
        : `${subject.speciesId} remains conscious and able to battle; no unrecorded status or collapse.`;
    return `${opening} ${ending}`.trim();
  }).join(" ");
}

function cinematicImpactDirection(attack) {
  const { outcome } = attack;
  if (outcome.damage === 0) return "No damage pose, hit flash, hit-stop, impact shake or knockback. Tension comes from the delivery path, eyes and the recorded tactical result, not injury.";
  const quality = outcome.effectiveness > 1
    ? `Super-effective (${outcome.effectiveness}x): a sharper type-colored impact accent and a more urgent reaction, not an automatic knockout.`
    : outcome.effectiveness < 1
      ? `Not very effective (${outcome.effectiveness}x): the attack visibly connects but its energy breaks up against the receiver, with a restrained contact accent; do not confuse resistance with a miss.`
      : "Normally effective (1x): one clean type-specific contact accent, without super-effective exaggeration.";
  const weight = ["sleep", "freeze"].includes(attack.target.status)
    ? `The receiver is already ${attack.target.status}: only passive displacement from the force, no voluntary bracing, dodging, alert eyes or recovery footwork. ${outcome.clearedStatus ? "The recorded fire hit melts the ice at contact, not before." : "An ordinary hit does not cure this condition."}`
    : outcome.damageTier === "light"
    ? "Small body flinch and a short footing adjustment, no launch across the arena."
    : "Compress the receiver's torso at contact, then a force-directed stagger with grounded foot drag and a short dust trail; no arbitrary flight out of frame.";
  return `${quality} Actual damage is ${outcome.damage} HP (${Math.round(outcome.damageRatio * 100)}% of maximum HP); use a ${outcome.damageTier} body reaction. ${weight} ${outcome.critical ? "Critical hit: a precise vulnerable-point contact, one short accent, not a second strike." : "This is not a critical hit."} A single 2-frame impact drawing and brief local camera jolt only at contact, never rapid full-screen flashing. Keep the target visible and its canonical colors readable through the effect.`;
}

function cinematicShots(attack, impactAt) {
  const firstCut = Math.min(0.8, impactAt - 0.5);
  const lastCut = Math.max(3.3, impactAt + 0.3);
  return [
    { index: 0, startAt: 0, endAt: firstCut, shotSize: "close_up", subject: "actor", cameraMovement: "slow_push" },
    { index: 1, startAt: firstCut, endAt: lastCut, shotSize: "wide", subject: "both", cameraMovement: "lateral_track" },
    { index: 2, startAt: lastCut, endAt: 5, shotSize: "medium", subject: resultShotSubject(attack), cameraMovement: "locked" },
  ];
}

function cinematicShotDirection(attack, shot, shotCount, impactAt) {
  const subject = { actor: attack.actor.speciesId, target: attack.target.speciesId, both: `${attack.actor.speciesId} and ${attack.target.speciesId}`, move_effect: `${readableId(attack.move.id)} delivery path` }[shot.subject];
  const movement = { locked: "hold the camera steady so body acting reads clearly", slow_push: "push in toward the face", lateral_track: "track laterally along the attack direction with foreground grass parallax", impact_push: attack.outcome.damage > 0 ? "push toward the contact plane, with one brief jolt at contact" : "push toward the receiving expression without impact shake" }[shot.cameraMovement];
  const angle = shot.index === 0 ? "low three-quarter angle"
    : shot.index === shotCount - 1 ? "high three-quarter reaction angle on the same side of the action axis"
      : attack.move.category === "special" ? "oblique over-the-shoulder angle, attacker foreground and receiver beyond"
        : "ground-level side angle showing the full travel and contact plane";
  const resolved = attackVisualScene(attack, true);
  const statefulReaction = attack.outcome.fainted || attack.outcome.actorFainted || attack.target.status || attack.outcome.status;
  const reaction = statefulReaction
    ? [attack.actor.side, attack.target.side].map(side => conditionDirection(resolved[side])).join(" ")
    : attack.outcome.damage > 0 ? "The receiver's eyes squeeze, jaw tightens and torso folds along the force, then footing reacts according to the recorded damage and final condition; no cheerful smile at impact" : "Resolve the recorded tactical result through expression and posture, without a pain flinch";
  const action = shot.index === 0 ? `Eyes narrow in concentration, body coils: ${moveVisualSignature(attack, "windup")}. Finish anticipation by ${shot.endAt.toFixed(1)}s; do not linger on the charged face`
    : shot.index === shotCount - 1 ? `${reaction}; no replay of the contact`
      : `Release immediately on this cut: ${moveVisualSignature(attack, "impact")}. The result occurs at ${impactAt.toFixed(1)}s with the receiver's body in view; the final part of this shot already shows the reaction, not more charging`;
  return `[${shot.startAt.toFixed(1)}-${shot.endAt.toFixed(1)}s] ${shot.index ? "CUT ON ACTION to" : "Move immediately into"} a ${shot.shotSize.replaceAll("_", " ")} of ${subject}, ${angle}; ${movement}. ${action}.`;
}

// Reuse compact director timing; replace all-wide compositions with readable coverage.
// The server also applies this, so a client cannot inject arbitrary motion prompts.
export function createRealtimeStoryboard(attacks, plan = null, anchored = false) {
  const sequence = attacks.map((attack, index) => {
    if (attack.blockedReason) return createBlockedBeat(attack, index, anchored);
    const candidate = plan?.turn?.sequence?.find(beat => beat.attackId === attack.id && beat.purpose === "complete");
    // This compact coverage has anticipation / delivery / reaction roles. Keep
    // director timing only when it actually places the result in the middle shot.
    const authored = candidate?.shots.length === 3
      && candidate.impactAt > candidate.shots[1].startAt && candidate.impactAt < candidate.shots[1].endAt
      && candidate.impactAt >= 1.3 && candidate.impactAt <= 3.8 ? candidate : null;
    const impactAt = authored?.impactAt ?? ({ quickAttack: 2.8, thunderbolt: 2.6, ember: 3.2 })[attack.move.id] ?? 1.8;
    const beat = {
      ...SINGLE_BEAT, camera: "side_tracking", motionStyle: attack.tempo.tier === "deliberate" ? "weighty" : "snappy",
      energyLevel: ["heavy", "decisive"].includes(attack.outcome.damageTier) ? "intense" : attack.outcome.damage > 0 ? "moderate" : "subtle",
      cameraMovement: "lateral_track",
      ...authored,
      impactAt,
      shots: authored?.shots.some(shot => ["close_up", "extreme_close_up"].includes(shot.shotSize))
        ? authored.shots : cinematicShots(attack, impactAt),
    };
    const finalized = finalizeBeat(attack, beat, 0, index);
    const player = attack.actor.side === "player" ? attack.actor : attack.target;
    const opponent = attack.actor.side === "opponent" ? attack.actor : attack.target;
    const identity = {
      pikachu: "Pikachu: yellow mouse, black-tipped long ears, red cheek circles, brown stripes ONLY on the back (never on the face or forehead), lightning-shaped tail",
      charmander: "Charmander: uniformly ORANGE bipedal lizard with a cream belly, round earless head, long smooth orange tail with a burning flame at its tip; no spots, colored patches, shell, wings or head stripes; never yellow, never mouse ears, never red cheek circles, never a lightning-shaped tail",
    };
    finalized.motionPrompt = [
      index === 0 && !anchored
        ? `Image 1 identifies ${player.speciesId}; Image 2 identifies ${opponent.speciesId}. Use these non-pixel character artwork references only for identity and canonical colors; animate both as hand-drawn 2D Pokémon TV anime on level grass in a pine clearing with grass-capped ochre rock ledges and a rounded tree on the right. No pixel art or game sprites in the rendered video. Establish a low battle viewpoint, player in the left foreground and opponent grounded in the right middle distance, then move into the authored camera coverage.`
        : "Match the supplied preceding tail frame on the FIRST rendered frame only, then immediately move into the authored camera coverage. This is frame continuity, NOT a locked camera or an idle loop. Keep the same arena, identities and action direction.",
      `The cast contains only two distinct Pokémon: ${identity[player.speciesId] ?? player.speciesId} on the player side; ${identity[opponent.speciesId] ?? opponent.speciesId} on the opponent side. A close-up may show just one of them; the other remains off-screen in the same arena. Never transfer features between species.`,
      "Hand-drawn Pokémon TV anime action sequence: bold clean ink, flat cel colors, painted grassland, expressive foreshortened poses and clear silhouettes. No UI, text, split-screen, trainers, extra creatures or 3D game rendering.",
      `The acting Pokémon is ${attack.actor.speciesId}; the receiving Pokémon is ${attack.target.speciesId}. Show exactly one ${readableId(attack.move.id)} action.`,
      "The command already happened: brief coiled anticipation, explosive acceleration, one readable result, then follow-through. Avoid a long charge-up, repeated attack or slow motion throughout.",
      `CONTINUITY SHEET: before=${JSON.stringify(attackVisualScene(attack))}; after=${JSON.stringify(attackVisualScene(attack, true))}. These are mandatory per-character conditions, not optional effects. Camera cuts, a new turn and fading particles never cure a condition.`,
      `Recorded result at ${beat.impactAt.toFixed(1)}s: ${authoritativeAction(attack, "impact")}. ${cinematicImpactDirection(attack)}`,
      ...beat.shots.map(shot => cinematicShotDirection(attack, shot, beat.shots.length, beat.impactAt)),
      `Resolution: carry the recorded result into the final reaction shot. ${attack.outcome.recoilDamage ? `The actor also takes exactly ${attack.outcome.recoilDamage} HP recoil from this same action, never a counterattack; show the actor's recoil reaction as well as the target.` : "The receiver does not counterattack in this clip."}`,
      persistentConditionDirection(attack),
      `Timing: ${attack.tempo.tier} action (${attack.tempo.actorSpeed} versus ${attack.tempo.targetSpeed} modified Speed); ${beat.motionStyle} motion. Use brief directional smears during travel, not distorted faces. Direct edit cuts, not dissolves or morphed transitions. Match action across cuts, preserve the 180-degree axis and location. End on the current result, not original idle poses; widen the final reaction framing just enough to leave both species identifiable in the tail frame. Only transient attack particles dissipate.`,
      attack.outcome.damage > 0 ? "Sound: acceleration whoosh, type-specific release, a short dry contact accent exactly at the hit, then footing and breathing. No music or dialogue." : "Sound: move-specific delivery and soft outdoor ambience; no damaging contact sound, music or dialogue.",
    ].join(" ");
    return finalized;
  });
  return { version: 2, turn: createTurnPlan(attacks, sequence) };
}

function storyboardError(message) {
  const error = new Error(message);
  error.code = "INVALID_STORYBOARD";
  return error;
}

export function normalizeStoryboardPlan(candidate, attacks) {
  if (!candidate || candidate.version !== 2 || !Array.isArray(candidate.sequence)) {
    throw storyboardError("分镜响应缺少 version=2 或 sequence 数组");
  }
  if (candidate.sequence.length < attacks.length || candidate.sequence.length > attacks.length * 2) {
    throw storyboardError(`连续时间线必须为每次攻击提供 1 个完整分镜，决定性击倒最多可扩展为 2 个`);
  }

  const sequence = [];
  let sequenceIndex = 0;
  for (const attack of attacks) {
    const group = [];
    while (sequenceIndex < candidate.sequence.length
      && cleanString(candidate.sequence[sequenceIndex]?.attackId, 160) === attack.id
      && group.length < 2) {
      group.push(candidate.sequence[sequenceIndex]);
      sequenceIndex += 1;
    }
    if (group.length === 0) throw storyboardError("连续时间线中的攻击顺序与战斗记录不一致");
    if (attack.blockedReason) {
      if (group.length !== 1 || group[0].purpose !== "blocked" || (attack.blockedReason === "confusion" ? group[0].impactAt !== 2.4 : group[0].impactAt != null)
        || group[0].startAnchor !== "idle" || group[0].endAnchor !== "recovery") {
        throw storyboardError("状态行动失败只能有一个独立 blocked 分镜；仅混乱自伤允许固定的自伤同步点");
      }
      sequence.push(createBlockedBeat(attack, sequence.length));
      continue;
    }
    if (group.length === 2 && !canExpandAttack(attack)) {
      throw storyboardError("普通攻击必须在单个 5 秒分镜内完整表现，不得重复拆分");
    }
    const pattern = group.length === 1 ? [SINGLE_BEAT] : EXPANDED_BEATS;
    group.forEach((beat, phaseIndex) => {
      const globalIndex = sequence.length;
      if (cleanString(beat?.attackId, 160) !== attack.id) {
        throw storyboardError("连续时间线中的攻击顺序与战斗记录不一致");
      }
      const purpose = cleanString(beat?.purpose, 24);
      const startAnchor = cleanString(beat?.startAnchor, 24);
      const endAnchor = cleanString(beat?.endAnchor, 24);
      const camera = cleanString(beat?.camera, 40);
      const motionStyle = cleanString(beat?.motionStyle, 24);
      const energyLevel = cleanString(beat?.energyLevel, 24);
      const cameraMovement = cleanString(beat?.cameraMovement, 32);
      const canonical = pattern[phaseIndex];
      if (!PURPOSES.has(purpose) || !ANCHORS.has(startAnchor) || !ANCHORS.has(endAnchor) || !CAMERAS.has(camera)
        || !MOTION_STYLES.has(motionStyle) || !ENERGY_LEVELS.has(energyLevel) || !CAMERA_MOVEMENTS.has(cameraMovement)) {
        throw storyboardError("分镜包含未允许的镜头枚举值");
      }
      if (purpose !== canonical.purpose || startAnchor !== canonical.startAnchor || endAnchor !== canonical.endAnchor) {
        throw storyboardError("分镜结构不符合精简连续模板");
      }
      const impactAt = beat?.impactAt == null ? null : finiteNumber(beat.impactAt, -1);
      const requiresImpact = purpose === "complete" || purpose === "payoff";
      if (requiresImpact && (impactAt === null || impactAt < 0.1 || impactAt > 4.9)) throw storyboardError("impactAt 必须位于 0.1 至 4.9 秒");
      if (!requiresImpact && impactAt !== null) throw storyboardError("铺垫分镜不能提前包含命中同步点");
      const shots = normalizeShots(beat?.shots, purpose, impactAt, attack);
      const normalizedBeat = { purpose, startAnchor, endAnchor, camera, motionStyle, energyLevel, cameraMovement, shots, impactAt: requiresImpact ? impactAt : null };
      sequence.push(finalizeBeat(attack, normalizedBeat, phaseIndex, globalIndex));
    });
  }
  if (sequenceIndex !== candidate.sequence.length) {
    throw storyboardError("连续时间线中的攻击顺序与战斗记录不一致");
  }

  return deepFreeze({ version: 2, warning: "", turn: createTurnPlan(attacks, sequence) });
}

export function sanitizeAttackRecords(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw new Error("每回合仅接受 1 至 2 条攻击记录");
  const sanitized = value.map((record) => {
    if (!record || typeof record !== "object") throw new Error("攻击记录格式无效");
    const blockedReason = record.blockedReason;
    if (blockedReason !== undefined && !Object.hasOwn(BLOCKED_REASON_LABELS, blockedReason)) throw new Error("行动失败原因无效");
    const actorSide = cleanString(record.actor?.side, 12);
    const targetSide = cleanString(record.target?.side, 12);
    const tempo = cleanString(record.tempo?.tier, 16);
    if (!SIDES.has(actorSide) || !SIDES.has(targetSide) || actorSide === targetSide) throw new Error("攻击双方无效");
    if (!TEMPOS.has(tempo)) throw new Error("攻击枚举值无效");

    const moveId = cleanString(record.move?.id, 64);
    const canonicalMove = MOVES[moveId];
    const actorSpeciesId = cleanString(record.actor?.speciesId, 64);
    const targetSpeciesId = cleanString(record.target?.speciesId, 64);
    const actorSpecies = SPECIES[actorSpeciesId];
    const targetSpecies = SPECIES[targetSpeciesId];
    if (!canonicalMove || !actorSpecies || !targetSpecies) throw new Error("攻击记录引用了未知的招式或物种");
    if (moveId !== "struggle" && !actorSpecies.moveIds.includes(moveId)) {
      throw new Error("该物种不能使用此招式");
    }
    if (record.move?.name !== canonicalMove.name || record.move?.type !== canonicalMove.type
      || record.move?.category !== canonicalMove.category || record.move?.power !== (canonicalMove.power ?? 0)
      || record.move?.priority !== (canonicalMove.priority ?? 0)) {
      throw new Error("招式事实与本地数据不一致");
    }
    if (record.actor?.name !== actorSpecies.name || record.actor?.dex !== actorSpecies.dex
      || record.target?.name !== targetSpecies.name || record.target?.dex !== targetSpecies.dex) {
      throw new Error("角色事实与本地数据不一致");
    }
    const actorStages = sanitizeStages(record.actor?.stages, "攻击者");
    const targetStages = sanitizeStages(record.target?.stages, "目标");
    const actorStatus = sanitizePrimaryStatus(record.actor?.status, "攻击者");
    const targetStatus = sanitizePrimaryStatus(record.target?.status, "目标");
    if ((actorStatus && !primaryStatusAllowedForSpecies(actorStatus, actorSpecies))
      || (targetStatus && !primaryStatusAllowedForSpecies(targetStatus, targetSpecies))) {
      throw new Error("主异常快照与物种属性免疫不一致");
    }
    if ((actorStatus === "sleep" || actorStatus === "freeze") && blockedReason !== actorStatus) {
      throw new Error("睡眠或冰冻中的攻击者不可能产生招式记录");
    }
    if (typeof record.actor?.confused !== "boolean" || typeof record.target?.confused !== "boolean") {
      throw new Error("混乱快照必须是布尔值");
    }
    const actorConfused = record.actor.confused;
    const targetConfused = record.target.confused;
    const actorSpeedStage = boundedInteger(record.actor?.speedStage, -6, 6, "攻击者速度阶级");
    const targetSpeedStage = boundedInteger(record.target?.speedStage, -6, 6, "目标速度阶级");
    if (actorSpeedStage !== actorStages.speed || targetSpeedStage !== targetStages.speed) {
      throw new Error("速度阶级与完整能力快照不一致");
    }
    if (typeof record.actor?.paralyzed !== "boolean" || typeof record.target?.paralyzed !== "boolean") {
      throw new Error("麻痹速度快照必须是布尔值");
    }
    const actorParalyzed = record.actor.paralyzed;
    const targetParalyzed = record.target.paralyzed;
    if (actorParalyzed !== (actorStatus === "paralysis") || targetParalyzed !== (targetStatus === "paralysis")) {
      throw new Error("麻痹速度快照与主异常不一致");
    }
    if (blockedReason && (blockedReason === "confusion" ? !actorConfused : actorStatus !== blockedReason)) throw new Error("行动失败要求行动者具有对应状态");

    const status = record.outcome?.status == null ? null : cleanString(record.outcome.status, 32);
    const clearedStatus = record.outcome?.clearedStatus == null ? null : cleanString(record.outcome.clearedStatus, 32);
    if (status && !ALLOWED_STATUSES.has(status)) throw new Error("异常状态无效");
    if (clearedStatus && !PRIMARY_STATUSES.has(clearedStatus)) throw new Error("解除的异常状态无效");
    if (!Array.isArray(record.outcome?.statChanges)) throw new Error("statChanges 必须是数组");
    if (record.outcome.statChanges.length > 4) throw new Error("能力变化数量超出限制");
    const statChanges = record.outcome.statChanges.map((change) => {
      if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("能力变化格式无效");
      if (!SIDES.has(change.targetSide)) throw new Error("能力变化目标无效");
      if (!ALLOWED_STATS.has(change.stat)) throw new Error("能力名称无效");
      if (!Number.isInteger(change.delta) || change.delta === 0 || Math.abs(change.delta) > 6) throw new Error("能力变化级数无效");
      return { targetSide: change.targetSide, stat: change.stat, delta: change.delta };
    });

    const canonicalTargetMode = intendedTargetMode(canonicalMove);
    if (canonicalTargetMode === "self" && statChanges.some((change) => change.targetSide !== actorSide)) {
      throw new Error("自我招式包含矛盾的能力变化目标");
    }
    if (canonicalTargetMode === "foe" && statChanges.some((change) => change.targetSide !== targetSide)) {
      throw new Error("对敌招式包含矛盾的能力变化目标");
    }

    for (const flag of ["critical", "missed", "fainted", "actorFainted"]) {
      if (typeof record.outcome?.[flag] !== "boolean") throw new Error(`${flag} 必须是布尔值`);
    }

    const actorMaxHp = boundedInteger(record.actor?.maxHp, 1, 100_000, "攻击者最大 HP");
    const targetMaxHp = boundedInteger(record.target?.maxHp, 1, 100_000, "目标最大 HP");
    if (actorMaxHp !== calculateStats(actorSpecies.baseStats).hp
      || targetMaxHp !== calculateStats(targetSpecies.baseStats).hp) {
      throw new Error("最大 HP 与物种数据不一致");
    }
    const actorCurrentHp = boundedInteger(record.actor?.currentHp, 1, actorMaxHp, "攻击者当前 HP");
    const targetCurrentHp = boundedInteger(record.target?.currentHp, 1, targetMaxHp, "目标当前 HP");
    const recoilDamage = boundedInteger(record.outcome?.recoilDamage, 0, actorMaxHp, "反作用力伤害");
    const selfDamage = blockedReason === "confusion" ? boundedInteger(record.outcome?.selfDamage, 1, actorCurrentHp, "混乱自伤") : 0;
    if (blockedReason !== "confusion" && record.outcome?.selfDamage !== undefined) throw new Error("非混乱自伤不能夹带自伤数值");
    if (selfDamage) {
      const actor = { level: 50, stats: calculateStats(actorSpecies.baseStats), stages: actorStages, status: actorStatus };
      const possible = new Set(Array.from({ length: 16 }, (_, i) => Math.min(actorCurrentHp, confusionDamage(actor, () => (i + .1) / 16))));
      if (!possible.has(selfDamage) || record.outcome.actorFainted !== (selfDamage === actorCurrentHp)) throw new Error("混乱自伤与本地公式或倒下结果不一致");
    }
    const actorModifiedSpeed = boundedInteger(record.actor?.modifiedSpeed, 1, 10_000, "攻击者速度");
    const targetModifiedSpeed = boundedInteger(record.target?.modifiedSpeed, 1, 10_000, "目标速度");
    if (actorModifiedSpeed !== speedFromSnapshot(actorSpecies, actorSpeedStage, actorParalyzed)
      || targetModifiedSpeed !== speedFromSnapshot(targetSpecies, targetSpeedStage, targetParalyzed)) {
      throw new Error("修正后速度与物种、阶级及麻痹状态不一致");
    }
    const suppliedActorSpeed = boundedInteger(record.tempo?.actorSpeed, 1, 10_000, "节奏攻击者速度");
    const suppliedTargetSpeed = boundedInteger(record.tempo?.targetSpeed, 1, 10_000, "节奏目标速度");
    const suppliedSpeedDelta = boundedInteger(record.tempo?.speedDelta, -10_000, 10_000, "速度差");
    const suppliedSpeedRatio = boundedNumber(record.tempo?.speedRatio, 0.001, 10_000, "速度比例");
    const expectedSpeedRatio = Number((actorModifiedSpeed / targetModifiedSpeed).toFixed(3));
    if (suppliedActorSpeed !== actorModifiedSpeed || suppliedTargetSpeed !== targetModifiedSpeed
      || suppliedSpeedDelta !== actorModifiedSpeed - targetModifiedSpeed
      || suppliedSpeedRatio !== expectedSpeedRatio
      || tempo !== tempoTier(actorModifiedSpeed, targetModifiedSpeed)) {
      throw new Error("节奏速度与角色实际速度不一致");
    }
    const damage = boundedInteger(record.outcome?.damage, 0, targetMaxHp, "伤害");
    const damageRatio = boundedNumber(record.outcome?.damageRatio, 0, 1, "伤害比例");
    const effectiveness = record.outcome?.effectiveness == null
      ? null
      : boundedNumber(record.outcome.effectiveness, 0, 4, "属性效果");
    if (effectiveness !== null && !EFFECTIVENESS_VALUES.has(effectiveness)) throw new Error("属性效果无效");
    if (damageRatio !== Number((damage / targetMaxHp).toFixed(4))) throw new Error("伤害比例与实际伤害不一致");

    const move = {
      id: canonicalMove.id,
      name: canonicalMove.name,
      type: canonicalMove.type,
      category: canonicalMove.category,
      power: canonicalMove.power ?? 0,
      priority: canonicalMove.priority ?? 0,
      targetMode: canonicalTargetMode,
      effectKinds: intendedEffectKinds(canonicalMove),
    };
    const outcome = {
      damage,
      damageRatio,
      critical: record.outcome.critical,
      effectiveness,
      missed: record.outcome.missed,
      fainted: record.outcome.fainted,
      recoilDamage,
      actorFainted: record.outcome.actorFainted,
      ...(selfDamage ? { selfDamage } : {}),
      status,
      clearedStatus,
      statChanges,
    };
    if (!outcome.damage && (outcome.critical || outcome.fainted)) {
      throw new Error("零伤害不能标记要害或直接击倒");
    }
    if (outcome.damage > targetCurrentHp || outcome.fainted !== (outcome.damage === targetCurrentHp && outcome.damage > 0)) {
      throw new Error("伤害与目标攻击前当前 HP 或击倒结果不一致");
    }
    if (outcome.missed || outcome.effectiveness === 0) {
      if (outcome.damage || outcome.critical || outcome.fainted || outcome.status || outcome.statChanges.length) {
        throw new Error("落空或免疫不能附带伤害、要害、击倒、状态或能力变化");
      }
    }
    const shouldRecoil = Boolean(canonicalMove.recoil)
      && !outcome.missed && outcome.effectiveness !== 0 && outcome.damage > 0;
    if (shouldRecoil) {
      const maximumRecoil = Math.max(1, Math.round(actorMaxHp * canonicalMove.recoil));
      const expectedRecoil = Math.min(actorCurrentHp, maximumRecoil);
      if (outcome.recoilDamage !== expectedRecoil
        || outcome.actorFainted !== (actorCurrentHp - expectedRecoil === 0)) {
        throw new Error("反作用力结果与招式或攻击者最大 HP 不一致");
      }
    } else if (outcome.recoilDamage !== 0 || (outcome.actorFainted && !selfDamage)) {
      throw new Error("非反作用力结果不能标记攻击者受伤或倒下");
    }
    if (outcome.actorFainted && outcome.recoilDamage === 0 && !selfDamage) {
      throw new Error("攻击者倒下必须包含反作用力伤害");
    }
    const matchup = typeEffectiveness(canonicalMove.type, targetSpecies.types);
    const canonicallyImmune = (
      (canonicalMove.power > 0 || canonicalMove.checksTypeImmunity) && matchup === 0
    ) || (canonicalMove.powder && targetSpecies.types.includes("grass"));
    if (!blockedReason && !canonicallyImmune && outcome.missed) {
      if (canonicalMove.accuracy == null) throw new Error("必中的招式不能标记落空");
      const combinedAccuracyStage = clamp(actorStages.accuracy - targetStages.evasion, -6, 6);
      const hitChance = Math.min(100, Math.floor(
        canonicalMove.accuracy * accuracyMultiplier(combinedAccuracyStage),
      ));
      if (hitChance >= 100) throw new Error("当前命中与闪避阶级下招式不可能落空");
    }
    if (blockedReason) {
      if (outcome.damage || outcome.damageRatio || outcome.critical || outcome.missed || outcome.effectiveness !== null
        || outcome.fainted || (outcome.actorFainted && !selfDamage) || outcome.recoilDamage || outcome.status || outcome.clearedStatus || outcome.statChanges.length) {
        throw new Error("状态行动失败不能包含对敌命中、伤害、免疫、能力或状态变化");
      }
    } else if (canonicalMove.power > 0) {
      if (canonicallyImmune) {
        if (outcome.missed || outcome.effectiveness !== 0) throw new Error("免疫结果与招式及目标属性不一致");
      } else if (outcome.missed) {
        if (outcome.effectiveness !== null) throw new Error("落空结果不能包含属性效果");
      } else if (outcome.damage < 1 || outcome.effectiveness !== matchup) {
        throw new Error("伤害结果与招式威力及目标属性不一致");
      }
    } else {
      if (outcome.damage || outcome.critical || outcome.fainted) throw new Error("变化招式不能造成直接伤害");
      const expectedEffectiveness = canonicallyImmune ? 0 : null;
      if (outcome.effectiveness !== expectedEffectiveness) throw new Error("变化招式的属性效果与目标不一致");
      if (canonicallyImmune && outcome.missed) throw new Error("免疫招式不会继续进行命中判定");
    }
    if (!blockedReason && canonicalMove.power > 0 && !canonicallyImmune && !outcome.missed) {
      if (canonicalMove.critStage < 0 && outcome.critical) {
        throw new Error("该招式不能击中要害");
      }
      const possibleDamage = possibleDamageValues(
        actorSpecies,
        targetSpecies,
        actorStages,
        targetStages,
        actorStatus,
        canonicalMove,
        outcome.critical,
      );
      const possibleActualDamage = new Set([...possibleDamage].map((value) => Math.min(targetCurrentHp, value)));
      if (!possibleActualDamage.has(outcome.damage)) {
        throw new Error("伤害值不在本地公式的可达范围内");
      }
    }

    const expectedClearedStatus = canonicalMove.type === "fire"
      && outcome.damage > 0 && !outcome.fainted && targetStatus === "freeze" ? "freeze" : null;
    if (outcome.clearedStatus !== expectedClearedStatus) {
      throw new Error("解除异常状态与招式、伤害或目标原状态不一致");
    }

    const effectsCanApply = !blockedReason && !outcome.missed && outcome.effectiveness !== 0 && !outcome.fainted;
    const effectSubject = (effect) => effect.target === "self"
      ? {
        side: actorSide,
        stages: actorStages,
        status: actorStatus,
        confused: actorConfused,
        species: actorSpecies,
      }
      : {
        side: targetSide,
        stages: targetStages,
        status: targetStatus,
        confused: targetConfused,
        species: targetSpecies,
      };
    const statusBeforeEffects = (effect, subject) => (
      effect.target !== "self"
      && canonicalMove.type === "fire"
      && outcome.damage > 0
      && !outcome.fainted
      && subject.status === "freeze"
        ? null
        : subject.status
    );
    const statEffects = (canonicalMove.effects ?? []).filter((effect) => effect.kind === "stat");
    const usedStatEffects = new Set();
    for (const change of statChanges) {
      if (!effectsCanApply) throw new Error("未成功生效的招式不能附带能力变化");
      const matchingEffectIndex = statEffects.findIndex((effect, index) => {
        if (usedStatEffects.has(index) || effect.stat !== change.stat) return false;
        const subject = effectSubject(effect);
        const expectedDelta = clamp(subject.stages[effect.stat] + effect.stages, -6, 6)
          - subject.stages[effect.stat];
        return subject.side === change.targetSide && expectedDelta === change.delta;
      });
      if (matchingEffectIndex < 0) throw new Error("能力变化与招式定义或变化前阶级不一致");
      usedStatEffects.add(matchingEffectIndex);
    }
    statEffects.forEach((effect, index) => {
      if (!effectsCanApply || effect.chance !== 1) return;
      const subject = effectSubject(effect);
      const expectedDelta = clamp(subject.stages[effect.stat] + effect.stages, -6, 6)
        - subject.stages[effect.stat];
      if (expectedDelta !== 0 && !usedStatEffects.has(index)) {
        throw new Error("攻击结果缺少必定发生的能力变化");
      }
    });

    const statusEffects = (canonicalMove.effects ?? []).filter(
      (effect) => effect.kind === "status" || effect.kind === "confusion",
    );
    const statusEffectCanApply = (effect) => {
      if (!effectsCanApply) return false;
      const subject = effectSubject(effect);
      if (effect.kind === "confusion") return !subject.confused;
      return canReceivePrimaryStatus(
        effect.status,
        statusBeforeEffects(effect, subject),
        subject.species,
      );
    };
    if (status) {
      const matchingEffect = statusEffects.find((effect) => (
        (effect.kind === "confusion" ? "confusion" : effect.status) === status
      ));
      if (!matchingEffect || !statusEffectCanApply(matchingEffect)) {
        throw new Error("异常状态与招式定义或目标原状态不一致");
      }
    }
    for (const effect of statusEffects) {
      if (effect.chance !== 1 || !statusEffectCanApply(effect)) continue;
      const expectedStatus = effect.kind === "confusion" ? "confusion" : effect.status;
      if (outcome.status !== expectedStatus) throw new Error("攻击结果缺少必定发生的异常状态");
    }

    outcome.effectMode = blockedReason ? "blocked" : effectMode(outcome, actorSide, move);
    outcome.damageTier = damageTier(outcome);
    const suppliedMode = cleanString(record.outcome?.effectMode, 20);
    const suppliedTier = cleanString(record.outcome?.damageTier, 16);
    if (!EFFECT_MODES.has(suppliedMode) || suppliedMode !== outcome.effectMode) throw new Error("effectMode 与攻击事实不一致");
    if (!DAMAGE_TIERS.has(suppliedTier) || suppliedTier !== outcome.damageTier) throw new Error("damageTier 与攻击事实不一致");

    const result = {
      id: cleanString(record.id, 160),
      battleEpoch: boundedInteger(record.battleEpoch, 0, 1_000_000, "战斗批次"),
      turn: boundedInteger(record.turn, 1, 10_000, "回合"),
      sequenceIndex: boundedInteger(record.sequenceIndex, 0, 1, "攻击顺序"),
      ...(blockedReason ? { blockedReason } : {}),
      move,
      actor: {
        side: actorSide,
        uid: cleanString(record.actor?.uid, 80),
        speciesId: actorSpeciesId,
        dex: actorSpecies.dex,
        name: actorSpecies.name,
        stages: actorStages,
        status: actorStatus,
        confused: actorConfused,
        speedStage: actorSpeedStage,
        paralyzed: actorParalyzed,
        modifiedSpeed: actorModifiedSpeed,
        currentHp: actorCurrentHp,
        maxHp: actorMaxHp,
      },
      target: {
        side: targetSide,
        uid: cleanString(record.target?.uid, 80),
        speciesId: targetSpeciesId,
        dex: targetSpecies.dex,
        name: targetSpecies.name,
        stages: targetStages,
        status: targetStatus,
        confused: targetConfused,
        speedStage: targetSpeedStage,
        paralyzed: targetParalyzed,
        modifiedSpeed: targetModifiedSpeed,
        currentHp: targetCurrentHp,
        maxHp: targetMaxHp,
      },
      outcome,
      tempo: {
        actorSpeed: actorModifiedSpeed,
        targetSpeed: targetModifiedSpeed,
        speedDelta: actorModifiedSpeed - targetModifiedSpeed,
        speedRatio: expectedSpeedRatio,
        tier: tempo,
      },
    };
    const uidPattern = /^[a-zA-Z0-9-]{1,80}$/;
    if (!/^[a-zA-Z0-9-]{1,160}$/.test(result.id)
      || !uidPattern.test(result.actor.uid) || !uidPattern.test(result.target.uid)) {
      throw new Error("攻击记录缺少必要标识");
    }
    if (result.id !== `${result.battleEpoch}-${result.turn}-${result.sequenceIndex}-${result.actor.uid}-${result.move.id}`) {
      throw new Error("攻击记录标识与回合顺序不一致");
    }
    return deepFreeze(result);
  });
  const { battleEpoch, turn } = sanitized[0];
  sanitized.forEach((record, index) => {
    if (record.sequenceIndex !== index) throw new Error("攻击记录数组顺序与 sequenceIndex 不一致");
    if (record.battleEpoch !== battleEpoch || record.turn !== turn) throw new Error("攻击记录必须属于同一批次与回合");
  });
  if (sanitized.length === 2) {
    const [first, second] = sanitized;
    if (first.outcome.fainted || first.outcome.actorFainted) throw new Error("首击任一行动者倒下后不能存在第二次行动");
    if (first.outcome.status === "sleep" && second.blockedReason !== "sleep") throw new Error("首击施加睡眠后不能存在第二次攻击");
    const sameCombatant = (left, right) => (
      left.side === right.side
      && left.uid === right.uid
      && left.speciesId === right.speciesId
      && left.dex === right.dex
      && left.name === right.name
      && left.maxHp === right.maxHp
    );
    if (!sameCombatant(first.actor, second.target) || !sameCombatant(first.target, second.actor)) {
      throw new Error("双次行动必须由同一对战双方交替执行");
    }
    if (first.move.priority < second.move.priority) {
      throw new Error("攻击记录顺序违反招式优先度");
    }
    if (first.move.priority === second.move.priority
      && first.actor.modifiedSpeed < first.target.modifiedSpeed) {
      throw new Error("同优先度攻击记录顺序违反修正后速度");
    }
    const validateSnapshotTransition = (before, after, willActBeforeSnapshot) => {
      const receivesDirectDamage = first.target.side === before.side;
      const receivesRecoil = first.actor.side === before.side;
      const expectedHp = before.currentHp
        - (receivesDirectDamage ? first.outcome.damage : 0)
        - (receivesRecoil ? first.outcome.recoilDamage + (first.outcome.selfDamage ?? 0) : 0);
      if (after.currentHp !== expectedHp) throw new Error("跨行动当前 HP 不连续");
      for (const stat of ALLOWED_STATS) {
        const delta = first.outcome.statChanges
          .filter((change) => change.targetSide === before.side && change.stat === stat)
          .reduce((total, change) => total + change.delta, 0);
        const expectedStage = clamp(before.stages[stat] + delta, -6, 6);
        if (after.stages[stat] !== expectedStage) {
          throw new Error("跨行动能力阶级不连续");
        }
      }

      const receivesFirstEffect = first.target.side === before.side;
      let expectedStatus = before.status;
      if (receivesFirstEffect
        && first.move.type === "fire"
        && first.outcome.damage > 0
        && !first.outcome.fainted
        && expectedStatus === "freeze") {
        expectedStatus = null;
      }
      if (receivesFirstEffect && PRIMARY_STATUSES.has(first.outcome.status)) {
        expectedStatus = first.outcome.status;
      }
      if (willActBeforeSnapshot && (expectedStatus === "sleep" || expectedStatus === "freeze") && second.blockedReason !== expectedStatus) {
        expectedStatus = null;
      }
      if (after.status !== expectedStatus) {
        throw new Error("跨行动主异常状态不连续");
      }

      const newlyConfused = receivesFirstEffect && first.outcome.status === "confusion";
      if (!willActBeforeSnapshot) {
        if (after.confused !== (before.confused || newlyConfused)) {
          throw new Error("跨行动混乱状态不连续");
        }
      } else if ((!before.confused && !newlyConfused && after.confused)
        || (newlyConfused && !after.confused)) {
        throw new Error("跨行动混乱状态不连续");
      }
    };
    validateSnapshotTransition(first.actor, second.target, false);
    validateSnapshotTransition(first.target, second.actor, true);
  }
  return Object.freeze(sanitized);
}
