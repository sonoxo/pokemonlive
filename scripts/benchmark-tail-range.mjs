// Existing clips only: no generation/submission and no artifact writes.
// node scripts/benchmark-tail-range.mjs .local/runs/<id>/clip-0.json [...]
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { VideoMediaCache } from "../src/video-media-cache.js";
import { downloadVideo, extractVideoTailFrame } from "../src/video-tail-frame.js";

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Provide existing clip JSON paths; this script never generates video.");
const hash = async blob => createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex");
for (const [index, path] of paths.entries()) {
  const clip = JSON.parse(await readFile(path, "utf8"));
  const reference = await readFile(path.replace(/\.json$/, ".mp4"));
  const expected = await hash(await extractVideoTailFrame(clip.videoUrl, { fetchImpl: async () => new Response(reference) }));
  // Alternate order to reduce the systematic benefit of warm connections.
  for (const mode of index % 2 ? ["range-only", "full-only"] : ["full-only", "range-only"]) {
    if (mode === "full-only") {
      const started = performance.now();
      const bytes = await downloadVideo(clip.videoUrl, { signal: AbortSignal.timeout(45000) });
      const downloadMs = Math.round(performance.now() - started);
      const frame = await extractVideoTailFrame(clip.videoUrl, { fetchImpl: async () => new Response(bytes) });
      const identicalFrame = await hash(frame) === expected;
      console.log(JSON.stringify({ clip: path, mode, identicalFrame, downloadBytes: bytes.length, downloadMs,
        tailReadyMs: Math.round(performance.now() - started) }));
      if (!identicalFrame) throw new Error("Tail frame mismatch");
      continue;
    }
    const cache = new VideoMediaCache();
    const entry = cache.pin(clip.videoUrl);
    const frame = await cache.tail(clip.videoUrl);
    const actual = await hash(frame);
    await entry.bytes;
    await entry.tailWork;
    console.log(JSON.stringify({ clip: path, mode, identicalFrame: actual === expected, ...entry.timings }));
    cache.release(clip.videoUrl);
    if (actual !== expected) throw new Error("Tail frame mismatch");
  }
}
