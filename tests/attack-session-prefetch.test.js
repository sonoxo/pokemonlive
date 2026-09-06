import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prefetchAttackSession } from "../src/attack-session-prefetch.js";

const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = () => new Response(JSON.stringify({ ok: true, session: { id: "accepted" } }));

test("攻击预提交一次，等待放出锚点/规划而非放出播放结束", async () => {
  const body = defer(), controller = new AbortController(), calls = [];
  const pending = prefetchAttackSession(body.promise, { signal: controller.signal,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(); } });
  assert.equal(calls.length, 0);
  body.resolve({ sceneAnchorKey: "actual-sendout", attacks: ["newcomer"] });
  assert.equal((await pending).session.id, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).sceneAnchorKey, "actual-sendout");
  controller.abort(); await tick();
  assert.equal(calls[1].url, "/api/attack-videos/accepted");
});

test("规划期间取消不购买；POST在途取消捕获迟到ID并仅取消同一任务", async () => {
  const body = defer(), controller = new AbortController(); let calls = 0;
  const pending = prefetchAttackSession(body.promise, { signal: controller.signal, fetchImpl: async () => { calls++; return response(); } });
  controller.abort(); body.resolve({}); await assert.rejects(pending, { name: "AbortError" }); assert.equal(calls, 0);
  const accepted = defer(), owner = new AbortController(), methods = [];
  const creating = prefetchAttackSession({}, { signal: owner.signal, fetchImpl: async (_url, options) => {
    methods.push(options.method); return options.method === "POST" ? accepted.promise : response();
  } });
  await tick(); owner.abort(); accepted.resolve(response());
  await assert.rejects(creating, { name: "AbortError" });
  assert.deepEqual(methods, ["POST", "DELETE"]);
});

test("预生成失败不会自动重提，放出预生成钩子早于播放且不为回合末换人买旧攻击", async () => {
  let calls = 0;
  await assert.rejects(prefetchAttackSession({}, { signal: new AbortController().signal,
    fetchImpl: async () => { calls++; throw new Error("uncertain"); } }), /uncertain/);
  assert.equal(calls, 1);
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const swap = app.slice(app.indexOf("async function playSwitchEvent("), app.indexOf("function finishTurnPresentation("));
  assert(swap.indexOf("onPrepared(job, run)") < swap.indexOf("await run.bridgeDone"));
  assert(swap.indexOf("onPrepared(job, run)") < swap.indexOf('run.mark("sendout_playing")'));
  assert.match(app, /action.type !== "switch" \|\| event.targetSide !== "player"/);
  assert(swap.indexOf("run.completed = true") < swap.indexOf("run.controller.abort()"));
});
