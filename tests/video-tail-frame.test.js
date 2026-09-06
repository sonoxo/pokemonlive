import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractVideoTailFrame } from "../src/video-tail-frame.js";

test("FFmpeg 会从完整视频末尾提取可上传的 JPEG 尾帧", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pokemonlive-tail-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const videoPath = join(directory, "source.mp4");
  const generated = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", "color=c=0x2574d9:s=320x180:d=1:r=24",
    "-c:v", "mpeg4",
    videoPath,
  ]);
  assert.equal(generated.status, 0, generated.stderr?.toString("utf8"));
  const video = await readFile(videoPath);

  const frame = await extractVideoTailFrame("https://v3.fal.media/test.mp4", {
    fetchImpl: async () => new Response(video, {
      status: 200,
      headers: { "content-length": String(video.length) },
    }),
  });

  assert.equal(frame.type, "image/jpeg");
  assert.ok(frame.size > 100);
  const jpeg = new Uint8Array(await frame.arrayBuffer());
  assert.deepEqual([...jpeg.slice(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...jpeg.slice(-2)], [0xff, 0xd9]);
});
