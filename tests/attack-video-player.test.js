import assert from "node:assert/strict";
import test from "node:test";
import { AttackVideoPlayer } from "../src/attack-video-player.js";
import { playVideo } from "../src/inline-cinema.js";
import { playbackSession } from "../server.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
class Video extends EventTarget {
  constructor() {
    super(); this.currentTime = 0; this.readyState = 0; this.paused = true; this.autoFrame = true;
    this.classes = new Set(); this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c) };
    this.style = {}; this.muted = false;
  }
  setAttribute() {}
  getAttribute(name) { return this[name]; }
  load() { this.readyState = 0; queueMicrotask(() => this.onLoad ? this.onLoad(this) : this.ready()); }
  ready() { this.readyState = 3; this.emit("loadedmetadata"); this.emit("loadeddata"); this.emit("canplay"); }
  pause() { this.paused = true; }
  play() { this.paused = false; this.emit("playing"); if (this.autoFrame) queueMicrotask(() => this.frame?.()); return Promise.resolve(); }
  requestVideoFrameCallback(fn) { this.frame = fn; return 1; }
  cancelVideoFrameCallback() { this.frame = null; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}
const clip = index => ({ clip: { index, videoUrl: `https://cdn.example/${index}.mp4`, localVideoUrl: `/clips/${index}.mp4` }, session: { id: "session" } });
function setup(options = () => ({})) {
  const controller = new AbortController(), videos = [new Video(), new Video(), new Video()], events = [];
  const player = new AttackVideoPlayer({ videos, signal: controller.signal, configureVideo() {},
    waitForClip: async index => clip(index), mark: (name, index, value) => events.push({ name, index, value }),
    ...options(videos),
  });
  return { controller, videos, events, player };
}

test("第二段在首段未缓冲/未起播时已经预解码，旧尾帧槽位不被覆盖", async () => {
  const { player, videos, controller, events } = setup(videos => ({ protectedVideo: videos[2] }));
  videos[2].classList.add("is-visible"); videos[2].src = "held.mp4";
  videos[0].onLoad = () => {};
  const first = player.prepare(0), next = player.prepare(1);
  assert.equal((await next).value.video, videos[1]);
  assert.equal(videos[0].readyState, 0); assert.equal(videos[2].src, "held.mp4");
  assert(videos[2].classes.has("is-visible"));
  videos[0].ready(); const prepared = await first;
  const playback = player.play(prepared.value, videos[2], { onFrame: () => events.push({ name: "started" }), onTime() {}, onBlocked() {} });
  await playback.started;
  assert(events.findIndex(e => e.name === "clip_buffered" && e.index === 1) < events.findIndex(e => e.name === "started"));
  videos[0].emit("ended"); await playback.ended;
  assert(videos[0].classes.has("is-visible"));
  controller.abort();
});

test("共享本地流初始失败只回退同片CDN，不等待下一片、不隐藏旧帧", async () => {
  const { player, videos, controller, events } = setup(videos => ({ protectedVideo: videos[2] }));
  videos[2].classList.add("is-visible");
  for (const video of videos.slice(0, 2)) video.onLoad = v => v.src.startsWith("/") ? v.emit("error") : v.ready();
  const item = (await player.prepare(0)).value;
  assert.equal(item.video.src, "https://cdn.example/0.mp4"); assert.equal(item.source, "cdn");
  assert(videos[2].classes.has("is-visible"));
  assert.equal(events.filter(e => e.name === "local_buffer_fallback").length, 1);
  controller.abort();
});

test("共享流播放中错误：保持原帧，CDN备用槽从原时间续播，逻辑首帧/伤害不重复", async () => {
  const { player, videos, controller, events } = setup(() => ({}));
  const first = (await player.prepare(0)).value;
  const next = (await player.prepare(1)).value;
  let starts = 0, impacts = 0, applied = false;
  const playback = player.play(first, null, { onFrame: () => starts++, onTime: time => { if (time >= 2 && !applied) { applied = true; impacts++; } }, onBlocked() {} });
  await playback.started;
  const failed = first.video; failed.currentTime = 2.4; failed.emit("timeupdate");
  videos[2].autoFrame = false;
  failed.emit("error"); await tick();
  assert(failed.classes.has("is-visible")); assert(!videos[2].classes.has("is-visible"));
  assert.equal(next.video.src, "/clips/1.mp4");
  assert.equal(videos[2].src, "https://cdn.example/0.mp4"); assert.equal(videos[2].currentTime, 2.4);
  videos[2].frame(); videos[2].emit("timeupdate"); videos[2].emit("ended");
  await playback.ended;
  assert.equal(starts, 1); assert.equal(impacts, 1); assert.equal(first.video, videos[2]);
  assert(events.some(e => e.name === "clip_resumed")); assert(!failed.classes.has("is-visible"));
  controller.abort();
});

test("取消尚未完成的片段准备，不会迟到加载或隐藏上轮尾帧", async () => {
  let ready;
  const { player, videos, controller } = setup(videos => ({ protectedVideo: videos[2], waitForClip: () => new Promise(resolve => { ready = resolve; }) }));
  videos[2].classList.add("is-visible");
  const pending = player.prepare(0); controller.abort(); ready(clip(0));
  assert.equal((await pending).error.name, "AbortError");
  assert(videos.every(v => v.src === undefined)); assert(videos[2].classes.has("is-visible"));
});

test("CDN 及本地都失败时明确退出，不循环下载或重新生成", async () => {
  let loads = 0;
  const { player, videos, controller } = setup(() => ({}));
  for (const video of videos) video.onLoad = v => { loads++; v.emit("error"); };
  const result = await player.prepare(0);
  assert.equal(result.error.message, "VIDEO_BUFFER_FAILED"); assert.equal(loads, 2);
  controller.abort();
});

test("本地缓冲失败后CDN播放失败，不回环重试已失败本地源", async () => {
  const { player, videos, controller } = setup();
  let loads = 0, starts = 0;
  for (const video of videos) video.onLoad = v => { loads++; v.src.startsWith("/") ? v.emit("error") : v.ready(); };
  const item = (await player.prepare(0)).value;
  const playback = player.play(item, null, { onFrame: () => starts++, onTime() {}, onBlocked() {} });
  await playback.started; item.video.emit("error");
  await assert.rejects(playback.ended, /VIDEO_PLAYBACK_FAILED/);
  assert.equal(loads, 2); assert.equal(starts, 1); assert(item.video.classes.has("is-visible"));
  controller.abort();
});

test("本地播放失败后CDN缓冲失败，不覆盖旧帧也不再次购买或重播", async () => {
  const { player, videos, controller } = setup();
  let loads = 0, starts = 0;
  for (const video of videos) video.onLoad = v => { loads++; v.src.startsWith("https:") ? v.emit("error") : v.ready(); };
  const item = (await player.prepare(0)).value;
  const previous = item.video;
  const playback = player.play(item, null, { onFrame: () => starts++, onTime() {}, onBlocked() {} });
  await playback.started; previous.emit("error");
  await assert.rejects(playback.ended, /VIDEO_BUFFER_FAILED/);
  assert.equal(loads, 2); assert.equal(starts, 1); assert(previous.classes.has("is-visible"));
  controller.abort();
});

test("卡顿记录去重、恢复记录耗时；持续卡顿会有界失败且不隐藏当前帧", async () => {
  const video = new Video(), marks = [], signal = new AbortController().signal;
  const playback = playVideo(video, null, signal, { stallTimeoutMs: 5, onStall: (...args) => marks.push(args) });
  await playback.started;
  video.emit("waiting"); video.emit("stalled"); video.emit("playing");
  assert.equal(marks.filter(([name]) => name === "playback_waiting").length, 1);
  assert.equal(marks.filter(([name]) => name === "playback_stall_ms").length, 1);
  video.emit("waiting"); await assert.rejects(playback.ended, /VIDEO_STALL_TIMEOUT/);
  assert(video.classes.has("is-visible"));
});

test("服务端同时发布 CDN 与本地地址，不把生成或存档完成当作浏览器已就绪", () => {
  const session = playbackSession({ id: "id", clips: [{ index: 0, videoUrl: "https://cdn.example/paid.mp4" }, { index: 1, videoUrl: null }] });
  assert.equal(session.clips[0].videoUrl, "https://cdn.example/paid.mp4");
  assert.equal(session.clips[0].localVideoUrl, "/api/attack-videos/id/clips/0.mp4");
  assert.equal(session.clips[1].localVideoUrl, null);
});

test("已 canplay 但首帧永不出现时，独立首帧截止时间有界退出且保留旧帧", async () => {
  const video = new Video(), old = new Video(); video.autoFrame = false;
  old.classList.add("is-visible");
  video.play = () => new Promise(() => {});
  const playback = playVideo(video, old, new AbortController().signal, { frameTimeoutMs: 5 });
  await assert.rejects(playback.started, /VIDEO_FIRST_FRAME_TIMEOUT/);
  await assert.rejects(playback.ended, /VIDEO_FIRST_FRAME_TIMEOUT/);
  assert(old.classes.has("is-visible")); assert(!video.classes.has("is-visible"));
});

test("fal Range-only 素材读取失败不另开 CDN 整片下载，保留旧画面", async () => {
  const session = playbackSession({ id: "id", clips: [{ index: 0, videoUrl: "https://v3.fal.media/paid.mp4" }] });
  assert.equal(session.clips[0].rangeOnly, true);
  const { player, videos, controller, events } = setup(videos => ({ protectedVideo: videos[2],
    waitForClip: async () => ({ clip: session.clips[0], session }),
  }));
  videos[2].classList.add("is-visible");
  const sources = [];
  for (const video of videos) video.onLoad = v => { sources.push(v.src); v.emit("error"); };
  assert.equal((await player.prepare(0)).error.message, "VIDEO_BUFFER_FAILED");
  assert.deepEqual(sources, ["/api/attack-videos/id/clips/0.mp4"]);
  assert(videos[2].classes.has("is-visible")); assert(!events.some(e => e.name.includes("fallback"))); controller.abort();
});
