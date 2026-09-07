import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudTailFrames, FAL_TAIL_FRAME_MODEL, CLOUD_TAIL_TTL_MS } from "../src/cloud-tail-frame.js";
import { FalVideoRunway } from "../src/fal-video-runway.js";
import { VideoMediaCache } from "../src/video-media-cache.js";
import { loadArchivedAttackTail, loadAttackSceneAnchor } from "../src/attack-scene-anchor.js";
import { archiveAttackClip, loadAttackContinuation } from "../server.mjs";
import { createBattle, resolveTurn } from "../src/battle-engine.js";
import { buildAttackRecords, sanitizeAttackRecords, createRealtimeStoryboard } from "../src/attack-storyboard.js";
import { attackVisualScene } from "../src/visual-battle-state.js";

const videoUrl = "https://v3.fal.media/test-clip.mp4", imageUrl = "https://v3.fal.media/test-tail.jpg";
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = () => Response.json({ images: [{ url: imageUrl }] });
const references = [
  { side: "player", speciesId: "pikachu", name: "皮卡丘", imageUrl: "data:image/png;base64,cGxheWVy" },
  { side: "opponent", speciesId: "charmander", name: "小火龙", imageUrl: "data:image/png;base64,b3Bwb25lbnQ=" },
];
const beats = count => Array.from({ length: count }, (_, index) => ({ index, attackId: `attack-${index}`, purpose: "complete", motionPrompt: `beat ${index}`, durationSeconds: 5 }));

test("云端只提交一次 last，取消单个等待不取消共享请求，URL直接返回且指标不含凭证", async () => {
  const gate = defer(), calls = [], metrics = [];
  const tails = new CloudTailFrames({ loadCredentials: async () => "private-key", metricSink: m => metrics.push(m),
    fetchImpl: async (url, options) => { calls.push({ url, options }); await gate.promise; return result(); } });
  const controller = new AbortController();
  const cancelled = tails.url(videoUrl, { signal: controller.signal }), survivor = tails.url(videoUrl);
  await tick(); controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(calls[0].options.signal.aborted, false);
  gate.resolve(); assert.equal(await survivor, imageUrl); assert.equal(await tails.url(videoUrl), imageUrl);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `https://fal.run/${FAL_TAIL_FRAME_MODEL}`);
  assert.equal(calls[0].options.method, "POST"); assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, "Key private-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), { video_url: videoUrl, frame_type: "last" });
  assert.equal(metrics[0].tailSource, "cloud"); assert.equal(metrics[0].outcome, "ready");
  assert(metrics[0].cloudTailMs >= 0); assert(!JSON.stringify(metrics).includes("private-key"));
  assert(!JSON.stringify(metrics).includes("fal.media"));
});

test("云端失败/非法输出/超时不自动重发付费POST；取消前不提交；缓存有界", async () => {
  for (const response of [() => new Response("secret", { status: 403 }), () => Response.json({ images: [] }),
    () => Response.json({ images: [{ url: "http://localhost/private.jpg" }] }),
    () => Response.json({ images: [{ url: "https://user:secret@example.com/frame.jpg" }] }),
    () => { throw new Error("network failed private-key"); }]) {
    let posts = 0;
    const tails = new CloudTailFrames({ loadCredentials: async () => "private-key", fetchImpl: async () => { posts++; return response(); } });
    for (let i = 0; i < 2; i++) await assert.rejects(tails.url(videoUrl), error => error.message === "TAIL_FRAME_CLOUD_FAILED");
    assert.equal(posts, 1);
  }
  let posts = 0;
  const tails = new CloudTailFrames({ timeoutMs: 10, loadCredentials: async () => "test", fetchImpl: (_url, { signal }) => {
    posts++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(tails.url(videoUrl), /TAIL_FRAME_CLOUD_TIMEOUT/);
  await assert.rejects(tails.url(videoUrl), /TAIL_FRAME_CLOUD_TIMEOUT/); assert.equal(posts, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tails.url(`${videoUrl}?cancelled`, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(tails.url("file:///private"), /URL_INVALID/); assert.equal(posts, 1);
  let now = 0, count = 0;
  const bounded = new CloudTailFrames({ loadCredentials: async () => "test", now: () => now, maxEntries: 1, ttlMs: 10,
    fetchImpl: async () => { count++; return result(); }, metricSink: async () => { throw new Error("metric disk failed"); } });
  await bounded.url(videoUrl); await assert.rejects(bounded.url(`${videoUrl}?second`), /CACHE_BUSY/);
  now = 11; await bounded.url(videoUrl); assert.equal(count, 2);
});

test("生产媒体模式立即补齐Range，只用于播放归档，不启动两种本地提帧器", async () => {
  const requests = [], bytes = Buffer.alloc(2 * 1024 * 1024, 7); let extracts = 0;
  const cache = new VideoMediaCache({ extractRangeTail: false,
    tailExtractor: () => { extracts++; throw new Error("local disabled"); }, rangeTailExtractor: () => { extracts++; throw new Error("local disabled"); },
    fetchImpl: async (_url, options) => {
      const [start, end] = options.headers.Range.match(/\d+/g).map(Number), last = Math.min(end, bytes.length - 1);
      requests.push([start, last]);
      return new Response(bytes.subarray(start, last + 1), { status: 206, headers: { "content-range": `bytes ${start}-${last}/${bytes.length}`, etag: '"v1"' } });
    } });
  const media = cache.pin(videoUrl);
  assert.deepEqual(await media.readRange(0, 1023), bytes.subarray(0, 1024));
  assert.deepEqual(await cache.bytes(videoUrl), bytes); assert.equal(extracts, 0);
  assert.equal(media.tail, undefined); assert.equal(media.tailWork, undefined);
  await assert.rejects(cache.tail(videoUrl), /LOCAL_TAIL_EXTRACTION_DISABLED/); assert.equal(extracts, 0);
  assert.equal(media.timings.downloadMode, "range-only");
  assert.equal(requests.reduce((n, [s, e]) => n + e - s + 1, 0), bytes.length);
  cache.unpin(videoUrl);
});

test("真实跑道与归档共享云端尾帧：下载/图片/落盘未完成时已提交下段；末段也交付锚点", { timeout: 2000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-cloud-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const download = defer(), jpeg = defer(), cloud = defer(), second = defer(), continuity = [defer(), defer()];
  let posts = 0, uploads = 0, imageDownloads = 0, localExtracts = 0; const inputs = [], archives = [];
  const tails = new CloudTailFrames({ loadCredentials: async () => "test", fetchImpl: async () => { posts++; await cloud.promise; return result(); } });
  const cache = new VideoMediaCache({ extractRangeTail: false, fetchImpl: async () => { await download.promise; return new Response("video"); },
    tailExtractor: () => { localExtracts++; throw new Error("disabled"); }, rangeTailExtractor: () => { localExtracts++; throw new Error("disabled"); } });
  const runway = new FalVideoRunway({ clientFactory: () => ({ storage: { upload: async () => { uploads++; throw new Error("no upload"); } }, queue: {
    async submit(_model, { input }) { inputs.push(input); if (inputs.length === 2) second.resolve(); return { request_id: `test-${inputs.length}` }; },
    async subscribeToStatus() {}, async result(_model, { requestId }) { return { data: { video: { url: `https://example.com/${requestId}.mp4` } } }; },
  } }), tailFrameExtractor: (url, options) => tails.url(url, options), clipSink: args => {
    const work = archiveAttackClip(args, { directory, cache, tailFrames: tails, continuity: { resolveTail: continuity[args.clip.index].resolve },
      fetchTail: async () => { imageDownloads++; await jpeg.promise; return Buffer.from("jpeg"); } });
    archives.push(work); return work;
  } });
  const created = runway.create({ credentials: "test", referenceImages: references, beats: beats(2) });
  await tick(); cloud.resolve(); await second.promise;
  assert.equal(inputs[1].image_url, imageUrl); assert.equal(inputs[1].seed, 42); assert.equal(uploads, 0);
  assert.equal(await continuity[0].promise, imageUrl); assert.equal(await continuity[1].promise, imageUrl);
  assert.equal(posts, 2, "两段各买一次提帧，归档与续段去重");
  assert.equal(imageDownloads, 0, "归档图片尚未下载但下一段已经生成");
  assert.equal(localExtracts, 0); assert([...cache.entries.values()].every(entry => !entry.settled));
  download.resolve(); await tick(); jpeg.resolve(); await Promise.all(archives);
  assert.equal(runway.get(created.id).status, "ready"); assert.equal(imageDownloads, 2);
  assert.equal((await readFile(join(directory, "clip-1-tail.jpg"))).toString(), "jpeg");
  assert.equal(JSON.parse(await readFile(join(directory, "clip-0-media.json"), "utf8")).tailSource, "cloud");
});

test("归档磁盘/图片/媒体缓存失败不能清掉独立云端状态锚点", { timeout: 2000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-cloud-fail-")); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const mode of ["disk", "image", "cache"]) {
    const anchor = defer(), ready = defer();
    const cache = mode === "cache" ? { pin: () => { throw new Error("cache busy"); } }
      : new VideoMediaCache({ extractRangeTail: false, fetchImpl: async () => new Response("video") });
    const archive = archiveAttackClip({ session: { id: "test" }, clip: { index: 0, videoUrl: "https://example.com/video.mp4" } }, {
      cache, directory, continuity: { resolveTail: anchor.resolve }, tailFrames: { url: async () => { await ready.promise; return imageUrl; } },
      fetchTail: async () => { if (mode === "image") throw new Error("image failed"); return Buffer.from("tail"); },
      writeArtifact: async (path, bytes) => { if (mode === "disk") throw new Error("disk failed"); return writeFile(path, bytes); },
    });
    const failed = assert.rejects(archive, /failed|busy/); ready.resolve();
    assert.equal(await anchor.promise, imageUrl); await failed;
  }
});

test("云端尾帧失败让后续分镜有界结束，不上传/重买首段/自动退回本地", { timeout: 2000 }, async () => {
  let submits = 0, uploads = 0;
  const runway = new FalVideoRunway({ clientFactory: () => ({ storage: { upload: () => { uploads++; } }, queue: {
    async submit() { submits++; return { request_id: "test" }; }, async subscribeToStatus() {},
    async result() { return { data: { video: { url: videoUrl } } }; },
  } }), tailFrameExtractor: async () => { throw new Error("TAIL_FRAME_CLOUD_FAILED"); } });
  const session = runway.create({ credentials: "test", referenceImages: references, beats: beats(3) });
  while (runway.get(session.id).status === "generating") await tick();
  const done = runway.get(session.id);
  assert.equal(done.status, "partial"); assert.deepEqual(done.clips.map(c => c.status), ["ready", "error", "error"]);
  assert.equal(done.clips[1].error, "无法提取上一分镜尾帧"); assert.equal(submits, 1); assert.equal(uploads, 0);
});

test("提帧途中取消演出立即释放跑道，不买下一段，也不取消归档共享请求", { timeout: 2000 }, async () => {
  const gate = defer(), extracting = defer(); let submits = 0, posts = 0;
  const tails = new CloudTailFrames({ loadCredentials: async () => "test", fetchImpl: async () => {
    posts++; extracting.resolve(); await gate.promise; return result();
  } });
  const runway = new FalVideoRunway({ clientFactory: () => ({ queue: {
    async submit() { submits++; return { request_id: "test" }; }, async subscribeToStatus() {},
    async result() { return { data: { video: { url: videoUrl } } }; },
  } }), tailFrameExtractor: (url, options) => tails.url(url, options) });
  const session = runway.create({ credentials: "test", referenceImages: references, beats: beats(2) });
  await extracting.promise;
  const archive = tails.url(videoUrl);
  runway.cancel(session.id);
  while (runway.get(session.id).status === "cancelling") await tick();
  assert.equal(runway.get(session.id).status, "cancelled"); assert.equal(submits, 1);
  gate.resolve(); assert.equal(await archive, imageUrl); await tick(); assert.equal(submits, 1); assert.equal(posts, 1);
});

test("重启复用：JPG优先，未归档时只用新鲜HTTPS尾帧URL，过期只读本地原片", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-cloud-restart-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let extracts = 0;
  const options = { tailExtractor: async (_url, { fetchImpl }) => { extracts++; assert.equal(await (await fetchImpl()).text(), "local paid video"); return new Blob(["decoded tail"]); } };
  await writeFile(join(directory, "clip-0-tail.json"), JSON.stringify({ url: imageUrl, createdAt: Date.now() }));
  assert.equal(await loadArchivedAttackTail(directory, 0, options), imageUrl); assert.equal(extracts, 0);
  await writeFile(join(directory, "clip-0-tail.jpg"), "archived tail");
  assert.equal(await loadArchivedAttackTail(directory, 0, options), `data:image/jpeg;base64,${Buffer.from("archived tail").toString("base64")}`);
  await rm(join(directory, "clip-0-tail.jpg"));
  await writeFile(join(directory, "clip-0.mp4"), "local paid video");
  await writeFile(join(directory, "clip-0-tail.json"), JSON.stringify({ url: imageUrl, createdAt: Date.now() - CLOUD_TAIL_TTL_MS - 1 }));
  assert.equal(await loadArchivedAttackTail(directory, 0, options), `data:image/jpeg;base64,${Buffer.from("decoded tail").toString("base64")}`);
  assert.equal(extracts, 1);
});

test("真实锚点入口在runway先过期或在线URL过期后复用归档，仍拒绝错误状态和未完成片", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-cloud-expired-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const attacks = sanitizeAttackRecords(buildAttackRecords(resolveTurn(createBattle(), { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 }).events));
  const plan = createRealtimeStoryboard(attacks), clipIndex = plan.turn.sequence.length - 1;
  const scene = attackVisualScene(attacks.at(-1), true), path = join(directory, sessionId);
  await mkdir(path); await writeFile(join(path, "plan.json"), JSON.stringify({ attacks, plan }));
  await writeFile(join(path, `clip-${clipIndex}-tail.jpg`), "durable tail");
  const expected = `data:image/jpeg;base64,${Buffer.from("durable tail").toString("base64")}`;
  const clips = plan.turn.sequence.map(() => ({ scene, tailExpiresAt: Date.now() - 1, tail: Promise.resolve("https://example.com/expired.jpg") }));
  const continuity = new Map([[sessionId, { scene, clips, attacks }]]);
  for (const session of [null, { status: "ready", clips: clips.map(() => ({ status: "ready" })) }]) {
    const runway = { get: () => session };
    assert.equal(await loadAttackSceneAnchor({ sessionId, clipIndex }, scene, null, { continuity, runway, directory }), expected);
    assert.equal(await loadAttackContinuation(sessionId, scene, { continuity, runway, runsDirectory: directory }), expected);
    const wrong = structuredClone(scene); wrong.opponent.status = "sleep";
    assert.equal(await loadAttackSceneAnchor({ sessionId, clipIndex }, wrong, null, { continuity, runway, directory }), null);
    assert.equal(await loadAttackContinuation(sessionId, wrong, { continuity, runway, runsDirectory: directory }), null);
  }
  const runway = { get: () => ({ status: "generating", clips: clips.map(() => ({ status: "queued" })) }) };
  assert.equal(await loadAttackSceneAnchor({ sessionId, clipIndex }, scene, null, { continuity, runway, directory }), null);
  assert.equal(await loadAttackContinuation(sessionId, scene, { continuity, runway, runsDirectory: directory }), null);
});
