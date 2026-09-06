import { conditionDirection } from "./visual-battle-state.js";

export const COMMAND_RESPONSE_VERSION = "command-response-v3";

function cannotRespond(subject) {
  return subject.fainted || ["sleep", "freeze"].includes(subject.status);
}

function continuingCondition(subject) {
  return subject.fainted
    ? `${subject.speciesId} is ALREADY fainted and lying limp, both eyes retain bold black spiral / swirl knockout eyes. Keep the body down and motionless throughout; no replay of collapsing, standing up, revival or death.`
    : conditionDirection(subject);
}

export function commandResponseDirection(scene) {
  const player = scene.player;
  const closeup = cannotRespond(player)
    ? `Show ${player.speciesId}'s existing immobile condition in close-up; it CANNOT acknowledge the trainer. No attentive turn, alert gaze, nod, ready crouch, active mouth movement or answering cry. ${continuingCondition(player)}`
    : `${player.speciesId} makes a small attentive head or gaze turn toward the offscreen trainer, appropriate to its own anatomy, and ${player.confused ? "attempts to listen while keeping its existing unfocused gaze and confusion cues" : "focuses on listening"}. It gives ONE short species-appropriate creature cry in acknowledgment, with natural synchronized mouth motion; not human speech or a spoken move name. No charge, electrical buildup, projectile or attack. Retain all existing condition cues, including stiffness or discomfort`;
  const readiness = Object.values(scene).map(subject => cannotRespond(subject)
    ? `${subject.speciesId} MUST remain in its existing immobile condition, with no awakening, thawing, standing up or ready pose. ${continuingCondition(subject)}`
    : `${subject.speciesId} makes a small species-appropriate ready-pose adjustment at its current position, facing its opponent; no advance, attack, charge or aggressive lunge. Preserve its identity and all ongoing condition cues`).join(" ");
  const conditions = Object.entries(scene).map(([side, subject]) => `${side} side ${continuingCondition(subject)}`).join(" ");
  return `Use the supplied scene tail only for first-frame continuity, then immediately cut closer; do not spend a second on an opening wide shot. Reusable listening-and-response transition, not tied to any particular move. [0-3.5s] Close-up of the player ${player.speciesId}. ${closeup}. The trainer stays offscreen. [3.5-5s] CUT back to the opening low shared battle composition with BOTH combatants recognizable at their original positions. ${readiness}. Hold this shared ready-or-immobile tableau at the end. The opponent NEVER attacks, answers the trainer, heals or changes condition during the cutaway or the return shot. Conditions persist in EVERY frame: ${conditions}.`;
}

export function commandResponseSound(scene) {
  return cannotRespond(scene.player)
    ? "Sound: quiet outdoor ambience only. The player cannot respond: NO answering cry, active vocalization, dialogue, narration, speech, music or move sound."
    : `Sound: quiet outdoor ambience under ONE short, clear ${scene.player.speciesId} creature acknowledgment cry during the first 3.5 seconds, synchronized to its visible response. No opponent cry, human speech, narration, move name, attack sound or music. No additional cry after the cut back.`;
}
