import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FalVideoRunway, createVideoFalClient, FAL_VIDEO_MODEL, FAL_VIDEO_REFERENCE_MODEL } from "../src/fal-video-runway.js";
import { falVideoFailure } from "../src/fal-video-failure.js";
import { SceneVideoService, sceneVideoSpec } from "../src/scene-video-service.js";
import { recoverSceneClip } from "../src/scene-video-recovery.js";
import { createBattle } from "../src/battle-engine.js";
import { visualScene } from "../src/visual-battle-state.js";

const topUp = () => Object.assign(new Error("Forbidden"), { status: 403, body: { detail: "User is locked. Reason: TOP_UP." } });
const providerFailed = () => Object.assign(new Error("Internal error"), { status: 500, body: { error_type: "generation_timeout" } });
const references = () => ["player", "opponent"].map((side, index) => ({ side, speciesId: index ? "charmander" : "pikachu", name: side, imageUrl: `https://example.com/${side}.png` }));
const beats = count => Array.from({ length: count }, (_, index) => ({ index, durationSeconds: 5, motionPrompt: `shot ${index}` }));
const input = () => ({ kind: "command", language: "ja", scene: visualScene(createBattle()), sourceKey: "default" });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function terminal(runway, id) {
  for (let tries = 0; tries < 2000; tries++) {
    const session = runway.get(id);
    if (!["generating", "cancelling"].includes(session.status)) return session;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail("runway did not finish");
}
function clientHarness({ submitError, resultError, statusError } = {}) {
  const calls = [], cancels = [];
  return { calls, cancels, client: { queue: {
    async submit(model, options) {
      calls.push({ model, input: options.input });
      const error = submitError?.(calls.length); if (error) throw error;
      return { request_id: `paid-${calls.length}` };
    },
    async subscribeToStatus(_model, options) {
      const error = statusError?.(); if (error) throw error;
      options.onQueueUpdate?.({ status: "COMPLETED" });
    },
    async status() { return { status: "COMPLETED" }; },
    async result(_model, options) {
      const error = resultError?.(options.requestId); if (error) throw error;
      return { data: { video: { url: `https://example.com/${options.requestId}.mp4` } } };
    },
    async cancel(_model, options) { cancels.push(options.requestId); },
  } } };
}
async function sceneHarness(overrides = {}, clientOptions = {}) {
  const fake = clientHarness(clientOptions);
  const directory = await mkdtemp(join(tmpdir(), "pokemon-regeneration-"));
  const options = {
    directory, retryDelayMs: 0,
    loadReferences: async () => references(), loadContextImages: async () => [],
    loadDefaultAnchor: async () => "data:image/jpeg;base64,YQ==",
    fetchImpl: async () => new Response("paid video"),
    commandAudio: async bytes => bytes,
    tailExtractor: async () => new Blob(["tail"], { type: "image/jpeg" }),
    runwayFactory: hooks => new FalVideoRunway({ ...hooks, clientFactory: () => fake.client }),
    recoverClip: (paid, options) => recoverSceneClip(paid, { ...options, clientFactory: () => fake.client }),
    ...overrides,
  };
  return { ...fake, options, service: new SceneVideoService(options) };
}
async function seedPaid(options, specInput = input()) {
  const spec = sceneVideoSpec(specInput);
  await mkdir(join(options.directory, spec.key), { recursive: true });
  const paid = { key: spec.key, kind: spec.kind, language: spec.language, status: "submitted", model: FAL_VIDEO_MODEL, requestId: "old-top-up" };
  await writeFile(join(options.directory, spec.key, "submission.json"), JSON.stringify(paid));
  return paid;
}
async function finishScene(service, specInput = input()) {
  const job = service.create(specInput, "fake-test-key");
  await service.jobs.get(job.key).done;
  return service.get(job.key);
}

test("明确失败与读请求错误分开：TOP_UP 只在提交/终态结果确认，错误载荷不泄漏", () => {
  assert(falVideoFailure(topUp(), "submit").regenerable);
  assert(falVideoFailure(topUp(), "result").regenerable);
  assert(!falVideoFailure(topUp(), "status").confirmed);
  for (const error of [new Error("fetch failed"), Object.assign(new Error("Forbidden"), { status: 403 }), Object.assign(new Error("Gateway"), { status: 502 })]) {
    assert(!falVideoFailure(error, "result").confirmed);
  }
  const blocked = Object.assign(new Error("secret-key"), { status: 422, body: { detail: [{ type: "content_policy_violation", input: "secret-key" }] } });
  assert(!falVideoFailure(blocked, "result").regenerable);
  assert(!JSON.stringify(falVideoFailure(blocked, "result")).includes("secret-key"));
});

test("真实客户端的付费 POST 只发一次，不继承 SDK 的隐式重发", async () => {
  for (const mode of ["network", "429", "502", "malformed"]) {
    let calls = 0;
    const client = createVideoFalClient("fake-secret", async (url, options) => {
      calls++; assert.equal(url, `https://queue.fal.run/${FAL_VIDEO_MODEL}`);
      assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
      if (mode === "network") throw new TypeError("fetch failed");
      return Response.json({}, { status: mode === "malformed" ? 200 : Number(mode) });
    });
    await assert.rejects(client.queue.submit(FAL_VIDEO_MODEL, { input: { prompt: "test" } }));
    assert.equal(calls, 1, mode);
  }
});

test("第二攻击片明确失败只重生第二片，保留首片和同一尾帧/提示词/seed", async () => {
  const fake = clientHarness({ resultError: id => id === "paid-2" ? providerFailed() : null });
  let extracts = 0;
  const runway = new FalVideoRunway({ clientFactory: () => fake.client,
    tailFrameExtractor: async () => { extracts++; return new Blob(["tail"]); },
    tailFrameUploader: async () => "data:image/jpeg;base64,dGFpbA==" });
  const created = runway.create({ credentials: "test", referenceImages: references(), beats: beats(2) });
  const done = await terminal(runway, created.id);
  assert.equal(done.status, "ready"); assert.equal(fake.calls.length, 3); assert.equal(extracts, 1);
  assert.equal(done.clips[0].requestId, "paid-1"); assert.equal(done.clips[1].requestId, "paid-3");
  assert.equal(done.clips[1].regenerationCount, 1);
  assert.deepEqual(fake.calls[1], fake.calls[2]); assert.deepEqual(fake.cancels, []);
});

test("攻击提交明确拒绝自动重试一次；仍拒绝即停止且不暴露原始错误", async () => {
  for (const always of [false, true]) {
    const fake = clientHarness({ submitError: count => always || count === 1 ? topUp() : null });
    const runway = new FalVideoRunway({ clientFactory: () => fake.client });
    const created = runway.create({ credentials: "test", referenceImages: references(), beats: beats(1) });
    const done = await terminal(runway, created.id);
    assert.equal(done.status, always ? "failed" : "ready"); assert.equal(fake.calls.length, 2);
    if (always) assert.equal(done.clips[0].failure.code, "FAL_TOP_UP_REQUIRED");
  }
});

test("攻击提交/查询/取结果的不确定失败不重买，不取消已受理任务", async () => {
  for (const phase of ["submitError", "statusError", "resultError"]) {
    const fake = clientHarness({ [phase]: () => new TypeError("fetch failed") });
    const runway = new FalVideoRunway({ clientFactory: () => fake.client });
    const created = runway.create({ credentials: "test", referenceImages: references(), beats: beats(1) });
    const done = await terminal(runway, created.id);
    assert.equal(done.status, "failed"); assert.equal(fake.calls.length, 1); assert.deepEqual(fake.cancels, []);
  }
});

test("历史 TOP_UP 已完成失败任务即使 recoverOnly 也自动新生成，保留原凭证", async () => {
  const { service, options, calls } = await sceneHarness({}, { resultError: id => id === "old-top-up" ? topUp() : null });
  const old = await seedPaid(options);
  const done = await finishScene(service, { ...input(), recoverOnly: true });
  assert.equal(done.status, "ready"); assert.equal(done.regenerationCount, 1); assert.equal(calls.length, 1);
  const original = JSON.parse(await readFile(join(options.directory, old.key, "submission.json")));
  const retry = JSON.parse(await readFile(join(options.directory, old.key, "submission-retry-1.json")));
  assert.equal(original.requestId, old.requestId); assert.equal(original.status, "failed");
  assert.equal(retry.requestId, "paid-1"); assert.equal(retry.attempt, 1);
  assert.equal(retry.seed, 42); assert.equal(done.failure, null);
  const restarted = new SceneVideoService(options);
  const reused = await finishScene(restarted);
  assert.equal(reused.status, "ready"); assert.equal(reused.regenerationCount, 1); assert.equal(calls.length, 1);
});

test("场景新提交明确拒绝自动重生成，不能叠加 runway 的重试预算", async () => {
  const { service, calls } = await sceneHarness({}, { submitError: n => n === 1 ? topUp() : null });
  assert.equal((await finishScene(service)).status, "ready"); assert.equal(calls.length, 2);
});

test("场景两次明确失败后，重复 create 和重启都不能第三次付费", async () => {
  const { service, calls, options } = await sceneHarness({}, { submitError: () => topUp() });
  const failed = await finishScene(service);
  assert.equal(failed.status, "error"); assert.equal(failed.errorCode, "FAL_REGENERATION_EXHAUSTED");
  assert.equal(calls.length, 2); assert(!failed.retryable);
  await finishScene(service); await finishScene(new SceneVideoService(options), { ...input(), recoverOnly: true });
  assert.equal(calls.length, 2);
});

test("恢复 status 或 result 的裸403/断网不视为远端生成失败", async () => {
  for (const mode of ["permission", "network"]) {
    const { service, calls, options } = await sceneHarness({}, { resultError: () => mode === "permission" ? Object.assign(new Error("Forbidden"), { status: 403 }) : new Error("offline") });
    const old = await seedPaid(options);
    assert.equal((await finishScene(service)).status, "error"); assert.equal(calls.length, 0);
    assert.equal(JSON.parse(await readFile(join(options.directory, old.key, "submission.json"))).status, "submitted");
  }
});

test("重新生成后的下载失败仅恢复新 requestId，不再购买或退回旧任务", async () => {
  let offline = true;
  const { service, options, calls } = await sceneHarness({ fetchImpl: async () => { if (offline) throw new Error("offline"); return new Response("paid"); } }, { resultError: id => id === "old-top-up" ? topUp() : null });
  await seedPaid(options);
  assert.equal((await finishScene(service)).status, "error"); assert.equal(calls.length, 1);
  offline = false;
  assert.equal((await finishScene(new SceneVideoService(options), { ...input(), recoverOnly: true })).status, "ready");
  assert.equal(calls.length, 1);
});

test("共享目录的两个场景服务恢复同一失败任务，只能一个获得付费重试资格", async () => {
  const both = gate(); let recovered = 0;
  const { service, options, calls } = await sceneHarness({ recoverClip: async () => {
    if (++recovered === 2) both.resolve(); await both.promise;
    throw Object.assign(new Error("TOP_UP"), { failure: falVideoFailure(topUp(), "result") });
  } });
  await seedPaid(options);
  await Promise.all([finishScene(service), finishScene(new SceneVideoService(options))]);
  assert.equal(calls.length, 1);
});

test("重试 intent 写入失败不能提交，取消恢复后的迟到失败不能重买", async () => {
  const failedDisk = await sceneHarness({ writeSubmission: async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } }, { resultError: () => topUp() });
  await seedPaid(failedDisk.options);
  assert.equal((await finishScene(failedDisk.service)).status, "error"); assert.equal(failedDisk.calls.length, 0);
  const entered = gate(), done = gate();
  const cancelled = await sceneHarness({ recoverClip: async () => {
    entered.resolve(); await done.promise;
    throw Object.assign(new Error("TOP_UP"), { failure: falVideoFailure(topUp(), "result") });
  } });
  const old = await seedPaid(cancelled.options);
  const pending = finishScene(cancelled.service);
  await entered.promise; cancelled.service.cancel(old.key); done.resolve();
  assert.equal((await pending).status, "cancelled"); assert.equal(cancelled.calls.length, 0);
});
