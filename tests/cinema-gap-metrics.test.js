import test from "node:test";
import assert from "node:assert/strict";
import { clipGapMetrics } from "../src/cinema-gap-metrics.js";

test("片间停顿分成等待生成、缓冲和切屏，不误计播放期间已完成的工作", () => {
  const e = [{ name: "clip_ended", clipIndex: 0, ms: 5000 },
    { name: "clip_ready", clipIndex: 1, ms: 6100 }, { name: "clip_buffered", clipIndex: 1, ms: 6800 }];
  assert.deepEqual(clipGapMetrics(e, 1, 6820), { clip_gap_ms: 1820, gap_generation_ms: 1100, gap_buffer_ms: 700, gap_handoff_ms: 20 });
  e[1].ms = 4000; e[2].ms = 4500;
  assert.deepEqual(clipGapMetrics(e, 1, 5010), { clip_gap_ms: 10, gap_generation_ms: 0, gap_buffer_ms: 0, gap_handoff_ms: 10 });
  assert.equal(clipGapMetrics(e, 0, 5010), null);
  assert.equal(clipGapMetrics([], 1, 5010), null);
});
