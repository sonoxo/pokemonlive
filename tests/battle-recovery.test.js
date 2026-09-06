import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createBattle, resolveTurn } from "../src/battle-engine.js";
import { buildAttackRecords, createRealtimeStoryboard } from "../src/attack-storyboard.js";
import { BATTLE_RECOVERY_VERSION, battleRecoveryState } from "../src/battle-recovery.js";
import { sceneVideoSpec } from "../src/scene-video-service.js";
import { loadAttackSceneAnchor, sceneAfterBeat } from "../src/attack-scene-anchor.js";
import { visualSceneKey } from "../src/visual-battle-state.js";

const sourceAttack = { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 1 };
const turn = () => {
  const result = resolveTurn(createBattle(), { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 });
  const attacks = buildAttackRecords(result.events);
  return { attacks, plan: createRealtimeStoryboard(attacks) };
};
const input = () => ({ kind: "recovery", ...battleRecoveryState(turn().attacks.at(-1)), sourceAttack });

test("收尾继承末行动双方实际 HP，包括反作用力与混乱自伤，不采用替换后的角色", () => {
  const { attacks } = turn();
  const last = structuredClone(attacks.at(-1));
  last.outcome.recoilDamage = 3; last.outcome.selfDamage = 4;
  const state = battleRecoveryState(last);
  assert.equal(state.health[last.actor.side].currentHp, last.actor.currentHp - 7);
  assert.equal(state.health[last.target.side].currentHp, last.target.currentHp - last.outcome.damage);
  assert.equal(state.scene[last.actor.side].speciesId, last.actor.speciesId);
});

test("收尾三镜剪辑承接尾帧、反应特写、立即同框，低 HP 用姿态而非慢走表现", () => {
  const value = input();
  value.health.player.currentHp = 10;
  const spec = sceneVideoSpec(value);
  assert.match(spec.prompt, /EXACT last frame/);
  assert.match(spec.prompt, /exactly THREE purposeful shots.*cuts at 1s and 2.5s/);
  assert.match(spec.prompt, /\[0-1s\] SHOT 1:.*already present/);
  assert.match(spec.prompt, /\[1-2.5s\] SHOT 2:.*ONE concise post-action reaction close-up/);
  assert.match(spec.prompt, /\[2.5-4.5s\] SHOT 3:.*BOTH original combatants/);
  assert.match(spec.prompt, /Establish the two-shot immediately at this cut/);
  assert.match(spec.prompt, /\[4.5-5s\] Remain in SHOT 3.*only the final half-second/);
  assert.match(spec.prompt, /VERY LOW HP.*trembling support.*in-place posture/);
  assert.doesNotMatch(spec.prompt, /one continuous shot|slow difficult.*retreat|\[1-4s\]|\[4-5s\]|No hard cut/);
  assert.match(spec.prompt, /no required return to original marks/);
  assert.match(spec.prompt, /offscreen combatant stays in its actual location and condition/);
  assert.match(spec.prompt, /preserve the action axis and spatial geography/);
  assert.doesNotMatch(spec.prompt, /Re-establish the low shared battle view from the FIRST frame|Image 3/);
  assert.match(spec.prompt, /Hand-drawn 2D Pokémon TV anime/);
  const scene = { ...value.scene, player: { ...value.scene.player, currentHp: 1 } };
  assert.equal(visualSceneKey(scene), visualSceneKey(value.scene));
});

test("收尾剪辑修订不命中旧慢拉远缓存；片长、真实来源与其他场景缓存不变", () => {
  const value = input();
  const oldKey = createHash("sha256").update(JSON.stringify(["recovery", null, visualSceneKey(value.scene),
    "battle-recovery-v1", value.sourceAttack, value.health, "attack-layout-v1"])).digest("hex");
  const spec = sceneVideoSpec(value);
  assert.equal(BATTLE_RECOVERY_VERSION, "battle-recovery-v2");
  assert.notEqual(spec.key, oldKey);
  assert.match(spec.prompt, /five-second post-battle recovery/);
  assert.deepEqual(spec.sourceAttack, value.sourceAttack);
  for (const kind of ["idle", "command"]) {
    assert.equal(sceneVideoSpec({ ...value, kind }).key, sceneVideoSpec({ ...value, kind, health: undefined }).key);
    assert.doesNotMatch(sceneVideoSpec({ ...value, kind }).prompt, /SHOT 1: carry through|THREE purposeful shots/);
  }
});

test("收尾对睡眠冰冻昏厥的双方都禁止归位跳跃，其他异常持续", () => {
  for (const side of ["player", "opponent"]) for (const status of ["sleep", "freeze", "fainted", "paralysis", "poison", "burn"]) {
    const value = input();
    value.scene[side].speciesId = "squirtle";
    value.scene[side].status = status === "fainted" ? null : status;
    value.scene[side].fainted = status === "fainted";
    if (status === "fainted") value.health[side].currentHp = 0;
    const { prompt } = sceneVideoSpec(value);
    if (status === "fainted") {
      assert.match(prompt, /ALREADY fainted.*spiral \/ swirl eyes/);
      assert.doesNotMatch(prompt, /loses balance and drops limp/);
    } else if (["sleep", "freeze"].includes(status)) assert.match(prompt, /CANNOT return voluntarily.*no walking, jumping, awakening or thawing/);
    else assert.match(prompt, /Existing condition takes priority/);
    assert.match(prompt, /Neither side attacks, charges, deals additional damage, heals, wakes up, thaws, changes condition or gets replaced/);
    assert.match(prompt, /An asleep, frozen or fainted subject remains exactly in that condition, without alert eye contact, acknowledgement or waking/);
  }
});

test("收尾缓存隔离回合尾帧和 HP，拒绝缺失来源/越界 HP/昏厥矛盾", () => {
  const value = input(), key = sceneVideoSpec(value).key;
  const other = { ...value, sourceAttack: { ...sourceAttack, sessionId: "22222222-2222-4222-8222-222222222222" } };
  assert.notEqual(sceneVideoSpec(other).key, key);
  const hp = structuredClone(value); hp.health.player.currentHp--;
  assert.notEqual(sceneVideoSpec(hp).key, key);
  assert.throws(() => sceneVideoSpec({ ...value, sourceAttack: null, sourceKey: "a".repeat(64) }));
  for (const currentHp of [-1, 100001, 0, .5, NaN]) {
    const bad = structuredClone(value); bad.health.player.currentHp = currentHp;
    assert.throws(() => sceneVideoSpec(bad));
  }
});

test("在线末段收尾锚点核对实际 HP，拒绝首段/错误角色/伪造血量，取消不破坏共享尾帧", async () => {
  const { attacks, plan } = turn();
  const expected = battleRecoveryState(attacks.at(-1));
  let finish; const tail = new Promise(resolve => { finish = resolve; });
  const clips = plan.turn.sequence.map(beat => ({ scene: sceneAfterBeat(beat, attacks), tail }));
  const options = { continuity: new Map([[sourceAttack.sessionId, { clips, attacks }]]),
    runway: { get: () => ({ clips: clips.map(() => ({ status: "ready" })) }) }, recoveryHealth: expected.health };
  assert.equal(await loadAttackSceneAnchor({ ...sourceAttack, clipIndex: 0 }, expected.scene, null, options), null);
  const wrong = structuredClone(expected.health); wrong.player.currentHp--;
  assert.equal(await loadAttackSceneAnchor(sourceAttack, expected.scene, null, { ...options, recoveryHealth: wrong }), null);
  const controller = new AbortController();
  const cancelled = loadAttackSceneAnchor(sourceAttack, expected.scene, controller.signal, options);
  const surviving = loadAttackSceneAnchor(sourceAttack, expected.scene, null, options);
  controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  finish("data:image/jpeg;base64,dGFpbA==");
  assert.equal(await surviving, "data:image/jpeg;base64,dGFpbA==");
});

test("重启后收尾只复用归档末段实际尾帧，伪造 HP 在读取视频前拒绝", async () => {
  const { attacks, plan } = turn();
  const expected = battleRecoveryState(attacks.at(-1));
  const directory = await mkdtemp(join(tmpdir(), "pokemon-recovery-anchor-"));
  const path = join(directory, sourceAttack.sessionId); await mkdir(path);
  await writeFile(join(path, "plan.json"), JSON.stringify({ attacks, plan }));
  await writeFile(join(path, "clip-1-tail.jpg"), "last frame");
  const options = { directory, continuity: new Map(), recoveryHealth: expected.health,
    tailExtractor: () => { throw new Error("should reuse archived JPEG"); } };
  assert.equal(await loadAttackSceneAnchor(sourceAttack, expected.scene, null, options), "data:image/jpeg;base64,bGFzdCBmcmFtZQ==");
  const wrong = structuredClone(expected.health); wrong.opponent.currentHp--;
  assert.equal(await loadAttackSceneAnchor(sourceAttack, expected.scene, null, { ...options, recoveryHealth: wrong }), null);
});
