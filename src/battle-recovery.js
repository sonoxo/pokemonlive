import { attackVisualScene, conditionDirection } from "./visual-battle-state.js";

export const BATTLE_RECOVERY_VERSION = "battle-recovery-v2";

// This snapshot belongs to the last visible action, before automatic replacement.
// HP is local to recovery; existing idle/command identities remain unchanged.
export function battleRecoveryState(attack) {
  const scene = attackVisualScene(attack, true);
  const health = Object.fromEntries([attack.actor, attack.target].map(subject => {
    const damage = subject.side === attack.actor.side
      ? attack.outcome.recoilDamage + (attack.outcome.selfDamage ?? 0) : attack.outcome.damage;
    return [subject.side, { currentHp: Math.max(0, subject.currentHp - damage), maxHp: subject.maxHp }];
  }));
  return { scene, health };
}

export function sanitizeRecoveryHealth(value, scene) {
  return Object.fromEntries(["player", "opponent"].map(side => {
    const hp = value?.[side];
    if (!Number.isInteger(hp?.maxHp) || hp.maxHp < 1 || hp.maxHp > 100000
      || !Number.isInteger(hp.currentHp) || hp.currentHp < 0 || hp.currentHp > hp.maxHp
      || scene[side].fainted !== (hp.currentHp === 0)) throw new TypeError("收尾血量与战斗状态不匹配");
    return [side, { currentHp: hp.currentHp, maxHp: hp.maxHp }];
  }));
}

export function battleRecoveryDirection(scene, health) {
  const acting = Object.entries(scene).map(([side, subject]) => {
    const name = `${side} ${subject.speciesId}`;
    if (subject.fainted) return `${name} is ALREADY fainted: keep it limp on the ground at the exact location from the opening frame, with both black spiral / swirl eyes. No repeated collapse, standing up, relocation, revival or death. Reveal it with the camera only.`;
    if (["sleep", "freeze"].includes(subject.status)) return `${name} CANNOT return voluntarily: keep its body at its existing location, no walking, jumping, awakening or thawing. Reframe the camera around its actual location across the cuts, never teleport it. ${conditionDirection(subject)}`;
    const hp = health[side];
    const effort = hp.currentHp / hp.maxHp <= .25
      ? "VERY LOW HP: one short exhausted breath, trembling support and a strained in-place posture. Convey effort through the body, not a prolonged retreat or repeated pauses; no energetic hopping or sudden recovery"
      : hp.currentHp / hp.maxHp <= .5
        ? "WOUNDED: guarded posture, one brief tired breath and at most one small in-place balance adjustment; do not become fresh or fully energetic"
        : "one brief species-appropriate steadying gesture and a focused gaze toward the opponent; at most one small foot or body adjustment, not a walk back to a starting mark";
    return `${name} has ${hp.currentHp}/${hp.maxHp} HP remaining (do not display numbers). ${effort}. ${subject.status || subject.confused ? "Existing condition takes priority over smooth movement: strained or hesitant motion, preserve every condition cue." : ""} ${conditionDirection(subject)}`;
  }).join(" ");
  return `This is ONLY the five-second post-battle recovery, after all recorded actions. Use exactly THREE purposeful shots with clean straight cuts at 1s and 2.5s, natural real-time movement and brisk anime editing. The supplied opening image is the EXACT last frame of the final attack: preserve its camera, positions, poses, identities, lighting and residual effects at time zero. Do NOT jump straight to a reset wide shot. [0-1s] SHOT 1: carry through only the motion already present at the end of the attack; residual effects dissipate promptly. A mobile creature already recoiling settles its balance once. No repeated impact, new hit, replayed collapse or fresh stumble. [1-2.5s] SHOT 2: cut to ONE concise post-action reaction close-up of a creature showing the existing aftermath. An awake, mobile creature steadies its posture or refocuses on its opponent; a wounded creature shows one brief strained breath. An asleep, frozen or fainted subject remains exactly in that condition, without alert eye contact, acknowledgement or waking. This is a reaction, never attack anticipation. The offscreen combatant stays in its actual location and condition throughout. ${acting} [2.5-4.5s] SHOT 3: cut decisively to the low shared arena view with BOTH original combatants recognizable; preserve the action axis and spatial geography across cuts, never reverse or swap sides. Favor player rear three-quarter in the left foreground and opponent front three-quarter in the right middle distance only where their actual locations and conditions allow. Establish the two-shot immediately at this cut, not by spending seconds zooming or slowly pulling back. Only minimal state-appropriate balance or facing adjustments by mobile creatures, no required return to original marks, long walking or repeated retreat. If a creature cannot move, adapt the camera to its actual location instead of moving it. [4.5-5s] Remain in SHOT 3 and settle the shared composition for only the final half-second, with subtle condition-appropriate breathing rather than a freeze-frame; no further cut. Keep the anime identities, anatomy, colors, scale, background and lighting consistent across all three shots. No slow motion, extended establishing shot, dissolve, morph, teleport or repetitive settling gestures. Preserve all HP, fatigue and conditions through the last frame. Neither side attacks, charges, deals additional damage, heals, wakes up, thaws, changes condition or gets replaced. No new creatures, trainers, speech, move callout or music; quiet outdoor ambience and restrained movement sounds only.`;
}
