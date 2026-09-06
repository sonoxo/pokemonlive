import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBattle } from "../src/battle-engine.js";
import { visualScene, visualSceneKey } from "../src/visual-battle-state.js";
import { SceneAssetCache, waitForScene } from "../src/scene-video-client.js";
import { prepareCommandBridge } from "../src/command-bridge-preparation.js";

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const scene = visualScene(createBattle());
const jobFor = (value = scene, key = "a".repeat(64)) => ({ kind: "command", language: "zh", scene: value, key, videoUrl: `/media/${key}.mp4` });
class Video extends EventTarget {
  constructor() {
    super(); this.dataset = {}; this.readyState = 0; this.loads = 0; this.error = null;
    this.classList = { contains: () => false }; this.src = "";
  }
  getAttribute(name) { return this[name]; }
  load() { this.loads++; this.readyState = 0; }
  decode() { this.readyState = 4; this.dispatchEvent(new Event("canplay")); }
}
function binding(video, job) {
  if (video.src !== job.videoUrl) {
    video.src = job.videoUrl;
    video.dataset.sceneKey = visualSceneKey(job.scene);
    video.dataset.assetKey = job.key;
    video.load();
  }
}

test("听令在剪影期间下载及解码完成即选定，结束检查不会更换攻击首帧锚点", async () => {
  const video = new Video(), controller = new AbortController();
  let job = null;
  const prep = prepareCommandBridge({ video, scene, language: "zh", getJob: () => job, bind: value => binding(video, value), signal: controller.signal });
  let selection;
  prep.ready.then(value => { selection = value; });
  job = jobFor(); prep.check(); await tick();
  assert.equal(selection, undefined, "下载完成但未解码不能抢播");
  video.decode(); await tick();
  assert.deepEqual(selection, { key: job.key, videoUrl: job.videoUrl });
  job = jobFor(scene, "b".repeat(64));
  prep.finish(); prep.check();
  assert.equal(video.dataset.assetKey, "a".repeat(64), "一经选定，迟到任务不得更换首帧来源");
  assert.equal(video.loads, 1);
});

test("剪影结束时最后一次检查就绪，超出窗口的听令不抢占既定兜底", async () => {
  for (const readyAtBoundary of [true, false]) {
    const video = new Video(), controller = new AbortController(), job = jobFor();
    let current = null;
    const prep = prepareCommandBridge({ video, scene, language: "zh", getJob: () => current, bind: value => binding(video, value), signal: controller.signal });
    if (readyAtBoundary) { current = job; binding(video, job); video.readyState = 3; }
    prep.finish();
    assert.deepEqual(await prep.ready, readyAtBoundary ? { key: job.key, videoUrl: job.videoUrl } : null);
    current = job; prep.check(); video.decode();
    assert.equal(video.loads, readyAtBoundary ? 1 : 0);
  }
});

test("听令可反复复用；旧语言、旧阵容、错误解码均不被选中，取消后不再绑定", async () => {
  const video = new Video(), job = jobFor(); binding(video, job); video.decode();
  for (let attack = 0; attack < 2; attack++) {
    const controller = new AbortController();
    const prep = prepareCommandBridge({ video, scene, language: "zh", getJob: () => job, bind: value => binding(video, value), signal: controller.signal });
    assert.equal((await prep.ready).key, job.key);
    controller.abort();
  }
  assert.equal(video.loads, 1, "第二次出招不重新下载或重置已解码素材");
  for (const bad of [{ ...job, language: "ja" }, { ...job, scene: { ...scene, opponent: { ...scene.opponent, status: "freeze" } } }, { ...job, kind: "idle" }]) {
    const prep = prepareCommandBridge({ video, scene, language: "zh", getJob: () => bad, bind: () => assert.fail("错误素材不可绑定"), signal: new AbortController().signal });
    prep.finish(); assert.equal(await prep.ready, null);
  }
  video.error = new Error("decode failed");
  const failed = prepareCommandBridge({ video, scene, language: "zh", getJob: () => job, bind() {}, signal: new AbortController().signal });
  failed.finish(); assert.equal(await failed.ready, null);
  const controller = new AbortController(); controller.abort();
  const aborted = prepareCommandBridge({ video, scene, language: "zh", getJob: () => job, bind: () => assert.fail("取消后不能绑定"), signal: controller.signal });
  await assert.rejects(aborted.ready, { name: "AbortError" });
  aborted.check(); aborted.finish();
});

test("当前演出引用保护听令及收回，不妨碍下一状态预热；释放或取消后恢复清理", async () => {
  const pending = [];
  const cache = new SceneAssetCache({ request: (input, signal) => {
    const gate = defer(); pending.push({ input, signal, gate });
    return waitForScene(gate.promise, signal);
  } });
  const next = { ...scene, opponent: { ...scene.opponent, status: "freeze" } };
  const run = new AbortController(), otherConsumer = new AbortController();
  const release = cache.retain(scene, run.signal);
  cache.retain(scene, otherConsumer.signal);
  const current = cache.warm(scene, "default", { skipIdle: true });
  const recall = cache.warmRecall(scene, "default", "player");
  const future = cache.warm(next, "b".repeat(64));
  cache.cancelPendingExcept(next);
  assert.equal(pending.length, 4, "当前和下一状态保持并发");
  assert(pending.every(call => !call.signal.aborted));
  release(); release(); cache.cancelPendingExcept(next);
  assert.equal(current.controller.signal.aborted, false, "另一演出仍持有引用");
  otherConsumer.abort(); cache.cancelPendingExcept(next);
  assert(current.controller.signal.aborted);
  assert(recall.controller.signal.aborted);
  assert(!future.controller.signal.aborted);
  assert.equal(cache.retainedScenes.size, 0);
  cache.cancelPendingExcept();
  await Promise.all([current.done, recall.done, future.done]);
});

async function appHarness() {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const begin = app.slice(app.indexOf("function beginCinema("), app.indexOf("async function pollAttackVideoClip("));
  const preload = app.slice(app.indexOf("function preloadSceneAsset("), app.indexOf("function retryIdleVideoLoad("));
  const trainer = defer(), commandEnd = defer(), requests = [], plays = [];
  const state = createBattle(); state.player.active = 1; state.opponent.active = 1;
  const initial = visualScene(state), video = new Video(), trainerVideo = {};
  let bound;
  const cache = new SceneAssetCache({ onReady: (entry, kind) => bound.preloadSceneAsset(entry, kind), request: (input, signal) => {
    const gate = defer(); requests.push({ input, signal, gate }); return waitForScene(gate.promise, signal);
  } });
  cache.warm(initial, "c".repeat(64), { skipIdle: true });
  const deps = {
    attackVideoAbortController: null, battleEpoch: 1, cinemaRun: null, attackVideoAutoplayBlocked: false,
    renderAttackVideoSoundControl() {}, setAttackVideoCopy() {}, setMessage() {},
    visualSceneKey, visualScene, presentationBattle: null, battle: state, heldFrame: null,
    sceneAssets: cache, defaultSceneKey: visualSceneKey(scene), prepareCommandBridge, waitForScene,
    attackVideoSoundEnabled: false, battleNarrator: { stop() {} },
    abortableDelay: () => Promise.resolve(), applyAttackVideoAudio() {}, busy: true,
    dom: { languageSelect: { value: "zh" }, attackVideo: {}, cinemaControls: {},
      stage: { classList: { add() {} } }, commandBridge: video, trainerVideos: { command: trainerVideo } },
    playTrainerCutIn: () => ({ started: Promise.resolve(), ended: trainer.promise }),
    playVideo: (incoming, outgoing, signal, hooks) => {
      plays.push({ src: incoming.src, outgoing }); hooks.onFrame();
      return { started: Promise.resolve(), ended: waitForScene(commandEnd.promise, signal) };
    },
  };
  bound = new Function(...Object.keys(deps), `${begin}\n${preload}\nreturn {beginCinema, preloadSceneAsset, bindSceneVideos};`)(...Object.values(deps));
  const run = bound.beginCinema("杰尼龟，使用水枪！");
  // Rules resolve immediately; the presentation still requires the old state.
  state.opponent.team[1].status = "freeze";
  const final = visualScene(state);
  cache.cancelPendingExcept(final);
  return { bound, run, trainer, commandEnd, requests, plays, video, cache, initial, final, trainerVideo };
}

test("真实 beginCinema：换人后规则结算到冰冻，旧状态听令仍能在剪影内就绪并衔接", async () => {
  const h = await appHarness();
  assert.equal(h.requests.length, 1, "复用换人时启动的预热，不重复生成");
  assert(!h.requests[0].signal.aborted, "规则的未来状态不能取消当前所需听令");
  const job = jobFor(h.initial);
  h.requests[0].gate.resolve(job); await h.cache.get(h.initial).done;
  assert.equal(h.video.src, job.videoUrl, "当前状态任务迟到也预载，不被未来状态过滤");
  h.video.decode(); await h.run.openingReady;
  assert.equal(h.run.sceneAnchorKey, job.key);
  assert.equal(h.run.commandBridge, true);
  assert.equal(h.plays.length, 0, "剪影未结束前不抢播听令");
  h.bound.bindSceneVideos(h.final, null, "/future.mp4", "b".repeat(64));
  assert.equal(h.video.src, job.videoUrl, "下一状态素材不能偷换保留的听令槽");
  h.trainer.resolve(h.trainerVideo); await tick();
  assert.equal(h.plays.length, 1);
  assert.equal(h.plays[0].src, job.videoUrl);
  assert.equal(h.plays[0].outgoing, h.trainerVideo);
  h.commandEnd.resolve(); await h.run.bridgeDone;
  h.run.releaseCommandAssets();
  assert.equal(h.cache.retainedScenes.size, 0);
  h.bound.bindSceneVideos(h.final, null, "/future.mp4", "b".repeat(64));
  assert.equal(h.video.src, "/future.mp4", "首段攻击接管后才允许下一状态绑定");
  h.run.controller.abort();
});

test("真实 beginCinema：剪影结束仍未就绪则原锚点兜底；取消则解除待选及缓存保护", async () => {
  for (const abort of [false, true]) {
    const h = await appHarness();
    if (abort) {
      h.run.controller.abort(); h.trainer.resolve(h.trainerVideo);
      await assert.rejects(h.run.openingReady, { name: "AbortError" });
      await assert.rejects(h.run.bridgeDone, { name: "AbortError" });
      assert.equal(h.cache.retainedScenes.size, 0);
    } else {
      h.trainer.resolve(h.trainerVideo); await h.run.bridgeDone;
      assert.equal(h.run.commandBridge, false);
      assert.equal(h.run.sceneAnchorKey, null);
      h.requests[0].gate.resolve(jobFor(h.initial)); await h.cache.get(h.initial).done;
      h.video.decode(); await tick();
      assert.equal(h.plays.length, 0, "攻击锚点已决定，不补播超出窗口的听令");
      h.run.controller.abort();
    }
    h.run.releaseCommandAssets(); h.cache.cancelPendingExcept();
  }
});

test("真实攻击请求在规划早于听令时等共享选择；一就绪即在剪影结束前提交同一 key", async () => {
  for (const abort of [false, true]) {
    const h = await appHarness();
    const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
    const body = app.slice(app.indexOf("async function requestAndPlayAttackVideos("), app.indexOf("function updateStatusCard("));
    const posts = [];
    const deps = {
      battleEpoch: 1, cinemaRun: h.run, activeVideoSessionId: null, activeVideoClipIndex: null, attackVideoAbortController: null,
      waitForScene, battleNarrator: { stop() {} },
      fetch: async (url, options) => {
        posts.push({ url, input: JSON.parse(options.body) });
        // Stop after the real POST boundary, without buying or playing a clip.
        throw new DOMException("offline test complete", "AbortError");
      },
    };
    const play = new Function(...Object.keys(deps), `${body}; return requestAndPlayAttackVideos;`)(...Object.values(deps));
    const done = play({ plan: { turn: { sequence: [] } } }, [], 1, 2, h.run, {});
    await tick(); assert.equal(posts.length, 0);
    if (abort) h.run.controller.abort();
    else {
      h.requests[0].gate.resolve(jobFor(h.initial)); await h.cache.get(h.initial).done;
      await tick(); assert.equal(posts.length, 0, "服务端ready但浏览器未decode，不能用错锚点提交");
      h.video.decode();
    }
    await done;
    assert.equal(posts.length, abort ? 0 : 1);
    if (!abort) {
      assert.equal(posts[0].input.sceneAnchorKey, "a".repeat(64));
      assert.equal(posts[0].input.continuationSessionId, null);
      assert.equal(h.plays.length, 0, "不必等剪影和听令播放完才提交攻击");
    }
    assert.equal(h.cache.retainedScenes.size, 0);
    h.trainer.resolve(h.trainerVideo);
    await assert.rejects(h.run.bridgeDone, { name: "AbortError" });
  }
});
