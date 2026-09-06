import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBattle, createPokemon, resolveTurn, resolveForcedSwitch } from "../src/battle-engine.js";
import { buildAttackRecords, sanitizeAttackRecords, createRealtimeStoryboard, createFallbackStoryboard } from "../src/attack-storyboard.js";
import { visualScene, visualSceneKey, sanitizeVisualScene, attackVisualScene } from "../src/visual-battle-state.js";
import { supportsDefaultIdleVideo } from "../src/idle-battle-video.js";
import { sceneVideoSpec } from "../src/scene-video-service.js";
import { SceneAssetCache, requestSceneVideo } from "../src/scene-video-client.js";
import { createCinemaEventCursor } from "../src/cinema-events.js";

const records = result => sanitizeAttackRecords(structuredClone(buildAttackRecords(result.events)));
const text = attack => createRealtimeStoryboard([attack]).turn.sequence[0].motionPrompt;
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("同物种健康、睡眠、混乱、昏厥不共用待机键，普通 HP 变化可复用", () => {
  const battle = createBattle();
  const base = visualSceneKey(visualScene(battle));
  battle.player.team[0].hp -= 1;
  assert.equal(visualSceneKey(visualScene(battle)), base);
  for (const status of ["sleep", "paralysis", "poison", "freeze", "burn"]) {
    battle.opponent.team[0].status = status;
    assert.notEqual(visualSceneKey(visualScene(battle)), base);
    assert.equal(supportsDefaultIdleVideo(battle.player.team[0], battle.opponent.team[0]), false);
  }
  battle.opponent.team[0].status = null;
  battle.opponent.team[0].volatile.confusedTurns = 1;
  assert.equal(supportsDefaultIdleVideo(battle.player.team[0], battle.opponent.team[0]), false);
  assert.notEqual(visualSceneKey(visualScene(battle)), base);
  battle.opponent.team[0].hp = 0;
  assert.equal(visualScene(battle).opponent.fainted, true);
});

test("小拳石跨两个回合熟睡受击：开场、所有镜头、尾帧均继承睡眠，不主动躲避或站起", () => {
  let battle = createBattle();
  battle.opponent.team[1] = createPokemon("geodude", 50, "opponent-1-geodude");
  battle.player.active = 2;
  battle.opponent.active = 1;
  battle.opponent.team[1].status = "sleep";
  battle.opponent.team[1].statusTurns = 3;
  for (let turn = 0; turn < 2; turn++) {
    const result = resolveTurn(battle, { type: "move", moveIndex: 1 }, () => 0.5, { type: "move", moveIndex: 0 });
    const attacks = records(result);
    assert.equal(attacks.length, 2);
    assert.equal(attacks[1].blockedReason, "sleep");
    assert.equal(attacks[1].outcome.damage, 0);
    const prompt = text(attacks[0]);
    assert.match(prompt, /FROM FRAME ONE geodude already has sleep/);
    assert.match(prompt, /EVERY shot/);
    assert.match(prompt, /closed eyelids, slow breathing/);
    assert.match(prompt, /no voluntary bracing, dodging, alert eyes or recovery footwork/);
    assert.doesNotMatch(prompt, /receiver's eyes squeeze|recover their footing/);
    assert.equal(attackVisualScene(attacks[0], true).opponent.status, "sleep");
    battle = result.state;
    assert.equal(battle.opponent.team[1].status, "sleep");
  }
});

test("自然醒来只归属下一行动，先前受击仍睡眠；醒后快照才移除睡眠", () => {
  const battle = createBattle();
  battle.opponent.team[0].status = "sleep";
  battle.opponent.team[0].statusTurns = 0;
  const attacks = records(resolveTurn(battle, { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 }));
  assert.equal(attacks[0].target.status, "sleep");
  assert.equal(attacks[0].outcome.clearedStatus, null);
  assert.equal(attacks[1].actor.status, null);
  assert.match(text(attacks[0]), /already has sleep/);
  assert.doesNotMatch(text(attacks[1]), /already has sleep/);
});

test("KO 与睡眠的眼睛严格区分，KO 普通/降级分镜均含卷卷眼", () => {
  const battle = createBattle();
  battle.opponent.team[0].hp = 1;
  battle.opponent.team[0].status = "sleep";
  const attacks = records(resolveTurn(battle, { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 }));
  assert.equal(attacks[0].outcome.fainted, true);
  assert.match(text(attacks[0]), /BOTH eyes visibly become bold black spiral/);
  assert.match(text(attacks[0]), /classic anime knockout eyes/);
  const beats = createFallbackStoryboard(attacks).turn.sequence;
  assert.doesNotMatch(beats[0].motionPrompt, /BOTH eyes visibly become/); // no premature KO in setup
  assert.match(beats.at(-1).motionPrompt, /BOTH eyes visibly become/);
});

test("换人事件锁定瞬时快照，换入者状态保留且由其承受随后攻击", () => {
  const battle = createBattle();
  battle.player.team[1].status = "sleep";
  battle.player.team[1].statusTurns = 2;
  battle.player.team[0].volatile.confusedTurns = 2;
  const result = resolveTurn(battle, { type: "switch", teamIndex: 1 }, () => .5, { type: "move", moveIndex: 0 });
  const event = result.events.find(e => e.type === "switch");
  assert.equal(event.sceneBefore.player.speciesId, "pikachu");
  assert.equal(event.sceneBefore.player.confused, true);
  assert.equal(event.sceneAfter.player.speciesId, "squirtle");
  assert.equal(event.sceneAfter.player.status, "sleep");
  assert.equal(event.incoming.hp, battle.player.team[1].hp);
  assert(result.state.player.team[1].hp < event.incoming.hp);
  assert.equal(records(result)[0].target.uid, event.incoming.uid);
  assert.equal(result.state.player.team[0].volatile.confusedTurns, 0);
  assert.equal(result.state.player.team[1].statusTurns, 2);
});

test("强制换人不触发额外攻击或回合；敌方自动替换保留 KO 出场快照", () => {
  const battle = createBattle();
  battle.phase = "must-switch";
  battle.player.team[0].hp = 0;
  const forced = resolveForcedSwitch(battle, 1);
  assert.equal(forced.state.turn, battle.turn);
  assert.equal(buildAttackRecords(forced.events).length, 0);
  assert.equal(forced.events.find(e => e.type === "switch").sceneBefore.player.fainted, true);
  const other = createBattle();
  other.opponent.team[0].hp = 1;
  const result = resolveTurn(other, { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 });
  const replacement = result.events.find(e => e.type === "switch");
  assert.equal(replacement.sceneBefore.opponent.fainted, true);
  assert.equal(replacement.sceneAfter.opponent.speciesId, "dragonite");
});

test("异步换人与规则事件游标保持顺序和一次性应用，包括重复 finish", async () => {
  const battle = createBattle();
  const result = resolveTurn(battle, { type: "switch", teamIndex: 1 }, () => .5, { type: "move", moveIndex: 0 });
  const attacks = records(result);
  const applied = [];
  const cursor = createCinemaEventCursor(result.events, attacks, event => applied.push(event));
  const gate = defer();
  const preparation = cursor.before(attacks[0].id, event => event.type === "switch" ? gate.promise : undefined);
  assert.equal(applied.length, 0);
  gate.resolve();
  await preparation;
  assert.equal(applied[0].type, "switch");
  cursor.start(attacks[0].id);
  cursor.impact(attacks[0].id);
  await cursor.finishAsync();
  cursor.finish();
  assert.deepEqual(applied, result.events);
});

test("替换提示词区分旧/新角色并保留对手睡眠，预热要求匹配登场尾帧", () => {
  const battle = createBattle();
  battle.opponent.active = 1;
  battle.opponent.team[1].status = "sleep";
  const before = visualScene(battle);
  battle.player.active = 2;
  const scene = visualScene(battle);
  const spec = sceneVideoSpec({ kind: "switch", before, scene });
  assert.match(spec.prompt, /OUTGOING pikachu/);
  assert.match(spec.prompt, /FINAL player bulbasaur/);
  assert.match(spec.prompt, /dragonite: sleep/);
  for (const kind of ["idle", "command"]) {
    const warm = sceneVideoSpec({ kind, scene, sourceKey: spec.key });
    assert.match(warm.prompt, /Conditions persist in EVERY frame/);
    assert.match(warm.prompt, /NO spiral eyes/);
  }
  assert.throws(() => sceneVideoSpec({ kind: "idle", scene }), /尾帧/);
  assert.throws(() => sceneVideoSpec({ kind: "switch", before, scene: before }), /只能替换一方/);
  assert.throws(() => sanitizeVisualScene({ ...scene, player: { ...scene.player, status: "injected" } }), /状态无效/);
});

test("待机/听令同步启动、去重且旧阵容迟到结果不能覆盖新阵容", async () => {
  const calls = [];
  const ready = [];
  const gates = [];
  const cache = new SceneAssetCache({ request: (input, signal) => { calls.push({ input, signal }); const gate = defer(); gates.push(gate); return gate.promise; }, onReady: entry => ready.push(entry.scene) });
  const battle = createBattle();
  const first = visualScene(battle);
  const entry = cache.warm(first, "a".repeat(64));
  cache.warm(first, "a".repeat(64));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.input.kind), ["idle", "command"]);
  battle.player.active = 1;
  const second = visualScene(battle);
  cache.cancelPendingExcept(second);
  assert(calls.every(c => c.signal.aborted));
  gates.forEach((gate, i) => gate.resolve({ status: "ready", kind: calls[i].input.kind, scene: first }));
  await entry.done;
  assert.equal(cache.get(first), undefined);
  assert.deepEqual(ready, []);
});

test("预热部分失败不影响成功素材且不自动重复收费", async () => {
  let count = 0;
  const scene = visualScene(createBattle());
  const cache = new SceneAssetCache({ request: async input => { count++; if (input.kind === "command") throw new Error("offline"); return { ...input, status: "ready" }; } });
  const entry = cache.warm(scene, "a".repeat(64));
  await entry.done;
  assert(entry.idle);
  assert.equal(entry.command, null);
  cache.warm(scene, "a".repeat(64));
  await entry.done;
  assert.equal(count, 3, "失败类型允许重新读取原任务，成功待机不重做");
});

test("场景创建响应迟到时仍取得 key 并远端取消，不遗留付费任务", async () => {
  const submitted = defer();
  const calls = [];
  const controller = new AbortController();
  const request = requestSceneVideo({}, controller.signal, async (url, options) => {
    calls.push([url, options.method]);
    if (options.method === "POST") return submitted.promise;
    return new Response("{}");
  });
  controller.abort();
  submitted.resolve(Response.json({ ok: true, job: { key: "a".repeat(64), status: "loading" } }));
  await assert.rejects(request, { name: "AbortError" });
  assert(calls.some(([url, method]) => method === "DELETE" && url.endsWith("a".repeat(64))));
});

test("第二段中途跳过时，实际 clearCinema 恢复已隐藏的正确状态尾帧", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("function clearCinema("), app.indexOf("function beginCinema("));
  const video = visible => ({ pause() {}, style: {}, setAttribute() {}, classList: new Set(visible ? ["is-visible"] : []) });
  const players = [video(false), video(true)];
  const dom = { attackVideoPlayers: players, commandBridge: video(false), switchVideo: video(false), trainerVideos: { command: video(true), recall: video(true) },
    attackVideo: { hidden: false }, cinemaControls: { hidden: false }, stage: { classList: new Set(["is-cinema-active"]) }, attackVideoStatus: {} };
  for (const node of [...players, dom.commandBridge, dom.switchVideo, dom.stage, ...Object.values(dom.trainerVideos)]) node.classList.remove = node.classList.delete.bind(node.classList);
  const clear = new Function("dom", "heldFrame", `${source}; return clearCinema;`)(dom, { video: players[0] });
  clear({ hold: true });
  assert(players[0].classList.has("is-visible"));
  assert(!players[1].classList.has("is-visible"));
  assert.equal(dom.attackVideo.hidden, false);
  assert.equal(dom.cinemaControls.hidden, true);
  assert(!dom.stage.classList.has("is-cinema-active"));
  assert(Object.values(dom.trainerVideos).every(node => !node.classList.has("is-visible")));
});
