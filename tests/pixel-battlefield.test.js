import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("正式战斗页面保持 2D，项目不再依赖 Three.js", async () => {
  const [index, app, packageSource, lockSource] = await Promise.all([
    readProjectFile("index.html"),
    readProjectFile("src/app.js"),
    readProjectFile("package.json"),
    readProjectFile("package-lock.json"),
  ]);

  assert.doesNotMatch(index, /three(?:\.module|\/addons)|battle-viewport|3D 模型/u);
  assert.doesNotMatch(app, /BattleScene3D|battle-scene-3d/u);
  const manifest = JSON.parse(packageSource);
  const lock = JSON.parse(lockSource);
  assert.equal(manifest.dependencies?.three, undefined);
  assert.equal(manifest.devDependencies?.three, undefined);
  assert.equal(lock.packages[""].dependencies?.three, undefined);
  assert.equal(lock.packages["node_modules/three"], undefined);
});

test("所有已注册宝可梦均使用本地前后视像素精灵", async () => {
  const data = await readProjectFile("src/data.js");
  const spritePaths = [...data.matchAll(/sprite:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(spritePaths, [
    "assets/sprites/pikachu-back.gif",
    "assets/sprites/squirtle-back.gif",
    "assets/sprites/bulbasaur-back.gif",
    "assets/sprites/charmander-front.gif",
    "assets/sprites/geodude-front.gif",
    "assets/sprites/gastly-front.gif",
    "assets/sprites/dragonite-front.gif",
    "assets/sprites/gengar-front.gif",
  ]);
  await Promise.all(spritePaths.map((path) => access(new URL(`../${path}`, import.meta.url))));
});

test("默认动画待机使用新松林背景并保留本地像素回退", async () => {
  const [index, app, css] = await Promise.all([
    readProjectFile("index.html"),
    readProjectFile("src/app.js"),
    readProjectFile("styles.css"),
  ]);

  assert.match(index, /pine-idle-v2-loop\.mp4/u);
  assert.match(index, /pine-idle-v2-loop-first-frame\.png/u);
  assert.match(index, /battle-stage battle-stage--pine/u);
  assert.match(css, /assets\/backgrounds\/pine-clearing-v2\.png/u);
  assert.match(app, /Boolean\(dom\.idleBattleVideo\.getAttribute\("src"\)\)/u);
  assert.match(app, /supportsDefaultIdleVideo/u);
  assert.match(app, /matchMedia\("\(min-width: 661px\)"\)/u);
  assert.match(app, /setIdleBattleVideoActive\(false\)/u);
  await Promise.all([
    access(new URL("../assets/video/pine-idle-v2-loop.mp4", import.meta.url)),
    access(new URL("../assets/video/pine-idle-v2-loop-first-frame.png", import.meta.url)),
    access(new URL("../assets/backgrounds/pine-clearing-v2.png", import.meta.url)),
  ]);
});

test("通用听令片动态预加载且服务端按缓存键锚定真实尾帧", async () => {
  const [index, server, app] = await Promise.all([
    readProjectFile("index.html"), readProjectFile("server.mjs"),
    readProjectFile("src/app.js"),
  ]);
  assert.match(index, /id="command-bridge"[^>]*preload="auto"/u);
  assert.doesNotMatch(index, /id="command-bridge"[^>]*(?:src=|muted)/u);
  assert.match(server, /sceneVideos\.anchor\(body.sceneAnchorKey/);
  assert.match(app, /const commandUrl = entry\?\.command\?\.videoUrl/);
  assert.doesNotMatch(app, /pine-command-v2\.mp4/);
  assert.doesNotMatch(index, /src="assets\/video\/(?:command-bridge|idle-battle-pikachu-charmander-anime-v3)\.mp4"/u);
  await Promise.all(["pine-command-v2.mp4", "pine-command-v2-tail.jpg"].map(name => access(new URL(`../assets/video/${name}`, import.meta.url))));
});
