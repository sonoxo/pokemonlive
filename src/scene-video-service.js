import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { FalVideoRunway, FAL_VIDEO_SEED } from "./fal-video-runway.js";
import { downloadVideo, extractVideoTailFrame } from "./video-tail-frame.js";
import { sanitizeVisualScene, visualSceneKey, sceneConditionDirection, validateSwitch } from "./visual-battle-state.js";
import { sanitizeAttackSource, waitForAnchor } from "./attack-scene-anchor.js";
import { createSettledIdleLoop, IDLE_LOOP_VERSION } from "./idle-video-loop.js";
import { COMMAND_RESPONSE_VERSION, commandResponseDirection, commandResponseSound } from "./command-response.js";
import { COMMAND_AUDIO_VERSION, normalizeCommandAudio } from "./command-video-audio.js";
import { BATTLE_RECOVERY_VERSION, sanitizeRecoveryHealth, battleRecoveryDirection } from "./battle-recovery.js";
import { recoverSceneClip, validatePaidScene, recoveryError } from "./scene-video-recovery.js";
import { normalizeLanguage } from "./language.js";

const ACTIVE = new Set(["queued", "loading", "generating"]);
export const SCENE_VIDEO_KEY = /^[0-9a-f]{64}$/;
export const IDLE_COMPOSITION_VERSION = "idle-rear-view-v1";
export const SENDOUT_STAGING_VERSION = "sendout-staging-v2";
const abortError = () => new DOMException("Aborted", "AbortError");
const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
async function atomicArtifact(path, bytes) {
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw recoveryError("UNCONFIRMED_SUBMISSION"); }
}

export function sceneVideoSpec(input) {
  const language = normalizeLanguage(input?.language);
  const kind = input?.kind;
  if (!["switch", "recall", "sendout", "idle", "command", "recovery"].includes(kind)) throw new TypeError("场景动画类型无效");
  const scene = sanitizeVisualScene(input.scene);
  const before = ["switch", "sendout"].includes(kind) ? sanitizeVisualScene(input.before) : null;
  const side = before ? validateSwitch(before, scene) : kind === "recall" ? input.side : null;
  if (kind === "recall" && !["player", "opponent"].includes(side)) throw new TypeError("收回一侧无效");
  const sourceAttack = input.sourceAttack == null ? null : sanitizeAttackSource(input.sourceAttack);
  if (sourceAttack && input.sourceKey != null) throw new TypeError("尾帧来源只能选一个");
  if (kind === "recovery" && !sourceAttack) throw new TypeError("收尾必须接最后一段攻击尾帧");
  const health = kind === "recovery" ? sanitizeRecoveryHealth(input.health, scene) : null;
  const defaultSource = ["recall", "command"].includes(kind) && input.sourceKey === "default";
  const coldRecall = kind === "recall" && input.sourceKey == null && !sourceAttack;
  if (kind !== "switch" && !coldRecall && !sourceAttack && !SCENE_VIDEO_KEY.test(input.sourceKey ?? "") && !defaultSource) throw new TypeError("缺少已生成的场景尾帧");
  if (kind === "sendout" && !SCENE_VIDEO_KEY.test(input.sourceKey ?? "")) throw new TypeError("放出需要已生成的收回尾帧");
  const identity = [kind, before && visualSceneKey(before), visualSceneKey(scene)];
  if (kind === "idle") identity.push(IDLE_COMPOSITION_VERSION);
  if (kind === "command") identity.push(COMMAND_RESPONSE_VERSION);
  if (kind === "recall") identity.push(side);
  if (["sendout", "switch"].includes(kind)) identity.push(SENDOUT_STAGING_VERSION);
  if (kind === "recovery") identity.push(BATTLE_RECOVERY_VERSION, sourceAttack, health);
  // Attack tails may be a single-character close-up, unlike an entrance tableau.
  // Isolate the corrected two-character layout from earlier I2V close-up caches.
  if (sourceAttack) identity.push("attack-layout-v1");
  // Keep already-paid Chinese cache keys; other languages must never reuse them.
  if (language !== "zh") identity.push("audio-language-v1", language);
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const style = "Hand-drawn 2D Pokémon TV anime, crisp expressive ink contours, flat cel shading, soft painted pine clearing with grass-capped ochre rock ledges and a rounded tree on the right. Low battle camera: player large in left foreground, opponent smaller in right middle distance, same level grass contact plane. Exactly two combatants at a time. No pixel art, game sprites, UI, text, subtitles, trainers, extra creatures or 3D rendering. No attacks, damage, healing, evolution or new conditions in this five-second scene.";
  const idleComposition = `Wide shared battle view, camera behind the player side. Player ${scene.player.speciesId} stays in the LEFT foreground in a REAR or rear three-quarter view: BACK toward the camera, body and gaze directed diagonally RIGHT into the arena toward opponent ${scene.opponent.speciesId}, never a frontal portrait facing the viewer. Opponent ${scene.opponent.speciesId} stays in the RIGHT middle distance in a FRONT or front three-quarter view toward the camera side, angled LEFT toward the player, not posing or staring into the lens. The two creatures face EACH OTHER across a clearly visible open strip of battlefield. Moderate perspective, not an extreme foreground close-up: the player's entire silhouette, including ears and tail where applicable, occupies about 40-50% of frame height and NEVER more than 55%; opponent about 30-40%, preserving canonical anatomy and species proportions. Fit BOTH complete silhouettes inside the image with generous margin above, below and beside them; no cropped heads, ears, tails or feet, no oversized player dominating the image. Keep these screen sizes and facing directions stable throughout the loop; no camera push-in, turn toward the viewer, left-right swap or mirror flip. Existing sleep, freeze or fainted poses take priority over an alert facing stance: establish the camera view around the existing condition, never wake, thaw or stand a creature up for composition.`;
  const idleStaging = sourceAttack ? idleComposition : `IMAGE-LOCKED IDLE: exact source-frame continuity has priority over the following target staging. Apply the rear/front views, screen-size targets and framing rules below ONLY when already compatible with the supplied first and last frame. If the source differs, preserve its composition; do not force a turn, resize a creature or reframe mid-loop to meet those targets. ${idleComposition}`;
  const sendoutStaging = ["sendout", "switch"].includes(kind)
    ? `THROW OWNERSHIP AND PATH: only the ${side} trainer throws this ball. ${side === "player"
      ? "The player trainer is OFFSCREEN behind the camera on the LEFT. The ball first becomes visible crossing the LEFT frame edge, travels rightward in a short arc entirely within the LEFT foreground, and opens just above the EMPTY player ground mark."
      : "The opponent trainer is OFFSCREEN beyond the opponent ground mark on the RIGHT. The ball first becomes visible crossing the RIGHT frame edge, travels leftward in a short arc entirely within the RIGHT middle distance, and opens just above the EMPTY opponent ground mark."} Keep the camera and left-right action axis fixed during the throw; do not mirror or swap sides. The ball starts outside the image, never materializes inside the arena. Keep the entire flight path and release glow spatially separate from the untouched ${scene[side === "player" ? "opponent" : "player"].speciesId} on the ${side === "player" ? "opponent" : "player"} side, with a clear visible gap around its whole silhouette. Never spawn, perch, hover, bounce or launch a ball on or above its head; never cover its face, cross its body, touch it or merge with its anatomy. The untouched creature never holds, throws, emits or transforms into a ball, and never moves to make room. Show no trainer or throwing hand. Only ONE ball, with a continuous flight from the frame edge to the empty ground mark; the small release glow stays at that mark.`
    : "";
  const direction = kind === "recovery" ? battleRecoveryDirection(scene, health) : kind === "recall"
    ? `Use the supplied battle frame as the exact opening. This is ONLY a recall, never a replacement or attack. [0-1s] Show the current pair and their recorded conditions. [1-3.5s] Cut toward ${scene[side].speciesId} on the ${side} side. A narrow red recall beam wraps ONLY this creature in a soft red silhouette, shrinks it and draws it completely offscreen into its trainer's Poké Ball. No visible trainer needed. [3.5-5s] Return to the same low battle camera: the ${side} position is EMPTY; only ${scene[side === "player" ? "opponent" : "player"].speciesId} remains at its original position. Hold the empty contact area for the next send-out. Do not release a new creature, do not morph species. Conditions before recall and on the untouched combatant: ${sceneConditionDirection(scene)}.`
    : kind === "sendout"
      ? `Image 1 identifies the NEW player ${scene.player.speciesId}. Image 2 identifies the NEW opponent ${scene.opponent.speciesId}. Image 3 is the preceding recall's exact tail composition: the ${side} position is EMPTY. Image 4 is the painted environment reference. Redraw identities in unified anime style. This clip is ONLY a send-out: NEVER repeat the recall and NEVER show outgoing ${before[side].speciesId} again. [0-0.8s] Match Image 3, same camera, light, background and remaining combatant, empty ${side} contact area; no ball visible yet. [0.8-3s] ${sendoutStaging} The Poké Ball opens in a localized soft glow and releases ${scene[side].speciesId}, with correct colors, body proportions and markings from its identity image. [3-5s] The new creature settles into its recorded condition; return to and hold the low shared battle composition. No full-screen white flash. The other side never changes identity, condition or location. Conditions from entry onwards: ${sceneConditionDirection(scene)}.`
      : kind === "switch"
    ? `Image 1 identifies the FINAL player ${scene.player.speciesId}. Image 2 identifies the FINAL opponent ${scene.opponent.speciesId}. Image 3 is the environment and color reference only. Image 4 identifies the OUTGOING ${before[side].speciesId}. Species references lock identity, colors, anatomy and markings only; redraw in unified anime style, no pixel grid. [0-1.4s] Show the previous pair: ${before.player.speciesId} left, ${before.opponent.speciesId} right. Recall only ${before[side].speciesId} on the ${side} side in a soft red silhouette that shrinks and disappears completely. Do not morph one species into another. [1.4-3.5s] ${sendoutStaging} The Poké Ball opens on that same ${side} side; send out ${scene[side].speciesId} in a brief soft glow, no full-screen flash. [3.5-5s] Pull back to the low shared battle composition and hold the NEW pair, correct scale, both recognizable. The other side never changes identity, pose condition or location. Previous conditions until recall: ${sceneConditionDirection(before)}. Final conditions from entry onwards: ${sceneConditionDirection(scene)}.`
    : kind === "idle"
      ? `Use the supplied scene tail as the exact first AND last composition. ${idleStaging} Seamless idle loop, locked camera for all 5s. Only tiny breathing, natural blinking for awake characters, tail motion and gentle grass sway; no stepping, attacking or camera cuts. Finish with matching poses for looping. Conditions persist in EVERY frame: ${sceneConditionDirection(scene)}.`
      : commandResponseDirection(scene);
  const composition = kind === "recall" ? "After recall exactly ONE remaining combatant; never duplicate it." : "";
  const coldDirection = coldRecall ? direction.replace("Use the supplied battle frame as the exact opening.", `Image 1 identifies player ${scene.player.speciesId}; Image 2 identifies opponent ${scene.opponent.speciesId}; Image 3 is the environment reference. Start with the low shared battle composition, faithful anatomy and colors, redraw all references as anime.`) : direction;
  const attackLayout = sourceAttack ? `Image 1 identifies player ${scene.player.speciesId}, Image 2 identifies opponent ${scene.opponent.speciesId}, Image 3 is the preceding attack's reaction tail, Image 4 is the environment. Preserve species and conditions, but DO NOT copy a close-up or split-screen from Image 3. ${kind === "command" ? "Use the low shared battle view as spatial reference for the closing shot; start immediately with the authored player close-up" : "Re-establish the low shared battle view from the FIRST frame"}: ${scene.player.speciesId} large left foreground, ${scene.opponent.speciesId} smaller right middle distance. ${kind === "command" ? "Both full bodies visible in the closing shot" : "Both full bodies visible in the establishing shot"}, breathing room around silhouettes, same ground plane. Never merge or replace either character. ${kind === "idle" ? "Keep BOTH in frame throughout the idle." : kind === "recall" ? "After recall the recalled side MUST be empty; only the untouched combatant remains." : "Restore both combatants in the closing wide shot."} ` : "";
  let sceneDirection = coldDirection;
  if (sourceAttack && kind !== "recovery") {
    sceneDirection = sceneDirection.replace("Use the supplied scene tail as the exact first AND last composition.", "Use the same shared TWO-character composition on the first and last frames; NEVER end on a close-up.")
      .replace("Use the supplied scene tail on the first frame.", "Start and end with BOTH combatants in the shared battle view.")
      .replace("Use the supplied battle frame as the exact opening.", "Start with both combatants in the shared battle view.");
    if (kind === "command") sceneDirection = sceneDirection.replace("Use the supplied scene tail only for first-frame continuity, then immediately cut closer; do not spend a second on an opening wide shot.", "Begin immediately with the authored close-up in the same arena; use the attack tail for state continuity, not its camera framing.");
  }
  const sound = kind === "command" ? commandResponseSound(scene) : "Sound: quiet outdoor ambience only, no music, speech or move sound.";
  const framing = kind === "recovery" ? style.replace("Low battle camera:", "Closing battle composition only, not a reset of the opening frame:")
    : kind === "idle" ? style.replace("player large in left foreground, opponent smaller in right middle distance", "both combatants on their respective sides") : style;
  const layout = kind === "idle" ? attackLayout.replace(`${scene.player.speciesId} large left foreground, ${scene.opponent.speciesId} smaller right middle distance`, `${scene.player.speciesId} rear view in left foreground at a restrained scale, ${scene.opponent.speciesId} front three-quarter view in right middle distance`) : attackLayout;
  return { key, kind, scene, before, side, language, ...(health ? { health } : {}), sourceKey: input.sourceKey ?? null, sourceAttack,
    prompt: `${framing.replace("Exactly two combatants at a time.", "At most two combatants at a time.")} ${kind === "recovery" ? "" : layout}${sceneDirection} ${composition} ${sound}` };
}

// Separate, bounded scene jobs never occupy the foreground attack runway.
// Complete assets are local and content-keyed; page renders cannot submit jobs.
export class SceneVideoService {
  constructor({ directory, loadReferences, loadContextImages, loadAttackAnchor = async () => null, loadDefaultAnchor = async () => null, runwayFactory = options => new FalVideoRunway(options), tailExtractor = extractVideoTailFrame, idleLoop = createSettledIdleLoop, commandAudio = normalizeCommandAudio, fetchImpl = fetch, writeSubmission = writeFile, writeArtifact = atomicArtifact, recoverClip = recoverSceneClip, retryDelayMs = 2000 } = {}) {
    Object.assign(this, { directory, loadReferences, loadContextImages, loadAttackAnchor, loadDefaultAnchor, runwayFactory, tailExtractor, idleLoop, commandAudio, fetchImpl, writeSubmission, writeArtifact, recoverClip, retryDelayMs });
    this.jobs = new Map();
    this.running = 0;
    this.queue = [];
  }

  snapshot(job) {
    const { key, kind, scene, status, error, generationMs } = job;
    const playable = !["error", "cancelled"].includes(status) && Boolean(job.playable || status === "ready");
    const archiveReady = job.archiveReady ?? status === "ready";
    const tailReady = job.tailReady ?? archiveReady;
    return { key, kind, scene, language: job.language ?? "zh", side: job.side ?? null, status, error, generationMs, seed: job.seed ?? null,
      playable, archiveReady, tailReady, timings: job.timings ?? null,
      retryable: Boolean(job.retryable), errorCode: job.errorCode ?? null,
      retryAfterMs: Math.max(0, (job.retryAt ?? 0) - Date.now()),
      videoUrl: playable ? `/api/scene-videos/${key}/media.mp4` : null,
      tailUrl: playable && tailReady ? `/api/scene-videos/${key}/tail.jpg` : null };
  }

  async get(key) {
    if (!SCENE_VIDEO_KEY.test(key)) return null;
    if (this.jobs.has(key)) return this.snapshot(this.jobs.get(key));
    try {
      const saved = JSON.parse(await readFile(join(this.directory, key, "manifest.json"), "utf8"));
      if (saved.key !== key || saved.status !== "ready" || obsoleteAttackCache(saved)) return null;
      this.jobs.set(key, saved);
      return this.snapshot(saved);
    } catch { return null; }
  }

  create(input, credentials) {
    const spec = sceneVideoSpec(input);
    const existing = this.jobs.get(spec.key);
    if (existing && (existing.executing || !["error", "cancelled"].includes(existing.status)
      || (existing.retryAt ?? 0) > Date.now())) return this.snapshot(existing);
    if ([...this.jobs.values()].filter(job => ACTIVE.has(job.status)).length >= 12) {
      const error = new Error("场景素材正在准备，请稍后再试");
      error.statusCode = 429;
      throw error;
    }
    const job = { ...spec, seed: FAL_VIDEO_SEED, status: "queued", controller: new AbortController(), credentials,
      recoverOnly: input.recoverOnly === true || existing?.status === "error", paid: existing?.paid, archive: existing?.archive };
    this.jobs.set(spec.key, job);
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    this.queue.push(job);
    this.drain();
    return this.snapshot(job);
  }

  drain() {
    // Four background assets plus one foreground slot. Queue during cancellation
    // instead of dropping the new state's command/idle requests with a 429.
    const priority = { recovery: 0, sendout: 0, switch: 0, idle: 1, command: 1, recall: 2 };
    this.queue.sort((a, b) => priority[a.kind] - priority[b.kind]);
    while (this.running < 5 && this.queue.length) {
      const job = this.queue.shift();
      if (job.controller.signal.aborted) { job.resolveDone(); continue; }
      this.running++;
      job.executing = true;
      job.status = "loading";
      const credentials = job.credentials;
      delete job.credentials;
      void this.run(job, credentials).finally(() => {
        this.running--;
        job.executing = false;
        job.resolveDone();
        this.drain();
      });
    }
  }

  cancel(key) {
    const job = this.jobs.get(key);
    if (!job) return false;
    if (!ACTIVE.has(job.status)) return true;
    job.controller.abort();
    if (job.status === "queued") {
      this.queue = this.queue.filter(item => item !== job);
      delete job.credentials;
      job.status = "cancelled";
      job.resolveDone();
    }
    if (job.runwayId) job.runway.cancel(job.runwayId);
    // Keep the slot reserved until remote cancellation has settled.
    return true;
  }

  async anchor(key, scene, kind = null, signal = null) {
    const job = await this.get(key);
    if (!job?.playable || (kind ? job.kind !== kind : job.kind === "recall") || visualSceneKey(job.scene) !== visualSceneKey(scene)) return null;
    const live = this.jobs.get(key);
    if (live?.tailBytes) return `data:image/jpeg;base64,${live.tailBytes.toString("base64")}`;
    if (live?.tailPromise) {
      const bytes = await waitForAnchor(live.tailPromise, signal);
      return bytes ? `data:image/jpeg;base64,${bytes.toString("base64")}` : null;
    }
    if (!job.tailReady) return null;
    const bytes = await readFile(join(this.directory, key, "tail.jpg"));
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  }

  async run(job, credentials) {
    const signal = job.controller.signal;
    const started = performance.now();
    job.timings = {};
    try {
      // A completed disk cache is usable even after restarting the server.
      try {
        const saved = JSON.parse(await readFile(join(this.directory, job.key, "manifest.json"), "utf8"));
        if (obsoleteAttackCache(saved)) throw recoveryError("OBSOLETE_SCENE_CACHE");
        if (saved.key === job.key && saved.status === "ready") {
          if (signal.aborted) throw abortError();
          // Legacy paid assets have an unknown seed; never relabel or regenerate them.
          Object.assign(job, saved, { seed: saved.seed ?? null });
          return;
        }
      } catch (error) { if (error.name === "AbortError" || error.code === "OBSOLETE_SCENE_CACHE") throw error; }
      const directory = join(this.directory, job.key);
      // Reconcile the paid journal BEFORE consulting a possibly expired attack
      // tail. Failed cached jobs never fall through to another paid submission.
      const paid = job.paid ?? await optionalJson(join(directory, "submission.json"));
      let archive, rawVideo;
      if (paid) {
        validatePaidScene(paid, job);
        job.paid = paid;
        job.seed = paid.seed ?? null;
        // Result metadata is rebuildable, unlike the paid submission journal.
        const result = await optionalJson(join(directory, "result.json")).catch(() => null);
        if (result?.requestId === paid.requestId && result.model === paid.model) {
          archive = result;
          try {
            const bytes = await readFile(join(directory, "generation.mp4"));
            if (bytes.length && result.rawSha256 === hashBytes(bytes)) rawVideo = bytes;
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        archive ??= job.archive;
        if (!rawVideo) archive = await this.recoverClip(paid, { credentials, signal });
        if (signal.aborted) throw abortError();
        job.status = "generating";
      } else {
        if (job.recoverOnly) throw recoveryError("NO_PAID_SUBMISSION");
      let sourceFrame = null;
      if (job.kind === "sendout") {
        const recall = await this.get(job.sourceKey);
        if (recall?.kind === "recall" && recall.side === job.side
          && visualSceneKey(recall.scene) === visualSceneKey(job.before)) {
          sourceFrame = await this.anchor(job.sourceKey, job.before, "recall", signal);
        }
      } else if (job.sourceAttack) {
        sourceFrame = await waitForAnchor(this.loadAttackAnchor(job.sourceAttack, job.scene, signal, job.kind === "recovery" ? job.health : null), signal);
      } else if (job.sourceKey === "default" && ["recall", "command"].includes(job.kind)) {
        sourceFrame = await this.loadDefaultAnchor(job.scene, job.kind);
      } else if (job.kind !== "switch") sourceFrame = await this.anchor(job.sourceKey, job.scene, null, signal);
      const coldRecall = job.kind === "recall" && !job.sourceKey && !job.sourceAttack;
      if (job.kind !== "switch" && !coldRecall && !sourceFrame) throw new Error("匹配的场景尾帧不可用");
      const referenceLayout = job.kind === "sendout" || (Boolean(job.sourceAttack) && job.kind !== "recovery");
      const openingFrame = referenceLayout ? null : sourceFrame;
      const [references, contextImages] = await Promise.all([
        this.loadReferences(job.scene),
        ["switch", "sendout"].includes(job.kind) || coldRecall || referenceLayout ? this.loadContextImages(job.before ?? job.scene, job.scene) : [],
      ]);
      if (signal.aborted) throw abortError();
      await mkdir(directory, { recursive: true });
      // Write intent BEFORE a paid submit. If the process dies at any point,
      // another process must not buy the same clip again without reconciliation.
      try {
        await this.writeSubmission(join(directory, "submission.json"), JSON.stringify({ key: job.key, kind: job.kind, seed: job.seed, status: "submitting", createdAt: Date.now() }), { flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") throw recoveryError("UNCONFIRMED_SUBMISSION");
        throw error;
      }
      if (signal.aborted) throw abortError();
      job.runway = this.runwayFactory({
        resolution: "480P",
        submittedSink: async ({ clip }) => {
          job.paid = { key: job.key, kind: job.kind, language: job.language, seed: job.seed, status: "submitted", requestId: clip.requestId, model: clip.model, createdAt: Date.now() };
          await atomicArtifact(join(directory, "submission.json"), JSON.stringify(job.paid));
        },
        clipSink: ({ clip }) => { archive = clip; },
      });
      // Send-out needs the newcomer's identity references, which I2V cannot take.
      // The recall tail is Image 3 for R2V; match-cut timing is handled by the player.
      const session = job.runway.create({ credentials, language: job.language, referenceImages: references,
        contextImages: referenceLayout ? [sourceFrame, contextImages[0]].filter(Boolean) : contextImages,
        battleEpoch: 0, turn: 1, openingFrame,
        closingFrame: ["idle", "command"].includes(job.kind) ? openingFrame : null,
        beats: [{ index: 0, durationSeconds: 5, purpose: job.kind, attackId: job.key, motionPrompt: job.prompt }] });
      job.runwayId = session.id;
      job.status = "generating";
      while (true) {
        const current = job.runway.get(session.id);
        if (!["generating", "cancelling"].includes(current.status)) {
          if (signal.aborted) throw abortError();
          if (current.status !== "ready") throw new Error("场景视频生成失败");
          archive ??= current.clips[0];
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      }
      job.archive = archive;
      job.generationMs = archive.generationMs;
      const downloadStart = performance.now();
      if (!rawVideo) {
        await this.writeArtifact(join(directory, "result.json"), JSON.stringify(archive));
        rawVideo = Buffer.from(await downloadVideo(archive.videoUrl, { fetchImpl: this.fetchImpl,
          signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) }));
        if (signal.aborted) throw abortError();
        // Publish the checksum only AFTER the complete raw file is saved.
        await this.writeArtifact(join(directory, "generation.mp4"), rawVideo);
        await this.writeArtifact(join(directory, "result.json"), JSON.stringify({ ...archive, rawSha256: hashBytes(rawVideo) }));
      }
      job.timings.downloadMs = Math.round(performance.now() - downloadStart);
      const needsLoop = job.kind === "idle" && job.sourceAttack;
      const needsAudio = job.kind === "command" && !job.scene.player.fainted && !["sleep", "freeze"].includes(job.scene.player.status);
      // Preserve the original paid output; processing is local and never resubmits.
      const processStart = performance.now();
      let audioVersion = null;
      let audioError = null;
      let video = needsLoop ? await this.idleLoop(rawVideo, { signal }) : rawVideo;
      if (needsAudio) {
        try {
          video = await this.commandAudio(rawVideo, { signal });
          audioVersion = COMMAND_AUDIO_VERSION;
        } catch (error) {
          if (signal.aborted || error.name === "AbortError") throw error;
          // Loudness is optional polish: keep the already-paid original playable.
          // A local processing failure must never cause another paid generation.
          audioError = "响度处理失败，保留原始音轨";
        }
      }
      job.timings.loopMs = Math.round(performance.now() - processStart);
      if (needsAudio) { job.timings.audioMs = job.timings.loopMs; job.timings.loopMs = 0; }
      const tailStart = performance.now();
      job.tailPromise = Promise.resolve().then(() => this.tailExtractor("http://127.0.0.1/scene.mp4", { signal, fetchImpl: async () => new Response(video) }))
        .then(async tail => {
          const bytes = Buffer.from(await tail.arrayBuffer());
          job.timings.tailFrameMs = Math.round(performance.now() - tailStart);
          job.tailBytes = bytes;
          return bytes;
        });
      job.tailPromise.catch(() => {});
      if (signal.aborted) throw abortError();
      await this.writeArtifact(join(directory, "media.mp4"), video);
      if (signal.aborted) throw abortError();
      // Stable local URL is now playable. Tail generation/archive can continue;
      // a dependent send-out still waits for the actual tail, not this flag.
      job.playable = true;
      job.archiveReady = false;
      job.tailReady = false;
      job.timings.playableMs = Math.round(performance.now() - started);
      const tail = await job.tailPromise;
      if (signal.aborted) throw abortError();
      await this.writeArtifact(join(directory, "tail.jpg"), tail);
      job.tailReady = true;
      if (signal.aborted) throw abortError();
      job.timings.archiveMs = Math.round(performance.now() - started);
      // The manifest is the last write: never publish half-prepared media.
      const manifest = { ...this.snapshot({ ...job, status: "ready", archiveReady: true }), before: job.before,
        ...(job.kind === "recovery" ? { health: job.health, recoveryVersion: BATTLE_RECOVERY_VERSION } : {}),
        sourceKey: job.sourceKey, sourceAttack: job.sourceAttack, layoutVersion: job.sourceAttack ? "attack-layout-v1" : null,
        loopVersion: needsLoop ? IDLE_LOOP_VERSION : null, audioVersion, audioError, prompt: job.prompt, model: archive.model, requestId: archive.requestId };
      await this.writeArtifact(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
      if (signal.aborted) throw abortError();
      job.archiveReady = true;
      delete job.tailBytes;
      job.status = "ready";
    } catch (error) {
      // A completed media file remains useful if its diagnostic archive fails.
      job.status = signal.aborted ? "cancelled" : job.playable ? "ready" : "error";
      const terminal = ["NO_PAID_SUBMISSION", "UNCONFIRMED_SUBMISSION", "OBSOLETE_SCENE_CACHE", "PAID_TASK_UNAVAILABLE"];
      job.errorCode = terminal.includes(error.code) || error.code === "ENOSPC" ? error.code : "SCENE_PREPARATION_FAILED";
      job.retryable = job.status === "error" && Boolean(job.paid) && !terminal.includes(error.code)
        && ![400, 401, 403, 404, 422].includes(error.status ?? error.statusCode);
      job.retryAt = Date.now() + this.retryDelayMs;
      job.error = signal.aborted ? "已取消场景生成" : job.playable
        ? "视频可播放，尾帧或归档未完成；不会自动重新付费生成"
        : job.retryable ? "已付费素材准备失败，将仅恢复原任务，不重新生成收费"
          : "场景素材未准备好，保留本地战场；不会自动重新付费生成";
    } finally {
      delete job.tailPromise;
    }
  }
}

function obsoleteAttackCache(saved) {
  if (saved.kind === "recovery") return saved.recoveryVersion !== BATTLE_RECOVERY_VERSION;
  return saved.sourceAttack && (saved.layoutVersion !== "attack-layout-v1"
    || (saved.kind === "idle" && saved.loopVersion !== IDLE_LOOP_VERSION));
}
