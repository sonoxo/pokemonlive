import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoMediaCache } from "../src/video-media-cache.js";
import { sendLocalVideo, sendDownloadingVideo } from "../src/local-video-response.js";
import { EventEmitter } from "node:events";
import { archiveAttackClip } from "../server.mjs";

const url = "https://example.com/paid.mp4";
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const imageUrl = "https://example.com/tail.jpg";
// Offline cloud URL/JPEG stand-ins; never call a provider from these tests.
const cloudArchiveTail = {
  tailFrames: { url: async () => imageUrl },
  fetchTail: async () => Buffer.from("tail"),
};

test("归档和播放器共享一次下载，下载和落盘未完成不挡云端尾帧", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const download = defer(), disk = defer(), continuity = defer();
  let downloads = 0, archived = false;
  const cache = new VideoMediaCache({ fetchImpl: async () => { downloads++; await download.promise; return new Response("paid video"); } });
  const archive = archiveAttackClip({ session: { id: "test" }, clip: { index: 0, videoUrl: url }, prompt: "test" }, {
    directory, cache, ...cloudArchiveTail, continuity: { resolveTail: continuity.resolve },
    writeArtifact: async (...args) => { await disk.promise; return writeFile(...args); },
  }).then(() => { archived = true; });
  const playback = cache.bytes(url);
  assert.equal(await continuity.promise, imageUrl);
  assert.equal(cache.entries.get(url).settled, false);
  download.resolve();
  assert.equal((await playback).toString(), "paid video");
  assert.equal(archived, false);
  assert.equal(downloads, 1);
  disk.resolve(); await archive;
  assert.equal((await readFile(join(directory, "clip-0-tail.jpg"))).toString(), "tail");
  assert.equal(cache.entries.size, 0, "归档后不长期保留整片视频内存");
});

test("磁盘归档失败不会抢先把仍在提取的共享尾帧清空", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-media-fail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tail = defer(), continuity = defer(), diskFailed = defer();
  const cache = new VideoMediaCache({ fetchImpl: async () => new Response("video") });
  const archive = archiveAttackClip({ session: { id: "test" }, clip: { index: 0, videoUrl: url } }, {
    directory, cache, ...cloudArchiveTail, tailFrames: { url: () => tail.promise },
    continuity: { resolveTail: continuity.resolve }, writeArtifact: async () => { diskFailed.resolve(); throw new Error("disk full"); },
  });
  await diskFailed.promise;
  tail.resolve(imageUrl);
  assert.equal(await continuity.promise, imageUrl);
  await assert.rejects(archive, /disk full/);
  assert.equal((await cache.bytes(url)).toString(), "video");
});

test("归档仍在写盘时，容量或TTL淘汰不能移走共享资源或触发再次下载", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-media-pinned-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const disk = defer(); let downloads = 0, now = 0;
  const cache = new VideoMediaCache({ maxCacheBytes: 4, ttlMs: 10, now: () => now,
    fetchImpl: async () => { downloads++; return new Response("1234"); } });
  const archive = archiveAttackClip({ session: { id: "test" }, clip: { index: 0, videoUrl: url } }, {
    cache, directory, ...cloudArchiveTail, writeArtifact: async (...args) => { await disk.promise; return writeFile(...args); },
  });
  await cache.bytes(url);
  now = 11; await cache.bytes(`${url}?pressure`); cache.trim();
  assert(cache.entries.has(url));
  assert.equal((await cache.bytes(url)).toString(), "1234");
  assert.equal(downloads, 2);
  disk.resolve(); await archive;
  assert(!cache.entries.has(url));
});

test("取消单个共享消费者立即退出，不取消下载和其它媒体消费者", async () => {
  const download = defer(); let downloads = 0;
  const cache = new VideoMediaCache({ fetchImpl: async () => { downloads++; await download.promise; return new Response("video"); } });
  const controller = new AbortController();
  const cancelled = cache.bytes(url, { signal: controller.signal });
  const surviving = cache.bytes(url);
  controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  download.resolve(); assert.equal((await surviving).toString(), "video");
  assert.equal(downloads, 1);
});

test("共享下载限制大小、拒绝非HTTPS来源；失败不重复下载", async () => {
  let downloads = 0;
  const cache = new VideoMediaCache({ maxVideoBytes: 4,
    fetchImpl: async () => { downloads++; return new Response("too large"); } });
  await assert.rejects(cache.bytes(url), /TOO_LARGE/);
  await assert.rejects(cache.bytes(url), /TOO_LARGE/);
  assert.equal(downloads, 1);
  await assert.rejects(cache.bytes("file:///etc/passwd"), /HTTPS/);
  assert.equal(downloads, 1);
});

test("共享下载受超时约束，已完成的缓存受体积和TTL约束", async () => {
  const cache = new VideoMediaCache({ timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  // AbortSignal.timeout is unref'ed; keep a bounded test timer alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(cache.bytes(url), { name: "TimeoutError" }); } finally { clearTimeout(keepAlive); }
  let now = 0;
  const bounded = new VideoMediaCache({ fetchImpl: async () => new Response("1234"), maxCacheBytes: 4, ttlMs: 10, now: () => now });
  await bounded.bytes(url); await bounded.bytes(`${url}?second`);
  assert.equal(bounded.entries.size, 1);
  now = 11; bounded.trim(); assert.equal(bounded.entries.size, 0);
});

test("本地视频支持首次读取、HEAD、前缀/后缀Range，并拒绝非法范围", async () => {
  const bytes = Buffer.from("0123456789");
  const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } });
  for (const [range, status, body] of [[undefined, 200, "0123456789"], ["bytes=0-1", 206, "01"], ["bytes=7-", 206, "789"], ["bytes=-3", 206, "789"], ["bytes=8-99", 206, "89"]]) {
    const res = response(); await sendLocalVideo({ method: "GET", headers: { range } }, res, { bytes });
    assert.equal(res.status, status); assert.equal(res.body.toString(), body);
    assert.equal(res.headers["Content-Length"], body.length);
  }
  const head = response(); await sendLocalVideo({ method: "HEAD", headers: {} }, head, { bytes });
  assert.equal(head.body, undefined); assert.equal(head.headers["Content-Length"], 10);
  for (const range of ["bytes=20-", "bytes=4-2", "bytes=-0", "bytes=-", "bytes=0-2,5-6", "foo"]) {
    const res = response(); await sendLocalVideo({ method: "GET", headers: { range } }, res, { bytes }); assert.equal(res.status, 416);
  }
});

class StreamingResponse extends EventEmitter {
  constructor() { super(); this.parts = []; this.headersSent = false; this.destroyed = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes) { this.parts.push(Buffer.from(bytes)); this.emit("chunk"); return true; }
  end(bytes) { if (bytes) this.parts.push(Buffer.from(bytes)); this.ended = true; this.emit("finish"); }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("播放器渐进接收共享字节，不等完整下载；断开一个播放器不影响其它消费者", async () => {
  let controller, downloads = 0;
  const cache = new VideoMediaCache({ fetchImpl: async () => { downloads++; return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "content-length": "10" } }); } });
  const entry = cache.pin(url), a = new StreamingResponse(), b = new StreamingResponse();
  const first = deferredChunk(a), second = deferredChunk(b);
  const playing = sendDownloadingVideo({ method: "GET", headers: { range: "bytes=0-" } }, a, entry);
  const other = sendDownloadingVideo({ method: "GET", headers: {} }, b, entry);
  controller.enqueue(new TextEncoder().encode("01234"));
  await Promise.all([first, second]);
  assert.equal(entry.settled, false); assert.equal(a.status, 206);
  assert.equal(Buffer.concat(a.parts).toString(), "01234");
  a.destroy(); await playing;
  const complete = cache.bytes(url);
  controller.enqueue(new TextEncoder().encode("56789")); controller.close();
  await other;
  assert.equal(Buffer.concat(b.parts).toString(), "0123456789");
  assert.equal((await complete).toString(), "0123456789"); assert.equal(downloads, 1);
  assert.equal(entry.listeners.size, 0); assert.equal(entry.readers, 0); assert.equal(entry.chunks.length, 0);
});

function deferredChunk(response) { return new Promise(resolve => response.once("chunk", resolve)); }

test("渐进有限 Range 不再等全片：前缀/中段按字节可用返回、非法范围立即拒绝", async () => {
  let stream;
  const cache = new VideoMediaCache({ fetchImpl: async () => new Response(new ReadableStream({ start(c) { stream = c; } }), {
    headers: { "content-length": "10" },
  }) });
  const entry = cache.pin(url);
  const prefix = new StreamingResponse(), middle = new StreamingResponse();
  const a = sendDownloadingVideo({ method: "GET", headers: { range: "bytes=0-1" } }, prefix, entry);
  const b = sendDownloadingVideo({ method: "GET", headers: { range: "bytes=3-6" } }, middle, entry);
  stream.enqueue(Buffer.from("01234")); await a;
  assert.equal(prefix.status, 206); assert.equal(prefix.headers["Content-Length"], 2);
  assert.equal(Buffer.concat(prefix.parts).toString(), "01"); assert.equal(entry.settled, false);
  const next = deferredChunk(middle);
  stream.enqueue(Buffer.from("567")); await next; await b;
  assert.equal(Buffer.concat(middle.parts).toString(), "3456"); assert.equal(entry.settled, false);
  for (const range of ["bytes=20-", "bytes=4-2", "bytes=-0", "bytes=-", "bytes=0-2,5-6", "foo"]) {
    const response = new StreamingResponse();
    await sendDownloadingVideo({ method: "GET", headers: { range } }, response, entry);
    assert.equal(response.status, 416); assert.equal(entry.settled, false);
  }
  const head = new StreamingResponse();
  await sendDownloadingVideo({ method: "HEAD", headers: { range: "bytes=-3" } }, head, entry);
  assert.equal(head.headers["Content-Range"], "bytes 7-9/10"); assert.equal(head.parts.length, 0);
  const suffix = new StreamingResponse();
  const c = sendDownloadingVideo({ method: "GET", headers: { range: "bytes=-3" } }, suffix, entry);
  stream.enqueue(Buffer.from("89")); await c;
  assert.equal(Buffer.concat(suffix.parts).toString(), "789"); assert.equal(entry.settled, false);
  stream.close(); await entry.bytes;
  assert.equal(entry.readers, 0); assert.equal(entry.listeners.size, 0);
});

test("共享渐进输出的下载失败关闭未完成响应，不发布不完整媒体", async () => {
  let controller;
  const cache = new VideoMediaCache({ fetchImpl: async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "content-length": "10" } }) });
  const entry = cache.pin(url), response = new StreamingResponse();
  const first = deferredChunk(response);
  const output = sendDownloadingVideo({ method: "GET", headers: {} }, response, entry);
  controller.enqueue(new TextEncoder().encode("01234")); await first;
  controller.error(new Error("network interrupted")); await output;
  assert(response.destroyed); assert.equal(response.ended, undefined);
  await assert.rejects(cache.bytes(url), /network interrupted/);
});

test("已声明长度与实际字节不符时拒绝完整媒体发布", async () => {
  const cache = new VideoMediaCache({ fetchImpl: async () => new Response("short", { headers: { "content-length": "10" } }) });
  await assert.rejects(cache.bytes(url), /LENGTH_MISMATCH/);
  await assert.rejects(cache.bytes(url), /LENGTH_MISMATCH/);
});

test("归档目录创建失败时仍等待独立云端尾帧，最终释放媒体引用", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-media-mkdir-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked = join(directory, "file"); await writeFile(blocked, "not a directory");
  let now = 0; const gate = defer(), entered = defer();
  const cache = new VideoMediaCache({ ttlMs: 1, now: () => now, fetchImpl: async () => new Response("video") });
  const continuity = defer();
  const archive = archiveAttackClip({ session: { id: "test" }, clip: { index: 0, videoUrl: url } }, {
    cache, directory: blocked, ...cloudArchiveTail, continuity: { resolveTail: continuity.resolve },
    tailFrames: { url: () => { entered.resolve(); return gate.promise; } },
  });
  const failed = assert.rejects(archive);
  await entered.promise; now = 10; cache.trim(); assert(cache.entries.has(url));
  gate.resolve(imageUrl); assert.equal(await continuity.promise, imageUrl); await failed;
  assert(!cache.entries.has(url));
});
