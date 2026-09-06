import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LANGUAGES, normalizeLanguage, localizedSpeech } from "../src/language.js";
import { translateText, localizedTurnSummary } from "../src/ui-localization.js";
import { buildAttackRecords, createFallbackStoryboard } from "../src/attack-storyboard.js";
import { SPECIES, MOVES, ITEMS, TYPE_NAMES, STATUS_NAMES } from "../src/data.js";
import { createBattle, createPokemon, resolveTurn } from "../src/battle-engine.js";
import { visualScene } from "../src/visual-battle-state.js";
import { sceneVideoSpec } from "../src/scene-video-service.js";
import { validatePaidScene } from "../src/scene-video-recovery.js";
import { SceneAssetCache } from "../src/scene-video-client.js";
import { speechSpec, synthesizeSpeech, SpeechCache } from "../src/minimax-speech.js";
import { FalVideoRunway, FAL_VIDEO_REFERENCE_MODEL } from "../src/fal-video-runway.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scene = visualScene(createBattle());
const sourceAttack = { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 };

test("全部物种、招式、道具、类型、状态与描述具有英日翻译", () => {
  const values = [...Object.values(SPECIES).map(x => x.name), ...Object.values(MOVES).flatMap(x => [x.name, x.description]),
    ...Object.values(ITEMS).flatMap(x => [x.name, x.description]), ...Object.values(TYPE_NAMES), ...Object.values(STATUS_NAMES)];
  for (const text of values) {
    assert.equal(translateText(text, "zh"), text);
    assert(!/[\u4e00-\u9fff]/.test(translateText(text, "en")), text);
    assert.notEqual(translateText(text, "ja"), text, text);
  }
  assert.equal(translateText("要让皮卡丘做什么？", "en"), "What should Pikachu do?");
  assert.equal(translateText("要让皮卡丘做什么？", "ja"), "ピカチュウはどうする？");
});

test("翻译回合日志不修改权威战斗事实与异常状态", () => {
  const result = resolveTurn(createBattle(), { type: "move", moveIndex: 2 }, () => .5, { type: "move", moveIndex: 0 });
  const original = JSON.stringify(result);
  for (const event of result.events) if (event.text) {
    assert(!/[\u4e00-\u9fff]/.test(translateText(event.text, "en")), event.text);
  }
  for (const text of ["小火龙正在熟睡。", "小火龙被冻住，无法行动！", "小火龙身体麻痹，无法行动！", "皮卡丘的防御大幅降低了！", "皮卡丘的攻击已经无法再提高了！", "小火龙倒下了！"]) {
    assert(!/[\u4e00-\u9fff]/.test(translateText(text, "en")), text);
    assert.notEqual(translateText(text, "ja"), text);
  }
  assert.equal(JSON.stringify(result), original);
});

test("分镜展示标题、镜头标签与事实摘要随语言切换，原始方案不变", () => {
  for (const text of ["皮卡丘 → 小火龙", "皮卡丘 ⇄ 小火龙", "3 镜", "近景→远景→中景", "同步点 2.6s", "0.0–2.0s 近景", "01 · 皮卡丘 → 小火龙 · 十万伏特 · 完整演出", "自伤 −4 HP", "解除冰冻"]) {
    assert(!/[\u4e00-\u9fff]/.test(translateText(text, "en")), text);
  }
  const battle = createBattle();
  const result = resolveTurn(battle, {type:"move",moveIndex:2}, () => .5, {type:"move",moveIndex:0});
  const plan = createFallbackStoryboard(buildAttackRecords(result.events)).turn;
  const original = JSON.stringify(plan);
  assert.equal(localizedTurnSummary(plan, "zh"), plan.directorNote);
  assert.match(localizedTurnSummary(plan, "en"), /Charmander: Paralyzed/);
  assert.match(localizedTurnSummary(plan, "ja"), /ヒトカゲ: まひ/);
  assert.doesNotMatch(localizedTurnSummary(plan, "en"), /×null|−0 HP|Not very effective/);
  assert(!/[\u4e00-\u9fff]/.test(localizedTurnSummary(plan, "en")));
  assert.equal(JSON.stringify(plan), original);
});

test("真实强化、落空、免疫和睡眠阻止行动摘要不虚构伤害或倍率", () => {
  const summarize = (battle, moveIndex, rng = () => .5) => {
    const result = resolveTurn(battle, {type:"move",moveIndex}, rng, {type:"move",moveIndex:2});
    const attack = buildAttackRecords(result.events).find(a => a.actor.side === "player");
    return localizedTurnSummary(createFallbackStoryboard([attack]).turn, "en");
  };
  const growthBattle = createBattle(); growthBattle.player.active = 2;
  const growth = summarize(growthBattle, 3);
  assert.match(growth, /Bulbasaur Attack \+1/);
  assert.match(growth, /Bulbasaur Sp\. Atk \+1/);
  assert.doesNotMatch(growth, /Charmander|×null|−0 HP|effective/);
  const missed = summarize(createBattle(), 3, () => .99);
  assert.match(missed, /MISS/); assert.doesNotMatch(missed, /−\d+ HP|effective/);
  const immuneBattle = createBattle(); immuneBattle.opponent.team[0] = createPokemon("geodude",50,"opponent-0-geodude");
  const immune = summarize(immuneBattle, 2);
  assert.match(immune, /IMMUNE/); assert.doesNotMatch(immune, /Paralyzed|−\d+ HP/);
  const sleepBattle = createBattle(); sleepBattle.player.team[0].status = "sleep"; sleepBattle.player.team[0].statusTurns = 3;
  const sleep = summarize(sleepBattle, 0);
  assert.match(sleep, /Asleep — Unable to move/); assert.doesNotMatch(sleep, /−\d+ HP|effective/);
});

test("三种语言缓存分离且默认中文兼容旧 key；错误语言在收费前拒绝", () => {
  for (const kind of ["idle", "command", "recall", "recovery"]) {
    const input = { kind, scene, sourceAttack, side: "player", health: { player: { currentHp: 50, maxHp: 110 }, opponent: { currentHp: 70, maxHp: 114 } } };
    const specs = ["zh", "en", "ja"].map(language => sceneVideoSpec({ ...input, language }));
    assert.equal(new Set(specs.map(x => x.key)).size, 3);
    assert.equal(sceneVideoSpec(input).key, specs[0].key);
    const paid = { key: specs[1].key, kind, status: "submitted", model: FAL_VIDEO_REFERENCE_MODEL, requestId: "test-id", language: "zh" };
    assert.throws(() => validatePaidScene(paid, specs[1]), /UNCONFIRMED/);
  }
  for (const language of [null, "fr", "English", "../zh", 12, ["en"], {}, "__proto__"]) {
    assert.throws(() => normalizeLanguage(language));
    assert.throws(() => speechSpec("皮卡丘，使用十万伏特！", language));
  }
});

test("语言预热请求包括待机听令和收回；错误语言返回不得进入播放缓存", async () => {
  for (const language of ["en", "ja"]) {
    const calls = [], ready = [];
    const cache = new SceneAssetCache({ language, onReady: (_, kind) => ready.push(kind), request: async input => {
      calls.push(input); return { ...input, status: "ready" };
    } });
    await Promise.all([cache.warm(scene, sourceAttack).done, cache.warmRecall(scene, sourceAttack, "player").done]);
    assert(calls.every(x => x.language === language)); assert.equal(ready.length, 3);
    const wrong = new SceneAssetCache({ language, request: async input => ({ ...input, language: "zh", status: "ready" }) });
    const entry = wrong.warm(scene, sourceAttack); await entry.done;
    assert.equal(entry.idle, null); assert.equal(entry.command, null);
  }
});

test("三语喊招使用各自原生音色和台词，仍只允许游戏内合法喊招", async () => {
  const text = "皮卡丘，使用十万伏特！", keys = [];
  for (const language of ["zh", "en", "ja"]) {
    const spec = speechSpec(text, language); keys.push(spec.key);
    const sent = [], socket = new EventEmitter(); socket.send = raw => sent.push(JSON.parse(raw)); socket.close = () => {}; socket.terminate = () => {};
    const pending = synthesizeSpeech(text, "test-only", { language, connect: () => socket });
    for (const event of [{ event: "connected_success" }, { event: "task_started" }, { data: { audio: "abcd" } }, { event: "task_finished" }]) socket.emit("message", Buffer.from(JSON.stringify(event)));
    await pending;
    assert.equal(sent[0].voice_setting.voice_id, LANGUAGES[language].voice);
    assert.equal(sent[0].language_boost, LANGUAGES[language].boost);
    assert.equal(sent[1].text, localizedSpeech(text, language));
    assert.throws(() => speechSpec("露营少年 阿岚派出了小火龙！", language));
  }
  assert.equal(new Set(keys).size, 3);
  assert.equal(speechSpec(text, "zh").key, speechSpec(text).key);
});

test("语音缓存按语言隔离，重复语言读取旧音频，不把中文 MP3 当成日文", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-languages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], cache = new SpeechCache({ directory, synthesize: async (_text, _key, options) => {
    calls.push(options.language); return { bytes: Buffer.from(options.language), timings: {} };
  } });
  for (const language of ["zh", "en", "ja", "en"]) {
    const result = await cache.get("皮卡丘，使用十万伏特！", async () => "test", language);
    assert.equal(result.bytes.toString(), language);
  }
  assert.deepEqual(calls, ["zh", "en", "ja"]);
});

test("fal 实际提交参数每一段都继承语言，首段R2V和尾帧I2V规则不变", async () => {
  for (const language of ["zh", "en", "ja"]) {
    const calls = [];
    const runway = new FalVideoRunway({ clientFactory: () => ({ queue: {
      submit: async (model, { input }) => { calls.push({ model, input }); return { request_id: `test-${calls.length}` }; },
      subscribeToStatus: async () => {}, result: async () => ({ data: { video: { url: "https://example.com/video.mp4" } } }), cancel: async () => {},
    } }), tailFrameExtractor: async () => new Blob(["frame"], { type: "image/jpeg" }),
    tailFrameUploader: async () => "data:image/jpeg;base64,YQ==",
  });
    const job = runway.create({ credentials: "test", language, battleEpoch: 1, turn: 1,
      referenceImages: ["player", "opponent"].map(side => ({ side, speciesId: scene[side].speciesId, name: side, imageUrl: "data:image/png;base64,YQ==" })),
      beats: [0, 1].map(index => ({ index, durationSeconds: 5, purpose: "complete", motionPrompt: "Preserve paralysis. No narration.", attackId: "a" })),
    });
    for (let i = 0; i < 100 && runway.get(job.id).status === "generating"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runway.get(job.id).status, "ready"); assert.equal(runway.get(job.id).language, language);
    assert.equal(calls.length, 2); assert(calls[0].model.includes("reference-to-video")); assert(calls[1].model.includes("image-to-video"));
    for (const call of calls) { assert(call.input.prompt.includes(`OUTPUT AUDIO LANGUAGE: ${LANGUAGES[language].name} (${language})`)); assert(call.input.prompt.includes("Preserve paralysis")); assert.equal(call.input.seed, 42); }
  }
});

test("请求入口传递语言到规划、攻击、收尾、放出和语音；切换不重开战斗", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const change = app.slice(app.indexOf("function changeLanguage("), app.indexOf("function restartBattle("));
  assert.doesNotMatch(change, /createBattle\(|restartBattle\(|battleEpoch\s*\+/);
  assert.match(change, /sceneAssets\.cancelPendingExcept/); assert.match(change, /if \(busy\)/);
  assert.match(app, /kind: "recovery", \.\.\.recoveryState, language: run.language/);
  assert.match(app, /kind: "sendout"[^\n]+language: run.language/);
  assert.match(app, /sequence: plan.turn.sequence, language: owner.language/);
  assert.match(app, /attacks, sequence, language: run.language/);
  assert.match(app, /turn, attacks, language \}/);
});
