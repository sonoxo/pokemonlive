import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCommandAudio } from "../src/command-video-audio.js";

test("本地应答响度处理保留视频帧与同步，提升过轻音轨而不重复生成", async () => {
  const dir = await mkdtemp(join(tmpdir(), "command-audio-test-"));
  const exec = promisify(execFile);
  try {
    const input = join(dir, "input.mp4"), output = join(dir, "output.mp4");
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=32x32:r=24:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-af", "volume=0.01", "-c:v", "libx264", "-c:a", "aac", "-shortest", input]);
    await writeFile(output, await normalizeCommandAudio(await readFile(input)));
    const videoHash = async path => (await exec("ffmpeg", ["-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-"])).stdout;
    assert.equal(await videoHash(input), await videoHash(output));
    const level = async path => {
      const { stderr } = await exec("ffmpeg", ["-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"]);
      return Number(stderr.match(/mean_volume: (-?[\d.]+)/)[1]);
    };
    assert(await level(output) > await level(input) + 15);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("已取消的音轨处理不启动FFmpeg", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(normalizeCommandAudio(Buffer.from("unused"), { signal: controller.signal, ffmpegPath: "must-not-launch" }), { name: "AbortError" });
});
