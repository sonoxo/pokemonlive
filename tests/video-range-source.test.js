import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoRangeSource } from "../src/video-range-source.js";
import { VideoMediaCache } from "../src/video-media-cache.js";
import { sendDownloadingVideo } from "../src/local-video-response.js";
import { FalVideoRunway } from "../src/fal-video-runway.js";
import { archiveAttackClip } from "../server.mjs";

const url = "https://v3.fal.media/range-only.mp4";
const video = Buffer.alloc(3 * 1024 * 1024 + 73).map((_, index) => index % 251);
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(before = async () => {}) {
  const requests = []; let active = 0, maxActive = 0;
  const fetchImpl = async (_url, options) => {
    assert(options.headers?.Range, "所有 CDN 请求必须携带 Range");
    assert.equal(options.redirect, "error");
    const [start, requestedEnd] = options.headers.Range.match(/\d+/g).map(Number);
    const end = Math.min(requestedEnd, video.length - 1);
    active++; maxActive = Math.max(maxActive, active); requests.push([start, end]);
    await before(start, end); await tick();
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(video.subarray(start, end + 1)); }
      else { active--; controller.close(); }
    } }), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${video.length}`,
      "content-length": String(end - start + 1), etag: '"same-video"' } });
  };
  return { fetchImpl, requests, assertComplete() {
    assert.equal(maxActive, 1, "同一视频的上游下载严格串行");
    const sorted = [...requests].sort((a, b) => a[0] - b[0]);
    assert.equal(sorted[0][0], 0); assert.equal(sorted.at(-1)[1], video.length - 1);
    for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i][0], sorted[i - 1][1] + 1, "没有重复区间/缺口");
    assert.equal(sorted.reduce((total, [start, end]) => total + end - start + 1, 0), video.length);
  } };
}

test("并发尾段/播放器重叠读取及归档仅补洞：串行、零重复字节、完整拼接一致", async () => {
  const network = fixture(), source = new VideoRangeSource(url, network);
  await source.headers;
  const [a, b, bytes] = await Promise.all([
    source.read(video.length - 700000, video.length - 1, { priority: 2 }),
    source.read(video.length - 350000, video.length - 10), source.complete(),
  ]);
  assert.deepEqual(a, video.subarray(video.length - 700000));
  assert.deepEqual(b, video.subarray(video.length - 350000, video.length - 9));
  assert.deepEqual(bytes, video); network.assertComplete();
  const count = network.requests.length;
  assert.deepEqual(await source.read(5, 20), video.subarray(5, 21)); assert.equal(network.requests.length, count);
  await assert.rejects(source.read(video.length, video.length), /INVALID_BOUNDS/);
});

test("归档从实际缺口连续补齐，避免文件对齐造成额外短 Range", async () => {
  const network = fixture(), source = new VideoRangeSource(url, network);
  await source.headers;
  await source.read(video.length - 700000, video.length - 1, { priority: 2 });
  assert.deepEqual(await source.complete(), video);
  assert.deepEqual(network.requests, [
    [0, 131071], [video.length - 700000, video.length - 1],
    [131072, 1179647], [1179648, 2228223], [2228224, video.length - 700001],
  ]);
  network.assertComplete();
});

test("补洞每块完成后让出队列，后到的尾帧不必等整片归档", async () => {
  const gate = defer(), entered = defer();
  const network = fixture(async start => { if (start === 131072) { entered.resolve(); await gate.promise; } });
  const source = new VideoRangeSource(url, network);
  const archive = source.complete();
  await entered.promise;
  const tail = source.read(video.length - 1000, video.length - 1, { priority: 2 });
  gate.resolve(); await tail; await archive;
  assert.equal(network.requests[2][0], video.length - 1000);
  network.assertComplete();
});

test("排队中的尾帧区间优先于后台归档；取消一个等待不取消共享字节", async () => {
  const gate = defer(), entered = defer();
  const network = fixture(async start => { if (start === 0) { entered.resolve(); await gate.promise; } });
  const source = new VideoRangeSource(url, network); await entered.promise;
  const controller = new AbortController();
  const cancelled = source.read(200000, 300000, { signal: controller.signal });
  const archive = source.read(131072, 200000, { priority: 0 });
  const tail = source.read(video.length - 1000, video.length - 1, { priority: 2 });
  controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  gate.resolve(); await Promise.all([tail, archive]);
  assert.equal(network.requests[1][0], video.length - 1000);
  assert.deepEqual(await source.complete(), video); network.assertComplete();
});

test("不支持 Range、无效长度或压缩响应不启动全量 GET，不重发失败片", async () => {
  for (const [status, headers, body] of [
    [200, {}, "ignored"], [302, { location: "http://127.0.0.1/private" }, "redirect"],
    [206, { "content-range": "bytes 1-5/6" }, "wrong"],
    [206, { "content-range": "bytes 0-9/10", "content-length": "3" }, "bad"],
    [206, { "content-range": "bytes 0-9/10", "content-encoding": "gzip" }, "0123456789"],
    [206, { "content-range": "bytes 0-131071/999999999" }, "large"],
    [206, { "content-range": "bytes 0-9/10" }, "short"],
    [206, { "content-range": "bytes 0-9/10" }, "01234567890"],
  ]) {
    let calls = 0;
    const source = new VideoRangeSource(url, { fetchImpl: async (_url, options) => {
      calls++; assert(options.headers.Range); return new Response(body, { status, headers });
    } });
    await assert.rejects(source.headers, /VIDEO_RANGE/);
    await assert.rejects(source.complete(), /VIDEO_RANGE/); await assert.rejects(source.read(0, 2), /VIDEO_RANGE/);
    assert.equal(calls, 1);
  }
});

test("跨请求总长或 validator 变化拒绝缓存拼接", async () => {
  for (const changed of ["validator", "size"]) {
    let calls = 0;
    const network = fixture();
    const source = new VideoRangeSource(url, { fetchImpl: async (url, options) => {
      const response = await network.fetchImpl(url, options);
      if (++calls === 2) {
        if (changed === "validator") response.headers.set("etag", '"changed"');
        else response.headers.set("content-range", response.headers.get("content-range").replace(`/${video.length}`, `/${video.length + 1}`));
      }
      return response;
    } });
    await source.headers;
    await assert.rejects(source.complete(), /VIDEO_RANGE/); assert.equal(calls, 2);
  }
});

test("Range-only 超时与来源限制有界退出，不降级为无 Range 请求", async () => {
  assert.throws(() => new VideoRangeSource("http://127.0.0.1/private"), /SOURCE_UNSUPPORTED/);
  const source = new VideoRangeSource(url, { timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(source.complete()); assert.equal(source.error.message, "VIDEO_RANGE_TIMEOUT"); }
  finally { clearTimeout(keepAlive); }
});

test("失败 Range 源释放预分配整片内存，只保留错误、不因再次读取重下", async () => {
  const network = fixture(); let requests = 0;
  const source = new VideoRangeSource(url, { fetchImpl: async (...args) => {
    if (++requests > 1) throw new Error("network interrupted");
    return network.fetchImpl(...args);
  } });
  await source.headers; assert.equal(source.buffer.length, video.length);
  await assert.rejects(source.complete(), /network interrupted/);
  assert.equal(source.buffer, null); assert.deepEqual(source.ranges, []);
  await assert.rejects(source.read(0, 10), /network interrupted/);
  await assert.rejects(source.complete(), /network interrupted/); assert.equal(requests, 2);
});

function cacheFixture(network, extra = {}) {
  return new VideoMediaCache({ fetchImpl: network.fetchImpl, rangeTailExtractor: async (_url, { rangeSource, readPrefix }) => {
    await readPrefix(131072);
    const bytes = await rangeSource.read(video.length - 700000, video.length - 1, { priority: 2 });
    assert.deepEqual(bytes, video.subarray(video.length - 700000));
    return new Blob(["actual tail"]);
  }, ...extra });
}

test("Range 尾帧先到，续段和状态共享；读者取消不影响后续完整归档", async () => {
  const gate = defer(), network = fixture(async start => { if (start === 131072) await gate.promise; });
  const cache = cacheFixture(network), controller = new AbortController();
  const cancelled = cache.tail(url, { signal: controller.signal }), surviving = cache.tail(url);
  controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(await (await surviving).text(), "actual tail");
  const entry = cache.entries.get(url);
  assert.equal(entry.settled, false); assert.equal(entry.timings.tailSource, "range");
  gate.resolve(); assert.deepEqual(await cache.bytes(url), video); network.assertComplete();
  assert.equal(entry.timings.rangeBytes, video.length);
  const count = network.requests.length;
  assert.equal(await (await cache.tail(url)).text(), "actual tail"); assert.equal(network.requests.length, count);
});

test("局部提帧失败后补齐同一 Range 缓存再本地解码，不重新下载文件头/末段", async () => {
  const network = fixture(); let extracts = 0;
  const cache = cacheFixture(network, { rangeTailExtractor: async (_url, { rangeSource }) => {
    await rangeSource.headers; await rangeSource.read(video.length - 500000, video.length - 1);
    throw new Error("TAIL_RANGE_BUDGET_EXCEEDED");
  }, tailExtractor: async (_url, { fetchImpl }) => {
    extracts++; assert.deepEqual(Buffer.from(await (await fetchImpl()).arrayBuffer()), video); return new Blob(["fallback tail"]);
  } });
  assert.equal(await (await cache.tail(url)).text(), "fallback tail"); assert.equal(extracts, 1);
  assert.equal(cache.entries.get(url).timings.tailSource, "range-complete"); network.assertComplete();
});

test("Range 下载失败不会发布完整媒体或尾帧、不会重买或重新下载", async () => {
  let requests = 0, extracts = 0;
  const cache = new VideoMediaCache({ fetchImpl: async () => { requests++; return new Response("no range"); },
    tailExtractor: async () => { extracts++; return new Blob(); } });
  await assert.rejects(cache.tail(url), /VIDEO_RANGE_UNSUPPORTED/);
  await assert.rejects(cache.bytes(url), /VIDEO_RANGE_UNSUPPORTED/);
  assert.equal(requests, 1); assert.equal(extracts, 0); assert(cache.entries.get(url).error);
});

class ResponseMock extends EventEmitter {
  constructor() { super(); this.parts = []; }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes) { this.parts.push(Buffer.from(bytes)); this.emit("chunk"); return true; }
  end(bytes) { if (bytes) this.parts.push(Buffer.from(bytes)); this.ended = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("稀疏播放前缀/中段/后缀/HEAD/非法 Range 正确，多个播放者和归档不重复上游", async () => {
  const gate = defer(), network = fixture();
  const cache = cacheFixture(network, { rangeTailExtractor: async () => { await gate.promise; return new Blob(["tail"]); } });
  const entry = cache.pin(url);
  const cases = [["bytes=0-1", 0, 1], ["bytes=200000-500000", 200000, 500000], ["bytes=-200000", video.length - 200000, video.length - 1]];
  await Promise.all(cases.map(async ([range, start, end]) => {
    const response = new ResponseMock(); await sendDownloadingVideo({ method: "GET", headers: { range } }, response, entry);
    assert.equal(response.status, 206); assert.deepEqual(Buffer.concat(response.parts), video.subarray(start, end + 1));
    assert.equal(entry.settled, false);
  }));
  const count = network.requests.length;
  for (const [method, range, status] of [["HEAD", "bytes=-3", 206], ["GET", "bytes=-0", 416], ["GET", "bytes=9-2", 416], ["GET", "bytes=0-2,5-8", 416]]) {
    const response = new ResponseMock(); await sendDownloadingVideo({ method, headers: { range } }, response, entry);
    assert.equal(response.status, status); assert.equal(response.parts.length, 0);
  }
  assert.equal(network.requests.length, count); assert.equal(entry.readers, 0);
  const player = new ResponseMock(), closed = new ResponseMock(); closed.once("chunk", () => closed.destroy());
  const streams = [player, closed].map(response => sendDownloadingVideo({ method: "GET", headers: {} }, response, entry));
  gate.resolve(); await Promise.all(streams); assert.deepEqual(Buffer.concat(player.parts), video);
  await entry.bytes; network.assertComplete(); assert.equal(entry.readers, 0);
});

test("真实跑道在 Range 尾帧到达时提交第二片，不等补洞且 seed 与实际尾帧不变", { timeout: 2000 }, async () => {
  const gate = defer(), second = defer(), inputs = [];
  const network = fixture(async start => { if (start === 131072) await gate.promise; });
  const cache = cacheFixture(network);
  const runway = new FalVideoRunway({ clientFactory: () => ({ queue: {
    async submit(_model, { input }) { inputs.push(input); if (inputs.length === 2) second.resolve(); return { request_id: `test-${inputs.length}` }; },
    async subscribeToStatus() {}, async result() { return { data: { video: { url } } }; },
  } }), tailFrameExtractor: (source, options) => cache.tail(source, options),
  tailFrameUploader: async (_client, frame) => `data:image/jpeg;base64,${Buffer.from(await frame.arrayBuffer()).toString("base64")}` });
  runway.create({ credentials: "test", openingFrame: "data:image/jpeg;base64,b3Blbg==", referenceImages: [
    { side: "player", speciesId: "pikachu", name: "皮卡丘", imageUrl: "data:image/png;base64,cGxheWVy" },
    { side: "opponent", speciesId: "charmander", name: "小火龙", imageUrl: "data:image/png;base64,b3Bwb25lbnQ=" },
  ], beats: [0, 1].map(index => ({ index, attackId: `attack-${index}`, purpose: "complete", motionPrompt: `beat ${index}`, durationSeconds: 5 })) });
  await second.promise;
  assert.equal(inputs.length, 2); assert.equal(cache.entries.get(url).settled, false);
  assert.equal(inputs[1].image_url, "data:image/jpeg;base64,YWN0dWFsIHRhaWw="); assert(inputs.every(input => input.seed === 42));
  gate.resolve(); await cache.bytes(url); network.assertComplete();
});

test("Range 归档原子写入与释放前保护 TTL；落盘失败保留可复用媒体", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-range-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const fail of [false, true]) {
    const gate = defer(), network = fixture(); let now = 0;
    const cache = cacheFixture(network, { ttlMs: 10, now: () => now });
    const archive = archiveAttackClip({ session: { id: "fixture" }, clip: { index: 0, videoUrl: url } }, {
      cache, directory, tailFrames: { url: async () => "https://v3.fal.media/test-tail.jpg" }, fetchTail: async () => Buffer.from("tail"),
      writeArtifact: async (path, bytes) => { await gate.promise; if (fail) throw new Error("disk full"); await writeFile(path, bytes); },
    });
    const result = archive.then(() => null, error => error);
    await cache.bytes(url); now = 11; cache.trim(); assert(cache.entries.has(url));
    assert.deepEqual(await cache.bytes(url), video); gate.resolve();
    const error = await result;
    if (fail) assert.match(error.message, /disk full/);
    else { assert.equal(error, null); assert.deepEqual(await readFile(join(directory, "clip-0.mp4")), video); }
    network.assertComplete();
  }
});
