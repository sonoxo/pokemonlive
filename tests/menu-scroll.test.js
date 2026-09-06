import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const panelBody = app.slice(app.indexOf("function showPanel("), app.indexOf("function showResult("));

function panelHarness({ backOnly = false } = {}) {
  const frames = [], focused = [];
  const button = { focus: options => focused.push(options) };
  const panels = ["main", "moves", "team", "bag", "result"].map(name => ({
    dataset: { panel: name }, active: false,
    classList: { toggle(_name, active) { panels.find(p => p.dataset.panel === name).active = active; } },
    querySelector: selector => backOnly && selector.includes(".command-button") ? null : button,
  }));
  const showPanel = new Function("dom", "window", "document", `let activePanel; ${panelBody}; return showPanel;`)(
    { panels }, { requestAnimationFrame: callback => frames.push(callback) },
    { querySelector: selector => panels.find(p => selector.includes(`"${p.dataset.panel}"`)) },
  );
  return { showPanel, panels, frames, focused };
}

test("菜单切换保留键盘焦点，但不允许聚焦滚动整个页面", () => {
  for (const name of ["main", "moves", "team", "bag", "result"]) {
    const h = panelHarness();
    h.showPanel(name);
    assert.deepEqual(h.panels.filter(p => p.active).map(p => p.dataset.panel), [name]);
    h.frames.shift()();
    assert.deepEqual(h.focused, [{ preventScroll: true }]);
  }
});

test("返回按钮的兜底聚焦也不滚动，显式禁用焦点时不安排聚焦", () => {
  const h = panelHarness({ backOnly: true });
  h.showPanel("bag"); h.frames.shift()();
  assert.deepEqual(h.focused, [{ preventScroll: true }]);
  h.showPanel("main", { focus: false });
  assert.equal(h.frames.length, 0);
  assert.equal(h.focused.length, 1);
});

test("所有菜单共用网格位置，隐藏菜单保留尺寸但不能获得焦点或鼠标点击", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const panel = css.match(/\.panel-view\s*\{([^}]+)\}/)[1];
  assert.match(css, /\.command-panel\s*\{[^}]*display:\s*grid/);
  assert.match(panel, /grid-area:\s*1\s*\/\s*1/);
  assert.match(panel, /display:\s*block/);
  assert.match(panel, /visibility:\s*hidden/);
  assert.match(css, /\.panel-view\.is-active\s*\{[^}]*visibility:\s*visible/);
});
