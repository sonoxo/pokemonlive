import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SceneAssetCache, requestSceneVideo } from "../src/scene-video-client.js";
import { recoverSceneClip } from "../src/scene-video-recovery.js";
import { FAL_VIDEO_REFERENCE_MODEL } from "../src/fal-video-runway.js";
import { createBattle } from "../src/battle-engine.js";
import { visualScene, visualSceneKey } from "../src/visual-battle-state.js";
const transient = () => Object.assign(new Error("local processing failed"), { retryable: true, retryAfterMs: 1 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("缓存恢复分类型有界重试，仅重读原任务；成功听令不重复请求", async () => {
  const scene = visualScene(createBattle()), requests = [], ready = [], waits = [];
  const cache = new SceneAssetCache({ wait: async ms => waits.push(ms), onReady: (_, kind) => ready.push(kind), request: async input => {
    requests.push(input);
    if (input.kind === "idle" && !input.recoverOnly) throw transient();
    return { ...input, status: "ready", videoUrl: `/media/${input.kind}.mp4` };
  } });
  const entry = cache.warm(scene, "a".repeat(64)); await entry.done;
  assert(entry.idle && entry.command); assert.deepEqual(ready.sort(), ["command", "idle"]);
  assert.equal(requests.filter(x => x.kind === "command").length, 1);
  assert.equal(requests.filter(x => x.kind === "idle").length, 2); assert.equal(requests.at(-1).recoverOnly, true);
  assert.deepEqual(waits, [2000]); cache.warm(scene, "a".repeat(64)); assert.equal(requests.length, 3);
});

test("永久失败最多两次自动恢复，后续 warm 也只能 recoverOnly", async () => {
  const requests = [], scene = visualScene(createBattle());
  const cache = new SceneAssetCache({ wait: async () => {}, request: async input => { requests.push(input); throw transient(); } });
  const entry = cache.warm(scene, "a".repeat(64), { skipIdle: true }); await entry.done;
  assert.equal(requests.length, 3); assert(requests.slice(1).every(x => x.recoverOnly));
  assert.deepEqual(entry.kinds, []); assert(entry.failedKinds.has("command"));
  cache.warm(scene, "a".repeat(64), { skipIdle: true }); await entry.done;
  assert.equal(requests.length, 6); assert(requests.slice(1).every(x => x.recoverOnly));
});

test("取消恢复退避与迟到成功均不能预加载旧阵容", async () => {
  for (const during of ["backoff", "request"]) {
    const gate = deferred(), entered = deferred(), ready = [], requests = [];
    const scene = visualScene(createBattle()), next = structuredClone(scene); next.opponent.status = "paralysis";
    const cache = new SceneAssetCache({ onReady: (...args) => ready.push(args),
      wait: async () => { entered.resolve(); await gate.promise; },
      request: async input => { requests.push(input); if (during === "backoff") throw transient(); entered.resolve(); await gate.promise; return { ...input, status: "ready" }; },
    });
    const entry = cache.warm(scene, "a".repeat(64), { skipIdle: true });
    await entered.promise; cache.cancelPendingExcept(next); gate.resolve(); await entry.done;
    assert.equal(requests.length, 1); assert.deepEqual(ready, []); assert.equal(cache.get(scene), undefined);
  }
});

test("HTTP 失败快照保留恢复标记，普通状态查询不会再次生成", async () => {
  const calls = [];
  const failed = { key: "a".repeat(64), status: "error", retryable: true, retryAfterMs: 123, errorCode: "ENOSPC" };
  await assert.rejects(requestSceneVideo({}, new AbortController().signal, async (_, options) => {
    calls.push(options.method); return Response.json({ ok: true, job: failed });
  }), error => error.retryable && error.retryAfterMs === 123 && error.code === "ENOSPC");
  assert.equal(calls.filter(x => x === "POST").length, 1);
});

test("fal 恢复仅查询既有 requestId，不提交或取消付费任务", async () => {
  const calls = [], signal = new AbortController().signal;
  const paid = { model: FAL_VIDEO_REFERENCE_MODEL, requestId: "existing-paid-1" };
  const result = await recoverSceneClip(paid, { signal, credentials: "test", clientFactory: () => ({ queue: {
    submit: () => assert.fail("must not submit"), cancel: () => assert.fail("must not cancel"),
    status: async (model, args) => { calls.push([model, args.requestId]); return { status: "COMPLETED" }; },
    result: async (model, args) => { calls.push([model, args.requestId]); return { data: { video: { url: "https://example.com/paid.mp4" } } }; },
  } }) });
  assert.equal(result.requestId, paid.requestId); assert.deepEqual(calls, [[paid.model, paid.requestId], [paid.model, paid.requestId]]);
});

test("同 URL 待机媒体失败有界重载；重载前保留尾帧且不触发生成", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("function retryIdleVideoLoad("), app.indexOf("function renderBattlefield("));
  const battle = createBattle(), key = visualSceneKey(visualScene(battle)), timers = [];
  let loads = 0;
  const video = { dataset: { sceneKey: key }, getAttribute: () => "/same.mp4", load: () => { loads++; } };
  const runtime = new Function("dom", "battle", "visualScene", "visualSceneKey", "setTimeout", `let idleVideoReloads=0, idleBattleVideoFailed=true; ${source}; return {retry: retryIdleVideoLoad, fail:()=>{idleBattleVideoFailed=true}, failed:()=>idleBattleVideoFailed};`)(
    { idleBattleVideo: video }, battle, visualScene, visualSceneKey, callback => timers.push(callback));
  runtime.retry(); assert.equal(loads, 0); assert(runtime.failed()); timers.shift()(); assert.equal(loads, 1);
  runtime.fail(); runtime.retry(); timers.shift()(); assert.equal(loads, 2);
  runtime.fail(); runtime.retry(); assert.equal(timers.length, 0);
});
