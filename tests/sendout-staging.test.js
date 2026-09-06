import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBattle } from "../src/battle-engine.js";
import { visualScene, visualSceneKey } from "../src/visual-battle-state.js";
import { sceneVideoSpec, SENDOUT_STAGING_VERSION, IDLE_COMPOSITION_VERSION } from "../src/scene-video-service.js";
import { COMMAND_RESPONSE_VERSION } from "../src/command-response.js";

function input(side, kind = "sendout", language = "zh") {
  const before = visualScene(createBattle());
  const scene = structuredClone(before);
  scene[side].speciesId = side === "player" ? "squirtle" : "dragonite";
  return { kind, language, before, scene, ...(kind === "sendout" ? { sourceKey: "a".repeat(64) } : {}) };
}
const hash = identity => createHash("sha256").update(JSON.stringify(identity)).digest("hex");

test("双方放出与旧整段换人都锁定画外投球侧、空位落点和不遮挡留场者", () => {
  for (const side of ["player", "opponent"]) for (const kind of ["sendout", "switch"]) for (const language of ["zh", "en", "ja"]) {
    const value = input(side, kind, language);
    const { prompt, side: actualSide } = sceneVideoSpec(value);
    assert.equal(actualSide, side);
    assert.match(prompt, new RegExp(`only the ${side} trainer throws this ball`));
    if (side === "player") {
      assert.match(prompt, /OFFSCREEN behind the camera on the LEFT/);
      assert.match(prompt, /crossing the LEFT frame edge, travels rightward.*entirely within the LEFT foreground/);
      assert.match(prompt, /EMPTY player ground mark/);
      assert.doesNotMatch(prompt, /crossing the RIGHT frame edge/);
    } else {
      assert.match(prompt, /OFFSCREEN beyond the opponent ground mark on the RIGHT/);
      assert.match(prompt, /crossing the RIGHT frame edge, travels leftward.*entirely within the RIGHT middle distance/);
      assert.match(prompt, /EMPTY opponent ground mark/);
      assert.doesNotMatch(prompt, /crossing the LEFT frame edge/);
    }
    const other = side === "player" ? "opponent" : "player";
    assert.match(prompt, new RegExp(`untouched ${value.scene[other].speciesId} on the ${other} side`));
    assert.match(prompt, /Never spawn, perch, hover, bounce or launch a ball on or above its head/);
    assert.match(prompt, /never cover its face, cross its body, touch it or merge with its anatomy/);
    assert.match(prompt, /never holds, throws, emits or transforms into a ball/);
    assert.match(prompt, /camera and left-right action axis fixed during the throw/);
    assert.match(prompt, /Only ONE ball, with a continuous flight from the frame edge/);
    assert.match(prompt, /Show no trainer or throwing hand/);
    assert.match(prompt, /Hand-drawn 2D Pokémon TV anime/);
    if (kind === "sendout") {
      assert.match(prompt, /\[0-0.8s\].*no ball visible yet/);
      assert.match(prompt, /Image 3 is the preceding recall's exact tail composition/);
      assert.match(prompt, /NEVER repeat the recall/);
      assert.doesNotMatch(prompt, /An offscreen trainer tosses a Poké Ball in an arc into that empty position/);
    }
  }
});

test("投球避让不能靠移动或唤醒留场者，入场睡眠和冰冻继续继承", () => {
  for (const side of ["player", "opponent"]) for (const status of ["sleep", "freeze"]) {
    const value = input(side);
    const other = side === "player" ? "opponent" : "player";
    value.before[other].status = status;
    value.scene[other].status = status;
    value.scene[side].status = status;
    const prompt = sceneVideoSpec(value).prompt;
    assert.match(prompt, /never moves to make room/);
    assert.match(prompt, /The other side never changes identity, condition or location/);
    assert.match(prompt, new RegExp(`${value.scene[side].speciesId}: ${status}:`));
    assert.match(prompt, new RegExp(`${value.scene[other].speciesId}: ${status}:`));
    assert.match(prompt, status === "sleep" ? /never open the eyes, dodge, brace, stand alert or wake/ : /holding the body immobile/);
  }
});

test("投球修订隔离旧错误换人缓存，并继续按双方、阵容和语言区分", () => {
  assert.equal(SENDOUT_STAGING_VERSION, "sendout-staging-v2");
  const keys = new Set();
  for (const side of ["player", "opponent"]) for (const kind of ["sendout", "switch"]) for (const language of ["zh", "en", "ja"]) {
    const value = input(side, kind, language);
    const oldIdentity = [kind, visualSceneKey(value.before), visualSceneKey(value.scene)];
    const identity = [...oldIdentity, SENDOUT_STAGING_VERSION];
    if (language !== "zh") { oldIdentity.push("audio-language-v1", language); identity.push("audio-language-v1", language); }
    const spec = sceneVideoSpec(value);
    assert.notEqual(spec.key, hash(oldIdentity));
    assert.equal(spec.key, hash(identity));
    assert.equal(spec.key, sceneVideoSpec(value).key);
    keys.add(spec.key);
  }
  assert.equal(keys.size, 12);
});

test("投球修订不更改既有待机、听令、收回的缓存键或提示词", () => {
  const scene = visualScene(createBattle());
  for (const kind of ["idle", "command", "recall"]) for (const side of ["player", "opponent"]) {
    const spec = sceneVideoSpec({ kind, side, scene, sourceKey: "a".repeat(64) });
    const identity = [kind, null, visualSceneKey(scene)];
    if (kind === "idle") identity.push(IDLE_COMPOSITION_VERSION);
    if (kind === "command") identity.push(COMMAND_RESPONSE_VERSION);
    if (kind === "recall") identity.push(side);
    assert.equal(spec.key, hash(identity));
    assert.doesNotMatch(spec.prompt, /THROW OWNERSHIP AND PATH/);
  }
});
