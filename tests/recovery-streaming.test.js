import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SceneVideoService } from "../src/scene-video-service.js";
import { requestSceneVideo } from "../src/scene-video-client.js";
import { createAppServer } from "../server.mjs";
import { createBattle } from "../src/battle-engine.js";
import { visualScene } from "../src/visual-battle-state.js";
import { FAL_VIDEO_MODEL } from "../src/fal-video-runway.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const input = () => ({ kind: "recovery", scene: visualScene(createBattle()),
  health: { player: { currentHp: 50, maxHp: 110 }, opponent: { currentHp: 50, maxHp: 100 } },
  sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 1 } });

async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-recovery-stream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let stream, submissions = 0, downloads = 0; const first = deferred();
  const service = new SceneVideoService({ directory, loadReferences: async () => [], loadContextImages: async () => [],
    loadAttackAnchor: async () => "data:image/jpeg;base64,dGFpbA==", retryDelayMs: 0,
    tailExtractor: async () => new Blob(["tail"]),
    runwayFactory: hooks => ({
      create() { submissions++; void hooks.submittedSink({ clip: { requestId: "test-id", model: FAL_VIDEO_MODEL } }); return { id: "test" }; },
      get() { return { status: "ready", clips: [{ requestId: "test-id", model: FAL_VIDEO_MODEL, generationMs: 5, videoUrl: "https://v3.fal.media/existing.mp4" }] }; },
      cancel() {},
    }),
    fetchImpl: async (_url, { signal }) => {
      downloads++;
      return new Response(new ReadableStream({ start(c) {
        stream = c; c.enqueue(Buffer.from("0123")); first.resolve();
        signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
      } }), { headers: { "content-length": "10" } });
    },
    ...overrides,
  });
  const job = service.create(input(), "test");
  await first.promise;
  // Allow downloadVideo to deliver its first onChunk (not its final bytes).
  await new Promise(resolve => setImmediate(resolve));
  return { service, job, directory, stream, counts: () => ({ submissions, downloads }) };
}

test("收尾首字节可用就公开同源流；真实 HTTP 有限 Range 提前返回且不发布假完整缓存", async t => {
  const h = await harness(t);
  const { service, job, stream, directory } = h;
  const early = await service.get(job.key);
  assert(early.streamable); assert.equal(early.playable, false);
  assert.equal(early.tailReady, false); assert.equal(early.archiveReady, false);
  assert.equal(early.fallbackVideoUrl, "https://v3.fal.media/existing.mp4");
  assert(early.timings.streamReadyMs >= 0);
  await assert.rejects(readFile(join(directory, job.key, "media.mp4")), { code: "ENOENT" });
  const server = createAppServer({ sceneService: service });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + early.videoUrl, { headers: { Origin: origin, Range: "bytes=0-1" } });
  assert.equal(response.status, 206); assert.equal(await response.text(), "01");
  assert.equal(service.downloading(job.key).settled, false);
  const tail = await fetch(`${origin}/api/scene-videos/${job.key}/tail.jpg`, { headers: { Origin: origin } });
  assert.equal(tail.status, 409);
  const denied = await fetch(origin + early.videoUrl, { headers: { Origin: "https://evil.example" } });
  assert.equal(denied.status, 403);
  stream.enqueue(Buffer.from("456789")); stream.close(); await service.jobs.get(job.key).done;
  const ready = await service.get(job.key);
  assert(ready.playable); assert(ready.tailReady); assert(ready.archiveReady); assert.equal(ready.streamable, false);
  const complete = await fetch(origin + ready.videoUrl, { headers: { Origin: origin, Range: "bytes=3-5" } });
  assert.equal(complete.status, 206); assert.equal(await complete.text(), "345");
  assert.equal((await readFile(join(directory, job.key, "media.mp4"))).toString(), "0123456789");
  assert.deepEqual(h.counts(), { submissions: 1, downloads: 1 });
});

test("提前返回收尾后跳过仍取消下载；迟到数据不发布，下载错误不重买", async t => {
  for (const cancel of [true, false]) {
    const h = await harness(t);
    assert((await h.service.get(h.job.key)).streamable);
    if (cancel) h.service.cancel(h.job.key);
    else h.stream.error(new Error("download interrupted"));
    await h.service.jobs.get(h.job.key).done;
    const failed = await h.service.get(h.job.key);
    assert.equal(failed.status, cancel ? "cancelled" : "error");
    assert.equal(failed.streamable, false); assert.equal(failed.playable, false);
    assert.equal(failed.videoUrl, null); assert.equal(h.service.downloading(h.job.key), null);
    assert.equal(failed.failure, null); assert.deepEqual(h.counts(), { submissions: 1, downloads: 1 });
  }
});

test("客户端只提前返回收尾流且保留取消监听，未加工待机/听令不因 streamable 越过门槛", async () => {
  for (const kind of ["recovery", "idle", "command"]) {
    const controller = new AbortController(); let gets = 0, deletes = 0;
    const initial = { key: "key", kind, status: "generating", streamable: true, playable: false, videoUrl: "media.mp4" };
    const result = await requestSceneVideo({}, controller.signal, async (_url, options = {}) => {
      if (options.method === "DELETE") { deletes++; return new Response("{}"); }
      if (options.method !== "POST") gets++;
      return new Response(JSON.stringify({ ok: true, job: gets ? { ...initial, streamable: false, playable: true } : initial }));
    });
    assert.equal(gets, kind === "recovery" ? 0 : 1);
    assert.equal(result.streamable, kind === "recovery");
    controller.abort(); assert.equal(deletes, kind === "recovery" ? 1 : 0);
  }
});
