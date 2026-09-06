import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { bufferVideo, playVideo } from "../src/inline-cinema.js";
import { createCinemaEventCursor } from "../src/cinema-events.js";
import { createRealtimeStoryboard, buildAttackRecords, normalizeStoryboardPlan } from "../src/attack-storyboard.js";
import { createBattle, resolveTurn } from "../src/battle-engine.js";

class Video extends EventTarget {
  constructor() {
    super(); this.currentTime = 0; this.readyState = 0; this.paused = true;
    this.classes = new Set(); this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c) };
    this.style = {}; this.muted = false;
  }
  setAttribute() {}
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; this.dispatchEvent(new Event("playing")); return Promise.resolve(); }
  requestVideoFrameCallback(fn) { this.frame = fn; return 1; }
  cancelVideoFrameCallback() { this.frame = null; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}

test("内联切换等待真实首帧，缓冲和等待期间保留上一段，无黑屏", async () => {
  const signal = new AbortController().signal;
  const old = new Video(); old.classList.add("is-visible");
  const next = new Video();
  const buffer = bufferVideo(next, "clip.mp4", signal);
  assert(old.classes.has("is-visible"));
  next.emit("canplay"); await buffer;
  const playback = playVideo(next, old, signal);
  assert(old.classes.has("is-visible"));
  assert(!next.classes.has("is-visible"));
  next.frame(); await playback.started;
  assert(next.classes.has("is-visible"));
  assert(!old.classes.has("is-visible"));
  next.emit("ended"); await playback.ended;
  assert(next.classes.has("is-visible"), "片段结束不清除尾帧");
});

test("取消或解码失败不能隐藏上一段，旧首帧回调不再接管画面", async () => {
  for (const event of ["abort", "error"]) {
    const controller = new AbortController();
    const old = new Video(); old.classList.add("is-visible");
    const next = new Video(); const p = playVideo(next, old, controller.signal);
    const lateFrame = next.frame;
    event === "abort" ? controller.abort() : next.emit("error");
    await assert.rejects(p.started); await assert.rejects(p.ended);
    lateFrame();
    assert(old.classes.has("is-visible")); assert(!next.classes.has("is-visible"));
    assert(next.paused);
  }
});

test("已取消的缓冲不会修改 src，播放中取消及时退出", async () => {
  const controller = new AbortController(); controller.abort();
  const video = new Video();
  await assert.rejects(bufferVideo(video, "new.mp4", controller.signal));
  assert.equal(video.src, undefined);
  const active = new AbortController(); const p = playVideo(video, null, active.signal);
  video.frame(); await p.started; active.abort(); await assert.rejects(p.ended);
});

test("视频成功/部分失败/跳过都只应用一次规则事件，残余伤害不算招式命中", () => {
  const events = [
    { type: "move" }, { type: "damage", source: "thunderbolt" },
    { type: "move" }, { type: "stat" }, { type: "damage", source: "burn" }, { type: "result" },
  ];
  const seen = []; const cursor = createCinemaEventCursor(events, [{ id: "a" }, { id: "b" }], e => seen.push(e));
  cursor.start("a"); assert.equal(seen.length, 1);
  cursor.impact("a"); cursor.impact("a"); assert.equal(seen.length, 2);
  cursor.start("b"); cursor.impact("b"); assert.equal(seen.length, 4);
  cursor.finish(); cursor.finish(); assert.deepEqual(seen, events);
});

test("实时分镜使用精简节奏、明确双物种，镜头和结算结果可被服务端重新核验", () => {
  const result = resolveTurn(createBattle(), { type: "move", moveIndex: 0 }, () => 0.5, { type: "move", moveIndex: 0 });
  const attacks = buildAttackRecords(result.events);
  const plan = createRealtimeStoryboard(attacks, null, true);
  assert.equal(plan.turn.sequence.length, attacks.length);
  assert.equal(plan.turn.sequence[0].impactAt, 2.6);
  assert.match(plan.turn.sequence[0].motionPrompt, /ORANGE bipedal lizard/);
  assert.doesNotMatch(plan.turn.sequence[0].motionPrompt, /Create a fresh establishing/);
  assert.doesNotThrow(() => normalizeStoryboardPlan({ version: 2, sequence: plan.turn.sequence }, attacks));
});

test("真实引擎：先手命中不吞掉下一位的混乱自伤、醒来或麻痹跳过", () => {
  for (const condition of ["confusion", "sleep", "paralysis"]) {
    const battle = createBattle();
    const target = battle.opponent.team[0];
    if (condition === "confusion") target.volatile.confusedTurns = 3;
    else { target.status = condition; target.statusTurns = 1; }
    const result = resolveTurn(battle, { type: "move", moveIndex: 1 }, () => 0.1, { type: "move", moveIndex: 0 });
    const attacks = buildAttackRecords(result.events);
    const seen = [];
    const cursor = createCinemaEventCursor(result.events, attacks, e => seen.push(e));
    cursor.start(attacks[0].id); cursor.impact(attacks[0].id);
    assert(seen.some(e => e.type === "damage" && e.source === "quickAttack"));
    assert(!seen.some(e => e.actionSide === "opponent"));
    cursor.finish();
    assert.deepEqual(seen, result.events);
  }
});

test("下一段缓冲在本段失败后被取消，不会在下一轮加载晚到资源", async () => {
  const run = new AbortController();
  const slot = new Video();
  const stale = bufferVideo(slot, "old-next.mp4", run.signal);
  run.abort();
  await assert.rejects(stale);
  const fresh = bufferVideo(slot, "new-opening.mp4", new AbortController().signal);
  slot.emit("canplay"); await fresh;
  assert.equal(slot.src, "new-opening.mp4");
});

test("战斗播放器属于原战场，不再使用 dialog，生成与过渡并行", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<dialog[^>]*attack/);
  assert.match(html, /id="battle-stage"[\s\S]*id="attack-video-stage"[\s\S]*id="move-flash"/);
  assert.doesNotMatch(app, /attackVideo\.showModal/);
  assert(app.indexOf("let preparation = prepare(0)") < app.indexOf("await run.bridgeDone"));
});

test("演出期间隐藏双方血量面板，清理演出后恢复且不改变结算", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(css, /\.battle-stage\.is-cinema-active \.status-card\s*\{[^}]*visibility:\s*hidden/);
  assert.match(app, /function beginCinema\(command,[\s\S]*?classList\.add\("is-cinema-active"\)/);
  assert.match(app, /function clearCinema\([\s\S]*?classList\.remove\("is-cinema-active"\)/);
});
