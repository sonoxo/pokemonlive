import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { VideoMediaCache } from "../src/video-media-cache.js";
import { sendDownloadingVideo } from "../src/local-video-response.js";

const url = "https://v3.fal.media/shared.mp4";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("真实HTTP播放器的重叠Range和归档只共用一个上游GET，先返回前缀再完成整片", { timeout: 5000 }, async t => {
  let stream, calls = 0;
  const cache = new VideoMediaCache({ fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.headers?.Range, undefined); assert.equal(options.redirect, "error");
    return new Response(new ReadableStream({ start(c) { stream = c; } }), { headers: { "content-length": "10" } });
  } });
  const entry = cache.pin(url);
  const server = createServer((req, res) => { void sendDownloadingVideo(req, res, cache.prepare(url)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cache.unpin(url); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const local = `http://127.0.0.1:${server.address().port}`;
  stream.enqueue(Buffer.from("01234"));
  const a = await fetch(local, { headers: { Range: "bytes=0-3" } });
  const b = await fetch(local, { headers: { Range: "bytes=2-4" } });
  assert.equal(a.status, 206); assert.equal(await a.text(), "0123"); assert.equal(await b.text(), "234");
  assert.equal(entry.settled, false); assert.equal(calls, 1);
  const head = await fetch(local, { method: "HEAD", headers: { Range: "bytes=-3" } });
  assert.equal(head.status, 206); assert.equal(head.headers.get("content-range"), "bytes 7-9/10");
  const bad = await fetch(local, { headers: { Range: "bytes=30-" } }); assert.equal(bad.status, 416);
  const stopped = await fetch(local, { headers: { Range: "bytes=0-" } }); await stopped.body.cancel();
  stream.enqueue(Buffer.from("56789")); stream.close();
  assert.equal((await entry.bytes).toString(), "0123456789");
  const suffix = await fetch(local, { headers: { Range: "bytes=-3" } }); assert.equal(await suffix.text(), "789");
  assert.equal(calls, 1); assert.equal(entry.timings.downloadMode, "single-get");
  assert.equal(cache.tail, undefined);
});

test("GET没有Content-Length时等实际文件完成后正确服务后缀，不重新下载", { timeout: 5000 }, async t => {
  let stream, calls = 0;
  const cache = new VideoMediaCache({ fetchImpl: async () => {
    calls++; return new Response(new ReadableStream({ start(c) { stream = c; } }));
  } });
  const entry = cache.pin(url);
  const server = createServer((req, res) => { void sendDownloadingVideo(req, res, entry); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cache.unpin(url); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let finished = false;
  const request = fetch(`http://127.0.0.1:${server.address().port}`, { headers: { Range: "bytes=-3" } }).then(async r => { finished = true; return r.text(); });
  stream.enqueue(Buffer.from("01234")); await tick(); assert.equal(finished, false);
  stream.enqueue(Buffer.from("56789")); stream.close(); assert.equal(await request, "789"); assert.equal(calls, 1);
});

test("整片GET拒绝部分响应、重定向和超限正文，取消流且失败不再请求", async () => {
  for (const [status, headers, message] of [
    [206, { "content-length": "2" }, /HTTP_206/],
    [302, { location: "https://other.example/video" }, /HTTP_302/],
    [200, { "content-length": "100" }, /TOO_LARGE/],
    [200, {}, /TOO_LARGE/],
  ]) {
    let calls = 0, cancelled = false;
    const cache = new VideoMediaCache({ maxVideoBytes: 4, fetchImpl: async () => {
      calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from("too large")); }, cancel() { cancelled = true; } }), { status, headers });
    } });
    await assert.rejects(cache.bytes(url), message); await assert.rejects(cache.bytes(url), message);
    assert.equal(calls, 1); assert.equal(cancelled, true); assert.equal(cache.entries.get(url).chunks.length, 0);
  }
});

test("生产代码不再导入上游Range模块，但仍返回浏览器可用的本地Range响应", async () => {
  const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  for (const path of ["server.mjs", "src/video-media-cache.js", "src/local-video-response.js"]) {
    assert.doesNotMatch(await source(path), /video-tail-range|video-range-source|rangeOnly|entry\.readRange/);
  }
  assert.doesNotMatch(await source("src/video-media-cache.js"), /extractVideoTailFrame|extractTail|tailExtractor/);
  assert.match(await source("server.mjs"), /tailFrameExtractor: \(url, options\) => attackTailFrames\.url\(url, options\)/);
  assert.match(await source("src/local-video-response.js"), /"Accept-Ranges": "bytes"/);
});
