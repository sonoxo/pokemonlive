import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_DOWNLOAD_LIMIT = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45 * 1000;

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function validateVideoUrl(value) {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new TypeError("视频尾帧来源必须使用 HTTPS");
  return url;
}

export async function downloadVideo(url, { fetchImpl = fetch, signal, maxBytes = DEFAULT_DOWNLOAD_LIMIT, onHeaders = () => {}, onChunk = () => {} } = {}) {
  const response = await fetchImpl(validateVideoUrl(url).href, { redirect: "follow", signal });
  if (!response.ok || !response.body) throw new Error(`VIDEO_DOWNLOAD_HTTP_${response.status}`);
  if (response.url) validateVideoUrl(response.url);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new RangeError("VIDEO_DOWNLOAD_TOO_LARGE");
  onHeaders(Number.isSafeInteger(declaredSize) && declaredSize > 0 ? declaredSize : null, response.headers);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RangeError("VIDEO_DOWNLOAD_TOO_LARGE");
    }
    chunks.push(value);
    onChunk(value);
  }
  if (declaredSize > 0 && total !== declaredSize) throw new Error("VIDEO_DOWNLOAD_LENGTH_MISMATCH");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function runTailFfmpeg(ffmpegPath, inputPath, outputPath, signal, inputOptions = []) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      ...inputOptions,
      "-sseof", "-1",
      "-i", inputPath,
      "-map", "0:v:0",
      "-an",
      "-q:v", "3",
      "-update", "1",
      outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let forceKill = null;
    const onAbort = () => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKill.unref?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (forceKill) clearTimeout(forceKill);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      if (forceKill) clearTimeout(forceKill);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(abortError());
      else if (code === 0) resolve();
      else reject(new Error(`FFMPEG_TAIL_FRAME_FAILED: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

export async function extractVideoTailFrame(videoUrl, {
  signal,
  fetchImpl = fetch,
  ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
  maxVideoBytes = DEFAULT_DOWNLOAD_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const url = validateVideoUrl(videoUrl);
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const directory = await mkdtemp(join(tmpdir(), "pokemonlive-tail-"));
  const inputPath = join(directory, "clip.mp4");
  const outputPath = join(directory, "tail.jpg");
  try {
    const bytes = await downloadVideo(url.href, {
      fetchImpl,
      signal: controller.signal,
      maxBytes: maxVideoBytes,
    });
    await writeFile(inputPath, bytes);
    await runTailFfmpeg(ffmpegPath, inputPath, outputPath, controller.signal);
    const frame = await readFile(outputPath);
    if (!frame.length || frame.length > 3 * 1024 * 1024) throw new RangeError("TAIL_FRAME_SIZE_INVALID");
    return new Blob([frame], { type: "image/jpeg" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", relayAbort);
    await rm(directory, { recursive: true, force: true });
  }
}
