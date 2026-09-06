import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { buildAttackRecords, createFallbackStoryboard } from "../src/attack-storyboard.js";
import { createBattle, createSequenceRng, resolveTurn } from "../src/battle-engine.js";
import { handleHttpRequest, loadBattleReferenceImages } from "../server.mjs";

function attackPayload() {
  const result = resolveTurn(
    createBattle(),
    { type: "move", moveIndex: 0 },
    createSequenceRng([0, 0.5, 0.5, 0, 0.5, 0.5]),
    { type: "move", moveIndex: 1 },
  );
  return JSON.stringify({
    version: 2,
    battleEpoch: 0,
    turn: 1,
    attacks: buildAttackRecords(result.events, { battleEpoch: 0, turn: 1 }),
  });
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.body = "";
    this.writableEnded = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk = "") {
    this.body += chunk;
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
}

function fakePost({
  contentType = "application/json",
  origin,
  host = "127.0.0.1:4173",
  body = attackPayload(),
  url = "/api/attack-storyboards",
} = {}) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = "POST";
  request.url = url;
  request.headers = { "content-type": contentType, host };
  if (origin) request.headers.origin = origin;
  return { request, response: new FakeResponse() };
}

test("语音入口拒绝跨来源、非 JSON 和非游戏台词，不接受对手登场播报", async () => {
  for (const options of [
    { origin: "https://attacker.example" },
    { contentType: "text/plain" },
    { host: "attacker.example:4173" },
  ]) {
    const local = fakePost({ url: "/api/battle-speech", body: JSON.stringify({ text: "皮卡丘，使用十万伏特！" }), ...options });
    await handleHttpRequest(local.request, local.response);
    assert.equal(local.response.statusCode, 403);
  }
  for (const text of ["外部任意台词", "露营少年 阿岚派出了小拳石！", null]) {
    const local = fakePost({ url: "/api/battle-speech", body: JSON.stringify({ text }) });
    await handleHttpRequest(local.request, local.response);
    assert.equal(local.response.statusCode, 400);
    assert(!local.response.body.includes("sk-"));
  }
});

test("语音密钥文件不能从静态路由读取", async () => {
  for (const url of ["/.env.minimax.local", "/%2eenv.minimax.local", "/.env.tts.local"]) {
    const local = fakePost({ url, body: "" }); local.request.method = "GET";
    await handleHttpRequest(local.request, local.response);
    assert.equal(local.response.statusCode, 404);
  }
});

test("视频接口缺少服务端 FAL_KEY 时在提交队列前明确失败", async () => {
  const originalDisabled = process.env.FAL_DISABLE_VIDEO;
  process.env.FAL_DISABLE_VIDEO = "1";
  try {
    const requestBody = JSON.parse(attackPayload());
    requestBody.sequence = createFallbackStoryboard(requestBody.attacks).turn.sequence;
    const local = fakePost({
      origin: "http://127.0.0.1:4173",
      body: JSON.stringify(requestBody),
      url: "/api/attack-videos",
    });
    await handleHttpRequest(local.request, local.response);
    assert.equal(local.response.statusCode, 503);
    const payload = JSON.parse(local.response.body);
    assert.equal(payload.code, "missing_fal_key");
    assert.match(payload.error, /FAL_KEY/);
  } finally {
    if (originalDisabled === undefined) delete process.env.FAL_DISABLE_VIDEO;
    else process.env.FAL_DISABLE_VIDEO = originalDisabled;
  }
});

test("视频首段参考图由服务端按我方、对方顺序从物种白名单加载", async () => {
  const attacks = JSON.parse(attackPayload()).attacks;
  const references = await loadBattleReferenceImages(attacks);
  assert.deepEqual(references.map(({ side, speciesId, name }) => ({ side, speciesId, name })), [
    { side: "player", speciesId: "pikachu", name: "皮卡丘" },
    { side: "opponent", speciesId: "charmander", name: "小火龙" },
  ]);
  assert.ok(references.every((reference) => reference.imageUrl.startsWith("data:image/png;base64,")));
  assert.ok(references.every((reference) => reference.imageUrl.length < 512 * 1024));
  for (const reference of references) {
    const png = Buffer.from(reference.imageUrl.split(",")[1], "base64");
    assert.equal(png.readUInt32BE(16), 475, "AI references must use non-pixel artwork, not 96px sprites");
    assert.equal(png.readUInt32BE(20), 475);
  }
});

test("跨站 text/plain 与不可信 Origin 在调用 DeepSeek 前被拒绝", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("不应调用上游");
  };
  process.env.DEEPSEEK_API_KEY = "test-only-key";
  try {
    const plain = fakePost({ contentType: "text/plain", origin: "https://attacker.example" });
    await handleHttpRequest(plain.request, plain.response);
    assert.equal(plain.response.statusCode, 415);
    const crossOriginJson = fakePost({ origin: "https://attacker.example" });
    await handleHttpRequest(crossOriginJson.request, crossOriginJson.response);
    assert.equal(crossOriginJson.response.statusCode, 403);
    const rebound = fakePost({ host: "attacker.example:4173", origin: "http://attacker.example:4173" });
    await handleHttpRequest(rebound.request, rebound.response);
    assert.equal(rebound.response.statusCode, 403);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("浏览器请求断开会中止仍在进行的 DeepSeek 请求", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let signalUpstreamStarted;
  const upstreamStarted = new Promise((resolve) => { signalUpstreamStarted = resolve; });
  let upstreamAborted = false;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    signalUpstreamStarted();
    options.signal.addEventListener("abort", () => {
      upstreamAborted = true;
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  process.env.DEEPSEEK_API_KEY = "test-only-key";
  try {
    const local = fakePost({ origin: "http://127.0.0.1:4173" });
    const handling = handleHttpRequest(local.request, local.response);
    await upstreamStarted;
    local.response.emit("close");
    await handling;
    assert.equal(upstreamAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("网关拒绝旧版分组请求且不会调用 DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("不应调用上游");
  };
  process.env.DEEPSEEK_API_KEY = "test-only-key";
  try {
    const legacyBody = JSON.parse(attackPayload());
    legacyBody.version = 1;
    const legacy = fakePost({ origin: "http://127.0.0.1:4173", body: JSON.stringify(legacyBody) });
    await handleHttpRequest(legacy.request, legacy.response);
    assert.equal(legacy.response.statusCode, 400);
    assert.equal(upstreamCalls, 0);
    assert.match(JSON.parse(legacy.response.body).error, /version=2 联合时间线/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("DeepSeek 精简输出经本地事实重建后仍按 version=2 单一 turn 输出", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const requestBody = JSON.parse(attackPayload());
  const candidate = {
    sequence: requestBody.attacks.map(() => ({
      impactAt: 2.5,
      cuts: [0.7, 3.5],
      sizes: ["extreme_close_up", "wide", "medium"],
      moves: ["slow_push", "lateral_track", "locked"],
      motionPrompt: "伪造的分离角色镜头",
      damage: 99999,
    })),
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const sent = JSON.parse(options.body);
    assert.equal(sent.max_tokens, 1024);
    assert.deepEqual(sent.thinking, { type: "disabled" });
    assert.match(sent.messages[1].content, /"cuts"/);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(candidate) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  process.env.DEEPSEEK_API_KEY = "test-only-key";
  try {
    const local = fakePost({ origin: "http://127.0.0.1:4173" });
    await handleHttpRequest(local.request, local.response);
    assert.equal(local.response.statusCode, 200);
    const payload = JSON.parse(local.response.body);
    assert.equal(payload.source, "deepseek");
    assert.equal(payload.plan.version, 2);
    assert.equal(payload.plan.turn.attacks.length, 2);
    assert.equal(payload.plan.turn.sequence.length, 2);
    assert.deepEqual(payload.plan.turn.sequence.map((beat) => beat.purpose), ["complete", "complete"]);
    assert.equal(payload.plan.attacks, undefined);
    assert.doesNotMatch(payload.plan.turn.sequence[0].motionPrompt, /伪造的分离角色镜头/);
    assert.match(payload.plan.turn.sequence[0].motionPrompt, /Keep both Pokémon inside/);
    assert.match(payload.plan.turn.sequence[0].motionPrompt, /fresh hand-drawn establishing first frame/);
    assert.match(payload.plan.turn.sequence[0].motionPrompt, /Image 1 is the player-side pikachu.*Image 2 is the opponent-side charmander/);
    assert.equal(payload.plan.turn.sequence[0].shots.length, 3);
    assert.equal(payload.plan.turn.sequence[0].impactAt, 2.5);
    assert.equal(payload.plan.turn.sequence[0].shots[0].endAt, 0.7);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("无效精简输出和长度截断仍安全降级且不重试上游", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-only-key";
  try {
    for (const [finishReason, content, expected] of [
      ["stop", '{"sequence":[]}', "invalid_storyboard"],
      ["length", '{"sequence":[', "truncated_response"],
    ]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }));
      };
      const local = fakePost();
      await handleHttpRequest(local.request, local.response);
      const payload = JSON.parse(local.response.body);
      assert.equal(calls, 1);
      assert.equal(payload.source, "local-fallback");
      assert.equal(payload.failureCode, expected);
      assert.equal(payload.plan.turn.attacks.length, 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});
