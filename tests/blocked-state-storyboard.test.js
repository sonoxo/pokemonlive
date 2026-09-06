import test from "node:test";
import assert from "node:assert/strict";
import { createBattle, createSequenceRng, resolveTurn, confusionDamage } from "../src/battle-engine.js";
import { buildAttackRecords, createFallbackStoryboard, createRealtimeStoryboard, normalizeStoryboardPlan, sanitizeAttackRecords } from "../src/attack-storyboard.js";
import { createCinemaEventCursor } from "../src/cinema-events.js";
import { attackVisualScene } from "../src/visual-battle-state.js";
import { FalVideoRunway, FAL_VIDEO_MODEL, FAL_VIDEO_SEED } from "../src/fal-video-runway.js";

const record = result => buildAttackRecords(result.events, { turn: 1, battleEpoch: 0 });
function withCondition(status, options = {}) {
  const b = createBattle();
  const p = b.opponent.team[0];
  if (status === "confusion") p.volatile.confusedTurns = 3;
  else { p.status = status; p.statusTurns = 2; }
  if (options.first) p.stages.speed = 6;
  if (options.ko) p.hp = 1;
  return resolveTurn(b, { type: "move", moveIndex: options.first ? 2 : 1 }, () => status === "freeze" ? .5 : .1, { type: "move", moveIndex: 0 });
}

test("睡眠与冰冻：先手或后手未能行动均有独立镜头，不扣PP且无伪造伤害/解除", () => {
  for (const status of ["sleep", "freeze"]) for (const first of [false, true]) {
    const result = withCondition(status, { first }), records = record(result);
    assert.equal(records.length, 2);
    const blocked = records[first ? 0 : 1];
    assert.equal(blocked.blockedReason, status);
    assert.equal(blocked.actor.status, status);
    assert.equal(blocked.outcome.damage, 0);
    assert.equal(blocked.outcome.clearedStatus, null);
    assert.equal(result.state.opponent.team[0].moves[0].pp, 25);
    assert.doesNotThrow(() => sanitizeAttackRecords(structuredClone(records)));
    const beat = createRealtimeStoryboard(records).turn.sequence[first ? 0 : 1];
    assert.equal(beat.purpose, "blocked"); assert.equal(beat.impactAt, null);
    assert.match(beat.motionPrompt, status === "sleep" ? /still ASLEEP/ : /still FROZEN/);
    assert.doesNotMatch(beat.motionPrompt, /muscles lock and tremble once/);
    assert.deepEqual(attackVisualScene(blocked), attackVisualScene(blocked, true));
  }
});

test("刚施加睡眠或冰冻后立即失去行动：保留新增状态进入失败镜头，不擅自醒来/解冻", () => {
  const sleep = createBattle(); sleep.player.active = 2; sleep.player.team[2].stages.speed = 6;
  const asleep = record(resolveTurn(sleep, { type: "move", moveIndex: 2 }, () => .1, { type: "move", moveIndex: 0 }));
  assert.equal(asleep[0].outcome.status, "sleep"); assert.equal(asleep[1].blockedReason, "sleep");
  assert.doesNotThrow(() => sanitizeAttackRecords(structuredClone(asleep)));
  const ice = createBattle(); ice.player.active = 1; ice.player.team[1].stages.speed = 6;
  const frozen = record(resolveTurn(ice, { type: "move", moveIndex: 3 }, createSequenceRng([.5, .5, .5, .01, .5]), { type: "move", moveIndex: 0 }));
  assert.equal(frozen[0].outcome.status, "freeze"); assert.equal(frozen[1].blockedReason, "freeze");
  assert.doesNotThrow(() => sanitizeAttackRecords(structuredClone(frozen)));
});

test("自然醒来、自然解冻、混乱但成功出招时不增加失败分镜", () => {
  for (const status of ["sleep", "freeze", "confusion"]) {
    const b = createBattle(), p = b.opponent.team[0];
    if (status === "confusion") p.volatile.confusedTurns = 3;
    else { p.status = status; p.statusTurns = 0; }
    const records = record(resolveTurn(b, { type: "move", moveIndex: 1 }, () => status === "freeze" ? .1 : .5, { type: "move", moveIndex: 0 }));
    assert.equal(records.length, 2);
    assert(records.every(r => !r.blockedReason));
    assert.doesNotThrow(() => sanitizeAttackRecords(structuredClone(records)));
  }
});

test("双方状态失败保留两个行动位置；混合状态不共享错误表演", () => {
  const b = createBattle(); b.player.active = 1;
  b.player.team[1].status = "sleep"; b.player.team[1].statusTurns = 2;
  b.opponent.team[0].status = "freeze";
  const records = record(resolveTurn(b, { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 0 }));
  assert.deepEqual(records.map(r => r.blockedReason), ["freeze", "sleep"]);
  assert.doesNotThrow(() => sanitizeAttackRecords(structuredClone(records)));
  assert.deepEqual(createRealtimeStoryboard(records).turn.sequence.map(b => b.purpose), ["blocked", "blocked"]);
});

test("混乱自伤：行动前后HP准确，游标到2.4秒才扣血，既不伤对手也不伪装反伤", () => {
  for (const first of [false, true]) {
    const result = withCondition("confusion", { first }), records = record(result);
    const i = first ? 0 : 1, blocked = records[i];
    const selfHit = result.events.find(e => e.source === "confusion");
    assert.equal(blocked.blockedReason, "confusion");
    assert.equal(blocked.actor.currentHp - blocked.outcome.selfDamage, selfHit.currentHp);
    assert.equal(blocked.outcome.selfDamage, selfHit.amount);
    assert.equal(blocked.outcome.damage, 0); assert.equal(blocked.outcome.recoilDamage, 0);
    assert.equal(selfHit.targetSide, "opponent");
    assert.doesNotThrow(() => sanitizeAttackRecords(structuredClone(records)));
    const beat = createRealtimeStoryboard(records).turn.sequence[i];
    assert.equal(beat.impactAt, 2.4); assert.match(beat.motionPrompt, /NOT recoil/);
    assert.doesNotThrow(() => normalizeStoryboardPlan({ version: 2, sequence: createFallbackStoryboard(records).turn.sequence }, records));
    const seen = [], cursor = createCinemaEventCursor(result.events, records, e => seen.push(e));
    if (i) { cursor.start(records[0].id); cursor.impact(records[0].id); }
    cursor.start(blocked.id); assert(!seen.includes(selfHit));
    cursor.impact(blocked.id); assert(seen.includes(selfHit));
    cursor.finish(); cursor.finish(); assert.deepEqual(seen, result.events);
  }
});

test("混乱自伤KO归属于行动者，镜头卷卷眼与尾帧倒地对应，不再给倒下者生成攻击", () => {
  const result = withCondition("confusion", { first: true, ko: true }), records = record(result);
  assert.equal(records.length, 1); const blocked = records[0];
  assert.equal(blocked.outcome.selfDamage, 1); assert.equal(blocked.outcome.actorFainted, true);
  assert.equal(blocked.outcome.fainted, false);
  assert.doesNotThrow(() => sanitizeAttackRecords(structuredClone(records)));
  assert.equal(attackVisualScene(blocked, true).opponent.fainted, true);
  assert.equal(attackVisualScene(blocked, true).player.fainted, false);
  const beat = createRealtimeStoryboard(records).turn.sequence[0];
  assert.equal(beat.purpose, "blocked"); assert.match(beat.motionPrompt, /BOTH eyes visibly become bold black spiral/);
});

test("混乱伤害校验拒绝伪造自伤、假KO和其它状态夹带自伤，保留原公式", () => {
  const records = record(withCondition("confusion"));
  for (const mutate of [r => { r.outcome.selfDamage = 1; }, r => { r.outcome.actorFainted = true; },
    r => { r.outcome.damage = 2; }, r => { r.actor.confused = false; }, r => { r.outcome.recoilDamage = 1; }]) {
    const copy = structuredClone(records); mutate(copy[1]); assert.throws(() => sanitizeAttackRecords(copy));
  }
  const sleeping = record(withCondition("sleep")); sleeping.forEach(r => assert(!r.outcome.selfDamage));
  const bad = structuredClone(sleeping); bad[1].outcome.selfDamage = 1;
  assert.throws(() => sanitizeAttackRecords(bad), /非混乱/);
  const p = createBattle().player.team[0]; let calls = 0;
  confusionDamage(p, () => { calls++; return .5; }); assert.equal(calls, 1);
});

test("已在睡眠或冰冻中不能跳过前序阻挡而冒充混乱自伤/麻痹", () => {
  for (const status of ["sleep", "freeze"]) {
    const records = structuredClone(record(withCondition(status)));
    records[1].blockedReason = "confusion"; records[1].outcome.selfDamage = 10;
    assert.throws(() => sanitizeAttackRecords(records), /睡眠或冰冻/);
  }
});

test("状态阻挡分镜沿用正式Turbo跑道、前片真实尾帧与固定seed，不额外提交空攻击", async () => {
  const records = record(withCondition("sleep")), submitted = [], extracted = [];
  const client = { queue: {
    async submit(model, { input }) { submitted.push({ model, input }); return { request_id: String(submitted.length) }; },
    async subscribeToStatus() {}, async result(_m, { requestId }) { return { data: { video: { url: `https://cdn.example/${requestId}.mp4` } } }; },
    async cancel() {},
  } };
  const tail = "data:image/jpeg;base64,dGFpbA==";
  const runway = new FalVideoRunway({ clientFactory: () => client,
    tailFrameExtractor: async url => { extracted.push(url); return new Blob(["tail"]); }, tailFrameUploader: async () => tail });
  const run = runway.create({ credentials: "test", beats: createRealtimeStoryboard(records).turn.sequence,
    openingFrame: "data:image/jpeg;base64,b3Blbg==", referenceImages: [
      { side: "player", speciesId: "pikachu", name: "皮卡丘", imageUrl: "data:image/png;base64,cA==" },
      { side: "opponent", speciesId: "charmander", name: "小火龙", imageUrl: "data:image/png;base64,bw==" },
    ] });
  for (let i = 0; i < 50 && runway.get(run.id).status === "generating"; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(runway.get(run.id).status, "ready");
  assert.equal(submitted.length, 2); assert.deepEqual(extracted, ["https://cdn.example/1.mp4"]);
  assert.equal(submitted[1].model, FAL_VIDEO_MODEL); assert.equal(submitted[1].input.seed, FAL_VIDEO_SEED);
  assert.equal(submitted[1].input.image_url, tail); assert.match(submitted[1].input.prompt, /still ASLEEP/);
});
