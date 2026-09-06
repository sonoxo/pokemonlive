import assert from "node:assert/strict";
import test from "node:test";

import {
  FalVideoRunway,
  FAL_VIDEO_MODEL,
  FAL_VIDEO_REFERENCE_MODEL,
  FAL_VIDEO_SEED,
} from "../src/fal-video-runway.js";

function beats(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    attackId: `attack-${index}`,
    purpose: "complete",
    motionPrompt: `combined battle beat ${index}`,
    durationSeconds: 5,
  }));
}

function referenceImages() {
  return [
    { side: "player", speciesId: "pikachu", name: "皮卡丘", imageUrl: "data:image/png;base64,cGxheWVy" },
    { side: "opponent", speciesId: "charmander", name: "小火龙", imageUrl: "data:image/png;base64,b3Bwb25lbnQ=" },
  ];
}

test("预生成过渡尾帧直接启动 Turbo，续段传 JPEG data URI，末段可接回待机", async () => {
  const submitted = [];
  const openingFrame = "data:image/jpeg;base64,b3Blbg==";
  const tail = "data:image/jpeg;base64,dGFpbA==";
  const closingFrame = "data:image/png;base64,Y2xvc2U=";
  const client = { queue: {
    async submit(model, { input }) { submitted.push({ model, input }); return { request_id: `id-${submitted.length}` }; },
    async subscribeToStatus() {},
    async result(_model, { requestId }) { return { data: { video: { url: `https://cdn.example/${requestId}.mp4` }, timings: { inference: 0.5 } } }; },
    async cancel() {},
  } };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    tailFrameExtractor: async () => new Blob(["tail"], { type: "image/jpeg" }),
    tailFrameUploader: async () => tail,
    clipSink: () => new Promise(() => {}), // diagnostic sink must not block the runway
  });
  const created = runway.create({ credentials: "test", beats: beats(2), referenceImages: referenceImages(), openingFrame, closingFrame });
  const complete = await waitForTerminal(runway, created.id);
  assert.equal(complete.status, "ready");
  assert.equal(complete.clips[0].inputMode, "command_tail_frame");
  assert(submitted.every(call => call.model === FAL_VIDEO_MODEL));
  assert(submitted.every(call => call.input.seed === FAL_VIDEO_SEED));
  assert.equal(complete.seed, FAL_VIDEO_SEED);
  assert(complete.clips.every(clip => clip.seed === FAL_VIDEO_SEED));
  assert.equal(submitted[0].input.image_url, openingFrame);
  assert.equal(submitted[0].input.reference_image_urls, undefined);
  assert.equal(submitted[0].input.end_image_url, undefined);
  assert.equal(submitted[1].input.image_url, tail);
  assert.equal(submitted[1].input.end_image_url, closingFrame);
  assert(complete.clips[1].anchoringMs >= 0);
  assert.equal(complete.clips[1].inferenceSeconds, 0.5);
});

async function waitForTerminal(runway, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = runway.get(id);
    if (["ready", "partial", "failed", "cancelled"].includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("session did not finish");
}

test("首段使用双方角色参考图，后续每段严格使用上一段尾帧且不会并发越序", async () => {
  let active = 0;
  let maxActive = 0;
  let uploads = 0;
  const calls = [];
  const extractedFrom = [];
  const client = {
    storage: {
      async upload(blob, options) {
        uploads += 1;
        assert.equal(blob.type, "image/jpeg");
        assert.equal(options.lifecycle.expiresIn, "1h");
        return `https://cdn.example/tail-${uploads}.jpg`;
      },
    },
    queue: {
      async submit(model, options) {
        const index = Number(options.input.prompt.match(/\d+/)[0]);
        calls.push({ model, options });
        return { request_id: `request-${index}` };
      },
      async subscribeToStatus(_model, options) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        options.onQueueUpdate({ status: "IN_PROGRESS" });
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { status: "COMPLETED" };
      },
      async result(_model, options) {
        const index = Number(options.requestId.match(/\d+$/)[0]);
        return {
          requestId: options.requestId,
          data: {
            video: { url: `https://cdn.example/clip-${index}.mp4` },
            expanded_prompt: `expanded ${index}`,
          },
        };
      },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: (credentials) => {
      assert.equal(credentials, "secret-test-key");
      return client;
    },
    tailFrameExtractor: async (url) => {
      extractedFrom.push(url);
      return new Blob(["frame"], { type: "image/jpeg" });
    },
    makeId: () => "00000000-0000-4000-8000-000000000001",
  });

  const created = runway.create({
    credentials: "secret-test-key",
    beats: beats(),
    referenceImages: referenceImages(),
    battleEpoch: 2,
    turn: 4,
  });
  assert.equal(created.status, "generating");
  const finished = await waitForTerminal(runway, created.id);

  assert.equal(uploads, 3);
  assert.equal(maxActive, 1);
  assert.equal(finished.status, "ready");
  assert.equal(finished.clips.length, 4);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].model, FAL_VIDEO_REFERENCE_MODEL);
  assert.ok(calls.slice(1).every(({ model }) => model === FAL_VIDEO_MODEL));
  assert.ok(calls.every(({ options }) => (
    options.input.duration === 5
    && options.input.seed === FAL_VIDEO_SEED
    && options.input.resolution === "480P"
    && options.input.prompt_expansion_mode === "balanced"
    && options.input.enable_safety_checker === true
  )));
  assert.equal("image_url" in calls[0].options.input, false);
  assert.equal(calls[0].options.input.aspect_ratio, "16:9");
  assert.deepEqual(calls[0].options.input.reference_image_urls, referenceImages().map((reference) => reference.imageUrl));
  for (let index = 1; index < calls.length; index += 1) {
    assert.equal(calls[index].options.input.image_url, `https://cdn.example/tail-${index}.jpg`);
    assert.equal("reference_image_urls" in calls[index].options.input, false);
  }
  assert.deepEqual(extractedFrom, Array.from(
    { length: 3 },
    (_, index) => `https://cdn.example/clip-${index}.mp4`,
  ));
  assert.deepEqual(finished.clips.map((clip) => clip.inputMode), [
    "character_references",
    "previous_tail_frame",
    "previous_tail_frame",
    "previous_tail_frame",
  ]);
  assert.deepEqual(finished.references, referenceImages().map(({ side, speciesId, name }) => ({ side, speciesId, name })));
  assert.equal(finished.clips[0].model, FAL_VIDEO_REFERENCE_MODEL);
  assert.deepEqual(finished.clips.map((clip) => clip.sourceClipIndex), [null, 0, 1, 2]);
});

test("视频完成时记录可观测的生成起止时间和结构化埋点", async () => {
  let now = 1_000;
  let monotonicNow = 20;
  const metrics = [];
  const client = {
    storage: { async upload() { throw new Error("单段视频不应上传尾帧"); } },
    queue: {
      async submit() { return { request_id: "request-metric" }; },
      async subscribeToStatus() { return { status: "COMPLETED" }; },
      async result() {
        now = 3_450;
        monotonicNow = 2_470;
        return { data: { video: { url: "https://cdn.example/metric.mp4" } } };
      },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    now: () => now,
    monotonicNow: () => monotonicNow,
    metricSink: (metric) => metrics.push(metric),
    makeId: () => "00000000-0000-4000-8000-000000000099",
  });
  const created = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 3,
    turn: 7,
  });
  const finished = await waitForTerminal(runway, created.id);

  assert.equal(finished.clips[0].generationStartedAt, 1_000);
  assert.equal(finished.clips[0].generationCompletedAt, 3_450);
  assert.equal(finished.clips[0].generationMs, 2_450);
  assert.deepEqual(metrics, [{
    event: "fal_video_clip_ready",
    recordedAt: 3_450,
    sessionId: created.id,
    battleEpoch: 3,
    turn: 7,
    clipIndex: 0,
    openingClip: true,
    model: FAL_VIDEO_REFERENCE_MODEL,
    seed: FAL_VIDEO_SEED,
    inputMode: "character_references",
    generationStartedAt: 1_000,
    generationCompletedAt: 3_450,
    generationMs: 2_450,
    submitMs: 0,
    queueWaitMs: null,
    providerRunMs: null,
    resultMs: 2_450,
    statusTransport: "polling",
  }]);
});

test("每个视频片段都有隐私安全的完成埋点", async () => {
  let requestIndex = 0;
  const metrics = [];
  const client = {
    storage: { async upload() { return "https://cdn.example/tail-private.jpg"; } },
    queue: {
      async submit() {
        requestIndex += 1;
        return { request_id: `request-private-${requestIndex}` };
      },
      async subscribeToStatus() { return { status: "COMPLETED" }; },
      async result(_model, options) {
        return { data: { video: { url: `https://cdn.example/${options.requestId}.mp4` } } };
      },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    tailFrameExtractor: async () => new Blob(["private-frame"], { type: "image/jpeg" }),
    metricSink: (metric) => metrics.push(metric),
  });
  const created = runway.create({
    credentials: "secret-must-not-leak",
    beats: beats(2),
    referenceImages: referenceImages(),
    battleEpoch: 1,
    turn: 2,
  });
  assert.equal((await waitForTerminal(runway, created.id)).status, "ready");

  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics.map(({ clipIndex, openingClip, model, inputMode }) => ({
    clipIndex,
    openingClip,
    model,
    inputMode,
  })), [
    {
      clipIndex: 0,
      openingClip: true,
      model: FAL_VIDEO_REFERENCE_MODEL,
      inputMode: "character_references",
    },
    {
      clipIndex: 1,
      openingClip: false,
      model: FAL_VIDEO_MODEL,
      inputMode: "previous_tail_frame",
    },
  ]);
  const allowedKeys = [
    "seed",
    "battleEpoch",
    "clipIndex",
    "event",
    "generationCompletedAt",
    "generationMs",
    "generationStartedAt",
    "inputMode",
    "model",
    "openingClip",
    "recordedAt",
    "sessionId",
    "turn",
    "submitMs", "queueWaitMs", "providerRunMs", "resultMs", "statusTransport",
  ].sort();
  assert.ok(metrics.every((metric) => (
    JSON.stringify(Object.keys(metric).sort()) === JSON.stringify(allowedKeys)
  )));
  assert.doesNotMatch(
    JSON.stringify(metrics),
    /secret-must-not-leak|combined battle beat|data:image|cdn\.example/,
  );
});

test("同步或异步埋点写入失败都不会破坏已完成的视频任务", async () => {
  const sinks = [
    () => { throw new Error("sync metric failure"); },
    async () => { throw new Error("async metric failure"); },
  ];
  for (const [index, metricSink] of sinks.entries()) {
    const client = {
      storage: { async upload() { throw new Error("单段视频不应上传尾帧"); } },
      queue: {
        async submit() { return { request_id: `request-sink-${index}` }; },
        async subscribeToStatus() { return { status: "COMPLETED" }; },
        async result() {
          return { data: { video: { url: `https://cdn.example/sink-${index}.mp4` } } };
        },
        async cancel() {},
      },
    };
    const runway = new FalVideoRunway({ clientFactory: () => client, metricSink });
    const created = runway.create({
      credentials: "key",
      beats: beats(1),
      referenceImages: referenceImages(),
      battleEpoch: 0,
      turn: index + 1,
    });
    assert.equal((await waitForTerminal(runway, created.id)).status, "ready");
  }
});

test("尾帧提取失败会停止后续付费提交并让剩余分镜收敛为错误", async () => {
  let submissions = 0;
  const client = {
    storage: { async upload() { throw new Error("提取失败后不应上传"); } },
    queue: {
      async submit() { submissions += 1; return { request_id: "request-first" }; },
      async subscribeToStatus() { return { status: "COMPLETED" }; },
      async result() {
        return { data: { video: { url: "https://cdn.example/first.mp4" } } };
      },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    tailFrameExtractor: async () => { throw new Error("FFMPEG_TAIL_FRAME_FAILED"); },
  });
  const created = runway.create({
    credentials: "key",
    beats: beats(3),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  const finished = await waitForTerminal(runway, created.id);

  assert.equal(finished.status, "partial");
  assert.equal(submissions, 1);
  assert.deepEqual(finished.clips.map((clip) => clip.status), ["ready", "error", "error"]);
  assert.match(finished.clips[1].error, /尾帧/);
});

test("尾帧上传返回空地址时会停止后续提交并收敛全部剩余分镜", async () => {
  let submissions = 0;
  const client = {
    storage: { async upload() { return ""; } },
    queue: {
      async submit() { submissions += 1; return { request_id: "request-first" }; },
      async subscribeToStatus() { return { status: "COMPLETED" }; },
      async result() {
        return { data: { video: { url: "https://cdn.example/first.mp4" } } };
      },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    tailFrameExtractor: async () => new Blob(["frame"], { type: "image/jpeg" }),
  });
  const created = runway.create({
    credentials: "key",
    beats: beats(3),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  const finished = await waitForTerminal(runway, created.id);

  assert.equal(finished.status, "partial");
  assert.equal(submissions, 1);
  assert.deepEqual(finished.clips.map((clip) => clip.status), ["ready", "error", "error"]);
  assert.match(finished.clips[1].error, /尾帧/);
});

test("取消视频任务会中止活动请求、显式取消 fal 队列且不再启动分镜", async () => {
  let started = 0;
  const remotelyCancelled = [];
  const client = {
    storage: { async upload() { return "https://cdn.example/battle.jpg"; } },
    queue: {
      async submit() {
        started += 1;
        return { request_id: `request-${started}` };
      },
      async subscribeToStatus(_model, options) {
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
      async result() { throw new Error("不应读取结果"); },
      async cancel(_model, options) { remotelyCancelled.push(options.requestId); },
    },
  };
  const runway = new FalVideoRunway({ clientFactory: () => client });
  const created = runway.create({
    credentials: "secret-test-key",
    beats: beats(),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  while (started < 1) await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(runway.cancel(created.id), true);
  const cancelled = await waitForTerminal(runway, created.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(started, 1);
  assert.deepEqual(remotelyCancelled, ["request-1"]);
  assert.ok(cancelled.clips.every((clip) => clip.status === "cancelled"));
});

test("全服务同时只允许一个连续视频跑道", async () => {
  let statusStarted = 0;
  const client = {
    storage: { async upload() { return "https://cdn.example/battle.jpg"; } },
    queue: {
      async submit() { return { request_id: `request-${statusStarted + 1}` }; },
      async subscribeToStatus(_model, options) {
        statusStarted += 1;
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      async result() { throw new Error("不应读取结果"); },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({ clientFactory: () => client });
  const first = runway.create({
    credentials: "key",
    beats: beats(),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  while (statusStarted < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.throws(() => runway.create({
    credentials: "key",
    beats: beats(),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 2,
  }), /已有 fal 视频任务/);
  runway.cancel(first.id);
  await waitForTerminal(runway, first.id);
});

test("单片超时会显式取消远端 fal 请求", async () => {
  let remoteCancels = 0;
  const client = {
    storage: { async upload() { return "https://cdn.example/battle.jpg"; } },
    queue: {
      async submit() { return { request_id: "request-timeout" }; },
      async subscribeToStatus(_model, options) {
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      async result() { throw new Error("不应读取结果"); },
      async cancel() { remoteCancels += 1; },
    },
  };
  const runway = new FalVideoRunway({ clientFactory: () => client, clipTimeoutMs: 5 });
  const created = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  const finished = await waitForTerminal(runway, created.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.clips[0].status, "cancelled");
  assert.equal(remoteCancels, 1);
});

test("TTL 清理不会删除仍在生成的活动任务", async () => {
  let now = 100;
  let statusStarted = false;
  const client = {
    storage: { async upload() { throw new Error("单段不应上传尾帧"); } },
    queue: {
      async submit() { return { request_id: "request-active" }; },
      async subscribeToStatus(_model, options) {
        statusStarted = true;
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      async result() { throw new Error("取消后不应读取结果"); },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    now: () => now,
    ttlMs: 10,
  });
  const created = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  while (!statusStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  now = 1000;
  assert.equal(runway.get(created.id).status, "generating");
  runway.cancel(created.id);
  const cancelled = await waitForTerminal(runway, created.id);
  assert.equal(cancelled.status, "cancelled");
});

test("永不返回的尾帧上传在取消后立即释放全局跑道", async () => {
  const never = new Promise(() => {});
  let uploadStarted = false;
  let requestIndex = 0;
  const client = {
    storage: { async upload() { uploadStarted = true; return never; } },
    queue: {
      async submit() { requestIndex += 1; return { request_id: `request-${requestIndex}` }; },
      async subscribeToStatus() { return { status: "COMPLETED" }; },
      async result(_model, options) {
        return { data: { video: { url: `https://cdn.example/${options.requestId}.mp4` } } };
      },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    tailFrameExtractor: async () => new Blob(["frame"], { type: "image/jpeg" }),
    uploadTimeoutMs: 20,
  });
  const first = runway.create({
    credentials: "key",
    beats: beats(2),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  while (!uploadStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  runway.cancel(first.id);
  assert.equal((await waitForTerminal(runway, first.id)).status, "cancelled");

  const second = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 2,
  });
  assert.equal((await waitForTerminal(runway, second.id)).status, "ready");
});

test("永不返回的提交会被 abortSignal 和硬截止时间终止", async () => {
  let submitAborted = false;
  const client = {
    storage: { async upload() { return "https://cdn.example/battle.jpg"; } },
    queue: {
      async submit(_model, options) {
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => {
            submitAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
      async subscribeToStatus() { throw new Error("不应轮询"); },
      async result() { throw new Error("不应读取结果"); },
      async cancel() {},
    },
  };
  const runway = new FalVideoRunway({
    clientFactory: () => client,
    submitTimeoutMs: 5,
    clipTimeoutMs: 50,
  });
  const created = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  const finished = await waitForTerminal(runway, created.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.clips[0].status, "error");
  assert.equal(submitAborted, true);
});

test("取消发生在 fal 已入队但 request_id 返回前时仍会取得句柄并远端取消", async () => {
  let resolveSubmit;
  let remoteEnqueued = false;
  const remotelyCancelled = [];
  const submitStarted = new Promise((resolve) => {
    resolveSubmit = () => resolve({ request_id: "request-late-response" });
  });
  let markSubmitStarted;
  const didStartSubmit = new Promise((resolve) => { markSubmitStarted = resolve; });
  const client = {
    storage: { async upload() { return "https://cdn.example/battle.jpg"; } },
    queue: {
      async submit(_model, options) {
        remoteEnqueued = true;
        markSubmitStarted();
        options.abortSignal.addEventListener("abort", () => {
          throw new Error("用户取消不应中止尚未返回 request_id 的提交请求");
        }, { once: true });
        return submitStarted;
      },
      async subscribeToStatus() { throw new Error("取消后不应轮询"); },
      async result() { throw new Error("取消后不应读取结果"); },
      async cancel(_model, options) { remotelyCancelled.push(options.requestId); },
    },
  };
  const runway = new FalVideoRunway({ clientFactory: () => client, submitTimeoutMs: 50 });
  const created = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  await didStartSubmit;
  assert.equal(remoteEnqueued, true);
  runway.cancel(created.id);
  assert.equal(runway.get(created.id).status, "cancelling");
  resolveSubmit();

  const finished = await waitForTerminal(runway, created.id);
  assert.equal(finished.status, "cancelled");
  assert.equal(finished.clips[0].requestId, "request-late-response");
  assert.deepEqual(remotelyCancelled, ["request-late-response"]);
});

test("永不返回的远端 cancel 不会让 session 永久占槽", async () => {
  let statusStarted = false;
  const client = {
    storage: { async upload() { return "https://cdn.example/battle.jpg"; } },
    queue: {
      async submit() { return { request_id: "request-stuck-cancel" }; },
      async subscribeToStatus(_model, options) {
        statusStarted = true;
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      async result() { throw new Error("不应读取结果"); },
      async cancel() { return new Promise(() => {}); },
    },
  };
  const runway = new FalVideoRunway({ clientFactory: () => client, cancelTimeoutMs: 5 });
  const created = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  });
  while (!statusStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  runway.cancel(created.id);
  const finished = await waitForTerminal(runway, created.id);
  assert.equal(finished.status, "cancelled");

  const next = runway.create({
    credentials: "key",
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 2,
  });
  runway.cancel(next.id);
  assert.equal((await waitForTerminal(runway, next.id)).status, "cancelled");
});

test("跑道在产生费用前拒绝无密钥和非五秒分镜", () => {
  const runway = new FalVideoRunway({ clientFactory: () => { throw new Error("不应创建客户端"); } });
  const valid = {
    beats: beats(1),
    referenceImages: referenceImages(),
    battleEpoch: 0,
    turn: 1,
  };
  assert.throws(() => runway.create({ ...valid, credentials: "" }), /FAL_KEY/);
  assert.throws(() => runway.create({
    ...valid,
    credentials: "key",
    beats: [{ ...valid.beats[0], durationSeconds: 4 }],
  }), /必须为 5 秒/);
  assert.throws(() => runway.create({
    ...valid,
    credentials: "key",
    referenceImages: [...referenceImages()].reverse(),
  }), /顺序或物种无效/);
});
