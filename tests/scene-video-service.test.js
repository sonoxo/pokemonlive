import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SceneVideoService, sceneVideoSpec } from "../src/scene-video-service.js";
import { FalVideoRunway, FAL_VIDEO_SEED, FAL_VIDEO_MODEL, FAL_VIDEO_REFERENCE_MODEL } from "../src/fal-video-runway.js";
import { createBattle } from "../src/battle-engine.js";
import { visualScene } from "../src/visual-battle-state.js";
import { requestSceneVideo } from "../src/scene-video-client.js";

test("收尾将攻击尾帧直接作为 Turbo 首帧，不复用场景 R2V 重建构图，不强制回到旧尾帧", async () => {
  let receivedHealth;
  const { service, submissions, options } = await harness({ loadAttackAnchor: async (_source, _scene, _signal, health) => {
    receivedHealth = health; return "data:image/jpeg;base64,dGFpbA==";
  }, loadContextImages: () => { throw new Error("recovery must not rebuild reference layout"); } });
  const health = { player: { currentHp: 10, maxHp: 110 }, opponent: { currentHp: 50, maxHp: 100 } };
  const input = { kind: "recovery", scene: visualScene(createBattle()), health,
    sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 1 } };
  const job = service.create(input, "test");
  await service.jobs.get(job.key).done;
  assert.equal((await service.get(job.key)).status, "ready");
  assert.deepEqual(receivedHealth, health);
  assert.equal(submissions[0].openingFrame, "data:image/jpeg;base64,dGFpbA==");
  assert.equal(submissions[0].closingFrame, null);
  assert.deepEqual(submissions[0].contextImages, []);
  assert.equal(submissions[0].beats[0].durationSeconds, 5);
  assert.equal(submissions[0].beats[0].purpose, "recovery");
  assert.equal((await new SceneVideoService(options).get(job.key)).status, "ready");
  const same = service.create(input, "test"); assert.equal(same.key, job.key);
  assert.equal(submissions.length, 1);
});

test("收尾等待尾帧时取消不付费；不匹配的末段锚点拒绝生成", async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const { service, submissions } = await harness({ loadAttackAnchor: () => gate });
  const input = { kind: "recovery", scene: visualScene(createBattle()),
    health: { player: { currentHp: 10, maxHp: 110 }, opponent: { currentHp: 50, maxHp: 100 } },
    sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 1 } };
  const job = service.create(input, "test"); service.cancel(job.key);
  finish(null); await service.jobs.get(job.key).done;
  assert.equal((await service.get(job.key)).status, "cancelled");
  const rejected = await harness({ loadAttackAnchor: async () => null });
  const bad = rejected.service.create(input, "test"); await rejected.service.jobs.get(bad.key).done;
  assert.equal((await rejected.service.get(bad.key)).status, "error");
  assert.equal(submissions.length + rejected.submissions.length, 0);
});

const makeInput = () => {
  const battle = createBattle();
  const before = visualScene(battle);
  battle.player.active = 1;
  return { kind: "switch", before, scene: visualScene(battle) };
};
async function harness(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-scene-test-"));
  const submissions = [];
  const options = {
    directory,
    loadReferences: async scene => [scene.player, scene.opponent],
    loadContextImages: async () => [],
    fetchImpl: async () => new Response("fake video"),
    tailExtractor: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
    idleLoop: async bytes => bytes,
    commandAudio: async bytes => bytes,
    retryDelayMs: 0,
    recoverClip: async paid => ({ requestId: paid.requestId, model: paid.model, videoUrl: "https://example.com/video.mp4" }),
    runwayFactory: hooks => {
      let status = "generating";
      const clip = { requestId: `request-${submissions.length}`, model: FAL_VIDEO_REFERENCE_MODEL, videoUrl: "https://example.com/video.mp4", generationMs: 4 };
      return {
        create: input => {
          submissions.push(input);
          void hooks.submittedSink({ clip }).then(() => { status = "ready"; });
          return { id: "fake" };
        },
        get: () => ({ status, clips: [clip] }),
        cancel: () => { status = "cancelled"; },
      };
    },
    ...overrides,
  };
  return { options, submissions, service: new SceneVideoService(options) };
}

test("通用应答可由默认场景锚点预热，错阵容和状态在付费前拒绝", async () => {
  const valid = visualScene(createBattle());
  const { service, submissions } = await harness({ loadDefaultAnchor: async (scene, kind) => {
    assert.equal(kind, "command");
    return JSON.stringify(scene) === JSON.stringify(valid) ? "data:image/png;base64,YW5jaG9y" : null;
  } });
  const job = service.create({ kind: "command", scene: valid, sourceKey: "default" }, "test");
  await service.jobs.get(job.key).done;
  assert.equal((await service.get(job.key)).status, "ready");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].openingFrame, "data:image/png;base64,YW5jaG9y");
  assert.match(submissions[0].beats[0].motionPrompt, /creature acknowledgment cry/);
  for (const patch of [{ speciesId: "squirtle" }, { status: "sleep" }]) {
    const wrong = { ...valid, player: { ...valid.player, ...patch } };
    const bad = service.create({ kind: "command", scene: wrong, sourceKey: "default" }, "test");
    await service.jobs.get(bad.key).done;
    assert.equal((await service.get(bad.key)).status, "error");
  }
  assert.equal(submissions.length, 1);
});

test("仅可回应的听令片处理响度，睡眠冰冻昏厥不放大主动应答", async () => {
  let audioCalls = 0;
  const { service } = await harness({ loadAttackAnchor: async () => "data:image/jpeg;base64,YW5jaG9y",
    commandAudio: async bytes => { audioCalls++; return bytes; } });
  for (const state of [null, "sleep", "freeze", "fainted"]) {
    const scene = visualScene(createBattle());
    if (state === "fainted") scene.player.fainted = true;
    else scene.player.status = state;
    const job = service.create({ kind: "command", scene, sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 } }, "test");
    await service.jobs.get(job.key).done;
    assert.equal((await service.get(job.key)).status, "ready");
    assert.equal(audioCalls, 1);
  }
});

test("应答响度处理失败保留已付费原片可播放，重启复用不重买", async () => {
  const { service, submissions, options } = await harness({ loadDefaultAnchor: async () => "data:image/png;base64,YQ==",
    commandAudio: async () => { throw new Error("FFmpeg audio failed"); } });
  const job = service.create({ kind: "command", scene: visualScene(createBattle()), sourceKey: "default" }, "test");
  await service.jobs.get(job.key).done;
  const ready = await service.get(job.key);
  assert.equal(ready.status, "ready"); assert(ready.playable); assert(ready.videoUrl);
  assert.equal((await readFile(join(options.directory, job.key, "media.mp4"))).toString(), "fake video");
  const saved = JSON.parse(await readFile(join(options.directory, job.key, "manifest.json"), "utf8"));
  assert.equal(saved.audioVersion, null); assert(saved.audioError);
  assert.equal((await new SceneVideoService(options).get(job.key)).status, "ready");
  assert.equal(submissions.length, 1);
});

test("应答音轨处理中取消后，迟到结果不能发布或重买", async () => {
  let started, finish;
  const startedGate = new Promise(resolve => { started = resolve; });
  const audioGate = new Promise(resolve => { finish = resolve; });
  const { service, submissions } = await harness({ loadDefaultAnchor: async () => "data:image/png;base64,YQ==",
    commandAudio: async () => { started(); return audioGate; } });
  const job = service.create({ kind: "command", scene: visualScene(createBattle()), sourceKey: "default" }, "test");
  await startedGate;
  service.cancel(job.key);
  finish(Buffer.from("late audio"));
  await service.jobs.get(job.key).done;
  const cancelled = await service.get(job.key);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.playable, false); assert.equal(cancelled.videoUrl, null);
  assert.equal(submissions.length, 1);
});

test("场景服务在途去重、产物齐备后发布，并从磁盘缓存跨重启复用", async () => {
  const { service, submissions, options } = await harness();
  const input = makeInput();
  const a = service.create(input, "test");
  const b = service.create(input, "test");
  assert.equal(a.key, b.key);
  await service.jobs.get(a.key).done;
  const ready = await service.get(a.key);
  assert.equal(ready.status, "ready");
  assert.equal(ready.seed, FAL_VIDEO_SEED);
  assert.equal(submissions.length, 1);
  assert.equal((await readFile(join(options.directory, a.key, "media.mp4"))).toString(), "fake video");
  const journal = JSON.parse(await readFile(join(options.directory, a.key, "submission.json")));
  assert.equal(journal.requestId, "request-0");
  assert.equal(journal.seed, FAL_VIDEO_SEED);
  const restarted = new SceneVideoService(options);
  restarted.create(input, "test");
  await restarted.jobs.get(a.key).done;
  assert.equal((await restarted.get(a.key)).status, "ready");
  assert.equal((await restarted.get(a.key)).seed, FAL_VIDEO_SEED);
  assert.equal(submissions.length, 1);
});

test("旧场景缓存 seed 未知时保持未知，跨重启复用且不重复提交", async () => {
  const { service, submissions, options } = await harness();
  const input = makeInput();
  const job = service.create(input, "test");
  await service.jobs.get(job.key).done;
  const path = join(options.directory, job.key, "manifest.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  delete saved.seed;
  await writeFile(path, JSON.stringify(saved));
  assert.equal((await new SceneVideoService(options).get(job.key)).seed, null);
  const restarted = new SceneVideoService(options);
  restarted.create(input, "test");
  await restarted.jobs.get(job.key).done;
  assert.equal((await restarted.get(job.key)).seed, null);
  assert.equal(submissions.length, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).seed, undefined);
});

test("旧失败攻击缓存不能借 sourceKey 分支重新发布，旧正常登场缓存不失效", async () => {
  const { service, options } = await harness();
  const input = makeInput();
  const entrance = service.create(input, "test");
  await service.jobs.get(entrance.key).done;
  const idle = service.create({ kind: "idle", scene: input.scene, sourceKey: entrance.key }, "test");
  await service.jobs.get(idle.key).done;
  const path = join(options.directory, idle.key, "manifest.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.sourceAttack = { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 };
  delete saved.layoutVersion;
  await writeFile(path, JSON.stringify(saved));
  const restarted = new SceneVideoService(options);
  assert.equal(await restarted.get(idle.key), null);
  assert.equal((await restarted.get(entrance.key)).status, "ready");
  const retry = restarted.create({ kind: "idle", scene: input.scene, sourceKey: entrance.key }, "test");
  await restarted.jobs.get(retry.key).done;
  assert.equal((await restarted.get(idle.key)).status, "error", "不能从旧manifest发布失败画面或自动重复收费");
});

test("换人、待机和听令经真实视频跑道向两种 fal 模型传入相同固定 seed", async () => {
  const calls = [];
  const client = { queue: {
    async submit(model, { input }) { calls.push({ model, input }); return { request_id: `seed-${calls.length}` }; },
    async subscribeToStatus() {},
    async result(_model, { requestId }) { return { data: { video: { url: `https://example.com/${requestId}.mp4` } } }; },
    async cancel() {},
  } };
  const { service } = await harness({
    loadReferences: async scene => ["player", "opponent"].map(side => ({ side, speciesId: scene[side].speciesId, name: scene[side].speciesId, imageUrl: "data:image/png;base64,YXJ0" })),
    runwayFactory: hooks => new FalVideoRunway({ ...hooks, clientFactory: () => client }),
  });
  const input = makeInput();
  const entrance = service.create(input, "test");
  await service.jobs.get(entrance.key).done;
  assert.equal((await service.get(entrance.key)).status, "ready");
  const jobs = ["idle", "command"].map(kind => service.create({ kind, scene: input.scene, sourceKey: entrance.key }, "test"));
  await Promise.all(jobs.map(job => service.jobs.get(job.key).done));
  assert.deepEqual(calls.map(call => call.model), [FAL_VIDEO_REFERENCE_MODEL, FAL_VIDEO_MODEL, FAL_VIDEO_MODEL]);
  assert.deepEqual(calls.map(call => call.input.seed), [42, 42, 42]);
  for (const job of jobs) {
    const ready = await service.get(job.key);
    assert.equal(ready.status, "ready");
    assert.equal(ready.seed, FAL_VIDEO_SEED);
  }
});

test("生成已提交但下载失败或进程重启，不自动重复付费", async () => {
  const { service, submissions, options } = await harness({ fetchImpl: async () => { throw new Error("offline"); } });
  const input = makeInput();
  const job = service.create(input, "test");
  await service.jobs.get(job.key).done;
  assert.equal((await service.get(job.key)).status, "error");
  assert.equal(submissions.length, 1);
  const restarted = new SceneVideoService(options);
  restarted.create(input, "test");
  await restarted.jobs.get(job.key).done;
  assert.equal((await restarted.get(job.key)).status, "error");
  assert.equal(submissions.length, 1);
});

test("未就绪、错状态、错类型的锚点不能提交预热；准备好后两类都从相同登场尾帧启动", async () => {
  const { service, submissions } = await harness();
  const input = makeInput();
  const entrance = service.create(input, "test");
  assert.equal(await service.anchor(entrance.key, input.scene), null);
  await service.jobs.get(entrance.key).done;
  const wrong = structuredClone(input.scene);
  wrong.player.status = "sleep";
  assert.equal(await service.anchor(entrance.key, wrong), null);
  assert.equal(await service.anchor(entrance.key, input.scene, "command"), null);
  const jobs = ["idle", "command"].map(kind => service.create({ kind, scene: input.scene, sourceKey: entrance.key }, "test"));
  await Promise.all(jobs.map(job => service.jobs.get(job.key).done));
  assert.equal(submissions.length, 3);
  assert.equal(submissions[1].openingFrame, submissions[2].openingFrame);
  assert(submissions[1].openingFrame.startsWith("data:image/jpeg;base64,"));
  assert.equal(submissions[1].closingFrame, submissions[1].openingFrame);
});

test("错阵容的登场来源、非法输入在场景收费前失败", async () => {
  const { service, submissions } = await harness();
  const input = makeInput();
  const job = service.create({ kind: "idle", scene: input.scene, sourceKey: "f".repeat(64) }, "test");
  await service.jobs.get(job.key).done;
  assert.equal((await service.get(job.key)).status, "error");
  assert.equal(submissions.length, 0);
  assert.throws(() => sceneVideoSpec({ kind: "switch", before: input.before, scene: { ...input.scene, opponent: { ...input.scene.opponent, status: "sleep" } } }), /改变另一方状态/);
});

test("重开取消生成时未发布半成品，远端任务退出前不重复启动", async () => {
  const { service, submissions } = await harness();
  const input = makeInput();
  const job = service.create(input, "test");
  service.cancel(job.key);
  await service.jobs.get(job.key).done;
  assert.equal((await service.get(job.key)).status, "cancelled");
  assert.equal(submissions.length, 0);
  assert.equal((await service.get(job.key)).videoUrl, null);
});

test("取消发生于提交日志落盘期间，也必须在收费提交前停止", async () => {
  let entered, release;
  const writing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { service, submissions } = await harness({ writeSubmission: async (...args) => { entered(); await gate; return writeFile(...args); } });
  const job = service.create(makeInput(), "test");
  await writing;
  service.cancel(job.key);
  release();
  await service.jobs.get(job.key).done;
  assert.equal((await service.get(job.key)).status, "cancelled");
  assert.equal(submissions.length, 0);
});

test("战斗尾帧可在其它片生成中并发预热，取消锚点等待不会付费", async () => {
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  const { service, submissions } = await harness({ loadAttackAnchor: () => tail });
  const input = { kind: "idle", scene: makeInput().scene, sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 } };
  const a = service.create(input, "test");
  const b = service.create({ ...input, kind: "command" }, "test");
  service.cancel(a.key);
  await service.jobs.get(a.key).done;
  assert.equal(submissions.length, 0);
  release("data:image/jpeg;base64,dGFpbA==");
  await service.jobs.get(b.key).done;
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].openingFrame, null, "攻击尾帧可能是特写，用身份参考恢复双方同框");
  assert.equal(submissions[0].contextImages[0], "data:image/jpeg;base64,dGFpbA==");
  assert.equal((await service.get(b.key)).status, "ready");
});

test("收回不锁定旧尾帧，放出携带新身份与收回尾帧，错侧锚点收费前拒绝", async () => {
  const { service, submissions } = await harness({ loadDefaultAnchor: async () => "data:image/jpeg;base64,dGFpbA==", loadContextImages: async () => ["background", "outgoing-art"] });
  const input = makeInput();
  const recall = service.create({ kind: "recall", scene: input.before, side: "player", sourceKey: "default" }, "test");
  await service.jobs.get(recall.key).done;
  assert.equal(submissions[0].closingFrame, null, "不能要求收回片结尾重新出现旧宝可梦");
  assert.equal(await service.anchor(recall.key, input.before), null, "空场不能冒充双方待机");
  const sendout = service.create({ ...input, kind: "sendout", sourceKey: recall.key }, "test");
  await service.jobs.get(sendout.key).done;
  assert.equal((await service.get(sendout.key)).status, "ready");
  assert.equal(submissions[1].openingFrame, null);
  assert.deepEqual(submissions[1].contextImages, ["data:image/jpeg;base64,anBlZw==", "background"]);
  assert.equal(submissions[1].referenceImages[0].speciesId, "squirtle");
  const wrongScene = structuredClone(input.before);
  wrongScene.opponent.speciesId = "geodude";
  const bad = service.create({ kind: "sendout", before: input.before, scene: wrongScene, sourceKey: recall.key }, "test");
  await service.jobs.get(bad.key).done;
  assert.equal((await service.get(bad.key)).status, "error");
  assert.equal(submissions.length, 2);
});

test("五个执行槽占用时新状态进入队列；可取消排队任务且不挤掉听令", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, submissions } = await harness({ loadAttackAnchor: () => gate });
  const scene = makeInput().scene;
  const sourceAttack = { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 };
  const states = [null, "sleep", "poison", "freeze", "paralysis"].map(status => ({ ...scene, player: { ...scene.player, status } }));
  const active = states.map(state => service.create({ kind: "idle", scene: state, sourceAttack }, "test"));
  assert.equal(service.running, 5);
  const queued = service.create({ kind: "command", scene, sourceAttack }, "test");
  assert.equal(queued.status, "queued");
  const cancelled = service.create({ kind: "recall", scene, side: "player", sourceAttack }, "test");
  service.cancel(cancelled.key);
  await service.jobs.get(cancelled.key).done;
  assert.equal((await service.get(cancelled.key)).status, "cancelled");
  release("data:image/jpeg;base64,dGFpbA==");
  await Promise.all([...active, queued].map(job => service.jobs.get(job.key).done));
  assert.equal(submissions.length, 6);
  assert.equal((await service.get(queued.key)).status, "ready");
  assert.equal(service.running, 0);
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitPlayable(service, key) {
  for (let i = 0; i < 300; i++) {
    const job = await service.get(key);
    if (job.playable) return job;
    assert(!["error", "cancelled"].includes(job.status), job.error);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("playable deadline");
}

test("场景媒体先可播放；收回真实尾帧未到之前放出不付费提交", async () => {
  const tail = deferred(); let extracts = 0;
  const { service, options, submissions } = await harness({
    loadDefaultAnchor: async () => "data:image/jpeg;base64,dGFpbA==",
    tailExtractor: async () => { if (++extracts === 1) return tail.promise; return new Blob(["next tail"]); },
  });
  const input = makeInput();
  const recall = service.create({ kind: "recall", scene: input.before, side: "player", sourceKey: "default" }, "test");
  const playable = await waitPlayable(service, recall.key);
  assert.equal(playable.status, "generating"); assert.equal(playable.archiveReady, false); assert.equal(playable.tailReady, false);
  assert.equal((await readFile(join(options.directory, recall.key, "media.mp4"))).toString(), "fake video");
  const received = await requestSceneVideo({}, new AbortController().signal, async () => new Response(JSON.stringify({ ok: true, job: playable })));
  assert.equal(received.videoUrl, playable.videoUrl, "客户端不再等待归档完成");
  const sendout = service.create({ ...input, kind: "sendout", sourceKey: recall.key }, "test");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(submissions.length, 1);
  tail.resolve(new Blob(["recall tail"]));
  await Promise.all([recall, sendout].map(job => service.jobs.get(job.key).done));
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].contextImages[0], "data:image/jpeg;base64,cmVjYWxsIHRhaWw=");
  const ready = await service.get(recall.key);
  assert.equal(ready.archiveReady, true); assert.equal(ready.videoUrl, playable.videoUrl);
});

test("归档阻塞不挡场景播放和尾帧消费，未完成manifest不被重启复用", async () => {
  const disk = deferred(), reached = deferred();
  const { service, options, submissions } = await harness({ writeArtifact: async (path, bytes) => {
    if (path.endsWith("manifest.json")) { reached.resolve(); await disk.promise; }
    return writeFile(path, bytes);
  } });
  const input = makeInput(), job = service.create(input, "test");
  await reached.promise;
  const playable = await service.get(job.key);
  assert(playable.playable); assert.equal(playable.archiveReady, false);
  assert.match(await service.anchor(job.key, input.scene), /^data:image\/jpeg/);
  const restarted = new SceneVideoService(options);
  assert.equal(await restarted.get(job.key), null);
  const retry = restarted.create({ ...input, recoverOnly: true }, "test");
  await waitPlayable(restarted, retry.key);
  assert.equal(submissions.length, 1, "重启可恢复原片，但不能重买");
  disk.resolve(); await Promise.all([service.jobs.get(job.key).done, restarted.jobs.get(retry.key).done]);
  assert((await service.get(job.key)).archiveReady);
});

test("攻击状态待机必须先完成闭环；不会提前发布原始付费片头", async () => {
  const loop = deferred(), entered = deferred();
  const { service, options } = await harness({ loadAttackAnchor: async () => "data:image/jpeg;base64,dGFpbA==",
    idleLoop: async () => { entered.resolve(); return loop.promise; } });
  const job = service.create({ kind: "idle", scene: makeInput().scene,
    sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 } }, "test");
  await entered.promise;
  assert.equal((await service.get(job.key)).playable, false);
  assert.equal((await service.get(job.key)).videoUrl, null);
  loop.resolve(Buffer.from("processed sleeping loop"));
  await service.jobs.get(job.key).done;
  assert.equal((await readFile(join(options.directory, job.key, "media.mp4"))).toString(), "processed sleeping loop");
  assert.equal((await readFile(join(options.directory, job.key, "generation.mp4"))).toString(), "fake video");
});

test("场景归档或尾帧失败不撤回已可播媒体，但不得伪造锚点或重复付费", async () => {
  const { service, submissions } = await harness({ tailExtractor: async () => { throw new Error("tail failed"); } });
  const input = makeInput(), job = service.create(input, "test");
  await service.jobs.get(job.key).done;
  const playable = await service.get(job.key);
  assert(playable.playable); assert.equal(playable.archiveReady, false); assert.equal(playable.tailReady, false);
  assert.equal(await service.anchor(job.key, input.scene), null);
  service.create(input, "test"); assert.equal(submissions.length, 1);
});

test("等待已可播放的收回尾帧时取消放出，不能取消共享源或迟到付费", async () => {
  const tail = deferred();
  const { service, submissions } = await harness({ loadDefaultAnchor: async () => "data:image/jpeg;base64,dGFpbA==", tailExtractor: () => tail.promise });
  const input = makeInput();
  const recall = service.create({ kind: "recall", scene: input.before, side: "player", sourceKey: "default" }, "test");
  await waitPlayable(service, recall.key);
  const sendout = service.create({ ...input, kind: "sendout", sourceKey: recall.key }, "test");
  service.cancel(sendout.key); await service.jobs.get(sendout.key).done;
  assert.equal((await service.get(sendout.key)).status, "cancelled");
  assert.equal(service.jobs.get(recall.key).controller.signal.aborted, false);
  tail.resolve(new Blob(["tail"])); await service.jobs.get(recall.key).done;
  assert.equal(submissions.length, 1);
});

test("场景JPEG落盘失败仍保留已成功尾帧，后续放出可消费而不重复抽帧", async () => {
  let extracts = 0;
  const { service, submissions } = await harness({
    loadDefaultAnchor: async () => "data:image/jpeg;base64,dGFpbA==",
    tailExtractor: async () => { extracts++; return new Blob(["valid recall tail"]); },
    writeArtifact: async (path, bytes) => { if (path.endsWith("tail.jpg")) throw new Error("disk full"); return writeFile(path, bytes); },
  });
  const input = makeInput();
  const recall = service.create({ kind: "recall", scene: input.before, side: "player", sourceKey: "default" }, "test");
  await service.jobs.get(recall.key).done;
  assert.equal((await service.get(recall.key)).archiveReady, false);
  assert.equal(await service.anchor(recall.key, input.before, "recall"), "data:image/jpeg;base64,dmFsaWQgcmVjYWxsIHRhaWw=");
  const sendout = service.create({ ...input, kind: "sendout", sourceKey: recall.key }, "test");
  await service.jobs.get(sendout.key).done;
  assert.equal(submissions.length, 2); assert.equal(extracts, 2, "每条付费视频只抽一次");
  assert.equal(submissions[1].contextImages[0], "data:image/jpeg;base64,dmFsaWQgcmVjYWxsIHRhaWw=");
});

test("下载失败后同进程恢复旧任务，在途去重且不需要旧战斗尾帧", async () => {
  let offline = true, lookups = 0, anchors = 0;
  const { service, submissions } = await harness({
    loadAttackAnchor: async () => { if (++anchors > 1) throw new Error("expired tail"); return "data:image/jpeg;base64,YQ=="; },
    fetchImpl: async () => { if (offline) throw new Error("offline"); return new Response("recovered paid video"); },
    recoverClip: async paid => { lookups++; return { ...paid, videoUrl: "https://example.com/paid.mp4" }; },
  });
  const input = { kind: "idle", scene: makeInput().scene, sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 } };
  const first = service.create(input, "test"); await service.jobs.get(first.key).done;
  assert.equal((await service.get(first.key)).retryable, true);
  offline = false;
  service.create({ ...input, recoverOnly: true }, "test");
  const done = service.jobs.get(first.key).done;
  service.create(input, "test"); assert.equal(service.jobs.get(first.key).done, done);
  await done;
  assert.equal((await service.get(first.key)).status, "ready");
  assert.equal(submissions.length, 1); assert.equal(lookups, 1); assert.equal(anchors, 1);
});

test("磁盘发布失败跨重启用校验过的原片恢复；待机仍闭环，不联网不重买", async () => {
  let blocked = true, loops = 0;
  const { service, options, submissions } = await harness({ loadAttackAnchor: async () => "data:image/jpeg;base64,YQ==",
    writeArtifact: async (path, bytes) => {
      if (blocked && path.endsWith("media.mp4")) throw Object.assign(new Error("full"), { code: "ENOSPC" });
      return writeFile(path, bytes);
    },
    idleLoop: async () => { loops++; return Buffer.from("settled paralysis loop"); },
  });
  const input = { kind: "idle", scene: makeInput().scene, sourceAttack: { sessionId: "11111111-1111-4111-8111-111111111111", clipIndex: 0 } };
  const first = service.create(input, "test"); await service.jobs.get(first.key).done;
  const failed = await service.get(first.key);
  assert.equal(failed.errorCode, "ENOSPC"); assert(failed.retryable); assert(!failed.playable);
  blocked = false;
  const restarted = new SceneVideoService({ ...options,
    loadAttackAnchor: () => assert.fail("expired anchor is not needed"),
    recoverClip: () => assert.fail("verified raw needs no network"), fetchImpl: () => assert.fail("no download"),
  });
  restarted.create({ ...input, recoverOnly: true }, "test"); await restarted.jobs.get(first.key).done;
  assert.equal((await restarted.get(first.key)).status, "ready");
  assert.equal((await readFile(join(options.directory, first.key, "media.mp4"))).toString(), "settled paralysis loop");
  assert.equal(loops, 2); assert.equal(submissions.length, 1);
});

test("原片半写或被截断不能直接发布，按同 requestId 重新下载", async () => {
  let fail = true, lookups = 0;
  const { service, options, submissions } = await harness({
    writeArtifact: async (path, bytes) => { if (fail && path.endsWith("media.mp4")) throw new Error("disk"); return writeFile(path, bytes); },
    recoverClip: async paid => { lookups++; return { ...paid, videoUrl: "https://example.com/original.mp4" }; },
  });
  const input = makeInput(), job = service.create(input, "test"); await service.jobs.get(job.key).done;
  await writeFile(join(options.directory, job.key, "generation.mp4"), "partial");
  fail = false;
  const restarted = new SceneVideoService(options);
  restarted.create({ ...input, recoverOnly: true }, "test"); await restarted.jobs.get(job.key).done;
  assert.equal((await restarted.get(job.key)).status, "ready"); assert.equal(lookups, 1); assert.equal(submissions.length, 1);
  assert.equal((await readFile(join(options.directory, job.key, "media.mp4"))).toString(), "fake video");
});

test("恢复缺记录、未知提交、错 key/kind/model 均关闭付费入口", async () => {
  for (const variant of ["missing", "malformed", "intent", "key", "kind", "model", "requestId"]) {
    const { service, options, submissions } = await harness({ recoverClip: () => assert.fail("unconfirmed task cannot be read") });
    const input = makeInput(), spec = sceneVideoSpec(input), directory = join(options.directory, spec.key);
    await mkdir(directory);
    let paid = { key: spec.key, kind: spec.kind, status: "submitted", requestId: "paid-1", model: FAL_VIDEO_REFERENCE_MODEL };
    if (variant === "intent") paid.status = "submitting";
    else if (["key", "kind", "model", "requestId"].includes(variant)) paid[variant] = "../invalid";
    if (variant !== "missing") await writeFile(join(directory, "submission.json"), variant === "malformed" ? "{" : JSON.stringify(paid));
    const job = service.create({ ...input, recoverOnly: true }, "test"); await service.jobs.get(job.key).done;
    assert.equal((await service.get(job.key)).status, "error", variant);
    assert.equal((await service.get(job.key)).retryable, false, variant);
    assert.equal(submissions.length, 0, variant);
  }
});

test("恢复时取消只中断本地读取，迟到结果不发布，不取消远端原任务", async () => {
  let offline = true;
  const gate = deferred(), entered = deferred();
  const { service, submissions } = await harness({ fetchImpl: async () => { if (offline) throw new Error("offline"); return new Response("paid"); },
    recoverClip: async paid => { entered.resolve(); await gate.promise; return { ...paid, videoUrl: "https://example.com/video.mp4" }; },
  });
  const input = makeInput(), job = service.create(input, "test"); await service.jobs.get(job.key).done;
  offline = false;
  service.create({ ...input, recoverOnly: true }, "test");
  const recovering = service.jobs.get(job.key);
  await entered.promise; service.cancel(job.key); service.create(input, "test");
  assert.equal(service.jobs.get(job.key), recovering, "取消尚未结束不能覆盖在途任务");
  assert.equal(recovering.runway, undefined);
  gate.resolve(); await recovering.done;
  assert.equal((await service.get(job.key)).status, "cancelled"); assert.equal((await service.get(job.key)).playable, false);
  assert.equal(submissions.length, 1);
});

test("原子发布失败清理本次临时文件，不用半写文件挤占恢复空间", async () => {
  const { service, options, submissions } = await harness();
  const input = makeInput(), key = sceneVideoSpec(input).key, directory = join(options.directory, key);
  await mkdir(join(directory, "media.mp4"), { recursive: true });
  service.create(input, "test"); await service.jobs.get(key).done;
  assert.equal((await service.get(key)).status, "error");
  assert(!(await readdir(directory)).some(name => name.endsWith(".part")));
  assert.equal(submissions.length, 1);
});

test("结果缓存 JSON 损坏不影响已验证付费凭证，仍可读取原任务", async () => {
  let blocked = true, queries = 0;
  const { service, options, submissions } = await harness({
    fetchImpl: async () => { if (blocked) throw new Error("offline"); return new Response("original video"); },
    recoverClip: async paid => { queries++; return { ...paid, videoUrl: "https://example.com/original.mp4" }; },
  });
  const input = makeInput(), job = service.create(input, "test"); await service.jobs.get(job.key).done;
  await writeFile(join(options.directory, job.key, "result.json"), "{truncated");
  blocked = false;
  const restarted = new SceneVideoService(options);
  restarted.create({ ...input, recoverOnly: true }, "test"); await restarted.jobs.get(job.key).done;
  assert.equal((await restarted.get(job.key)).status, "ready"); assert.equal(queries, 1); assert.equal(submissions.length, 1);
});
