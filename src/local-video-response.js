import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { waitForAnchor } from "./attack-scene-anchor.js";

export async function sendDownloadingVideo(request, response, entry) {
  const controller = new AbortController();
  const close = () => controller.abort();
  if (response.destroyed) return;
  if (entry.settled) {
    try { await sendLocalVideo(request, response, { bytes: await entry.bytes }); }
    catch { if (!response.destroyed) response.writeHead(502).end(); }
    return;
  }
  entry.readers++;
  response.once("close", close);
  try {
    const size = await waitForAnchor(entry.headers, controller.signal);
    // Without a declared size we cannot resolve suffixes or Content-Range.
    if (!size) {
      await sendLocalVideo(request, response, { bytes: await waitForAnchor(entry.bytes, controller.signal) });
      return;
    }
    const range = request.headers.range;
    const bounds = videoRange(range, size);
    if (!bounds) { response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return; }
    const { start, end } = bounds;
    response.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === "HEAD") { response.end(); return; }
    if (entry.readRange) {
      // Sparse tail bytes are not sequential chunks. Read exact offsets from
      // the shared Range cache, filling only holes the player actually needs.
      for (let offset = start; offset <= end; offset += 256 * 1024) {
        const bytes = await entry.readRange(offset, Math.min(end, offset + 256 * 1024 - 1), controller.signal);
        if (!response.write(bytes)) await waitForDrain(response, controller.signal);
      }
      response.end(); return;
    }
    let index = 0, offset = 0;
    while (!controller.signal.aborted) {
      while (index < entry.chunks.length) {
        const chunk = entry.chunks[index++];
        const chunkStart = offset;
        offset += chunk.length;
        if (offset <= start) continue;
        const slice = chunk.subarray(Math.max(0, start - chunkStart), Math.min(chunk.length, end - chunkStart + 1));
        if (!response.write(slice)) {
          await waitForDrain(response, controller.signal);
        }
        if (offset > end) { response.end(); return; }
      }
      if (entry.error) throw entry.error;
      if (entry.settled) { response.end(); return; }
      await new Promise((resolve, reject) => {
        const clean = () => { entry.listeners.delete(wake); controller.signal.removeEventListener("abort", stop); };
        const wake = () => { clean(); resolve(); };
        const stop = () => { clean(); reject(controller.signal.reason); };
        entry.listeners.add(wake); controller.signal.addEventListener("abort", stop, { once: true });
        if (controller.signal.aborted) stop();
      });
    }
  } catch {
    if (!response.destroyed) {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    }
  } finally {
    response.removeListener("close", close);
    entry.readers--;
    if (entry.settled && !entry.readers) entry.chunks = [];
  }
}

function waitForDrain(response, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { response.removeListener("drain", drain); signal.removeEventListener("abort", stop); };
    const drain = () => { clean(); resolve(); };
    const stop = () => { clean(); reject(signal.reason); };
    response.once("drain", drain); signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

// Stable same-origin URLs; byte ranges let the browser seek without downloading
// a second remote MP4. Only callers with a validated artifact path reach here.
export async function sendLocalVideo(request, response, { path, bytes, contentType = "video/mp4" }) {
  const size = bytes ? bytes.length : (await stat(path)).size;
  const range = request.headers.range;
  const bounds = videoRange(range, size);
  if (!bounds) { response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return; }
  const { start, end } = bounds;
  if (response.destroyed) return;
  response.writeHead(range ? 206 : 200, {
    "Content-Type": contentType, "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === "HEAD") { response.end(); return; }
  if (bytes) { response.end(bytes.subarray(start, end + 1)); return; }
  const stream = createReadStream(path, { start, end });
  const close = () => stream.destroy();
  response.once("close", close);
  stream.once("close", () => response.removeListener("close", close));
  stream.once("error", () => response.destroy());
  stream.pipe(response);
}

function videoRange(range, size) {
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start > end || start >= size) {
      return null;
    }
  }
  return { start, end };
}
