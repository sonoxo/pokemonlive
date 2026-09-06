import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("对手登场禁用语音但保留文字，玩家指令调用 MiniMax 播报", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.slice(app.indexOf("function beginCinema("), app.indexOf("async function pollAttackVideoClip("));
  const spoken = [], messages = [];
  const deps = {
    attackVideoAbortController: null, battleEpoch: 1, cinemaRun: null, attackVideoAutoplayBlocked: false,
    renderAttackVideoSoundControl() {}, reducedMotion: true, setAttackVideoCopy() {}, setMessage: text => messages.push(text),
    visualSceneKey: () => "scene", visualScene: x => x, presentationBattle: null, battle: {}, heldFrame: null,
    attackVideoSoundEnabled: true, battleNarrator: { speak: text => spoken.push(text) },
    dom: { attackVideo: {}, cinemaControls: {}, stage: { classList: { add() {} }, scrollIntoView() { assert.fail("演出开始不应强制滚动页面"); } }, commandBridge: { dataset: {} } },
  };
  const begin = new Function(...Object.keys(deps), `${body};return beginCinema;`)(...Object.values(deps));
  begin("露营少年 阿岚派出了小拳石！", { bridge: false, speak: false });
  assert.deepEqual(spoken, []);
  assert.deepEqual(messages, ["露营少年 阿岚派出了小拳石！"]);
  begin("皮卡丘，使用十万伏特！", { bridge: false });
  assert.deepEqual(spoken, ["皮卡丘，使用十万伏特！"]);
  assert.doesNotMatch(app, /speechSynthesis|SpeechSynthesisUtterance/);
});

test("实际换人入口按阵营关闭对手语音，不按角色名或文本匹配", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.slice(app.indexOf("async function playSwitchEvent("), app.indexOf("function finishTurnPresentation("));
  const calls = [];
  const stop = new Error("STOP_AFTER_CINEMA");
  const play = new Function("battleEpoch", "sceneAssets", "beginCinema", `${body};return playSwitchEvent;`)(
    1, { cancelPendingExcept() {} }, (text, options) => { calls.push({ text, ...options }); throw stop; });
  for (const targetSide of ["opponent", "player"]) {
    await assert.rejects(play({ targetSide, text: "任意登场文字" }, 1), error => error === stop);
  }
  assert.deepEqual(calls.map(c => c.speak), [false, true]);
  assert.deepEqual(calls.map(c => c.trainer), [null, "recall"]);
  assert(calls.every(c => c.bridge === false));
});
