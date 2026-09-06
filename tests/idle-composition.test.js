import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sceneVideoSpec } from "../src/scene-video-service.js";
import { visualScene, visualSceneKey } from "../src/visual-battle-state.js";
import { createBattle } from "../src/battle-engine.js";

const sourceAttack = { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 1 };

test("待机提示包含背面/正面相向、占比与防裁切，锁首尾帧来源以端点连续性优先", () => {
  for (const source of [{ sourceAttack }, { sourceKey: "a".repeat(64) }]) {
    for (const speciesId of ["pikachu", "squirtle", "bulbasaur", "charmander", "geodude", "gastly"]) {
      const scene = visualScene(createBattle()); scene.player.speciesId = speciesId;
      const { prompt } = sceneVideoSpec({ kind: "idle", scene, ...source });
      assert.match(prompt, new RegExp(`Player ${speciesId}.*REAR or rear three-quarter view`));
      assert.match(prompt, /BACK toward the camera/);
      assert.match(prompt, /FRONT or front three-quarter view toward the camera side, angled LEFT toward the player/);
      assert.match(prompt, /face EACH OTHER/);
      assert.match(prompt, /40-50% of frame height and NEVER more than 55%/);
      assert.match(prompt, /no cropped heads, ears, tails or feet/);
      assert.match(prompt, /no camera push-in, turn toward the viewer, left-right swap or mirror flip/);
      assert.doesNotMatch(prompt, /player large|large left foreground/);
      assert.match(prompt, /Hand-drawn 2D Pokémon TV anime/);
      if (source.sourceKey) {
        assert.match(prompt, /exact source-frame continuity has priority/);
        assert.match(prompt, /ONLY when already compatible with the supplied first and last frame/);
        assert.match(prompt, /If the source differs, preserve its composition/);
      } else {
        assert.doesNotMatch(prompt, /IMAGE-LOCKED IDLE|as the exact first AND last composition/);
      }
    }
  }
});

test("待机朝向不能覆盖异常状态，睡眠冰冻昏厥不能为了站姿恢复", () => {
  for (const status of ["sleep", "freeze", "fainted", "burn", "paralysis"]) {
    const scene = visualScene(createBattle()); scene.player.speciesId = "squirtle";
    scene.player.status = status === "fainted" ? null : status;
    scene.player.fainted = status === "fainted";
    const { prompt } = sceneVideoSpec({ kind: "idle", scene, sourceAttack });
    assert.match(prompt, /Existing sleep, freeze or fainted poses take priority/);
    assert.match(prompt, /never wake, thaw or stand a creature up for composition/);
    assert.match(prompt, /Conditions persist in EVERY frame/);
    if (status === "sleep") assert.match(prompt, /never open the eyes/);
    if (status === "freeze") assert.match(prompt, /ice shell holding the body immobile/);
    if (status === "fainted") assert.match(prompt, /spiral \/ swirl eyes/);
  }
});

test("新版待机不命中旧构图缓存，也不把背面/限高约束加到其他演出", () => {
  const scene = visualScene(createBattle());
  for (const source of [{ sourceAttack }, { sourceKey: "a".repeat(64) }]) {
    const old = createHash("sha256").update(JSON.stringify([
      "idle", null, visualSceneKey(scene), ...(source.sourceAttack ? ["attack-layout-v1"] : []),
    ])).digest("hex");
    assert.notEqual(sceneVideoSpec({ kind: "idle", scene, ...source }).key, old);
  }
  for (const kind of ["command", "recall", "recovery"]) {
    const { prompt } = sceneVideoSpec({ kind, scene, sourceAttack, side: "player",
      health: { player: { currentHp: 43, maxHp: 110 }, opponent: { currentHp: 60, maxHp: 114 } } });
    assert.doesNotMatch(prompt, /NEVER more than 55%|BACK toward the camera|face EACH OTHER/);
  }
});
