import assert from "node:assert/strict";
import test from "node:test";
import { waitForFalStatus } from "../src/fal-status.js";
import { FalVideoRunway } from "../src/fal-video-runway.js";

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fakeStream() {
  const done = defer();
  return { done: () => done.promise, finish: done.resolve, fail: done.reject,
    on(_name, callback) { this.emit = callback; }, abort() { this.aborted = true; done.resolve({ status: "IN_PROGRESS" }); } };
}

test("流式 COMPLETED 立即就绪，不等待连接关闭；关闭状态流不取消远端任务", async () => {
  const stream = fakeStream(), events = [], modes = [];
  let polls = 0;
  const client = { queue: { streamStatus: async () => stream, subscribeToStatus: async () => { polls++; } } };
  const pending = waitForFalStatus(client, "model", { requestId: "id", signal: new AbortController().signal,
    onQueueUpdate: status => events.push(status.status), onTransport: mode => modes.push(mode) });
  await new Promise(resolve => setImmediate(resolve));
  stream.emit({ status: "IN_PROGRESS" }); stream.emit({ status: "COMPLETED" });
  await pending;
  assert.equal(stream.aborted, true); assert.equal(polls, 0);
  assert.deepEqual(events, ["IN_PROGRESS", "COMPLETED"]); assert.deepEqual(modes, ["streaming"]);
});

test("流失败/过早关闭/无消息超时，只轮询相同 requestId，不误报完成", async () => {
  for (const failure of ["network", "incomplete", "idle"]) {
    const stream = fakeStream(), modes = [];
    const calls = [];
    const pending = waitForFalStatus({ queue: { streamStatus: async () => stream,
      subscribeToStatus: async (_model, options) => { calls.push(options); return { status: "COMPLETED" }; },
    } }, "same-model", { requestId: "paid-id", signal: new AbortController().signal,
      onQueueUpdate() {}, onTransport: mode => modes.push(mode), idleTimeoutMs: 10 });
    await new Promise(resolve => setImmediate(resolve));
    if (failure === "network") stream.fail(new Error("network"));
    if (failure === "incomplete") stream.finish({ status: "IN_PROGRESS" });
    await pending;
    assert.equal(calls.length, 1); assert.equal(calls[0].requestId, "paid-id");
    assert.equal(calls[0].timeout, undefined); assert.equal(stream.aborted, true);
    assert.deepEqual(modes, ["streaming", "polling-fallback"]);
  }
});

test("状态流建立前/后取消均及时退出，不转轮询；迟到流也被关闭", async () => {
  for (const beforeOpen of [true, false]) {
    const gate = defer(), stream = fakeStream(), controller = new AbortController(); let polls = 0;
    const pending = waitForFalStatus({ queue: { streamStatus: () => beforeOpen ? gate.promise : stream,
      subscribeToStatus: async () => { polls++; },
    } }, "model", { requestId: "id", signal: controller.signal, onQueueUpdate() {}, onTransport() {} });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await assert.rejects(pending, { name: "AbortError" });
    gate.resolve(stream); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stream.aborted, true); assert.equal(polls, 0);
  }
});

test("真实跑道：stream 断线回退、计时分段，提交只发生一次", async () => {
  let mono = 0, submits = 0; const stream = fakeStream();
  const runway = new FalVideoRunway({ monotonicNow: () => mono,
    clientFactory: () => ({ queue: {
      submit: async () => { submits++; mono = 100; return { request_id: "paid" }; },
      streamStatus: async () => { queueMicrotask(() => stream.fail(new Error("offline"))); return stream; },
      subscribeToStatus: async (_model, { requestId, onQueueUpdate }) => {
        assert.equal(requestId, "paid"); mono = 300; onQueueUpdate({ status: "IN_PROGRESS" });
        mono = 2300; onQueueUpdate({ status: "COMPLETED" });
      },
      result: async () => { mono = 2400; return { data: { video: { url: "https://cdn.example/clip.mp4" } } }; },
      cancel: async () => assert.fail("successful job must not be cancelled"),
    } }),
  });
  const session = runway.create({ credentials: "test", beats: [{ index: 0, durationSeconds: 5, attackId: "a", purpose: "complete", motionPrompt: "test" }],
    referenceImages: ["player", "opponent"].map(side => ({ side, speciesId: side === "player" ? "pikachu" : "charmander", name: side, imageUrl: "https://cdn.example/ref.png" })) });
  for (let i = 0; i < 100 && runway.get(session.id).status === "generating"; i++) await new Promise(resolve => setImmediate(resolve));
  const clip = runway.get(session.id).clips[0];
  assert.equal(clip.status, "ready"); assert.equal(submits, 1);
  assert.equal(clip.submitMs, 100); assert.equal(clip.queueWaitMs, 200);
  assert.equal(clip.providerRunMs, 2000); assert.equal(clip.resultMs, 100);
  assert.equal(clip.statusTransport, "polling-fallback");
});
