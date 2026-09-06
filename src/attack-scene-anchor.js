import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeAttackRecords } from "./attack-storyboard.js";
import { attackVisualScene, visualSceneKey } from "./visual-battle-state.js";
import { extractVideoTailFrame } from "./video-tail-frame.js";
import { battleRecoveryState } from "./battle-recovery.js";

export function sanitizeAttackSource(source) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source?.sessionId ?? "")
    || !Number.isInteger(source.clipIndex) || source.clipIndex < 0 || source.clipIndex > 3) {
    throw new TypeError("战斗尾帧来源无效");
  }
  return { sessionId: source.sessionId, clipIndex: source.clipIndex };
}

export function sceneAfterBeat(beat, attacks) {
  const attack = attacks.find(record => record.id === beat.attackId);
  return attack ? attackVisualScene(attack, beat.purpose !== "setup") : null;
}

// Cancelling a background consumer must not cancel the foreground's shared tail.
export function waitForAnchor(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export async function loadAttackSceneAnchor(source, scene, signal, { continuity, runway, directory, tailExtractor = extractVideoTailFrame, recoveryHealth = null }) {
  const { sessionId, clipIndex } = sanitizeAttackSource(source);
  const live = continuity.get(sessionId);
  if (live) {
    const clip = live.clips[clipIndex];
    if (recoveryHealth && (clipIndex !== live.clips.length - 1 || !matchesRecovery(live.attacks, scene, recoveryHealth))) return null;
    if (!clip?.scene || runway.get(sessionId)?.clips[clipIndex]?.status !== "ready"
      || visualSceneKey(clip.scene) !== visualSceneKey(scene)) return null;
    // A single clip is enough; do not wait for the rest of the attack session.
    return waitForAnchor(clip.tail, signal);
  }
  try {
    const path = join(directory, sessionId);
    const saved = JSON.parse(await readFile(join(path, "plan.json"), "utf8"));
    if (recoveryHealth && (clipIndex !== saved.plan?.turn?.sequence?.length - 1
      || !matchesRecovery(sanitizeAttackRecords(saved.attacks), scene, recoveryHealth))) return null;
    const beat = saved.plan?.turn?.sequence?.[clipIndex];
    const actual = beat && sceneAfterBeat(beat, sanitizeAttackRecords(saved.attacks));
    if (!actual || visualSceneKey(actual) !== visualSceneKey(scene)) return null;
    try {
      const tail = await readFile(join(path, `clip-${clipIndex}-tail.jpg`));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return `data:image/jpeg;base64,${tail.toString("base64")}`;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const bytes = await readFile(join(path, `clip-${clipIndex}.mp4`));
    const tail = await tailExtractor("http://127.0.0.1/archived.mp4", { signal, fetchImpl: async () => new Response(bytes) });
    return `data:image/jpeg;base64,${Buffer.from(await tail.arrayBuffer()).toString("base64")}`;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return null;
  }
}

function matchesRecovery(attacks, scene, health) {
  if (!attacks?.length) return false;
  const expected = battleRecoveryState(attacks.at(-1));
  return visualSceneKey(expected.scene) === visualSceneKey(scene)
    && ["player", "opponent"].every(side => expected.health[side].currentHp === health[side].currentHp
      && expected.health[side].maxHp === health[side].maxHp);
}
