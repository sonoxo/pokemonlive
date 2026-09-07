import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractVideoTailFrame } from "../src/video-tail-frame.js";
import { extractVideoTailFrameRange, supportsTailRange } from "../src/video-tail-range.js";
import { VideoMediaCache } from "../src/video-media-cache.js";

const url = "https://v3.fal.media/test.mp4";
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function rangeFetch(video, requests = []) {
  return async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Accept-Encoding"], "identity");
    const [start, requestedEnd] = options.headers.Range.match(/\d+/g).map(Number);
    const end = Math.min(video.length - 1, requestedEnd);
    requests.push([start, end]);
    return new Response(video.subarray(start, end + 1), { status: 206, headers: {
      "content-range": `bytes ${start}-${end}/${video.length}`, "content-length": String(end - start + 1), etag: '"immutable"',
    } });
  };
}

test("Range 严格保留真实最后一帧：含 B 帧和音轨，moov 在头/尾均可 seek", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-range-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const faststart of [true, false]) {
    const path = join(directory, `${faststart}.mp4`);
    const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=832x480:r=24:d=5.167",
      "-f", "lavfi", "-i", "sine=frequency=400:duration=5.167", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-g", "48", "-bf", "3", "-c:a", "aac", ...(faststart ? ["-movflags", "+faststart"] : []), path]);
    assert.equal(made.status, 0, made.stderr?.toString());
    const video = await readFile(path), requests = []; let stats;
    const full = await extractVideoTailFrame(url, { fetchImpl: async () => new Response(video) });
    const partial = await extractVideoTailFrameRange(url, { fetchImpl: rangeFetch(video, requests), onMetrics: value => { stats = value; } });
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), Buffer.from(await full.arrayBuffer()));
    assert(stats.rangeBytes < video.length, `${stats.rangeBytes} < ${video.length}`);
    assert(requests.some(([start]) => start > video.length / 2), "跳过中间片段，寻址末段关键帧");
    assert.equal(requests.filter(([start]) => start === 0).length, 1, "复用元信息读取");
    {
      const ranges = [], gate = defer(); let tailReady = false;
      const cache = new VideoMediaCache({ fetchImpl: async (source, options) => {
        assert(options.headers.Range, "禁止额外的全量 GET");
        // Hold archive filling after the tail has been returned.
        if (tailReady) await gate.promise;
        return rangeFetch(video, ranges)(source, options);
      } });
      const entry = cache.pin(url);
      const early = await cache.tail(url);
      tailReady = true;
      assert.equal(entry.settled, false, "只收到文件头时就能完成真实尾帧解码");
      assert.deepEqual(Buffer.from(await early.arrayBuffer()), Buffer.from(await full.arrayBuffer()));
      assert.equal(entry.timings.tailSource, "range");
      assert.equal(entry.timings.rangeReusedPrefixBytes, 128 * 1024);
      assert.equal(ranges.filter(([start]) => start === 0).length, 1, "文件头只下载一次");
      assert.equal(entry.readers, 0); assert.equal(entry.listeners.size, 0);
      gate.resolve(); assert.deepEqual(await entry.bytes, video);
      const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
      assert.equal(sorted.reduce((bytes, [start, end]) => bytes + end - start + 1, 0), video.length);
      sorted.slice(1).forEach(([start], i) => assert.equal(start, sorted[i][1] + 1, "无重叠、无缺口"));
    }
  }
});

test("不支持 Range 或响应不合法时不读取整片、不跟随重定向", async () => {
  for (const [status, headers] of [[200, {}], [302, { location: "http://127.0.0.1/private" }],
    [206, { "content-range": "bytes 1-5/6" }], [206, { "content-range": "bytes 0-9/10", "content-length": "2" }],
    [206, { "content-range": "bytes 0-65535/999999999" }],
    [206, { "content-range": "bytes 0-9/10", "content-encoding": "gzip" }]]) {
    let cancelled = false;
    const fetchImpl = async (_url, options) => {
      assert.equal(options.redirect, "error");
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers });
    };
    await assert.rejects(extractVideoTailFrameRange(url, { fetchImpl }), /TAIL_RANGE/);
    assert(cancelled);
  }
  await assert.rejects(extractVideoTailFrameRange(url, { fetchImpl: async () => new Response("short", {
    status: 206, headers: { "content-range": "bytes 0-9/10" },
  }) }), /LENGTH_MISMATCH/);
});

test("Range 只允许 fal HTTPS CDN，超时和取消会退出读取", async () => {
  for (const value of ["file:///etc/passwd", "http://v3.fal.media/a", "https://fal.media.evil/a", "https://127.0.0.1/a",
    "https://user:pass@v3.fal.media/a", "https://v3.fal.media:8080/a"]) assert.equal(supportsTailRange(value), false);
  let requests = 0;
  await assert.rejects(extractVideoTailFrameRange("https://example.com/a", { fetchImpl: () => { requests++; } }), /SOURCE_UNSUPPORTED/);
  assert.equal(requests, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractVideoTailFrameRange(url, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(extractVideoTailFrameRange(url, { timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) }), { name: "AbortError" });
});
