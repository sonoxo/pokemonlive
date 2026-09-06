import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const COMMAND_AUDIO_VERSION = "response-loudness-v1";

// Normalize the model's sometimes very quiet response track locally. Copy video
// packets unchanged; never synthesize another voice or amplify an immobile reply.
export async function normalizeCommandAudio(bytes, { signal, ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg" } = {}) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const directory = await mkdtemp(join(tmpdir(), "pokemon-command-audio-"));
  try {
    const input = join(directory, "input.mp4"), output = join(directory, "response.mp4");
    await writeFile(input, bytes);
    await promisify(execFile)(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-af", "loudnorm=I=-18:TP=-3:LRA=7",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", output],
    { signal, timeout: 30000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
