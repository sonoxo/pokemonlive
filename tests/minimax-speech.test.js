import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechCache, speechSpec, synthesizeSpeech, SPEECH_MODEL, SPEECH_VOICE } from "../src/minimax-speech.js";
import { BattleNarrator } from "../src/battle-narrator.js";

const line = "皮卡丘，使用十万伏特！", secondLine = "皮卡丘，使用铁尾！";
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Socket extends EventEmitter {
  sent = []; terminated = false; closed = false;
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; }
  terminate() { this.terminated = true; }
  message(data) { this.emit("message", Buffer.from(JSON.stringify(data))); }
}
function connection(options = {}) {
  const socket = new Socket();
  const promise = synthesizeSpeech(line, "private-test-key", { ...options, connect: (url, config) => {
    assert.equal(url, "wss://api.minimax.cn/ws/v1/t2a_v2");
    assert.equal(config.headers.Authorization, "Bearer private-test-key");
    assert.equal(config.followRedirects, false);
    return socket;
  } });
  return { socket, promise };
}
function start(socket) {
  socket.message({ event: "connected_success", base_resp: { status_code: 0 } });
  socket.message({ event: "task_started", base_resp: { status_code: 0 } });
}

test("MiniMax WS 在真实任务确认后发送文本，按顺序拼接且等 task_finished 才发布", async () => {
  const { socket, promise } = connection();
  assert.equal(socket.sent.length, 0);
  socket.message({ event: "connected_success" });
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].model, SPEECH_MODEL);
  assert.equal(socket.sent[0].voice_setting.voice_id, SPEECH_VOICE);
  assert.equal(socket.sent[0].voice_setting.speed, 1.1);
  assert.equal(socket.sent[0].voice_setting.pitch, 2);
  assert.equal(socket.sent[0].voice_setting.emotion, "happy");
  socket.message({ event: "task_started" });
  assert.deepEqual(socket.sent.slice(1), [{ event: "task_continue", text: line }, { event: "task_finish" }]);
  let complete = false; promise.then(() => { complete = true; });
  socket.message({ data: { audio: "494433" } });
  socket.message({ data: { audio: "0102" }, is_final: true });
  await Promise.resolve(); assert.equal(complete, false);
  socket.message({ event: "task_finished" });
  const result = await promise;
  assert.equal(result.bytes.toString("hex"), "4944330102");
  assert(result.timings.firstAudioMs >= 0); assert(result.timings.totalMs >= result.timings.firstAudioMs);
  assert.equal(socket.closed, true);
});

test("WS 错误/提前断开/畸形音频/超限/空结果不会发布音频或泄露上游错误", async () => {
  for (const mode of ["rejected", "close", "invalid", "too-large", "empty", "json"]) {
    const { socket, promise } = connection();
    const rejected = assert.rejects(promise, error => { assert.match(error.message, /^MINIMAX_TTS_/); assert(!error.message.includes("private-test-key")); return true; });
    start(socket);
    if (mode === "rejected") socket.message({ event: "task_failed", base_resp: { status_code: 1004, status_msg: "private-test-key" } });
    if (mode === "close") { socket.message({ data: { audio: "abcd" } }); socket.emit("close"); }
    if (mode === "invalid") socket.message({ data: { audio: "abc" } });
    if (mode === "too-large") socket.message({ data: { audio: "aa".repeat(2 * 1024 * 1024 + 1) } });
    if (mode === "empty") socket.message({ event: "task_finished" });
    if (mode === "json") socket.emit("message", Buffer.from("bad json"));
    await rejected; assert(socket.terminated);
  }
  const { promise, socket } = connection({ timeoutMs: 10 });
  await assert.rejects(promise, /TIMEOUT/); assert(socket.terminated);
});

test("付费前仅接受游戏台词，不接受对手登场、外部文本或路径；缓存键稳定", () => {
  for (const text of [null, "", "任意小说", "露营少年 阿岚派出了小拳石！", "../key", `${line} `]) assert.throws(() => speechSpec(text));
  assert.equal(speechSpec(line).key, speechSpec(line).key);
  assert.notEqual(speechSpec(line).key, speechSpec(secondLine).key);
  assert(speechSpec("回来吧，皮卡丘！去吧，杰尼龟！"));
});

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-speech-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("同台词并发购买一次；完整 MP3 跨实例缓存，缓存不读 Key", async t => {
  const directory = await temp(t), done = defer(); let calls = 0;
  const cache = new SpeechCache({ directory, synthesize: async () => { calls++; await done.promise; return { bytes: Buffer.from("mp3"), timings: { totalMs: 800 } }; } });
  const jobs = Array.from({ length: 5 }, () => cache.get(line, async () => "key"));
  done.resolve(); const results = await Promise.all(jobs);
  assert.equal(calls, 1); assert(results.every(r => r.bytes.toString() === "mp3"));
  const restarted = new SpeechCache({ directory });
  assert.equal((await restarted.get(line, () => { throw Error("must not read key"); })).cached, true);
});

test("已合成但磁盘归档失败时保留可播放字节，重试只写盘不再次付费", async t => {
  const directory = await temp(t); let calls = 0, diskBroken = true;
  const cache = new SpeechCache({ directory,
    synthesize: async () => { calls++; return { bytes: Buffer.from("paid-mp3"), timings: {} }; },
    writeArtifact: async (path, bytes) => { if (diskBroken) throw Error("disk full"); await writeFile(path, bytes); },
  });
  const first = await cache.get(line, async () => "key");
  assert.equal(first.archiveWarning, true); assert.equal(first.bytes.toString(), "paid-mp3");
  assert.equal((await cache.get(line, () => { throw Error("no new key"); })).cached, true);
  diskBroken = false;
  await cache.get(line, () => { throw Error("no new purchase"); });
  assert.equal(calls, 1); assert.equal(cache.unarchived.size, 0);
  assert.equal((await new SpeechCache({ directory }).get(line, () => { throw Error("cached"); })).cached, true);
});

test("仅允许两个不同在途任务；无目录写权限时付费前失败", async t => {
  const directory = await temp(t), done = defer(); let calls = 0;
  const cache = new SpeechCache({ directory, synthesize: async () => { calls++; await done.promise; return { bytes: Buffer.from("mp3") }; } });
  const jobs = [cache.get(line, async () => "key"), cache.get(secondLine, async () => "key")];
  await assert.rejects(cache.get("皮卡丘，使用电光一闪！", async () => "key"), /BUSY/);
  done.resolve(); await Promise.all(jobs); assert.equal(calls, 2);
  const file = join(directory, "not-directory"); await writeFile(file, "file");
  const bad = new SpeechCache({ directory: join(file, "child"), synthesize: async () => { throw Error("must not spend"); } });
  await assert.rejects(bad.get(line, () => { throw Error("must not spend"); }), /CACHE_READ_FAILED/);
});

class Context {
  state = "running"; started = []; stopped = 0; destination = {};
  resume() { return Promise.resolve(); }
  decodeAudioData(bytes) { return Promise.resolve(bytes); }
  createBufferSource() {
    const context = this;
    return { connect() {}, disconnect() {}, start() { context.started.push(this.buffer); }, stop() { context.stopped++; } };
  }
}
const audioResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } });

test("客户端异步合成可播放，停止/外部取消立刻终止声音，不调用系统语音", async () => {
  const context = new Context(), marks = [], controller = new AbortController(); let payload;
  const narrator = new BattleNarrator({ createContext: () => context, fetchImpl: async (url, options) => {
    assert.equal(url, "/api/battle-speech"); payload = JSON.parse(options.body); return audioResponse();
  } });
  await narrator.speak(line, { signal: controller.signal, onMark: m => marks.push(m) });
  assert.deepEqual(payload, { text: line, language: "zh" }); assert.equal(context.started.length, 1);
  assert.deepEqual(marks, ["voice_requested", "voice_ready", "voice_playing"]);
  controller.abort(); assert.equal(context.stopped, 1); assert.equal(narrator.current, null);
});

test("取消下载或解码期间，新回合不能被旧语音迟到回调抢播", async () => {
  for (const stage of ["fetch", "decode"]) {
    const context = new Context(), wait = defer(); let count = 0;
    if (stage === "decode") context.decodeAudioData = async bytes => { if (++count === 1) await wait.promise; return bytes; };
    const narrator = new BattleNarrator({ createContext: () => context, fetchImpl: async () => {
      if (stage === "fetch" && ++count === 1) await wait.promise;
      return audioResponse();
    } });
    const first = narrator.speak(line);
    await new Promise(r => setImmediate(r));
    narrator.stop();
    await narrator.speak(secondLine);
    wait.resolve(); await first;
    assert.equal(context.started.length, 1);
    narrator.stop();
  }
});

test("自动播放被拦时提示开启声音；用户操作可续播，但过期语音不能复活", async () => {
  const context = new Context(); context.state = "suspended";
  let blocked = 0, allowResume = false;
  context.resume = async () => { if (allowResume) context.state = "running"; };
  const narrator = new BattleNarrator({ createContext: () => context, fetchImpl: async () => audioResponse(), maxWaitMs: 40 });
  await narrator.speak(line, { onBlocked: () => blocked++ });
  assert.equal(context.started.length, 0); assert(blocked > 0);
  allowResume = true; narrator.resume(); await new Promise(r => setImmediate(r));
  assert.equal(context.started.length, 1); narrator.stop();
  context.state = "suspended"; allowResume = false;
  await narrator.speak(line); await new Promise(r => setTimeout(r, 50));
  allowResume = true; narrator.resume(); await new Promise(r => setImmediate(r));
  assert.equal(context.started.length, 1);
});

test("请求超时或错误只取消播报，不阻断外部战斗；已取消请求不会提交", async () => {
  const wait = defer(), context = new Context(), marks = [];
  const narrator = new BattleNarrator({ createContext: () => context, fetchImpl: () => wait.promise, maxWaitMs: 10 });
  const controller = new AbortController();
  const pending = narrator.speak(line, { signal: controller.signal, onMark: m => marks.push(m) });
  await new Promise(r => setTimeout(r, 20)); wait.resolve(audioResponse()); await pending;
  assert(marks.includes("voice_late_dropped")); assert.equal(context.started.length, 0); assert(!controller.signal.aborted);
  narrator.fetchImpl = async () => new Response("error", { status: 502 });
  await narrator.speak(line, { onMark: m => marks.push(m) }); assert(marks.includes("voice_failed"));
  controller.abort(); const count = marks.length;
  await narrator.speak(line, { signal: controller.signal, onMark: m => marks.push(m) }); assert.equal(marks.length, count);
});

test("音频设备或播放启动失败不会产生未处理拒绝，也不会卡住语音状态", async () => {
  const context = new Context(), marks = [];
  context.createBufferSource = () => ({ connect() {}, disconnect() {}, start() { throw Error("device closed"); }, stop() { throw Error("not started"); } });
  const narrator = new BattleNarrator({ createContext: () => context, fetchImpl: async () => audioResponse() });
  await narrator.speak(line, { onMark: m => marks.push(m) });
  assert(marks.includes("voice_failed")); assert.equal(narrator.current, null);
});

test("浏览器原生 fetch 不以 BattleNarrator 为 this 调用，避免 Illegal invocation", async () => {
  const source = (await readFile(new URL("../src/battle-narrator.js", import.meta.url), "utf8")).replace("export class", "class");
  const BrowserNarrator = new Function("fetch", `"use strict"; ${source}; return BattleNarrator;`)(function () {
    "use strict";
    assert.equal(this, undefined, "原生浏览器 fetch 必须按全局函数调用");
    return Promise.resolve(audioResponse());
  });
  const context = new Context();
  const narrator = new BrowserNarrator({ createContext: () => context });
  await narrator.speak(line); assert.equal(context.started.length, 1); narrator.stop();
});
