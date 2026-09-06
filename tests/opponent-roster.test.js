import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBattle, createPokemon, resolveTurn, typeEffectiveness } from "../src/battle-engine.js";
import { buildAttackRecords, sanitizeAttackRecords, createRealtimeStoryboard } from "../src/attack-storyboard.js";
import { loadBattleReferenceImages } from "../server.mjs";
import { SPECIES } from "../src/data.js";
import { localizedName, videoLanguageDirection } from "../src/language.js";

test("对手按小火龙、喷火龙、耿鬼登场，我方阵容与 50 级保持不变", () => {
  const battle = createBattle();
  assert.deepEqual(battle.opponent.team.map(p => p.speciesId), ["charmander", "charizard", "gengar"]);
  assert.deepEqual(battle.player.team.map(p => p.speciesId), ["pikachu", "squirtle", "bulbasaur"]);
  assert(battle.opponent.team.every(p => p.level === 50 && p.hp === p.stats.hp));
  for (const index of [0, 1]) {
    const before = createBattle();
    before.opponent.active = index;
    before.opponent.team.slice(0, index + 1).forEach(p => { p.hp = 0; });
    before.opponent.team[index].hp = 1;
    const result = resolveTurn(before, { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex: 2 });
    const replacement = result.events.find(e => e.type === "switch" && e.targetSide === "opponent");
    assert.equal(result.state.opponent.active, index + 1);
    assert.equal(replacement.sceneAfter.opponent.speciesId, ["charizard", "gengar"][index]);
  }
});

test("新物种能力值、双属性和普通招式免疫符合现有规则", () => {
  const charizard = createPokemon("charizard");
  assert.deepEqual(charizard.stats, { hp: 153, attack: 104, defense: 98, specialAttack: 129, specialDefense: 105, speed: 120 });
  assert.deepEqual(charizard.types, ["fire", "flying"]);
  assert.equal(typeEffectiveness("rock", charizard.types), 4);
  assert.equal(typeEffectiveness("electric", charizard.types), 2);
  assert.equal(typeEffectiveness("ground", charizard.types), 0);
  const dragonite = createPokemon("dragonite"), gengar = createPokemon("gengar");
  assert.deepEqual(dragonite.stats, { hp: 166, attack: 154, defense: 115, specialAttack: 120, specialDefense: 120, speed: 100 });
  assert.deepEqual(gengar.stats, { hp: 135, attack: 85, defense: 80, specialAttack: 150, specialDefense: 95, speed: 130 });
  assert.equal(typeEffectiveness("ice", dragonite.types), 4);
  assert.equal(typeEffectiveness("electric", dragonite.types), 1);
  assert.equal(typeEffectiveness("normal", gengar.types), 0);
});

test("喷火龙和耿鬼全部招式能通过战斗事实校验与分镜编排", () => {
  for (const index of [1, 2]) for (let moveIndex = 0; moveIndex < 4; moveIndex++) {
    const battle = createBattle(); battle.opponent.active = index;
    const result = resolveTurn(battle, { type: "move", moveIndex: 0 }, () => .5, { type: "move", moveIndex });
    const attacks = sanitizeAttackRecords(structuredClone(buildAttackRecords(result.events)));
    const own = attacks.find(a => a.actor.side === "opponent");
    assert.equal(own.actor.speciesId, battle.opponent.team[index].speciesId);
    assert.equal(own.move.id, battle.opponent.team[index].moves[moveIndex].id);
    const plan = createRealtimeStoryboard(attacks);
    assert(plan.turn.sequence.length > 0);
    if (own.move.id === "dragonClaw") assert(plan.turn.sequence.some(beat => /close-range claw slash/.test(beat.motionPrompt)));
    if (own.move.id === "thunderWave") assert(plan.turn.sequence.every(beat => !/attacker's cheeks/.test(beat.motionPrompt)));
  }
});

test("新物种像素兜底与非像素参考图均可本地加载，服务端保持双方顺序", async () => {
  for (const speciesId of ["charizard", "dragonite", "gengar"]) {
    const sprite = await readFile(new URL(`../${SPECIES[speciesId].sprite}`, import.meta.url));
    assert.match(sprite.subarray(0, 6).toString(), /^GIF8[79]a$/);
    const subjects = [{ actor: { side: "opponent", speciesId }, target: { side: "player", speciesId: "pikachu" } }];
    for (const artwork of [true, false]) {
      const refs = await loadBattleReferenceImages(subjects, { artwork });
      assert.deepEqual(refs.map(r => r.speciesId), ["pikachu", speciesId]);
      const png = Buffer.from(refs[1].imageUrl.split(",")[1], "base64");
      assert.equal(png.readUInt32BE(16), artwork ? 475 : 96);
      assert.equal(png.readUInt32BE(20), artwork ? 475 : 96);
    }
  }
});

test("喷火龙支持三语展示与视频音轨命名，既有物种不被挤出名单", () => {
  assert.equal(localizedName("喷火龙", "en"), "Charizard");
  assert.equal(localizedName("喷火龙", "ja"), "リザードン");
  for (const language of ["zh", "en", "ja"]) {
    const direction = videoLanguageDirection(language);
    assert(direction.includes(`Charizard = ${localizedName("喷火龙", language)}`));
    assert(direction.includes(`Gastly = ${localizedName("鬼斯", language)}`));
  }
});
