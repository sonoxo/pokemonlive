import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

const file = path => new URL(`../${path}`, import.meta.url);

test("像素网页主题本地加载并位于基础战场样式之后", async () => {
  const index = await readFile(file("index.html"), "utf8");
  const theme = await readFile(file("pixel-ui.css"), "utf8");
  assert(index.indexOf('href="styles.css"') < index.indexOf('href="pixel-ui.css"'));
  assert.match(index, /TAB 选择 · 1–4 快捷指令 · ESC 返回/u);
  assert.match(theme, /font-display: swap/u);
  assert.match(theme, /--coral: #e74742/u);
  assert.match(theme, /--acid: #ffda45/u);
  assert.match(theme, /--blue: #3564aa/u);
  assert.match(theme, /button:focus-visible/u);
  assert.doesNotMatch(theme, /@import|https?:\/\//u);
});

test("中文像素字体为真实 WOFF2 并保留发行版及上游许可", async () => {
  const font = await readFile(file("assets/fonts/fusion-pixel-12px-monospaced-zh_hans.woff2"));
  assert.equal(font.subarray(0, 4).toString(), "wOF2");
  assert(font.byteLength > 100000);
  const license = await readFile(file("assets/fonts/OFL.txt"), "utf8");
  assert.match(license, /SIL Open Font License/u);
  await Promise.all([
    "assets/fonts/LICENSES/ark-pixel/OFL.txt",
    "assets/fonts/LICENSES/cubic-11/OFL.txt",
    "assets/fonts/LICENSES/galmuri/LICENSE.txt",
  ].map(path => access(file(path))));
  const server = await readFile(file("server.mjs"), "utf8");
  assert.match(server, /"\.woff2": "font\/woff2"/u);
});

test("网页换肤不覆盖视频渲染、战场几何或演出显隐状态", async () => {
  const theme = (await readFile(file("pixel-ui.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(theme, /(?:^|\n)[^{}]*(?:video|\.battle-stage|\.inline-cinema|is-cinema-active|is-idle-video-active|\[hidden\])[^{}]*\{/u);
  assert.doesNotMatch(theme, /image-rendering|object-fit|aspect-ratio|visibility\s*:/u);
  const index = await readFile(file("index.html"), "utf8");
  assert.match(index, /assets\/video\/pine-idle-v2-loop\.mp4/u);
  assert.match(index, /id="command-bridge"[^>]*preload="auto"/u);
  assert.doesNotMatch(index, /src="assets\/video\/pine-command-v2\.mp4"/u);
});
