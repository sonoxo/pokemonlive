import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { playTrainerCutIn } from "../src/trainer-cut-in.js";
import { BattleNarrator } from "../src/battle-narrator.js";
import { createBattle } from "../src/battle-engine.js";
import { visualScene, visualSceneKey } from "../src/visual-battle-state.js";
import { waitForScene } from "../src/scene-video-client.js";

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
class Video extends EventTarget {
  constructor() { super(); this.readyState = 4; this.currentTime = 0; this.style = {}; this.classes = new Set(); this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c) }; }
  getAttribute() { return "local-trainer.mp4"; }
  setAttribute() {}
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  requestVideoFrameCallback(callback) { this.frame = callback; return 1; }
  cancelVideoFrameCallback() { this.frame = null; }
}

test("训练家本地视频保留旧画面到真实首帧，并保留自己的尾帧等待下一镜", async () => {
  const video = new Video(), old = new Video(), marks = [];
  old.classes.add("is-visible");
  const clip = playTrainerCutIn(video, old, new AbortController().signal, { onMark: name => marks.push(name) });
  await flush();
  assert(old.classes.has("is-visible")); assert(!video.classes.has("is-visible"));
  video.frame(); await clip.started;
  assert(video.classes.has("is-visible")); assert(!old.classes.has("is-visible")); assert(video.muted);
  video.dispatchEvent(new Event("ended"));
  assert.equal(await clip.ended, video);
  assert(video.classes.has("is-visible"));
  assert.deepEqual(marks, ["trainer_playing", "trainer_ended"]);
});

test("训练家视频失败可退回原流程，跳过后迟到首帧不得抢播", async () => {
  for (const mode of ["error", "abort"]) {
    const video = new Video(), old = new Video(), controller = new AbortController();
    old.classes.add("is-visible");
    const clip = playTrainerCutIn(video, old, controller.signal);
    await flush(); const late = video.frame;
    if (mode === "error") {
      video.dispatchEvent(new Event("error"));
      await clip.started; assert.equal(await clip.ended, old);
    } else {
      controller.abort();
      await assert.rejects(clip.started, { name: "AbortError" });
      await assert.rejects(clip.ended, { name: "AbortError" });
    }
    late(); assert(old.classes.has("is-visible")); assert(!video.classes.has("is-visible"));
  }
});

test("声音提前下载但等训练家真实首帧才播；结束或取消只释放一次门禁", async () => {
  for (const cancel of [false, true]) {
    const gate = defer(), controller = new AbortController(); let started = 0, finished = 0;
    const context = { state: "running", resume: async () => {}, destination: {}, decodeAudioData: async () => ({}),
      createBufferSource: () => ({ connect() {}, disconnect() {}, start() { started++; }, stop() {} }) };
    const voice = new BattleNarrator({ createContext: () => context,
      fetchImpl: async () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "audio/mpeg" } }) });
    await voice.speak("皮卡丘，使用十万伏特！", { signal: controller.signal, playAfter: gate.promise, onEnd: () => finished++ });
    assert.equal(started, 0);
    if (cancel) controller.abort();
    gate.resolve(); await flush();
    assert.equal(started, cancel ? 0 : 1);
    if (!cancel) voice.current.source.onended();
    voice.stop(); assert.equal(finished, 1);
  }
});

test("实际换人：举球未结束已请求放出；放出ready即预热新阵容，收回不抢先播放", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.slice(app.indexOf("async function playSwitchEvent("), app.indexOf("function finishTurnPresentation("));
  const battle = createBattle(), before = visualScene(battle); battle.player.active = 1;
  const after = visualScene(battle), trainer = new Video(), recall = new Video(), sendout = new Video();
  const gate = defer(), generated = defer(), recallEnd = defer(), marks = [], preloads = [];
  const run = { controller: new AbortController(), outgoing: null, trainerOutgoing: trainer, bridgeDone: gate.promise, mark: name => marks.push(name) };
  const warmed = { scene: after, idle: {}, command: {} };
  const deps = {
    battleEpoch: 1, sceneAssets: { cancelPendingExcept() {}, get: () => warmed, getRecall: () => ({ done: Promise.resolve({ key: "a".repeat(64), videoUrl: "recall.mp4" }) }) },
    beginCinema: () => run, setAttackVideoCopy() {}, visualSceneKey, defaultSceneKey: visualSceneKey(before), heldFrame: null, cinemaRun: run,
    waitForScene, dom: { recallVideos: { player: recall }, switchVideo: sendout, attackVideoPlayers: [] },
    bufferVideo: async () => {}, applyAttackVideoAudio() {},
    requestSceneVideo: input => { assert.equal(input.sourceKey, "a".repeat(64)); marks.push("sendout_post"); return generated.promise; },
    warmSceneAssets: (scene, key) => { assert.deepEqual(scene, after); assert.equal(key, "b".repeat(64)); marks.push("warm_assets"); },
    preloadSceneAsset: (entry, kind) => { assert.equal(entry, warmed); preloads.push(kind); },
    playVideo: (video, old, signal, hooks) => {
      assert.equal(old, video === recall ? trainer : recall);
      hooks.onFrame();
      return { started: Promise.resolve(), ended: video === recall ? recallEnd.promise : Promise.resolve() };
    },
    setStoryboardStatus() {}, battleNarrator: { stop() {} },
  };
  const play = new Function(...Object.keys(deps), `${body};return playSwitchEvent;`)(...Object.values(deps));
  const task = play({ targetSide: "player", text: "换人", sceneBefore: before, sceneAfter: after }, 1);
  await flush(); assert(marks.includes("sendout_post")); assert(!marks.includes("recall_playing"));
  generated.resolve({ key: "b".repeat(64), videoUrl: "sendout.mp4" }); await flush();
  assert(marks.includes("warm_assets")); assert(marks.includes("sendout_buffered")); assert(!marks.includes("recall_playing"));
  gate.resolve(); await flush(); assert(marks.includes("recall_playing"));
  recallEnd.resolve(); await task;
  assert(marks.includes("sendout_playing")); assert.deepEqual(preloads, ["idle", "command"]);
});

test("两段固定文生视频直接预载在原舞台，不作为宝可梦生成参考", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const mode of ["command", "recall"]) assert.match(html, new RegExp(`id="trainer-${mode}-video" src="assets/video/trainer-${mode}-v1.mp4" playsinline muted preload="auto"`));
  assert(app.indexOf("let preparation = prepare(0)") < app.indexOf("await run.bridgeDone"));
  assert.match(app, /commandBridge: run.commandBridge && !run.sceneAnchorKey/);
  assert.doesNotMatch(app, /sourceKey:.*trainer|image_url:.*trainer/);
});

test("提前预热新收回片不能覆盖举球期间已保留的旧收回槽，但不阻挡另一侧", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.slice(app.indexOf("function preloadSceneAsset("), app.indexOf("function bindSceneVideos("));
  const battle = createBattle(); battle.player.active = 1;
  const scene = visualScene(battle);
  const video = () => ({ src: "old-pikachu-recall.mp4", dataset: {}, loads: 0, classList: { contains: () => false }, load() { this.loads++; } });
  const player = video(), opponent = video();
  const run = { recallVideo: player };
  const dom = { recallVideos: { player, opponent } };
  const preload = new Function("battle", "visualScene", "visualSceneKey", "dom", "busy", "cinemaRun", `${body};return preloadSceneAsset;`)(battle, visualScene, visualSceneKey, dom, true, run);
  const entry = { scene, side: "player", job: { videoUrl: "new-squirtle-recall.mp4" } };
  preload(entry, "recall");
  assert.equal(player.src, "old-pikachu-recall.mp4"); assert.equal(player.loads, 0);
  preload({ ...entry, side: "opponent" }, "recall"); assert.equal(opponent.loads, 1);
  run.recallVideo = null;
  preload(entry, "recall");
  assert.equal(player.src, "new-squirtle-recall.mp4"); assert.equal(player.loads, 1);
});
