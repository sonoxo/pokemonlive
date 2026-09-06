// Partition only the visible gap AFTER the preceding clip ended. Work hidden
// under that clip's playback is not reported as user-visible waiting.
export function clipGapMetrics(events, index, nowMs) {
  if (index < 1) return null;
  const time = (name, clipIndex) => events.find(event => event.name === name && event.clipIndex === clipIndex)?.ms;
  const ended = time("clip_ended", index - 1);
  if (!Number.isFinite(ended) || !Number.isFinite(nowMs) || nowMs < ended) return null;
  const ready = Math.max(ended, Math.min(nowMs, time("clip_ready", index) ?? nowMs));
  const buffered = Math.max(ready, Math.min(nowMs, time("clip_buffered", index) ?? nowMs));
  return { clip_gap_ms: nowMs - ended, gap_generation_ms: ready - ended,
    gap_buffer_ms: buffered - ready, gap_handoff_ms: nowMs - buffered };
}
