import assert from "node:assert/strict";
import test from "node:test";

import { supportsDefaultIdleVideo } from "../src/idle-battle-video.js";

test("默认待机视频只匹配仍可战斗的皮卡丘与小火龙", () => {
  const pikachu = { speciesId: "pikachu", hp: 80 };
  const charmander = { speciesId: "charmander", hp: 50 };
  assert.equal(supportsDefaultIdleVideo(pikachu, charmander), true);
  assert.equal(supportsDefaultIdleVideo({ ...pikachu, hp: 0 }, charmander), false);
  assert.equal(supportsDefaultIdleVideo(pikachu, { ...charmander, hp: 0 }), false);
  assert.equal(supportsDefaultIdleVideo({ speciesId: "squirtle", hp: 80 }, charmander), false);
  assert.equal(supportsDefaultIdleVideo(pikachu, { speciesId: "geodude", hp: 50 }), false);
});
