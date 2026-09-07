import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTailFfmpeg } from "./video-tail-frame.js";

const HEADER_BYTES = 128 * 1024;
const BLOCK_BYTES = 1024 * 1024;
const RANGE_BUDGET = 4 * 1024 * 1024;

// This fast path is only for immutable fal outputs, never arbitrary browser URLs.
export function supportsTailRange(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password
      && (url.hostname === "fal.media" || url.hostname.endsWith(".fal.media"));
  } catch { return false; }
}

// FFmpeg owns MP4 sample/keyframe interpretation. A private loopback reader
// bounds its remote reads and uses Node's shared HTTPS connection pool. No
// remote URL or provider credentials are passed to the subprocess.
export async function extractVideoTailFrameRange(videoUrl, {
  fetchImpl = fetch, signal, timeoutMs = 8000, maxVideoBytes = 64 * 1024 * 1024,
  ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", onMetrics = () => {}, readPrefix, rangeSource,
} = {}) {
  if (!supportsTailRange(videoUrl)) throw new Error("TAIL_RANGE_SOURCE_UNSUPPORTED");
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (signal?.aborted) relay();
  else signal?.addEventListener("abort", relay, { once: true });
  const timeout = setTimeout(relay, Math.min(timeoutMs, 8000));
  const start = performance.now();
  const stats = { rangeBytes: 0, rangeRequests: 0 };
  let size, validator, directory, server, failure, outcome = "failed", failureCode;
  const blocks = [];

  async function readRange(offset, requestedEnd) {
    controller.signal.throwIfAborted();
    const end = size ? Math.min(requestedEnd, size - 1) : requestedEnd;
    const cached = blocks.find(block => block.start <= offset && block.end >= end);
    if (cached) return cached.bytes.subarray(offset - cached.start, end - cached.start + 1);
    if (++stats.rangeRequests > 12 || stats.rangeBytes + end - offset + 1 > Math.min(RANGE_BUDGET, maxVideoBytes)) {
      throw new Error("TAIL_RANGE_BUDGET_EXCEEDED");
    }
    if (rangeSource) {
      const bytes = await rangeSource.read(offset, end, { signal: controller.signal, priority: 2 });
      size = rangeSource.size; validator = rangeSource.validator;
      stats.rangeBytes += bytes.length;
      blocks.push({ start: offset, end: offset + bytes.length - 1, bytes });
      return bytes;
    }
    const response = await fetchImpl(videoUrl, {
      redirect: "error", signal: controller.signal,
      headers: { Range: `bytes=${offset}-${end}`, "Accept-Encoding": "identity", ...(validator ? { "If-Range": validator } : {}) },
    });
    let reader;
    try {
      // In particular, do not consume a 200 response that ignored Range.
      if (response.status !== 206 || !response.body) throw new Error("TAIL_RANGE_UNSUPPORTED");
      if (response.url && response.url !== new URL(videoUrl).href) throw new Error("TAIL_RANGE_REDIRECT");
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
      const [from, to, total] = match ? match.slice(1).map(Number) : [];
      const length = to - from + 1;
      const encoding = response.headers.get("content-encoding");
      if (![from, to, total].every(Number.isSafeInteger) || total <= 0 || total > maxVideoBytes
        || from !== offset || to !== Math.min(end, total - 1) || length <= 0
        || (size !== undefined && total !== size) || (encoding && encoding !== "identity")
        || (response.headers.has("content-length") && Number(response.headers.get("content-length")) !== length)) {
        throw new Error("TAIL_RANGE_INVALID_RESPONSE");
      }
      const etag = response.headers.get("etag");
      const nextValidator = etag && !etag.startsWith("W/") ? etag : response.headers.get("last-modified");
      if (size !== undefined && validator !== nextValidator) throw new Error("TAIL_RANGE_CHANGED");
      size = total; validator = nextValidator;
      reader = response.body.getReader();
      const chunks = []; let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength; stats.rangeBytes += value.byteLength;
        if (received > length || stats.rangeBytes > Math.min(RANGE_BUDGET, maxVideoBytes)) throw new Error("TAIL_RANGE_TOO_LARGE");
        chunks.push(value);
      }
      if (received !== length) throw new Error("TAIL_RANGE_LENGTH_MISMATCH");
      const bytes = Buffer.concat(chunks, received);
      blocks.push({ start: from, end: to, bytes });
      return bytes;
    } finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response.body?.cancel().catch(() => {});
    }
  }

  try {
    // Reuse the shared source's header for playback and decoding, without
    // fetching it again or waiting for the rest of the video.
    const prefix = await readPrefix?.(HEADER_BYTES, controller.signal);
    if (prefix) {
      size = prefix.size; validator = prefix.validator;
      if (!Number.isSafeInteger(size) || size <= 0 || size > maxVideoBytes
        || prefix.bytes.length !== Math.min(HEADER_BYTES, size)) throw new Error("TAIL_RANGE_INVALID_PREFIX");
      blocks.push({ start: 0, end: prefix.bytes.length - 1, bytes: prefix.bytes });
      stats.rangeReusedPrefixBytes = prefix.bytes.length;
    } else await readRange(0, HEADER_BYTES - 1);
    directory = await mkdtemp(join(tmpdir(), "pokemonlive-range-tail-"));
    const path = `/${randomUUID()}.mp4`;
    server = createServer(async (request, response) => {
      try {
        if (request.method !== "GET" || request.url !== path) { response.writeHead(404).end(); return; }
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "bytes=0-");
        const offset = match ? Number(match[1]) : NaN;
        const requestedEnd = match?.[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || offset >= size || requestedEnd < offset) {
          response.writeHead(416).end(); return;
        }
        const end = Math.min(requestedEnd, size - 1, offset + (offset === 0 ? HEADER_BYTES : BLOCK_BYTES) - 1);
        // FFmpeg may ask for a small probe at the last keyframe followed by
        // the remaining GOP. Fetch that bounded block once, not two CDN RTTs.
        const prefetchEnd = offset >= HEADER_BYTES ? Math.min(size - 1, offset + BLOCK_BYTES - 1) : end;
        const block = await readRange(offset, Math.max(end, prefetchEnd));
        const bytes = block.subarray(0, end - offset + 1);
        response.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": bytes.length,
          "Content-Range": `bytes ${offset}-${end}/${size}` });
        response.end(bytes);
      } catch (error) {
        failure ??= error;
        response.destroy(); controller.abort();
      }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    controller.signal.throwIfAborted();
    const output = join(directory, "tail.jpg");
    await runTailFfmpeg(ffmpegPath, `http://127.0.0.1:${server.address().port}${path}`, output, controller.signal, [
      "-protocol_whitelist", "http,tcp", "-f", "mov", "-xerror",
      "-multiple_requests", "1", "-initial_request_size", String(HEADER_BYTES),
      "-request_size", String(BLOCK_BYTES), "-short_seek_size", String(HEADER_BYTES),
    ]);
    if (failure) throw failure;
    const bytes = await readFile(output);
    if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error("TAIL_FRAME_SIZE_INVALID");
    outcome = "extracted";
    return new Blob([bytes], { type: "image/jpeg" });
  } catch (error) {
    outcome = signal?.aborted ? "cancelled" : "failed";
    const cause = failure || error;
    failureCode = /^TAIL_RANGE_[A-Z_]+$/.test(cause.message) ? cause.message : "TAIL_RANGE_READ_OR_DECODE_FAILED";
    throw cause;
  }
  finally {
    clearTimeout(timeout); controller.abort(); signal?.removeEventListener("abort", relay);
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (directory) await rm(directory, { recursive: true, force: true });
    onMetrics({ ...stats, rangeOutcome: outcome, ...(failureCode && outcome !== "cancelled" ? { rangeFailure: failureCode } : {}),
      rangeTailMs: Math.round(performance.now() - start) });
  }
}
