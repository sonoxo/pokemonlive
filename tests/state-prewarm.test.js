import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBattle, resolveTurn, getActive } from "../src/battle-engine.js";
import { buildAttackRecords, createRealtimeStoryboard } from "../src/attack-storyboard.js";
import { visualScene, visualSceneKey, attackVisualScene } from "../src/visual-battle-state.js";
import { supportsDefaultIdleVideo } from "../src/idle-battle-video.js";
import { sceneVideoSpec } from "../src/scene-video-service.js";
import { SceneAssetCache, waitForScene } from "../src/scene-video-client.js";
import { sanitizeAttackSource, sceneAfterBeat, loadAttackSceneAnchor } from "../src/attack-scene-anchor.js";
import { bufferVideo } from "../src/inline-cinema.js";

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const source = { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 };
const paralyzedTurn = () => resolveTurn(createBattle(), { type: "move", moveIndex: 2 }, () => .5, { type: "move", moveIndex: 0 });

test("状态预热可引用单段战斗尾帧，拒绝任意 URL、越界及混合来源", () => {
  const scene = visualScene(paralyzedTurn().state);
  assert.equal(scene.opponent.status, "paralysis");
  assert.deepEqual(sceneVideoSpec({ kind: "idle", scene, sourceAttack: source }).sourceAttack, source);
  assert.match(sceneVideoSpec({ kind: "idle", scene, sourceAttack: source }).prompt, /Both full bodies visible/);
  assert.match(sceneVideoSpec({ kind: "idle", scene, sourceAttack: source }).prompt, /NEVER end on a close-up/);
  assert.notEqual(sceneVideoSpec({ kind: "idle", scene, sourceAttack: source }).key, sceneVideoSpec({ kind: "idle", scene, sourceKey: "a".repeat(64) }).key);
  for (const bad of [{ ...source, clipIndex: -1 }, { ...source, clipIndex: 4 }, { ...source, sessionId: "../../etc" }, { videoUrl: "https://example.com/video.mp4" }]) assert.throws(() => sanitizeAttackSource(bad));
  assert.throws(() => sceneVideoSpec({ kind: "idle", scene, sourceKey: "a".repeat(64), sourceAttack: source }), /只能选一个/);
});

test("第一段 ready 就能共享其归档尾帧，不必等第二段生成结束", async () => {
  const result = paralyzedTurn();
  const attacks = buildAttackRecords(result.events);
  const scene = attackVisualScene(attacks[0], true);
  const gate = defer();
  const continuity = new Map([[source.sessionId, { clips: [{ scene, tail: gate.promise }] }]]);
  const options = { continuity, runway: { get: () => ({ status: "generating", clips: [{ status: "ready" }, { status: "generating" }] }) } };
  const controller = new AbortController();
  const cancelled = loadAttackSceneAnchor(source, scene, controller.signal, options);
  const surviving = loadAttackSceneAnchor(source, scene, new AbortController().signal, options);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  gate.resolve("data:image/jpeg;base64,dGFpbA==");
  assert.equal(await surviving, "data:image/jpeg;base64,dGFpbA==");
  assert.equal(await loadAttackSceneAnchor(source, visualScene(createBattle()), null, options), null);
  assert.equal(await loadAttackSceneAnchor({ ...source, clipIndex: 1 }, scene, null, options), null);
});

test("归档恢复只读取指定真实片段，setup 不得冒充命中后的状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-anchor-"));
  const path = join(directory, source.sessionId);
  await mkdir(path);
  const attacks = buildAttackRecords(paralyzedTurn().events);
  const plan = createRealtimeStoryboard(attacks);
  await writeFile(join(path, "plan.json"), JSON.stringify({ attacks, plan }));
  await writeFile(join(path, "clip-0.mp4"), "paid video");
  const options = { directory, continuity: new Map(), tailExtractor: async () => new Blob(["tail"]) };
  assert.match(await loadAttackSceneAnchor(source, attackVisualScene(attacks[0], true), null, options), /^data:image\/jpeg/);
  assert.equal(await loadAttackSceneAnchor(source, attackVisualScene(attacks[0]), null, options), null);
  assert.equal(sceneAfterBeat({ ...plan.turn.sequence[0], purpose: "setup" }, attacks).opponent.status, null);
  await writeFile(join(path, "clip-0-tail.jpg"), "saved tail");
  options.tailExtractor = async () => { throw new Error("must reuse saved JPEG"); };
  assert.equal(await loadAttackSceneAnchor(source, attackVisualScene(attacks[0], true), null, options), "data:image/jpeg;base64,c2F2ZWQgdGFpbA==");
});

test("真实应用在首个最终状态片段的首帧预热，排除临时状态、KO和重复调用", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("function warmAfterAttack("), app.indexOf("function preloadSceneAsset("));
  const result = paralyzedTurn();
  const attacks = buildAttackRecords(result.events);
  const calls = [];
  const warm = new Function("battle", "battleEpoch", "visualScene", "visualSceneKey", "attackVisualScene", "getActive", "supportsDefaultIdleVideo", "warmSceneAssets", `${fn};return warmAfterAttack;`)(result.state, 1, visualScene, visualSceneKey, attackVisualScene, getActive, supportsDefaultIdleVideo, (...args) => calls.push(args));
  const run = { epoch: 1, sessionId: source.sessionId, controller: new AbortController(), mark() {} };
  const beat = createRealtimeStoryboard(attacks).turn.sequence[0];
  warm({ ...beat, purpose: "setup" }, attacks, run, 0);
  assert.equal(calls.length, 0);
  warm(beat, attacks, run, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], source);
  assert.equal(calls[0][0].opponent.status, "paralysis");
  warm(beat, attacks, run, 0);
  assert.equal(calls.length, 1);
  run.warmedScene = false;
  result.state.opponent.team[0].status = "sleep";
  warm(beat, attacks, run, 0);
  assert.equal(calls.length, 1, "不预热中途的麻痹状态");
  result.state.phase = "must-switch";
  warm(beat, attacks, run, 0);
  assert.equal(calls.length, 1);
});

test("收回与放出为不同缓存和动作，收回不可放出、放出不可重复收回", () => {
  const battle = createBattle();
  const before = visualScene(battle);
  const recall = sceneVideoSpec({ kind: "recall", scene: before, sourceKey: "default", side: "player" });
  battle.player.active = 1;
  const scene = visualScene(battle);
  const sendout = sceneVideoSpec({ kind: "sendout", before, scene, sourceKey: recall.key });
  assert.notEqual(recall.key, sendout.key);
  assert.match(recall.prompt, /ONLY a recall/);
  assert.match(recall.prompt, /position is EMPTY/);
  assert.match(sendout.prompt, /NEVER repeat the recall/);
  assert.match(sendout.prompt, /NEW player squirtle/);
  assert.match(sendout.prompt, /Image 3 is the preceding recall/);
  assert.match(sendout.prompt, /Hand-drawn 2D Pokémon TV anime/);
  assert.throws(() => sceneVideoSpec({ kind: "recall", scene, side: "both" }));
  assert.throws(() => sceneVideoSpec({ kind: "sendout", before, scene, sourceAttack: source }), /收回尾帧/);
});

test("KO 攻击播放时预热倒下者收回，不能按自动换入者状态买待机", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("function warmAfterAttack("), app.indexOf("function preloadSceneAsset("));
  const b = createBattle(); b.opponent.team[0].hp = 1;
  const result = resolveTurn(b, { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 });
  const attacks = buildAttackRecords(result.events), calls = [];
  const warm = new Function("battle", "battleEpoch", "visualScene", "visualSceneKey", "attackVisualScene", "getActive", "supportsDefaultIdleVideo", "warmSceneAssets", `${fn};return warmAfterAttack;`)(result.state, 1, visualScene, visualSceneKey, attackVisualScene, getActive, supportsDefaultIdleVideo, (...args) => calls.push(args));
  const run = { epoch: 1, sessionId: source.sessionId, controller: new AbortController(), mark() {} };
  warm(createRealtimeStoryboard(attacks).turn.sequence[0], attacks, run, 0);
  assert.equal(calls[0][0].opponent.speciesId, "charmander");
  assert.equal(calls[0][0].opponent.fainted, true);
  assert.equal(calls[0][2].ambient, false);
  assert.equal(visualScene(result.state).opponent.speciesId, "charizard");
});

test("待机、听令和两侧收回独立并发去重，取消旧场景不吞掉需要播放的收回", async () => {
  const calls = [], gates = [];
  const cache = new SceneAssetCache({ request: (input, signal) => { calls.push({ input, signal }); const gate = defer(); gates.push(gate); return gate.promise; } });
  const scene = visualScene(paralyzedTurn().state);
  const ambient = cache.warm(scene, source);
  const recalls = ["player", "opponent"].map(side => cache.warmRecall(scene, source, side));
  cache.warm(scene, source); cache.warmRecall(scene, source, "player");
  assert.equal(calls.length, 4);
  assert(calls.every(c => c.input.sourceAttack === source));
  cache.cancelPendingExcept(visualScene(createBattle()), scene);
  assert(calls[0].signal.aborted && calls[1].signal.aborted);
  assert(!calls[2].signal.aborted && !calls[3].signal.aborted);
  gates.forEach((gate, i) => gate.resolve({ ...calls[i].input, status: "ready" }));
  await Promise.all([ambient.done, ...recalls.map(r => r.done)]);
  assert(cache.getRecall(scene, "player").job);
  assert.equal(cache.get(scene), undefined);
});

test("跳过无需等待后台共享收回任务结束，也不取消其它素材消费者", async () => {
  const gate = defer();
  const controller = new AbortController();
  const waiting = waitForScene(gate.promise, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  gate.resolve("cached");
  assert.equal(await gate.promise, "cached");
});

test("已解码的预缓存视频直接复用，不重新 load 导致二次缓冲", async () => {
  const video = { getAttribute: () => "cached.mp4", readyState: 4, load() { assert.fail("不能重置缓存"); }, pause() {} };
  await bufferVideo(video, "cached.mp4", new AbortController().signal);
});

test("真实应用隐藏预加载只接收最终阵容且不得抢播或更换正在播放的听令", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("function preloadSceneAsset("), app.indexOf("function bindSceneVideos("));
  const result = paralyzedTurn();
  const visible = new Set(["is-visible"]);
  const dom = { attackVideoPlayers: [{ classList: { contains: c => visible.has(c) } }], switchVideo: { classList: { contains: () => false } } };
  const calls = [];
  const preload = new Function("busy", "battle", "visualScene", "visualSceneKey", "dom", "setIdleBattleVideoActive", "bindSceneVideos", "cinemaRun", `${fn};return preloadSceneAsset;`)(true, result.state, visualScene, visualSceneKey, dom, active => calls.push(active), (...args) => calls.push(args), { mark() {} });
  preload({ scene: visualScene(createBattle()), idle: { videoUrl: "old.mp4" } }, "idle");
  assert.equal(calls.length, 0);
  const entry = { scene: visualScene(result.state), idle: { videoUrl: "new.mp4" } };
  preload(entry, "idle");
  assert.equal(calls[0], false);
  assert.equal(calls[1][1], "new.mp4");
  visible.clear();
  preload(entry, "idle");
  assert.equal(calls.length, 2);
});

test("实际换人流程：收回播放前即生成放出，收回结束后 POST 迟到也能立即跳过", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("async function playSwitchEvent("), app.indexOf("function finishTurnPresentation("));
  const b = createBattle(), before = visualScene(b); b.player.active = 1;
  const event = { targetSide: "player", text: "换入", sceneBefore: before, sceneAfter: visualScene(b) };
  const gate = defer(), marks = [];
  const run = { controller: new AbortController(), outgoing: null, mark: name => marks.push(name) };
  let touched = 0;
  const video = { classList: { remove() { touched++; } } };
  const deps = {
    battleEpoch: 1, sceneAssets: { cancelPendingExcept() {}, getRecall: () => ({ done: Promise.resolve({ key: "a".repeat(64), videoUrl: "recall.mp4" }) }) },
    beginCinema: () => run, setAttackVideoCopy() {}, visualSceneKey, defaultSceneKey: visualSceneKey(before), heldFrame: null, cinemaRun: run,
    waitForScene, dom: { recallVideos: { player: video }, switchVideo: video, attackVideoPlayers: [video] },
    bufferVideo: async () => {}, applyAttackVideoAudio() {}, requestSceneVideo: () => { marks.push("sendout_post"); return gate.promise; },
    playVideo: (_v, _old, _signal, hooks) => { hooks.onFrame(); return { started: Promise.resolve(), ended: Promise.resolve() }; },
    setStoryboardStatus() {}, warmSceneAssets() {}, battleNarrator: { stop() {} },
  };
  const play = new Function(...Object.keys(deps), `${fn};return playSwitchEvent;`)(...Object.values(deps));
  const task = play(event, 1);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert(marks.indexOf("sendout_post") < marks.indexOf("recall_playing"));
  assert(marks.indexOf("sendout_post") < marks.indexOf("recall_ended"));
  run.controller.abort();
  assert.equal(await Promise.race([task.then(() => true), new Promise(r => setTimeout(() => r(false), 50))]), true);
  gate.resolve({ key: "b".repeat(64), videoUrl: "late.mp4" });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(touched, 0, "取消后迟到结果不得修改播放器");
});
