import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const IDLE_LOOP_VERSION = "settled-mirror-v1";

// Only idle breathing footage: remove model setup/end drift, then return through
// the exact same poses. Never apply reverse playback to attacks or send-outs.
export async function createSettledIdleLoop(bytes, { signal, ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg" } = {}) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const directory = await mkdtemp(join(tmpdir(), "pokemon-idle-loop-"));
  try {
    const input = join(directory, "input.mp4"), output = join(directory, "loop.mp4");
    await writeFile(input, bytes);
    await promisify(execFile)(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-filter_complex", "[0:v]fps=24,trim=start_frame=36:end_frame=96,setpts=PTS-STARTPTS,split[a][b];[b]reverse,setpts=PTS-STARTPTS[r];[a][r]concat=n=2:v=1:a=0,setpts=N/(24*TB),format=yuv420p[v]",
      "-map", "[v]", "-an", "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-movflags", "+faststart", output],
    { signal, timeout: 30000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
