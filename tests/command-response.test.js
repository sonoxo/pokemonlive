import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sceneVideoSpec, IDLE_COMPOSITION_VERSION, SENDOUT_STAGING_VERSION } from "../src/scene-video-service.js";
import { SceneAssetCache } from "../src/scene-video-client.js";
import { visualSceneKey } from "../src/visual-battle-state.js";

const creature = (speciesId, state = null) => ({ speciesId, status: state === "fainted" ? null : state, fainted: state === "fainted", confused: false });
const scene = (playerState = null, opponentState = null) => ({ player: creature("squirtle", playerState), opponent: creature("geodude", opponentState) });
const spec = value => sceneVideoSpec({ kind: "command", scene: value, sourceKey: "a".repeat(64) });

test("六物种共用两段式应答，不使用皮卡丘专属耳朵/电气袋动作", () => {
  for (const species of ["pikachu", "squirtle", "bulbasaur", "charmander", "geodude", "gastly"]) {
    const value = scene(); value.player.speciesId = species;
    const { prompt } = spec(value);
    assert.match(prompt, /\[0-3\.5s\].*\[3\.5-5s\]/);
    assert.match(prompt, /cry during the first 3\.5 seconds/);
    assert.doesNotMatch(prompt, /2\.5/);
    assert.match(prompt, new RegExp(`Close-up of the player ${species}`));
    assert.match(prompt, new RegExp(`ONE short, clear ${species} creature acknowledgment cry`));
    assert.match(prompt, /natural synchronized mouth motion/);
    assert.match(prompt, /No charge, electrical buildup, projectile or attack/);
    assert.match(prompt, /opponent NEVER attacks/);
    assert.doesNotMatch(prompt, /ears perk|cheek sacs|\[0-1s\]|\[1-3s\]|quiet outdoor ambience only, no music, speech/);
    assert.match(prompt, /Hand-drawn 2D Pokémon TV anime/);
  }
});

test("双方睡眠/冰冻/昏厥组合：不回应、不恢复姿势、不因切镜攻击或改变状态", () => {
  for (const playerState of [null, "sleep", "freeze", "fainted"]) for (const opponentState of [null, "sleep", "freeze", "fainted"]) {
    const { prompt } = spec(scene(playerState, opponentState));
    assert.match(prompt, /\[0-3\.5s\].*\[3\.5-5s\]/);
    assert.match(prompt, /opponent NEVER attacks, answers the trainer, heals or changes condition/);
    if (playerState) {
      assert.match(prompt, /CANNOT acknowledge the trainer/);
      assert.match(prompt, /NO answering cry, active vocalization/);
      assert.doesNotMatch(prompt, /It gives ONE short/);
    }
    for (const [name, state] of [["squirtle", playerState], ["geodude", opponentState]]) {
      if (state) {
        assert.match(prompt, new RegExp(`${name} MUST remain in its existing immobile condition`));
        assert.doesNotMatch(prompt, new RegExp(`${name} makes a small species-appropriate ready-pose`));
      }
      if (state === "sleep") assert.match(prompt, /never open the eyes/);
      if (state === "freeze") assert.match(prompt, /ice shell holding the body immobile/);
      if (state === "fainted") { assert.match(prompt, /ALREADY fainted.*spiral \/ swirl/); assert.doesNotMatch(prompt, /loses balance and drops/); }
    }
  }
});

test("麻痹中毒灼伤与混乱不因应答消失，攻击尾帧路径不强制前半段全景", () => {
  for (const status of ["paralysis", "poison", "burn"]) {
    const value = scene(status);
    value.player.confused = true;
    const { prompt } = sceneVideoSpec({ kind: "command", scene: value, sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 } });
    assert.match(prompt, /\[0-3\.5s\].*\[3\.5-5s\]/);
    assert.match(prompt, new RegExp(`${status}:`));
    assert.match(prompt, /keeping its existing unfocused gaze and confusion cues/);
    assert.match(prompt, /Begin immediately with the authored close-up/);
    assert.match(prompt, /Both full bodies visible in the closing shot/);
    assert.doesNotMatch(prompt, /Re-establish the low shared battle view from the FIRST frame|close-ups are allowed in the middle/);
  }
});

test("应答与待机缓存各自版本化，收回键不变，换人仅增加投球版本", () => {
  const value = scene();
  const oldKey = (kind, before = null, side = null) => createHash("sha256").update(JSON.stringify([
    kind, before && visualSceneKey(before), visualSceneKey(value), ...(side ? [side] : []),
  ])).digest("hex");
  assert.notEqual(spec(value).key, oldKey("command"));
  const previousResponseKey = createHash("sha256").update(JSON.stringify([
    "command", null, visualSceneKey(value), "command-response-v2",
  ])).digest("hex");
  assert.notEqual(spec(value).key, previousResponseKey);
  assert.equal(spec(value).key, sceneVideoSpec({ kind: "command", scene: value, sourceKey: "default" }).key);
  const idleKey = createHash("sha256").update(JSON.stringify(["idle", null, visualSceneKey(value), IDLE_COMPOSITION_VERSION])).digest("hex");
  assert.equal(sceneVideoSpec({ kind: "idle", scene: value, sourceKey: "a".repeat(64) }).key, idleKey);
  assert.notEqual(idleKey, oldKey("idle"));
  assert.equal(sceneVideoSpec({ kind: "recall", scene: value, sourceKey: "default", side: "player" }).key, oldKey("recall", null, "player"));
  const before = { ...value, player: creature("bulbasaur") };
  for (const kind of ["switch", "sendout"]) {
    const expected = createHash("sha256").update(JSON.stringify([
      kind, visualSceneKey(before), visualSceneKey(value), SENDOUT_STAGING_VERSION,
    ])).digest("hex");
    assert.equal(sceneVideoSpec({ kind, scene: value, before, sourceKey: "a".repeat(64) }).key, expected);
    assert.notEqual(expected, oldKey(kind, before));
  }
  assert.throws(() => sceneVideoSpec({ kind: "idle", scene: value, sourceKey: "default" }));
});

test("初始场景只预热通用应答，重复请求/切走/重开不重买，必要时只补待机", async () => {
  const requests = [], cache = new SceneAssetCache({ request: async input => { requests.push(input); return { kind: input.kind, scene: input.scene, key: "a".repeat(64), videoUrl: "test.mp4" }; } });
  const value = scene(), entry = cache.warm(value, "default", { skipIdle: true });
  cache.warm(value, "default", { skipIdle: true });
  await entry.done;
  assert.deepEqual(requests.map(r => r.kind), ["command"]);
  assert.equal(entry.idle, null);
  cache.cancelPendingExcept();
  assert.equal(cache.get(value), entry);
  assert.equal(entry.controller.signal.aborted, false);
  cache.warm(value, "a".repeat(64));
  await entry.done;
  assert.deepEqual(requests.map(r => r.kind), ["command", "idle"]);
});

test("取消尚未就绪的应答后，迟到响应不能重新绑定", async () => {
  let finish; const ready = [];
  const cache = new SceneAssetCache({ request: () => new Promise(r => { finish = r; }), onReady: (...args) => ready.push(args) });
  const value = scene(), entry = cache.warm(value, "default", { skipIdle: true });
  cache.cancelPendingExcept();
  finish({ kind: "command", scene: value, videoUrl: "late.mp4" }); await entry.done;
  assert.equal(cache.get(value), undefined); assert.equal(ready.length, 0);
});

test("应答接入全局音量开关，NotAllowed后可由同一开关恢复", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const functions = app.slice(app.indexOf("function applyAttackVideoAudio("), app.indexOf("function renderAttackVideoSession("));
  const commandBridge = {}, videos = [{}, {}, {}]; let stops = 0;
  const toggle = new Function("dom", "battleNarrator", "renderAttackVideoSoundControl", `let attackVideoSoundEnabled = true, attackVideoAutoplayBlocked = true; const ATTACK_VIDEO_VOLUME = 0.82; ${functions}; return toggleAttackVideoSound;`)(
    { commandBridge, attackVideoPlayers: videos, switchVideo: {}, recallVideos: { player: {}, opponent: {} } },
    { stop() { stops++; }, resume() {} }, () => {},
  );
  toggle(); assert.equal(commandBridge.muted, false); assert.equal(commandBridge.volume, 0.82);
  toggle(); assert.equal(commandBridge.muted, true); assert.equal(stops, 1);
  toggle(); assert.equal(commandBridge.muted, false);
  const begin = app.slice(app.indexOf("function beginCinema("), app.indexOf("async function pollAttackVideoClip("));
  assert.match(begin, /applyAttackVideoAudio\(dom.commandBridge\)/);
  assert.match(begin, /onBlocked: \(\) => \{ attackVideoAutoplayBlocked = true; renderAttackVideoSoundControl\(\)/);
  assert(begin.indexOf("battleNarrator.stop()") < begin.indexOf("playVideo(dom.commandBridge"));
  assert.doesNotMatch(begin, /commandBridge\.muted = true/);
});
