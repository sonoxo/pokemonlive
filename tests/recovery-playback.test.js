import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBattle, resolveTurn, getActive } from "../src/battle-engine.js";
import { buildAttackRecords, createRealtimeStoryboard } from "../src/attack-storyboard.js";
import { battleRecoveryState } from "../src/battle-recovery.js";
import { visualScene, visualSceneKey, attackVisualScene } from "../src/visual-battle-state.js";
import { waitForScene } from "../src/scene-video-client.js";
import { supportsDefaultIdleVideo } from "../src/idle-battle-video.js";
import { AttackVideoPlayer } from "../src/attack-video-player.js";

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({ realPlayer = false, failFirst = false, failRecovery = false } = {}) {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.slice(app.indexOf("async function requestAndPlayAttackVideos("), app.indexOf("function updateStatusCard("));
  const result = resolveTurn(createBattle(), { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 });
  const attacks = buildAttackRecords(result.events), plan = createRealtimeStoryboard(attacks);
  const lastAttack = defer(), recovery = defer(), requested = defer(), plays = [], impacts = [], marks = [], statuses = [];
  const run = { controller: new AbortController(), epoch: 1, bridgeDone: Promise.resolve(), events: [], startedAt: performance.now(),
    mark: name => marks.push(name) };
  const firstReady = defer(), decoded = [], recoverySignals = [];
  class Video extends EventTarget {
    constructor() {
      super(); this.readyState = 0; this.currentTime = 0; this.style = {}; this.classes = new Set();
      this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c) };
    }
    setAttribute() {}
    getAttribute(name) { return this[name]; }
    load() {
      decoded.push({ src: this.src, plays: marks.filter(name => name === "clip_playing").length });
      queueMicrotask(() => { this.readyState = 3; this.dispatchEvent(new Event("canplay")); });
    }
    pause() { this.paused = true; }
    play() {
      this.paused = false;
      queueMicrotask(() => {
        this.frame?.();
        if ((failFirst && this.src === "/attacks/0.mp4") || (failRecovery && this.src === "/recovery.mp4")) this.dispatchEvent(new Event("error"));
        else if (this.src === `/attacks/${plan.turn.sequence.length - 1}.mp4`) lastAttack.promise.then(() => this.dispatchEvent(new Event("ended")));
        else queueMicrotask(() => this.dispatchEvent(new Event("ended")));
      });
      return Promise.resolve();
    }
    requestVideoFrameCallback(fn) { this.frame = fn; return 1; }
    cancelVideoFrameCallback() { this.frame = null; }
  }
  const videos = realPlayer ? [new Video(), new Video(), new Video()] : [];
  if (realPlayer) { run.outgoing = videos[2]; videos[2].src = "old-held.mp4"; videos[2].classes.add("is-visible"); }
  class Player {
    constructor(options) { Object.assign(this, options); this.cache = new Map(); }
    prepare(index) {
      if (!this.cache.has(index)) this.cache.set(index, this.waitForClip(index).then(value => ({ value: { ...value, video: { index } } }), error => ({ error })));
      return this.cache.get(index);
    }
    play(item, outgoing, hooks) {
      plays.push({ index: item.clip.index, outgoing }); hooks.onFrame();
      const ended = item.clip.index === plan.turn.sequence.length - 1 ? waitForScene(lastAttack.promise, this.signal) : Promise.resolve();
      ended.catch(() => {});
      return { started: Promise.resolve(), ended };
    }
  }
  const deps = {
    battleEpoch: 1, cinemaRun: run, activeVideoSessionId: null, activeVideoClipIndex: null, attackVideoAbortController: null,
    dom: { attackVideoPlayers: videos, stage: { classList: { contains: () => false } } },
    AttackVideoPlayer: realPlayer ? AttackVideoPlayer : Player, applyAttackVideoAudio() {},
    battleRecoveryState, visualSceneKey, attackVisualScene, waitForScene,
    pollAttackVideoClip: async (_run, index) => {
      if (realPlayer && index === 0) await firstReady.promise;
      return { clip: { index, localVideoUrl: `/attacks/${index}.mp4`, videoUrl: `https://cdn.example/${index}.mp4` }, session: {} };
    },
    requestSceneVideo: async (input, signal) => { recoverySignals.push(signal); requested.resolve(input); return waitForScene(recovery.promise, signal); },
    fetch: async () => ({ ok: true }), clipGapMetrics: () => null, warmAfterAttack() {},
    renderAttackVideoSession() {}, setAttackVideoCopy() {}, BLOCKED_REASON_LABELS: {},
    attackVideoAutoplayBlocked: false, renderAttackVideoSoundControl() {}, heldFrame: null,
    setStoryboardStatus: (...args) => statuses.push(args), latestStoryboard: {}, renderStoryboardDetails() {},
    battleNarrator: { stop() {} }, cancelRemoteAttackVideoSession() {},
  };
  const bound = new Function(...Object.keys(deps), `${body}; return { play: requestAndPlayAttackVideos, held: () => heldFrame };`)(...Object.values(deps));
  const cursor = { start() {}, impact: id => impacts.push(id) };
  const done = bound.play({ plan }, attacks, 1, 1, run, cursor, {
    controller: new AbortController(), promise: Promise.resolve({ ok: true, session: { id: "11111111-1111-4111-8111-111111111111" } }),
  });
  return { bound, done, requested, recovery, lastAttack, run, impacts, plays, marks, statuses, attacks, plan, firstReady, decoded, videos, recoverySignals };
}

test("流式收尾经 CDN 备用正常播完不误取消未完归档；跳过仍中止收尾任务", async () => {
  for (const cancel of [false, true]) {
    const h = await harness({ realPlayer: true, failRecovery: true });
    const input = await h.requested.promise;
    h.recovery.resolve({ kind: "recovery", scene: input.scene, key: "a".repeat(64), streamable: true, playable: false,
      videoUrl: "/recovery.mp4", fallbackVideoUrl: "https://cdn.example/recovery.mp4" });
    h.firstReady.resolve(); await tick();
    if (cancel) h.run.controller.abort();
    h.lastAttack.resolve(); await h.done;
    assert(h.run.controller.signal.aborted, "页面播放器完成/取消后均清理");
    assert.equal(h.recoverySignals[0].aborted, cancel, "不能把正常播放器清理当成取消已付费收尾");
    if (!cancel) {
      assert(h.decoded.some(item => item.src === "https://cdn.example/recovery.mp4"));
      assert(h.marks.includes("complete")); assert.equal(h.bound.held().sceneAnchorKey, "a".repeat(64));
    }
  }
});

test("真实三槽播放器：末段乱序先 ready、旧尾帧占槽时，收尾只生成不抢首段或故障恢复槽", async () => {
  for (const failFirst of [false, true]) {
    const h = await harness({ realPlayer: true, failFirst });
    const input = await h.requested.promise;
    h.recovery.resolve({ kind: "recovery", scene: input.scene, key: "a".repeat(64), videoUrl: "/recovery.mp4" });
    await tick();
    assert(h.videos[2].classes.has("is-visible"));
    assert(!h.decoded.some(item => item.src === "/recovery.mp4"), "提前生成完成也不能占解码槽");
    h.firstReady.resolve(); await tick();
    assert.equal(h.marks.filter(name => name === "clip_playing").length, 2, "首段及末段均能起播，不死锁");
    assert(h.decoded.some(item => item.src === "/recovery.mp4" && item.plays === 2));
    if (failFirst) assert(h.marks.includes("local_playback_fallback"), "首段备用播放槽仍然可用");
    h.lastAttack.resolve(); await h.done;
    assert(h.marks.includes("complete"));
    assert.equal(h.impacts.length, 2);
  }
});

test("实际攻击播放入口在末段结束前请求收尾，迟到时保留尾帧，收尾不再次应用伤害", async () => {
  const h = await harness(); const input = await h.requested.promise;
  await tick();
  assert.equal(input.kind, "recovery"); assert.equal(input.sourceAttack.clipIndex, h.plan.turn.sequence.length - 1);
  assert.deepEqual(input.health, battleRecoveryState(h.attacks.at(-1)).health);
  assert(!h.marks.includes("complete"));
  h.lastAttack.resolve(); await tick();
  assert.equal(h.bound.held().video.index, h.plan.turn.sequence.length - 1);
  assert(!h.marks.includes("recovery_playing"));
  h.recovery.resolve({ kind: "recovery", scene: input.scene, key: "a".repeat(64), videoUrl: "/recovery.mp4" });
  await h.done;
  assert.equal(h.impacts.length, h.plan.turn.sequence.length, "收尾没有额外伤害结算");
  assert(h.marks.indexOf("recovery_requested") < h.marks.lastIndexOf("clip_ended"));
  assert(h.marks.indexOf("recovery_requested") < h.marks.lastIndexOf("clip_playing"), "末段提前生成好时不等起播才请求收尾");
  assert(h.marks.indexOf("recovery_ended") < h.marks.indexOf("complete"));
  assert.equal(h.bound.held().sceneAnchorKey, "a".repeat(64));
  assert.equal(h.plays.at(-1).outgoing.index, h.plan.turn.sequence.length - 1);
});

test("实际收尾生成失败保留攻击尾帧和战斗结果，取消等待不播放迟到视频", async () => {
  for (const cancel of [false, true]) {
    const h = await harness(); const input = await h.requested.promise;
    h.lastAttack.resolve(); await tick();
    if (cancel) h.run.controller.abort(); else h.recovery.reject(new Error("provider failed"));
    await h.done;
    h.recovery.resolve({ kind: "recovery", scene: input.scene, key: "a".repeat(64), videoUrl: "/late.mp4" }); await tick();
    assert(!h.marks.includes("recovery_playing"));
    assert(!h.marks.includes("complete"));
    assert(h.marks.includes(cancel ? "cancelled" : "failed"));
    assert.equal(h.bound.held().video.index, h.plan.turn.sequence.length - 1);
    assert.equal(h.impacts.length, h.plan.turn.sequence.length);
  }
});

test("回合末毒伤致 KO：收尾保持末行动活着状态，不为即将被换掉的旧阵容预热待机", async () => {
  const battle = createBattle(); battle.opponent.team[0].hp = 2; battle.opponent.team[0].status = "poison";
  // Non-damaging moves leave the poisoned combatant alive until residual damage.
  const result = resolveTurn(battle, { type: "move", moveIndex: 2 }, () => .5, { type: "move", moveIndex: 1 });
  const attacks = buildAttackRecords(result.events), plan = createRealtimeStoryboard(attacks);
  const recovery = battleRecoveryState(attacks.at(-1));
  assert.equal(recovery.health.opponent.currentHp, 2); assert.equal(recovery.scene.opponent.fainted, false);
  assert.equal(result.state.opponent.team[0].hp, 0);
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.slice(app.indexOf("function warmAfterAttack("), app.indexOf("function preloadSceneAsset("));
  const calls = [];
  const warm = new Function("battle", "battleEpoch", "visualScene", "visualSceneKey", "attackVisualScene", "getActive", "supportsDefaultIdleVideo", "warmSceneAssets", `${body}; return warmAfterAttack;`)(
    result.state, 1, visualScene, visualSceneKey, attackVisualScene, getActive, supportsDefaultIdleVideo, (...args) => calls.push(args));
  warm(plan.turn.sequence.at(-1), attacks, { epoch: 1, controller: new AbortController(), mark() {} }, plan.turn.sequence.length - 1);
  assert.equal(calls.length, 0);
  const playback = app.slice(app.indexOf("async function requestAndPlayAttackVideos("), app.indexOf("function updateStatusCard("));
  assert.doesNotMatch(playback, /warmSceneAssets\(/, "收尾不绕过现有最终状态预热门禁");
});
