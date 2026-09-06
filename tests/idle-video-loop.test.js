import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSettledIdleLoop } from "../src/idle-video-loop.js";

test("状态待机取稳定中段制作5秒闭环，首尾画面一致且不反转攻击", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pokemon-loop-test-"));
  const exec = promisify(execFile), ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  try {
    const input = join(directory, "input.mp4"), output = join(directory, "loop.mp4");
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=5", "-c:v", "libx264", input]);
    await writeFile(output, await createSettledIdleLoop(await readFile(input)));
    const { stdout } = await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    const frameSize = 64 * 64 * 3;
    assert.equal(stdout.length / frameSize, 120);
    let difference = 0;
    for (let i = 0; i < frameSize; i++) difference += Math.abs(stdout[i] - stdout[stdout.length - frameSize + i]);
    assert(difference / frameSize < 3, `首尾只有H264量化差异，没有姿态跳变：平均差 ${difference / frameSize}`);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createSettledIdleLoop(Buffer.alloc(0), { signal: controller.signal }), { name: "AbortError" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
