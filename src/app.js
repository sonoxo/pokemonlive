import {
  chooseAiAction,
  createBattle,
  getActive,
  getMoveChoices,
  resolveForcedSwitch,
  resolveTurn,
  typeEffectiveness,
} from "./battle-engine.js";
import { buildAttackRecords, createFallbackStoryboard, createRealtimeStoryboard, BLOCKED_REASON_LABELS } from "./attack-storyboard.js";
import { bufferVideo, playVideo } from "./inline-cinema.js";
import { prefetchAttackSession } from "./attack-session-prefetch.js";
import { clipGapMetrics } from "./cinema-gap-metrics.js";
import { AttackVideoPlayer } from "./attack-video-player.js";
import { createCinemaEventCursor } from "./cinema-events.js";
import { ITEMS, MOVES, STAT_NAMES, STATUS_NAMES, TYPE_NAMES } from "./data.js";
import { supportsDefaultIdleVideo } from "./idle-battle-video.js";
import { visualScene, visualSceneKey, attackVisualScene } from "./visual-battle-state.js";
import { requestSceneVideo, SceneAssetCache, waitForScene } from "./scene-video-client.js";
import { BattleNarrator } from "./battle-narrator.js";
import { playTrainerCutIn } from "./trainer-cut-in.js";
import { prepareCommandBridge } from "./command-bridge-preparation.js";
import { battleRecoveryState } from "./battle-recovery.js";
import { normalizeLanguage } from "./language.js";
import { createPageLocalizer, translateText, localizedTurnSummary } from "./ui-localization.js";

const battleNarrator = new BattleNarrator();

const TYPE_COLORS = {
  typeless: "#d7dfd9",
  normal: "#9b9a89",
  fire: "#e96f43",
  water: "#4d9dcc",
  electric: "#e5bb37",
  grass: "#62a950",
  ice: "#76c4c5",
  fighting: "#b84b45",
  poison: "#96529f",
  ground: "#b9954e",
  flying: "#879fcf",
  psychic: "#d85f87",
  bug: "#929f39",
  rock: "#9c8642",
  ghost: "#675e91",
  dragon: "#6555b5",
  dark: "#5f514a",
  steel: "#8997a0",
  fairy: "#d889b0",
};

const CATEGORY_NAMES = {
  physical: "物理",
  special: "特殊",
  status: "变化",
};

const EVENT_LABELS = {
  move: "招式发动",
  damage: "伤害结算",
  miss: "招式落空",
  status: "状态变化",
  stat: "能力变化",
  skip: "行动受阻",
  switch: "替换上场",
  item: "使用道具",
  heal: "体力回复",
  faint: "失去战斗能力",
  result: "对战结束",
  message: "战况播报",
};

const STORYBOARD_PURPOSES = {
  complete: "完整演出",
  setup: "决定性铺垫",
  payoff: "命中与收束",
  blocked: "状态阻止出招",
};

const STORYBOARD_CAMERAS = {
  attacker_three_quarter: "攻击方 3/4 机位",
  side_tracking: "侧向跟拍",
  target_close: "目标近景",
  wide_field: "战场全景",
};

const STORYBOARD_SHOT_SIZES = {
  extreme_close_up: "大特写",
  close_up: "近景",
  medium: "中景",
  wide: "远景",
  extreme_wide: "大全景",
};

const dom = {
  languageSelect: document.querySelector("#language-select"),
  stage: document.querySelector("#battle-stage"),
  idleBattleVideo: document.querySelector("#idle-battle-video"),
  turn: document.querySelector("#turn-counter"),
  message: document.querySelector("#battle-message"),
  messageLabel: document.querySelector("#message-label"),
  log: document.querySelector("#battle-log"),
  playerStatus: document.querySelector("#player-status"),
  opponentStatus: document.querySelector("#opponent-status"),
  playerCombatant: document.querySelector("#player-combatant"),
  opponentCombatant: document.querySelector("#opponent-combatant"),
  playerSprite: document.querySelector("#player-sprite"),
  opponentSprite: document.querySelector("#opponent-sprite"),
  playerPips: document.querySelector("#player-pips"),
  opponentPips: document.querySelector("#opponent-pips"),
  moveGrid: document.querySelector("#move-grid"),
  teamList: document.querySelector("#team-list"),
  bagList: document.querySelector("#bag-list"),
  moveFlash: document.querySelector("#move-flash"),
  damagePop: document.querySelector("#damage-pop"),
  storyboard: document.querySelector("#storyboard-dialog"),
  storyboardButton: document.querySelector("#storyboard-button"),
  storyboardStatus: document.querySelector("#storyboard-status"),
  storyboardStatusCopy: document.querySelector("#storyboard-status-copy"),
  storyboardSummary: document.querySelector("#storyboard-summary"),
  storyboardJson: document.querySelector("#storyboard-json"),
  attackVideo: document.querySelector("#attack-video-stage"),
  commandBridge: document.querySelector("#command-bridge"),
  trainerVideos: { command: document.querySelector("#trainer-command-video"), recall: document.querySelector("#trainer-recall-video") },
  switchVideo: document.querySelector("#switch-video"),
  recallVideos: { player: document.querySelector("#recall-player-video"), opponent: document.querySelector("#recall-opponent-video") },
  cinemaControls: document.querySelector("#cinema-controls"),
  attackVideoScreen: document.querySelector(".attack-cinema__screen"),
  attackVideoPlayers: [...document.querySelectorAll("[data-attack-video-slot]")],
  attackVideoWaiting: document.querySelector("#attack-video-waiting"),
  attackVideoTimeline: document.querySelector("#attack-video-timeline"),
  attackVideoBeat: document.querySelector("#attack-video-beat"),
  attackVideoStatus: document.querySelector("#attack-video-status"),
  attackVideoSound: document.querySelector("#attack-video-sound"),
  attackVideoSkip: document.querySelector("#attack-video-skip"),
  rules: document.querySelector("#rules-dialog"),
  rulesButton: document.querySelector("#rules-button"),
  resetButton: document.querySelector("#reset-button"),
  resultReset: document.querySelector("#result-reset"),
  resultTitle: document.querySelector("#result-title"),
  resultCopy: document.querySelector("#result-copy"),
  panels: [...document.querySelectorAll(".panel-view")],
  mainCommands: [...document.querySelectorAll("[data-command]")],
  backButtons: [...document.querySelectorAll("[data-back]")],
};

let battle = createBattle();
let language = "zh";
try { language = normalizeLanguage(localStorage.getItem("pokemonlive.language") ?? "zh"); } catch { /* Unavailable or old preference: Chinese default. */ }
dom.languageSelect.value = language;
const pageLocalizer = createPageLocalizer(document, language);
let activePanel = "main";
let busy = false;
let temporaryMessageTimer = null;
let battleEpoch = 0;
let storyboardAbortController = null;
let attackVideoAbortController = null;
let activeVideoSessionId = null;
let activeVideoClipIndex = null;
let attackVideoSoundEnabled = true;
let attackVideoAutoplayBlocked = false;
let latestStoryboard = null;
let cinemaRun = null;
let presentationBattle = null;
let idleBattleVideoFailed = false;
let idleVideoReloads = 0;
let heldFrame = null;
const defaultSceneKey = visualSceneKey(visualScene(battle));
dom.idleBattleVideo.dataset.sceneKey = defaultSceneKey;
const languageCaches = new Map();
function sceneCacheFor(locale) {
  if (!languageCaches.has(locale)) languageCaches.set(locale, new SceneAssetCache({ language: locale,
    onReady: (entry, kind) => { if (locale === language) preloadSceneAsset(entry, kind); },
  }));
  return languageCaches.get(locale);
}
let sceneAssets = sceneCacheFor(language);
const ATTACK_VIDEO_VOLUME = 0.82;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const idleVideoViewport = window.matchMedia("(min-width: 661px)");

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? Math.min(ms, 20) : ms));
}

function hpRatio(pokemon) {
  return Math.max(0, pokemon.hp / pokemon.stats.hp);
}

function statusText(pokemon) {
  if (pokemon.status) return STATUS_NAMES[pokemon.status];
  if (pokemon.volatile.confusedTurns > 0) return "混乱";
  return "";
}

function setMessage(text, label = "等待指令") {
  dom.message.textContent = text;
  dom.messageLabel.textContent = label;
}

function element(tagName, className, text = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function setStoryboardStatus(state, copy) {
  dom.storyboardStatus.dataset.state = state;
  dom.storyboardStatusCopy.textContent = copy;
}

function storyboardOutcomeBadge(attack) {
  if (attack.blockedReason) return `${BLOCKED_REASON_LABELS[attack.blockedReason]} · ${attack.outcome.selfDamage ? `自伤 −${attack.outcome.selfDamage} HP${attack.outcome.actorFainted ? " · 倒下" : ""}` : "无法行动"}`;
  if (attack.outcome.missed) return "MISS";
  if (attack.outcome.effectiveness === 0) return "IMMUNE";
  if (attack.outcome.damage > 0) {
    const cleared = attack.outcome.clearedStatus
      ? ` · 解除${STATUS_NAMES[attack.outcome.clearedStatus] ?? attack.outcome.clearedStatus}`
      : "";
    const status = attack.outcome.status ? ` · ${STATUS_NAMES[attack.outcome.status] ?? attack.outcome.status}` : "";
    const recoil = attack.outcome.recoilDamage
      ? ` · 反伤 −${attack.outcome.recoilDamage} HP${attack.outcome.actorFainted ? " · 攻击方倒下" : ""}`
      : "";
    return `−${attack.outcome.damage} HP${cleared}${status}${recoil}`;
  }
  if (attack.outcome.status) return "STATUS";
  if (["self_stat", "foe_stat", "mixed_stat"].includes(attack.outcome.effectMode)) {
    return attack.outcome.statChanges.length ? "STAT" : "STAT MAX";
  }
  return "NO EFFECT";
}

function storyboardRoute(attack) {
  if (attack.blockedReason) return `${attack.actor.name} · ${BLOCKED_REASON_LABELS[attack.blockedReason]}`;
  return attack.outcome.effectMode === "self_stat"
    ? `${attack.actor.name} · 自我强化`
    : `${attack.actor.name} → ${attack.target.name}`;
}

function renderStoryboardDetails() {
  dom.storyboardJson.textContent = JSON.stringify(latestStoryboard ?? {}, null, 2);
  if (!latestStoryboard) {
    const empty = element("div", "storyboard-empty");
    empty.append(
      element("strong", "", "还没有分镜记录"),
      element("p", "", "发动招式后，这里会显示输入事实、镜头节拍与生成耗时。"),
    );
    dom.storyboardSummary.replaceChildren(empty);
    return;
  }

  const meta = element("div", "storyboard-meta");
  const source = latestStoryboard.source === "deepseek"
    ? `DeepSeek · ${latestStoryboard.model}`
    : latestStoryboard.source === "pending" ? "等待 DeepSeek" : "本地安全降级";
  meta.append(
    element("span", "storyboard-chip", source),
    element("span", "storyboard-chip", `第 ${latestStoryboard.turn} 回合`),
    element("span", "storyboard-chip", latestStoryboard.planningMs == null ? "规划中" : `${latestStoryboard.planningMs} ms`),
  );
  if (latestStoryboard.videoSession) {
    const ready = latestStoryboard.videoSession.clips?.filter((clip) => clip.status === "ready").length ?? 0;
    const total = latestStoryboard.videoSession.clips?.length ?? 0;
    meta.append(element(
      "span",
      "storyboard-chip",
      `fal ${latestStoryboard.videoSession.resolution ?? "480P"} · ${ready}/${total}`,
    ));
    const openingGenerationMs = latestStoryboard.videoSession.clips?.[0]?.generationMs;
    if (Number.isFinite(openingGenerationMs)) {
      meta.append(element(
        "span",
        "storyboard-chip",
        `首段生成 ${(openingGenerationMs / 1000).toFixed(1)}s`,
      ));
    }
  }

  const content = document.createDocumentFragment();
  content.append(meta);
  if (latestStoryboard.warning) content.append(element("p", "storyboard-warning", latestStoryboard.warning));
  if (latestStoryboard.videoFailure) content.append(element("p", "storyboard-warning", latestStoryboard.videoFailure));

  const turnPlan = latestStoryboard.plan?.turn ?? {
    title: "双方联合分镜",
    directorNote: "正在把双方行动合成为一条连续时间线……",
    attacks: latestStoryboard.attacks ?? [],
    sequence: [],
  };
  if (turnPlan.attacks.length) {
    const card = element("article", "storyboard-card storyboard-turn-card");
    const heading = element("div", "storyboard-card__heading");
    const title = element("div", "");
    title.append(
      element("span", "eyebrow", "联合战斗分镜 · 双角色同镜"),
      element("h3", "", turnPlan.title),
    );
    heading.append(title, element("strong", "storyboard-damage", `${turnPlan.sequence.length || turnPlan.attacks.length} CLIPS`));
    card.append(heading);

    const facts = element("div", "storyboard-facts");
    const totalBeats = turnPlan.sequence.length || turnPlan.attacks.length;
    facts.append(
      element("span", "", `联合行动 ${turnPlan.attacks.length}`),
      element("span", "", `视频段落 ${totalBeats}`),
      element("span", "", `预计时长 ${totalBeats * 5}s`),
      element("span", "", `双角色同一场景`),
    );
    const note = element("p", "storyboard-note", localizedTurnSummary(turnPlan, language));
    note.dataset.noTranslate = "";
    card.append(facts, note);

    if (turnPlan.sequence.length) {
      const attacksById = new Map(turnPlan.attacks.map((attack) => [attack.id, attack]));
      const runway = element("ol", "storyboard-runway");
      turnPlan.sequence.forEach((beat) => {
        const attack = attacksById.get(beat.attackId);
        if (!attack) return;
        const item = element("li", "storyboard-beat");
        item.dataset.actorSide = attack.actor.side;
        const beatTop = element("div", "storyboard-beat__top");
        const shotSizes = beat.shots?.map((shot) => STORYBOARD_SHOT_SIZES[shot.shotSize] ?? shot.shotSize) ?? [];
        beatTop.append(
          element("strong", "", `${String(beat.index + 1).padStart(2, "0")} · ${storyboardRoute(attack)} · ${attack.blockedReason ? `未使出${attack.move.name}` : attack.move.name} · ${STORYBOARD_PURPOSES[beat.purpose] ?? beat.purpose}`),
          element("span", "", `${beat.durationSeconds}s · ${shotSizes.length} 镜 · ${shotSizes.join("→") || (STORYBOARD_CAMERAS[beat.camera] ?? beat.camera)}`),
        );
        // This is the original technical provider prompt, not player-facing narration.
        const prompt = element("p", "", beat.motionPrompt);
        prompt.dataset.noTranslate = "";
        item.append(beatTop, element("small", "", "生成提示词（原文）"), prompt);
        if (beat.shots?.length) {
          item.append(element(
            "small",
            "storyboard-beat__shots",
            beat.shots.map((shot) => `${shot.startAt.toFixed(1)}–${shot.endAt.toFixed(1)}s ${STORYBOARD_SHOT_SIZES[shot.shotSize] ?? shot.shotSize}`).join(" · "),
          ));
        }
        if (beat.impactAt != null) {
          item.append(element("small", "storyboard-beat__result", `${storyboardOutcomeBadge(attack)} · 速度 ${attack.tempo.actorSpeed}:${attack.tempo.targetSpeed} · 同步点 ${beat.impactAt.toFixed(1)}s`));
        }
        runway.append(item);
      });
      card.append(runway);
    } else {
      card.append(element("p", "storyboard-note", "正在生成双方共用的连续镜头序列……"));
    }
    content.append(card);
  }
  dom.storyboardSummary.replaceChildren(content);
}

async function requestAttackStoryboards(attacks, epoch, turn) {
  if (!attacks.length) return null;
  storyboardAbortController?.abort();
  const controller = new AbortController();
  storyboardAbortController = controller;
  latestStoryboard = {
    source: "pending",
    turn,
    planningMs: null,
    attacks,
  };
  setStoryboardStatus("planning", "AI 导演 · 正在规划");
  renderStoryboardDetails();
  if (!cinemaRun) setMessage(`正在把 ${attacks.map((attack) => attack.move.name).join("、")} 合成为双方共用的连续分镜……`, "AI 导演");
  const startedAt = performance.now();
  let clientTimedOut = false;
  const clientTimeout = window.setTimeout(() => {
    clientTimedOut = true;
    controller.abort();
  }, 3000);

  try {
    const response = await fetch("/api/attack-storyboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 2, battleEpoch: epoch, turn, attacks, language }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`STORYBOARD_HTTP_${response.status}`);
    const payload = await response.json();
    if (!payload.ok || !payload.plan) throw new Error("STORYBOARD_INVALID_RESPONSE");
    if (epoch !== battleEpoch) return null;
    latestStoryboard = { ...payload, turn };
  } catch (error) {
    if (error.name === "AbortError" && !clientTimedOut) return null;
    if (epoch !== battleEpoch) return null;
    latestStoryboard = {
      ok: true,
      source: "browser-fallback",
      model: null,
      turn,
      planningMs: Math.round(performance.now() - startedAt),
      failureCode: clientTimedOut ? "client_timeout" : "gateway_unavailable",
      warning: clientTimedOut
        ? "实时分镜预算 3 秒已到，使用按战斗事实编排的本地镜头。"
        : "本地分镜网关不可用，已在浏览器内生成安全降级分镜。",
      plan: createFallbackStoryboard(attacks, clientTimedOut ? "client_timeout" : "gateway_unavailable"),
    };
  } finally {
    window.clearTimeout(clientTimeout);
    if (storyboardAbortController === controller) storyboardAbortController = null;
  }

  if (latestStoryboard.source === "deepseek") {
    setStoryboardStatus("ready", `AI 导演 · ${latestStoryboard.planningMs} ms`);
  } else {
    setStoryboardStatus("fallback", "AI 导演 · 本地降级");
  }
  renderStoryboardDetails();
  return latestStoryboard;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function setAttackVideoCopy(title, status) {
  dom.attackVideoBeat.textContent = title;
  dom.attackVideoStatus.textContent = status;
}

function renderAttackVideoSoundControl() {
  const audible = attackVideoSoundEnabled && !attackVideoAutoplayBlocked;
  const label = attackVideoAutoplayBlocked
    ? "点击开启声音"
    : attackVideoSoundEnabled ? "声音开启" : "声音关闭";
  dom.attackVideoSound.dataset.state = attackVideoAutoplayBlocked
    ? "blocked"
    : audible ? "on" : "off";
  dom.attackVideoSound.setAttribute("aria-pressed", String(audible));
  dom.attackVideoSound.setAttribute("aria-label", audible ? "关闭战斗动画声音" : "开启战斗动画声音");
  dom.attackVideoSound.querySelector("[data-sound-label]").textContent = label;
}

function applyAttackVideoAudio(video) {
  video.volume = ATTACK_VIDEO_VOLUME;
  video.muted = !attackVideoSoundEnabled || attackVideoAutoplayBlocked;
}

function toggleAttackVideoSound() {
  if (attackVideoAutoplayBlocked || !attackVideoSoundEnabled) {
    attackVideoSoundEnabled = true;
    attackVideoAutoplayBlocked = false;
  } else {
    attackVideoSoundEnabled = false;
  }
  dom.attackVideoPlayers.concat(dom.commandBridge, dom.switchVideo, Object.values(dom.recallVideos)).forEach(applyAttackVideoAudio);
  if (!attackVideoSoundEnabled) battleNarrator.stop();
  else battleNarrator.resume();
  renderAttackVideoSoundControl();
}

function renderAttackVideoSession(session, playingIndex = null, played = new Set()) {
  latestStoryboard = latestStoryboard ? { ...latestStoryboard, videoSession: session } : latestStoryboard;
  renderStoryboardDetails();
}

function cancelRemoteAttackVideoSession(sessionId) {
  fetch(`/api/attack-videos/${sessionId}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

function cancelAttackVideoSession() {
  if (cinemaRun) cinemaRun.skipped = true;
  storyboardAbortController?.abort();
  attackVideoAbortController?.abort();
  battleNarrator.stop();
  if (activeVideoSessionId) cancelRemoteAttackVideoSession(activeVideoSessionId);
}

function clearCinema({ hold = false } = {}) {
  dom.attackVideoPlayers.concat(dom.commandBridge, dom.switchVideo, Object.values(dom.recallVideos ?? {}), Object.values(dom.trainerVideos)).forEach(video => {
    video.pause();
    if (hold && heldFrame?.video === video) {
      video.classList.add("is-visible");
      video.setAttribute("aria-hidden", "false");
      return;
    }
    video.classList.remove("is-visible");
    video.style.zIndex = "";
  });
  dom.attackVideo.hidden = !hold;
  dom.cinemaControls.hidden = true;
  dom.stage.classList.remove("is-cinema-active");
  dom.attackVideoStatus.textContent = "";
}

function beginCinema(command, { bridge = true, speak = true, trainer = bridge ? "command" : null } = {}) {
  const controller = new AbortController();
  attackVideoAbortController = controller;
  const run = { controller, epoch: battleEpoch, startedAt: performance.now(), events: [], sessionId: null, language: dom.languageSelect?.value ?? "zh" };
  run.mark = (name, clipIndex = null, value = null) => {
    if (run.events.length >= 256) return;
    run.events.push({ name, ms: Math.round(performance.now() - run.startedAt), clipIndex,
      ...(Number.isFinite(value) ? { value } : {}) });
  };
  run.mark("command");
  cinemaRun = run;
  attackVideoAutoplayBlocked = false;
  renderAttackVideoSoundControl();
  dom.attackVideo.hidden = false;
  dom.cinemaControls.hidden = false;
  dom.stage.classList.add("is-cinema-active");
  setAttackVideoCopy(command, "正在准备战斗演出");
  setMessage(command, "训练家指令");
  const scene = visualScene(presentationBattle ?? battle);
  const sceneKey = visualSceneKey(scene);
  run.commandBridge = false;
  run.sceneAnchorKey = heldFrame?.sceneKey === sceneKey ? heldFrame.sceneAnchorKey : null;
  run.continuationSessionId = heldFrame?.sceneKey === sceneKey ? heldFrame.sessionId : null;
  run.outgoing = heldFrame?.sceneKey === sceneKey ? heldFrame.video : null;
  if (bridge) {
    run.commandScene = scene;
    const assets = sceneAssets;
    const release = assets.retain(scene, controller.signal);
    run.releaseCommandAssets = () => {
      if (run.commandReleased) return;
      run.commandReleased = true;
      release();
      if (cinemaRun === run && run.epoch === battleEpoch) assets.cancelPendingExcept(visualScene(battle));
    };
    const entry = assets.get(scene);
    const source = entry?.source ?? (heldFrame?.sceneKey === sceneKey ? heldFrame.sceneAnchorKey ?? heldFrame.sourceAttack : null)
      ?? (sceneKey === defaultSceneKey ? "default" : null);
    if (source) assets.warm(scene, source, { skipIdle: true });
    run.commandPreparation = prepareCommandBridge({ video: dom.commandBridge, scene, language: run.language,
      getJob: () => assets.get(scene)?.command,
      bind: job => bindSceneVideos(scene, null, job.videoUrl, job.key), signal: controller.signal });
    run.openingReady = run.commandPreparation.ready.then(selected => {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      run.commandBridge = Boolean(selected);
      if (selected) {
        run.sceneAnchorKey = selected.key;
        run.continuationSessionId = null;
      }
      run.mark(selected ? "bridge_ready" : "bridge_unavailable");
    });
    run.openingReady.catch(() => {});
  }
  const trainerPlayback = trainer ? playTrainerCutIn(dom.trainerVideos[trainer], run.outgoing, controller.signal, {
    onMark: name => run.mark(name), onFrame: () => { run.trainerOutgoing = dom.trainerVideos[trainer]; },
  }) : null;
  let finishVoice;
  const voiceDone = new Promise(resolve => { finishVoice = resolve; });
  if (speak && attackVideoSoundEnabled) {
    void battleNarrator.speak(command, { signal: controller.signal, language: run.language, onMark: name => run.mark(name),
      onBlocked: () => { if (cinemaRun === run) { attackVideoAutoplayBlocked = true; renderAttackVideoSoundControl(); } },
      playAfter: trainerPlayback?.started, onEnd: finishVoice,
    });
  } else finishVoice();
  // Planning starts immediately. A pending command can select its exact attack
  // anchor during the trainer shot, without adding another wait after that shot.
  run.bridgeDone = (async () => {
    const outgoing = trainerPlayback ? await trainerPlayback.ended : run.outgoing;
    run.commandPreparation?.finish();
    await run.openingReady;
    if (trainerPlayback) {
      // Usually speech ends within the five-second clip. A late line can finish
      // over its held tail, but cannot keep the player waiting indefinitely.
      await waitForScene(Promise.race([voiceDone, abortableDelay(1500, controller.signal)]), controller.signal);
      battleNarrator.stop();
    }
    if (!run.commandBridge) return;
    applyAttackVideoAudio(dom.commandBridge);
    const playback = playVideo(dom.commandBridge, outgoing, controller.signal, {
      onFrame: () => run.mark("bridge_playing"),
      onBlocked: () => { attackVideoAutoplayBlocked = true; renderAttackVideoSoundControl(); },
    });
    await playback.started;
    await playback.ended;
  })().catch(error => {
    if (error.name === "AbortError") throw error;
    run.mark("bridge_failed");
  });
  run.bridgeDone.catch(() => {});
  return run;
}

async function pollAttackVideoClip(run, index) {
  const signal = run.controller.signal;
  const deadline = performance.now() + 12 * 60 * 1000;
  while (performance.now() < deadline) {
    if (cinemaRun !== run || run.epoch !== battleEpoch || signal.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await fetch(`/api/attack-videos/${run.sessionId}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error(`VIDEO_STATUS_HTTP_${response.status}`);
    const { session } = await response.json();
    if (cinemaRun !== run || run.epoch !== battleEpoch || signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!session) throw new Error("VIDEO_STATUS_INVALID_RESPONSE");
    renderAttackVideoSession(session);
    const clip = session.clips[index];
    if (clip?.status === "ready") { run.mark("clip_ready", index); return { clip, session }; }
    if (["error", "cancelled"].includes(clip?.status) || ["failed", "partial", "cancelled"].includes(session.status)) {
      throw new Error(clip?.error || "视频生成中断");
    }
    await abortableDelay(300, signal);
  }
  throw new Error("VIDEO_GENERATION_TIMEOUT");
}

async function requestAndPlayAttackVideos(storyboard, attacks, epoch, turn, run, cursor, prefetched = null) {
  const signal = run.controller.signal;
  const recoveryController = new AbortController();
  const abortRecovery = () => recoveryController.abort();
  signal.addEventListener("abort", abortRecovery, { once: true });
  if (signal.aborted) abortRecovery();
  let recoveryCompleted = false;
  const sequence = storyboard.plan.turn.sequence;
  run.mark("storyboard_ready");
  try {
    if (signal.aborted || epoch !== battleEpoch) throw new DOMException("Aborted", "AbortError");
    if (!prefetched && run.openingReady) await waitForScene(run.openingReady, signal);
    if (prefetched) signal.addEventListener("abort", () => prefetched.controller.abort(), { once: true });
    const response = prefetched ? null : await fetch("/api/attack-videos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 2, battleEpoch: epoch, turn, attacks, sequence, language: run.language,
        presentation: "inline-command-v1", commandBridge: run.commandBridge && !run.sceneAnchorKey,
        sceneAnchorKey: run.sceneAnchorKey, continuationSessionId: run.continuationSessionId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    const payload = prefetched ? await waitForScene(prefetched.promise, signal) : await response.json();
    if ((!prefetched && !response.ok) || !payload.ok) throw new Error(payload.error || "视频请求失败");
    run.sessionId = payload.session.id;
    activeVideoSessionId = run.sessionId;
    run.mark("session_created");
    const recoveryState = battleRecoveryState(attacks.find(attack => attack.id === sequence.at(-1).attackId));
    let recoveryJob, recoveryRequest, recoveryPreparation;
    const requestRecovery = () => {
      if (!recoveryRequest) {
        run.mark("recovery_requested");
        recoveryRequest = requestSceneVideo({ kind: "recovery", ...recoveryState, language: run.language,
          sourceAttack: { sessionId: run.sessionId, clipIndex: sequence.length - 1 } }, recoveryController.signal).then(job => {
          if (job.kind !== "recovery" || visualSceneKey(job.scene) !== visualSceneKey(recoveryState.scene)) throw new Error("收尾阵容不匹配");
          recoveryJob = job;
          run.mark("recovery_ready");
          return { clip: { index: sequence.length, localVideoUrl: job.videoUrl, videoUrl: job.fallbackVideoUrl }, session: null };
        });
        // Generation may fail before the attack ends and the consumer awaits it.
        recoveryRequest.catch(() => {});
      }
      return recoveryRequest;
    };
    const player = new AttackVideoPlayer({ videos: dom.attackVideoPlayers, signal,
      waitForClip: async index => {
        if (index < sequence.length) {
          const ready = await pollAttackVideoClip(run, index);
          // The last clip can finish generating while an earlier clip/bridge
          // still plays. Its tail is already sufficient to start recovery.
          if (index === sequence.length - 1) requestRecovery();
          return ready;
        }
        return requestRecovery();
      }, protectedVideo: run.outgoing,
      configureVideo: applyAttackVideoAudio, mark: run.mark });
    const prepare = index => player.prepare(index);
    // Attach a rejection handler immediately, even while the bridge is playing.
    let firstPrepared = false;
    let preparation = prepare(0).then(result => { firstPrepared = Boolean(result.value); return result; });
    // Even while the first clip/command is buffering, a ready second clip can
    // already decode in a different slot. It is never an opening playback gate.
    if (sequence.length > 1) prepare(1);
    await run.bridgeDone;
    let outgoing = run.commandBridge ? dom.commandBridge : run.trainerOutgoing ?? run.outgoing;
    // A slow first request can continue the already-buffered neutral idle loop
    // after the command shot, without repeating the spoken command.
    if (run.commandBridge && !firstPrepared && dom.stage.classList.contains("is-idle-video-active")) {
      dom.commandBridge.classList.remove("is-visible");
      outgoing = dom.idleBattleVideo;
      run.mark("bridge_to_idle");
    }
    for (let index = 0; index < sequence.length; index += 1) {
      const waitStarted = performance.now();
      const prepared = await preparation;
      if (prepared.error) throw prepared.error;
      run.mark("clip_wait_ms", index, Math.round(performance.now() - waitStarted));
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { session } = prepared.value;
      const beat = sequence[index];
      let applied = false;
      const playback = player.play(prepared.value, outgoing, {
        onFrame: () => {
          const gap = clipGapMetrics(run.events, index, Math.round(performance.now() - run.startedAt));
          for (const [name, value] of Object.entries(gap ?? {})) run.mark(name, index, value);
          run.mark("clip_playing", index);
          run.releaseCommandAssets?.();
          warmAfterAttack(beat, attacks, run, index);
          activeVideoClipIndex = index;
          cursor.start(beat.attackId);
          renderAttackVideoSession(session, index);
          setAttackVideoCopy(beat.purpose === "blocked" ? "无法行动" : "交战中",
            beat.purpose === "blocked" ? `${BLOCKED_REASON_LABELS[beat.blockedReason]}，本次招式未能使出` : "连续战斗演出");
        },
        onTime: time => {
          if (!applied && beat.impactAt != null && time >= beat.impactAt) {
            applied = true;
            cursor.impact(beat.attackId);
            run.mark("impact_cue", index);
          }
        },
        onBlocked: () => { attackVideoAutoplayBlocked = true; renderAttackVideoSoundControl(); },
      });
      await playback.started;
      // Generation is already running, but decoding must not steal the spare
      // slot needed by an earlier attack or its in-flight media recovery.
      if (index === sequence.length - 1) recoveryPreparation = prepare(sequence.length);
      outgoing = prepared.value.video;
      preparation = index + 1 < sequence.length
        ? prepare(index + 1)
        : Promise.resolve({ value: null });
      await playback.ended;
      const video = prepared.value.video;
      outgoing = video;
      cursor.impact(beat.attackId);
      const attack = attacks.find(record => record.id === beat.attackId);
      heldFrame = { video, sceneKey: visualSceneKey(attackVisualScene(attack, beat.purpose !== "setup")), sessionId: run.sessionId,
        sourceAttack: { sessionId: run.sessionId, clipIndex: index } };
      run.mark("clip_ended", index);
      setAttackVideoCopy("交战中", "保持尾帧，后续镜头就绪后续播");
    }
    setAttackVideoCopy("战斗收尾", "保持最后画面，收尾就绪后继续");
    const recoveryWait = performance.now();
    const recovered = await recoveryPreparation;
    run.mark("recovery_wait_ms", null, Math.round(performance.now() - recoveryWait));
    if (recovered.error) throw recovered.error;
    const recoveryPlayback = player.play(recovered.value, outgoing, {
      onFrame: () => {
        run.mark("recovery_playing");
        heldFrame = { video: recovered.value.video, sceneKey: visualSceneKey(recoveryState.scene), sceneAnchorKey: recoveryJob.key };
        setAttackVideoCopy("战斗收尾", "保留战后状态，回到双方同框");
      },
      onTime: () => {},
      onBlocked: () => { attackVideoAutoplayBlocked = true; renderAttackVideoSoundControl(); },
    });
    await recoveryPlayback.started;
    await recoveryPlayback.ended;
    recoveryCompleted = true;
    heldFrame = { video: recovered.value.video, sceneKey: visualSceneKey(recoveryState.scene), sceneAnchorKey: recoveryJob.key };
    run.mark("recovery_ended");
    run.mark("complete");
    setStoryboardStatus("ready", `连续演出 · ${sequence.length} 段 + 收尾`);
  } catch (error) {
    run.mark(error.name === "AbortError" ? "cancelled" : "failed");
    if (epoch === battleEpoch && error.name !== "AbortError") {
      latestStoryboard = { ...latestStoryboard, videoFailure: error.message };
      setStoryboardStatus("fallback", "动画中断 · 已保留战斗结果");
      renderStoryboardDetails();
    }
  } finally {
    prefetched?.controller.abort();
    // Normal playback may finish via CDN while its local archive is still
    // downloading. Only skip/restart/failure may cancel that paid asset.
    if (recoveryCompleted) signal.removeEventListener("abort", abortRecovery);
    run.controller.abort();
    signal.removeEventListener("abort", abortRecovery);
    run.releaseCommandAssets?.();
    if (cinemaRun === run) battleNarrator.stop();
    if (run.sessionId) {
      fetch("/api/cinema-metrics", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: run.sessionId, events: run.events }), keepalive: true }).catch(() => {});
      cancelRemoteAttackVideoSession(run.sessionId);
    }
    if (cinemaRun === run) {
      activeVideoSessionId = null;
      activeVideoClipIndex = null;
      attackVideoAbortController = null;
    }
  }
}

function updateStatusCard(side, pokemon) {
  const card = side === "player" ? dom.playerStatus : dom.opponentStatus;
  card.querySelector('[data-role="name"]').textContent = pokemon.name;
  card.querySelector('[data-role="level"]').textContent = `Lv.${pokemon.level}`;

  const types = card.querySelector('[data-role="types"]');
  types.replaceChildren(...pokemon.types.map((type) => {
    const chip = document.createElement("span");
    chip.className = "type-chip";
    chip.dataset.type = type;
    chip.textContent = TYPE_NAMES[type];
    return chip;
  }));

  const status = card.querySelector('[data-role="status"]');
  const currentStatus = pokemon.status ?? (pokemon.volatile.confusedTurns > 0 ? "confusion" : "");
  status.hidden = !currentStatus;
  status.dataset.status = currentStatus;
  status.textContent = statusText(pokemon);
  updateHpDisplay(side, pokemon.hp, pokemon.stats.hp);
}

function updateHpDisplay(side, currentHp, maxHp) {
  const card = side === "player" ? dom.playerStatus : dom.opponentStatus;
  const fill = card.querySelector('[data-role="hp-fill"]');
  const ratio = Math.max(0, Math.min(1, currentHp / maxHp));
  fill.style.width = `${ratio * 100}%`;
  fill.classList.toggle("is-mid", ratio > 0.2 && ratio <= 0.5);
  fill.classList.toggle("is-low", ratio <= 0.2);
  const numeric = card.querySelector('[data-role="hp-number"]');
  numeric.textContent = side === "player" ? `${currentHp} / ${maxHp}` : ratio === 0 ? "0%" : `${Math.ceil(ratio * 100)}%`;
}

function updateCombatant(side, pokemon) {
  const sprite = side === "player" ? dom.playerSprite : dom.opponentSprite;
  const combatant = side === "player" ? dom.playerCombatant : dom.opponentCombatant;
  combatant.className = `combatant combatant--${side}`;
  combatant.dataset.condition = pokemon.hp <= 0 ? "fainted" : pokemon.status ?? "healthy";
  sprite.src = pokemon.sprite;
  sprite.alt = `${side === "player" ? "我方" : "对手"}的${pokemon.name}`;
  sprite.style.setProperty("--accent", pokemon.accent);
}

function renderPips(side) {
  const trainer = (presentationBattle ?? battle)[side];
  const container = side === "player" ? dom.playerPips : dom.opponentPips;
  container.replaceChildren(...trainer.team.map((pokemon, index) => {
    const pip = document.createElement("span");
    pip.className = "team-pip";
    pip.classList.toggle("is-fainted", pokemon.hp <= 0);
    pip.classList.toggle("is-active", index === trainer.active && pokemon.hp > 0);
    pip.title = `${pokemon.name}：${pokemon.hp > 0 ? "可战斗" : "已倒下"}`;
    return pip;
  }));
}

function effectivenessLabel(move, defender) {
  if (!move.power && !move.checksTypeImmunity) return CATEGORY_NAMES[move.category];
  const multiplier = typeEffectiveness(move.type, defender.types);
  if (multiplier === 0) return "无效";
  if (multiplier > 1) return `效果绝佳 ×${multiplier}`;
  if (multiplier < 1) return `效果不佳 ×${multiplier}`;
  return CATEGORY_NAMES[move.category];
}

function renderMoves() {
  const pokemon = getActive(battle, "player");
  const defender = getActive(battle, "opponent");
  const choices = getMoveChoices(pokemon);
  dom.moveGrid.replaceChildren(...choices.map(({ entry, index, forced }) => {
    const move = forced ? { ...MOVES.struggle, pp: 1 } : { ...MOVES[entry.id], pp: entry.pp };
    const button = document.createElement("button");
    button.className = "move-button";
    button.type = "button";
    button.dataset.moveIndex = index;
    button.dataset.type = move.type;
    button.style.setProperty("--type-color", TYPE_COLORS[move.type]);
    button.disabled = busy || (!forced && entry.pp <= 0) || battle.phase !== "action";
    button.title = move.description;

    const typeOrb = document.createElement("span");
    typeOrb.className = "move-type-orb";
    typeOrb.textContent = language === "zh" ? TYPE_NAMES[move.type].slice(0, 1) : translateText(TYPE_NAMES[move.type], language);
    typeOrb.dataset.noTranslate = "";
    typeOrb.title = translateText(TYPE_NAMES[move.type], language);

    const copy = document.createElement("span");
    copy.className = "move-copy";
    const name = document.createElement("strong");
    name.textContent = move.name;
    const detail = document.createElement("small");
    const power = move.power ? `威力 ${move.power}` : "变化招式";
    detail.textContent = `${power} · ${effectivenessLabel(move, defender)}`;
    copy.append(name, detail);

    const pp = document.createElement("span");
    pp.className = "move-pp";
    pp.textContent = forced ? "自动发动" : `PP ${entry.pp}/${move.maxPp}`;

    const key = document.createElement("kbd");
    key.textContent = String(index + 1);
    button.append(typeOrb, copy, pp, key);
    return button;
  }));
}

function renderTeam() {
  const forced = battle.phase === "must-switch";
  dom.teamList.replaceChildren(...battle.player.team.map((pokemon, index) => {
    const button = document.createElement("button");
    button.className = "team-button";
    button.type = "button";
    button.dataset.teamIndex = index;
    const isCurrent = index === battle.player.active;
    button.disabled = busy || pokemon.hp <= 0 || (!forced && isCurrent) || battle.phase === "complete";
    button.title = pokemon.hp <= 0 ? "已经失去战斗能力" : isCurrent ? "正在战斗" : `替换为${pokemon.name}`;

    const image = document.createElement("img");
    image.src = pokemon.sprite;
    image.alt = "";

    const copy = document.createElement("span");
    copy.className = "team-copy";
    const name = document.createElement("strong");
    name.textContent = `${pokemon.name}${isCurrent ? " · 上场中" : ""}`;
    const hp = document.createElement("small");
    hp.textContent = pokemon.hp <= 0 ? "无法战斗" : `HP ${pokemon.hp}/${pokemon.stats.hp}`;
    const track = document.createElement("span");
    track.className = "mini-hp-track";
    const fill = document.createElement("i");
    fill.style.width = `${hpRatio(pokemon) * 100}%`;
    track.append(fill);
    copy.append(name, hp, track);
    button.append(image, copy);
    return button;
  }));
}

function renderBag() {
  const active = getActive(battle, "player");
  dom.bagList.replaceChildren(...Object.values(ITEMS).map((item) => {
    const count = battle.player.items[item.id] ?? 0;
    const button = document.createElement("button");
    button.className = "item-button";
    button.type = "button";
    button.dataset.itemId = item.id;
    button.disabled = busy || count <= 0 || active.hp <= 0 || battle.phase !== "action";
    button.title = item.description;

    const symbol = document.createElement("span");
    symbol.className = "item-symbol";
    symbol.textContent = item.symbol;
    const copy = document.createElement("span");
    copy.className = "item-copy";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const detail = document.createElement("small");
    detail.textContent = item.description;
    copy.append(name, detail);
    const quantity = document.createElement("span");
    quantity.className = "item-count";
    quantity.textContent = `×${count}`;
    button.append(symbol, copy, quantity);
    return button;
  }));
}

function renderLog() {
  const recent = battle.log.slice(-16);
  dom.log.replaceChildren(...recent.map((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    return item;
  }));
  dom.log.scrollTop = dom.log.scrollHeight;
}

function setIdleBattleVideoActive(active) {
  dom.stage.classList.toggle("is-idle-video-active", active);
  if (active) {
    if (reducedMotion) {
      dom.idleBattleVideo.pause();
      dom.idleBattleVideo.currentTime = 0;
    } else if (dom.idleBattleVideo.paused) {
      dom.idleBattleVideo.play().catch(() => {});
    }
    return;
  }
  dom.idleBattleVideo.pause();
  dom.idleBattleVideo.currentTime = 0;
}

function warmSceneAssets(scene, source, { ambient = true, skipIdle = visualSceneKey(scene) === defaultSceneKey } = {}) {
  if (ambient && !Object.values(scene).some(p => p.fainted)) sceneAssets.warm(scene, source, { skipIdle });
  for (const side of ["player", "opponent"]) sceneAssets.warmRecall(scene, source, side);
}

function warmAfterAttack(beat, attacks, run, index) {
  if (run.epoch !== battleEpoch || run.controller.signal.aborted || beat.purpose === "setup") return;
  const attack = attacks.find(record => record.id === beat.attackId);
  const after = attackVisualScene(attack, true);
  const final = visualScene(battle);
  if (Object.values(after).some(p => p.fainted) && battle.phase !== "complete") {
    const key = visualSceneKey(after);
    if (run.recallSceneKey !== key) {
      run.recallSceneKey = key;
      warmSceneAssets(after, { sessionId: run.sessionId, clipIndex: index }, { ambient: false });
      run.mark("ko_recall_warm_started", index);
    }
    return;
  }
  // Warm the earliest clip that already represents the final visible state.
  // HP-only changes reuse assets. Transient conditions and KO do not buy idle loops.
  if (visualSceneKey(after) !== visualSceneKey(final) || battle.phase !== "action"
    || Object.values(final).some(p => p.fainted) || run.warmedScene) return;
  run.warmedScene = true;
  const isDefault = supportsDefaultIdleVideo(getActive(battle, "player"), getActive(battle, "opponent"));
  warmSceneAssets(final, { sessionId: run.sessionId, clipIndex: index }, { skipIdle: isDefault });
  run.mark("state_warm_started", index);
}

function preloadSceneAsset(entry, kind) {
  const key = visualSceneKey(entry.scene);
  if (kind === "command" && cinemaRun?.commandScene && !cinemaRun.commandReleased
    && key === visualSceneKey(cinemaRun.commandScene)) {
    cinemaRun.commandPreparation?.check();
    return;
  }
  if (kind === "recall") {
    const video = dom.recallVideos[entry.side];
    // The trainer cut-in may cover a buffered old-lineup recall. Keep that
    // slot reserved even though its video has not become visible yet.
    if (cinemaRun?.recallVideo === video) return;
    // Never replace a playing recall with a future state's asset.
    if ((key === visualSceneKey(visualScene(battle)) || (busy && cinemaRun?.recallSceneKey === key)) && !video.classList.contains("is-visible")) {
      video.dataset.sceneKey = key;
      video.src = entry.job.videoUrl;
      video.load();
    }
    return;
  }
  if (!busy) { renderBattlefield(); return; }
  // An actual attack/send-out must cover the stage before rebinding hidden media.
  if (key !== visualSceneKey(visualScene(battle)) || !dom.attackVideoPlayers.concat(dom.switchVideo).some(video => video.classList.contains("is-visible"))) return;
  if (kind === "idle") setIdleBattleVideoActive(false);
  bindSceneVideos(entry.scene, entry.idle?.videoUrl, entry.command?.videoUrl, entry.command?.key);
  cinemaRun?.mark(`state_${kind}_preloading`);
}

function bindSceneVideos(scene, idleUrl, commandUrl, commandKey) {
  const key = visualSceneKey(scene);
  if (idleUrl && (dom.idleBattleVideo.dataset.sceneKey !== key || dom.idleBattleVideo.getAttribute("src") !== idleUrl)) {
    idleBattleVideoFailed = false;
    idleVideoReloads = 0;
    dom.idleBattleVideo.dataset.sceneKey = key;
    dom.idleBattleVideo.removeAttribute("poster");
    dom.idleBattleVideo.src = idleUrl;
    dom.idleBattleVideo.load();
  }
  if (commandUrl && !dom.commandBridge.classList.contains("is-visible")
    && (!cinemaRun?.commandScene || cinemaRun.commandReleased || key === visualSceneKey(cinemaRun.commandScene))
    && (dom.commandBridge.dataset.sceneKey !== key || dom.commandBridge.getAttribute("src") !== commandUrl)) {
    dom.commandBridge.dataset.sceneKey = key;
    dom.commandBridge.dataset.assetKey = commandKey;
    dom.commandBridge.src = commandUrl;
    dom.commandBridge.load();
  }
}

function retryIdleVideoLoad() {
  if (idleVideoReloads >= 2) return;
  idleVideoReloads++;
  const video = dom.idleBattleVideo;
  const key = video.dataset.sceneKey;
  const url = video.getAttribute("src");
  setTimeout(() => {
    if (!idleBattleVideoFailed || video.dataset.sceneKey !== key || video.getAttribute("src") !== url
      || key !== visualSceneKey(visualScene(battle))) return;
    // Keep the matching recovery frame visible until canplay, even when the
    // recovered file has the same URL as the previously failed media request.
    idleBattleVideoFailed = false;
    video.load();
  }, 1500);
}

function renderBattlefield() {
  const visibleBattle = presentationBattle ?? battle;
  const player = getActive(visibleBattle, "player");
  const opponent = getActive(visibleBattle, "opponent");
  const scene = visualScene(visibleBattle);
  const sceneKey = visualSceneKey(scene);
  const entry = sceneAssets.get(scene);
  const isDefault = supportsDefaultIdleVideo(player, opponent);
  const idleUrl = isDefault ? "assets/video/pine-idle-v2-loop.mp4" : entry?.idle?.videoUrl;
  const commandUrl = entry?.command?.videoUrl;
  if (!busy) {
    bindSceneVideos(scene, idleUrl, commandUrl, entry?.command?.key);
    for (const side of ["player", "opponent"]) {
      const recall = sceneAssets.getRecall(scene, side);
      if (recall?.job && dom.recallVideos[side].dataset.sceneKey !== sceneKey) preloadSceneAsset(recall, "recall");
    }
  }
  const idleReady = Boolean(idleUrl) && dom.idleBattleVideo.dataset.sceneKey === sceneKey && dom.idleBattleVideo.readyState >= 3;
  setIdleBattleVideoActive(
    Boolean(dom.idleBattleVideo.getAttribute("src"))
    && idleVideoViewport.matches
    && !idleBattleVideoFailed
    && idleReady,
  );
  if (!busy) {
    const hold = heldFrame?.sceneKey === sceneKey && !dom.stage.classList.contains("is-idle-video-active");
    clearCinema({ hold });
    if (!hold) heldFrame = null;
  }
  dom.turn.textContent = `TURN ${String(battle.turn).padStart(2, "0")}`;
  updateStatusCard("player", player);
  updateStatusCard("opponent", opponent);
  updateCombatant("player", player);
  updateCombatant("opponent", opponent);
  renderPips("player");
  renderPips("opponent");
}

function renderMenus() {
  renderMoves();
  renderTeam();
  renderBag();
  if (battle.phase === "must-switch") {
    showPanel("team", { focus: !busy });
    document.querySelector("#team-menu [data-back]").hidden = true;
  } else {
    document.querySelector("#team-menu [data-back]").hidden = false;
  }
  dom.mainCommands.forEach((button) => {
    button.disabled = busy || battle.phase !== "action";
  });
}

function renderAll() {
  renderBattlefield();
  renderMenus();
  renderLog();
  if (battle.phase === "complete") showResult();
}

function showPanel(name, options = {}) {
  activePanel = name;
  dom.panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === name));
  if (options.focus === false) return;
  window.requestAnimationFrame(() => {
    const panel = document.querySelector(`.panel-view[data-panel="${name}"]`);
    const contentButton = panel?.querySelector(
      ".command-button:not(:disabled), .move-button:not(:disabled), .team-button:not(:disabled), .item-button:not(:disabled), .result-button:not(:disabled)",
    );
    (contentButton ?? panel?.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  });
}

function showResult() {
  const copy = {
    player_won: ["对战胜利", "属性判断与队伍轮换都很漂亮。"],
    opponent_won: ["这次惜败", "调整出招与换人时机，再挑战一次。"],
    draw: ["同时倒下", "双方都拼到了最后一刻，本场对战平局。"],
  }[battle.result];
  [dom.resultTitle.textContent, dom.resultCopy.textContent] = copy;
  showPanel("result");
}

function setBusy(value) {
  busy = value;
  dom.languageSelect.disabled = value;
  dom.languageSelect.title = value ? "演出期间暂不可切换语言" : "语言";
  renderMenus();
}

function changeLanguage() {
  if (busy) { dom.languageSelect.value = language; return; }
  const next = normalizeLanguage(dom.languageSelect.value);
  if (next === language) return;
  const scene = visualScene(battle), key = visualSceneKey(scene);
  const source = sceneAssets.get(scene)?.source ?? (heldFrame?.sceneKey === key ? heldFrame.sourceAttack ?? heldFrame.sceneAnchorKey : null)
    ?? (key === defaultSceneKey ? "default" : null);
  sceneAssets.cancelPendingExcept();
  battleNarrator.stop();
  language = next;
  try { localStorage.setItem("pokemonlive.language", language); } catch { /* Selection still works without storage. */ }
  sceneAssets = sceneCacheFor(language);
  // An old-language command must not be used while the new one is warming.
  dom.commandBridge.dataset.sceneKey = "";
  for (const video of Object.values(dom.recallVideos)) video.dataset.sceneKey = "";
  renderAll();
  renderStoryboardDetails();
  pageLocalizer.setLanguage(language);
  if (battle.phase !== "complete" && source) warmSceneAssets(scene, source);
}

function restartBattle() {
  battleEpoch += 1;
  storyboardAbortController?.abort();
  storyboardAbortController = null;
  cancelAttackVideoSession();
  sceneAssets.cancelPendingExcept();
  heldFrame = null;
  cinemaRun = null;
  presentationBattle = null;
  activeVideoSessionId = null;
  clearCinema();
  battle = createBattle();
  busy = false;
  dom.languageSelect.disabled = false;
  activePanel = "main";
  clearTimeout(temporaryMessageTimer);
  latestStoryboard = null;
  setStoryboardStatus("idle", "AI 导演 · 待机");
  renderStoryboardDetails();
  if (dom.storyboard.open) dom.storyboard.close();
  showPanel("main", { focus: false });
  renderAll();
  setMessage("要让皮卡丘做什么？", "等待指令");
  showPanel("main");
  // Explicit initial-entry prewarm, never dispatched by a render pass.
  warmSceneAssets(visualScene(battle), "default", { skipIdle: true });
}

function flashTemporaryMessage(text) {
  clearTimeout(temporaryMessageTimer);
  setMessage(text, "战况播报");
  temporaryMessageTimer = window.setTimeout(() => {
    if (!busy && battle.phase === "action") {
      setMessage(`要让${getActive(battle, "player").name}做什么？`, "等待指令");
    }
  }, 1800);
}

function replayAnimation(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

function animateMove(event) {
  const attacker = event.actorSide === "player" ? dom.playerCombatant : dom.opponentCombatant;
  replayAnimation(attacker, event.actorSide === "player" ? "is-attacking-player" : "is-attacking-opponent");
  dom.moveFlash.style.setProperty("--move-color", TYPE_COLORS[event.moveType] ?? "#ffffff");
  dom.moveFlash.className = `move-flash at-${event.targetSide}`;
  replayAnimation(dom.moveFlash, "is-visible");
}

function animateDamage(event) {
  const target = event.targetSide === "player" ? dom.playerCombatant : dom.opponentCombatant;
  replayAnimation(target, "is-hit");
  updateHpDisplay(event.targetSide, event.currentHp, event.maxHp);
  dom.damagePop.className = `damage-pop at-${event.targetSide}`;
  dom.damagePop.textContent = `−${event.amount}`;
  replayAnimation(dom.damagePop, "is-visible");
}

function animateHeal(event) {
  updateHpDisplay(event.targetSide, event.currentHp, event.maxHp);
  dom.damagePop.className = `damage-pop at-${event.targetSide} is-heal`;
  dom.damagePop.textContent = `+${event.amount}`;
  replayAnimation(dom.damagePop, "is-visible");
}

async function playEvents(events, epoch) {
  if (epoch !== battleEpoch) return;
  setIdleBattleVideoActive(false);
  setBusy(true);
  showPanel(activePanel, { focus: false });

  for (const event of events) {
    if (epoch !== battleEpoch) return;
    if (event.text) setMessage(event.text, EVENT_LABELS[event.type] ?? "战况播报");
    if (event.type === "move") animateMove(event);
    if (event.type === "damage") animateDamage(event);
    if (event.type === "heal") animateHeal(event);
    if (event.type === "status") {
      const active = getActive(battle, event.targetSide);
      updateStatusCard(event.targetSide, active);
    }
    if (event.type === "faint") {
      const target = event.targetSide === "player" ? dom.playerCombatant : dom.opponentCombatant;
      replayAnimation(target, "is-fainting");
    }
    if (event.type === "switch") {
      const active = getActive(battle, event.targetSide);
      updateCombatant(event.targetSide, active);
      updateStatusCard(event.targetSide, active);
    }
    await wait(event.type === "move" ? 620 : event.type === "faint" ? 700 : 520);
    if (epoch !== battleEpoch) return;
  }

  setBusy(false);
  renderAll();
  if (battle.phase === "action") {
    showPanel("main");
    setMessage(`要让${getActive(battle, "player").name}做什么？`, "等待指令");
  } else if (battle.phase === "must-switch") {
    showPanel("team");
    setMessage("请选择下一只能够战斗的宝可梦。", "必须替换");
  }
}

async function takeTurn(action) {
  if (busy || battle.phase !== "action") return;
  const epoch = battleEpoch;
  const turn = battle.turn;
  setBusy(true);
  const player = getActive(battle, "player");
  const choice = action.type === "move" ? getMoveChoices(player)[action.moveIndex] : null;
  const command = `${player.name}，使用${MOVES[choice?.entry.id]?.name ?? "招式"}！`;
  let run = action.type === "move" ? beginCinema(command) : null;
  presentationBattle = structuredClone(battle);
  const opponentAction = chooseAiAction(battle);
  const result = resolveTurn(battle, action, Math.random, opponentAction);
  const attacks = buildAttackRecords(result.events, { battleEpoch: epoch, turn });
  battle = result.state;
  sceneAssets.cancelPendingExcept(visualScene(battle), result.events.find(event => event.type === "switch")?.sceneBefore ?? visualScene(battle));
  // Plan during the switch; once the real send-out anchor exists, generate
  // the newcomer's following attack while recall/send-out are still playing.
  const planning = attacks.length ? requestAttackStoryboards(attacks, epoch, turn) : Promise.resolve(null);
  let prefetchedAttack = null;
  if (action.type !== "item" || attacks.some(attack => attack.blockedReason)) {
    const cursor = createCinemaEventCursor(result.events, attacks, event => applyPresentationEvent(event, epoch));
    let skipRemaining = false;
    const beforeApply = async event => {
      if (epoch !== battleEpoch || event.type !== "switch" || skipRemaining) return;
      const switchRun = await playSwitchEvent(event, epoch, { onPrepared: (job, owner) => {
        if (action.type !== "switch" || event.targetSide !== "player" || !attacks.length || prefetchedAttack
          || epoch !== battleEpoch || owner.controller.signal.aborted) return;
        const controller = new AbortController();
        owner.controller.signal.addEventListener("abort", () => {
          // A successful switch hands ownership to the following attack run.
          if (!owner.completed) controller.abort();
        }, { once: true });
        const body = planning.then(storyboard => {
          if (!storyboard || epoch !== battleEpoch) { controller.abort(); throw new DOMException("Aborted", "AbortError"); }
          const plan = createRealtimeStoryboard(attacks, storyboard.source === "deepseek" ? storyboard.plan : null, true);
          owner.mark("following_attack_requested");
          return { version: 2, battleEpoch: epoch, turn, attacks, sequence: plan.turn.sequence, language: owner.language,
            presentation: "inline-command-v1", commandBridge: false, sceneAnchorKey: job.key, continuationSessionId: null };
        });
        prefetchedAttack = { controller, promise: prefetchAttackSession(body, { signal: controller.signal }) };
      } });
      skipRemaining ||= Boolean(switchRun?.skipped);
    };
    if (attacks.length) await cursor.before(attacks[0].id, beforeApply);
    const storyboard = await planning;
    if (epoch !== battleEpoch) { prefetchedAttack?.controller.abort(); return; }
    if (!run && attacks.length && !skipRemaining) run = beginCinema("对手准备出招！", { bridge: false });
    if (storyboard && run && !run.controller.signal.aborted) {
      latestStoryboard = { ...storyboard, plan: createRealtimeStoryboard(attacks, storyboard.source === "deepseek" ? storyboard.plan : null, Boolean(prefetchedAttack) || run.commandBridge) };
      await requestAndPlayAttackVideos(latestStoryboard, attacks, epoch, turn, run, cursor, prefetchedAttack);
    } else {
      prefetchedAttack?.controller.abort();
    }
    if (epoch !== battleEpoch) return;
    skipRemaining ||= Boolean(run?.skipped);
    await cursor.finishAsync(beforeApply);
    if (epoch !== battleEpoch) return;
    finishTurnPresentation();
    return;
  }
  await planning;
  if (epoch !== battleEpoch) return;
  presentationBattle = null;
  await playEvents(result.events, epoch);
}

async function forceSwitch(teamIndex) {
  if (busy || battle.phase !== "must-switch") return;
  const epoch = battleEpoch;
  setBusy(true);
  presentationBattle = structuredClone(battle);
  const result = resolveForcedSwitch(battle, teamIndex);
  battle = result.state;
  for (const event of result.events) {
    if (event.type === "switch") await playSwitchEvent(event, epoch);
    if (epoch !== battleEpoch) return;
    applyPresentationEvent(event, epoch);
  }
  finishTurnPresentation();
}

function applyPresentationEvent(event, epoch) {
  if (epoch !== battleEpoch || !presentationBattle) return;
  if (event.text) setMessage(event.text, EVENT_LABELS[event.type] ?? "战况播报");
  if (event.type === "switch") {
    presentationBattle[event.targetSide].active = event.teamIndex;
    presentationBattle[event.targetSide].team[event.teamIndex] = structuredClone(event.incoming);
    updateCombatant(event.targetSide, event.incoming);
  }
  if (!event.targetSide) return;
  const visible = getActive(presentationBattle, event.targetSide);
  if (event.type === "damage" || event.type === "heal") visible.hp = event.currentHp;
  if (event.type === "faint") visible.hp = 0;
  if (event.clearedCondition === "confusion") visible.volatile.confusedTurns = 0;
  if (event.type === "status") {
    if (event.status === "confusion") visible.volatile.confusedTurns = 1;
    else visible.status = event.status;
  }
  updateStatusCard(event.targetSide, visible);
}

async function playSwitchEvent(event, epoch, { onPrepared = () => {} } = {}) {
  if (epoch !== battleEpoch) return null;
  sceneAssets.cancelPendingExcept(event.sceneAfter, event.sceneBefore);
  const run = beginCinema(event.text, { bridge: false, speak: event.targetSide === "player", trainer: event.targetSide === "player" ? "recall" : null });
  const signal = run.controller.signal;
  run.mark("switch_requested");
  setAttackVideoCopy("收回宝可梦", "准备收回演出，可跳过");
  try {
    const side = event.targetSide;
    const key = visualSceneKey(event.sceneBefore);
    const source = heldFrame?.sceneKey === key ? heldFrame.sceneAnchorKey ?? heldFrame.sourceAttack
      : key === defaultSceneKey ? "default" : sceneAssets.get(event.sceneBefore)?.idle?.key;
    const recallEntry = sceneAssets.getRecall(event.sceneBefore, side) ?? sceneAssets.warmRecall(event.sceneBefore, source, side);
    const recall = await waitForScene(recallEntry.done, signal);
    if (!recall) throw new Error("RECALL_NOT_READY");
    const recallVideo = dom.recallVideos[side];
    run.recallVideo = recallVideo;
    // The cached recall's actual tail is already a valid source. Submit while
    // the trainer raises the ball, not on the recall's first playback frame.
    const preparation = (async () => {
      run.mark("sendout_requested");
      const job = await requestSceneVideo({ kind: "sendout", before: event.sceneBefore, scene: event.sceneAfter, sourceKey: recall.key, language: run.language }, signal);
      if (signal.aborted || epoch !== battleEpoch || cinemaRun !== run) throw new DOMException("Aborted", "AbortError");
      warmSceneAssets(event.sceneAfter, job.key);
      run.mark("ambient_warm_started");
      onPrepared(job, run);
      const video = run.outgoing === dom.switchVideo ? dom.attackVideoPlayers[0] : dom.switchVideo;
      video.classList.remove("is-visible");
      await bufferVideo(video, job.videoUrl, signal);
      applyAttackVideoAudio(video);
      run.mark("sendout_buffered");
      return { job, video };
    })().then(value => ({ value }), error => ({ error }));
    await bufferVideo(recallVideo, recall.videoUrl, signal);
    applyAttackVideoAudio(recallVideo);
    await run.bridgeDone;
    const recallPlayback = playVideo(recallVideo, run.trainerOutgoing ?? run.outgoing, signal, {
      onFrame: () => {
        run.mark("recall_playing");
        setAttackVideoCopy("收回宝可梦", "放出动画正在后台生成");
      },
      onBlocked: () => { attackVideoAutoplayBlocked = true; renderAttackVideoSoundControl(); },
    });
    await recallPlayback.started;
    await recallPlayback.ended;
    run.mark("recall_ended");
    const prepared = await waitForScene(preparation, signal);
    if (prepared.error) throw prepared.error;
    if (epoch !== battleEpoch || signal.aborted) return run;
    const { job, video } = prepared.value;
    const playback = playVideo(video, recallVideo, signal, {
      onFrame: () => {
        run.mark("sendout_playing");
        run.recallVideo = null;
        sceneAssets.cancelPendingExcept(event.sceneAfter);
        const warmed = sceneAssets.get(event.sceneAfter);
        for (const kind of ["idle", "command"]) if (warmed?.[kind]) preloadSceneAsset(warmed, kind);
        setAttackVideoCopy("放出宝可梦", "新阵容待机、听令与收回素材正在后台准备");
      },
      onBlocked: () => { attackVideoAutoplayBlocked = true; renderAttackVideoSoundControl(); },
    });
    await playback.started;
    await playback.ended;
    heldFrame = { video, sceneKey: visualSceneKey(event.sceneAfter), sceneAnchorKey: job.key };
    run.mark("switch_ended");
    run.completed = true;
  } catch (error) {
    if (epoch === battleEpoch && error.name !== "AbortError") setStoryboardStatus("fallback", "登场动画未就绪 · 使用本地战场");
  } finally {
    run.controller.abort();
    if (cinemaRun === run) battleNarrator.stop();
  }
  return run;
}

function finishTurnPresentation() {
  cinemaRun?.controller.abort();
  cinemaRun?.releaseCommandAssets?.();
  presentationBattle = null;
  cinemaRun = null;
  attackVideoAbortController = null;
  battleNarrator.stop();
  setBusy(false);
  renderAll();
  if (battle.phase === "action") {
    showPanel("main");
    setMessage(`要让${getActive(battle, "player").name}做什么？`, "等待指令");
  } else if (battle.phase === "must-switch") showPanel("team");
}

dom.mainCommands.forEach((button) => {
  button.addEventListener("click", () => {
    if (busy) return;
    const command = button.dataset.command;
    if (command === "fight") showPanel("moves");
    if (command === "team") showPanel("team");
    if (command === "bag") showPanel("bag");
    if (command === "run") flashTemporaryMessage("训练家对战中不能逃跑！");
  });
});

dom.backButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!busy && battle.phase !== "must-switch") showPanel(button.dataset.back);
  });
});

dom.moveGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-move-index]");
  if (button && !button.disabled) takeTurn({ type: "move", moveIndex: Number(button.dataset.moveIndex) });
});

dom.teamList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-team-index]");
  if (!button || button.disabled) return;
  const teamIndex = Number(button.dataset.teamIndex);
  if (battle.phase === "must-switch") forceSwitch(teamIndex);
  else takeTurn({ type: "switch", teamIndex });
});

dom.bagList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-item-id]");
  if (button && !button.disabled) takeTurn({ type: "item", itemId: button.dataset.itemId, teamIndex: battle.player.active });
});

document.addEventListener("keydown", (event) => {
  if (event.target.closest?.("select, input, textarea, [contenteditable=true]")) return;
  if (busy || dom.rules.open || dom.storyboard.open || dom.attackVideo.open || battle.phase === "complete") return;
  if (event.key === "Escape" && battle.phase !== "must-switch" && activePanel !== "main") {
    showPanel("main");
    return;
  }
  if (!/^[1-4]$/.test(event.key)) return;
  event.preventDefault();
  const index = Number(event.key) - 1;
  const panelAtKeydown = activePanel;
  if (panelAtKeydown === "main") dom.mainCommands[index]?.click();
  else if (panelAtKeydown === "moves") dom.moveGrid.querySelectorAll("[data-move-index]")[index]?.click();
  else if (panelAtKeydown === "team") dom.teamList.querySelectorAll("[data-team-index]")[index]?.click();
});

dom.rulesButton.addEventListener("click", () => dom.rules.showModal());
dom.languageSelect.addEventListener("change", changeLanguage);
dom.storyboardButton.addEventListener("click", () => dom.storyboard.showModal());
dom.storyboardStatus.addEventListener("click", () => dom.storyboard.showModal());
dom.attackVideoSound.addEventListener("click", toggleAttackVideoSound);
dom.attackVideoSkip.addEventListener("click", cancelAttackVideoSession);
dom.resetButton.addEventListener("click", restartBattle);
dom.resultReset.addEventListener("click", restartBattle);
dom.idleBattleVideo.addEventListener("error", () => {
  idleBattleVideoFailed = true;
  renderBattlefield();
  retryIdleVideoLoad();
});
dom.idleBattleVideo.addEventListener("canplay", () => { if (!busy) renderBattlefield(); });
idleVideoViewport.addEventListener("change", renderBattlefield);
restartBattle();
