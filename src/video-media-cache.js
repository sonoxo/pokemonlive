import { downloadVideo } from "./video-tail-frame.js";
import { waitForAnchor } from "./attack-scene-anchor.js";

// Playback and archiving share one progressive GET, never competing downloads.
// Consumer cancellation stops only that wait; other readers may need the data.
export class VideoMediaCache {
  constructor({ fetchImpl = fetch, timeoutMs = 45000,
    maxVideoBytes = 64 * 1024 * 1024, maxCacheBytes = 128 * 1024 * 1024, maxEntries = 32,
    ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { fetchImpl, timeoutMs, maxVideoBytes, maxCacheBytes, maxEntries, ttlMs, now });
    this.entries = new Map();
  }

  prepare(url) {
    this.trim();
    if (this.entries.has(url)) return this.entries.get(url);
    if (this.entries.size >= this.maxEntries) throw new Error("VIDEO_MEDIA_CACHE_BUSY");
    const entry = { createdAt: this.now(), settled: false, size: 0, pins: 0, readers: 0,
      timings: { downloadMode: "single-get", downloadRequests: 0 }, chunks: [], listeners: new Set() };
    this.entries.set(url, entry);
    let resolveHeaders, rejectHeaders;
    entry.headers = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    entry.headers.catch(() => {});
    const start = performance.now();
    entry.bytes = downloadVideo(url, { fetchImpl: (...args) => { entry.timings.downloadRequests++; return this.fetchImpl(...args); },
      redirect: "error", maxBytes: this.maxVideoBytes,
      signal: AbortSignal.timeout(this.timeoutMs),
      onHeaders: size => {
        entry.timings.headersMs = Math.round(performance.now() - start);
        entry.contentLength = size; resolveHeaders(size);
      },
      onChunk: chunk => {
        entry.timings.firstByteMs ??= Math.round(performance.now() - start);
        entry.chunks.push(chunk);
        for (const notify of entry.listeners) notify();
      },
    }).then(bytes => {
      entry.size = bytes.byteLength;
      entry.timings.downloadBytes = bytes.byteLength;
      entry.timings.downloadMs = Math.round(performance.now() - start);
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }).catch(error => { entry.error = error; rejectHeaders(error); throw error; })
      .finally(() => {
        entry.settled = true;
        for (const notify of entry.listeners) notify();
        if (!entry.readers) entry.chunks = [];
        this.trim();
      });
    // An eager producer can finish before its first consumer attaches.
    entry.bytes.catch(() => {});
    return entry;
  }

  bytes(url, { signal } = {}) { return waitForAnchor(this.prepare(url).bytes, signal); }

  pin(url) {
    const entry = this.prepare(url);
    entry.pins++;
    return entry;
  }

  unpin(url) {
    const entry = this.entries.get(url);
    if (entry) entry.pins = Math.max(0, entry.pins - 1);
    this.trim();
  }

  release(url) { this.entries.delete(url); }

  trim() {
    let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.size, 0);
    for (const [url, entry] of this.entries) {
      if (!entry.settled || entry.pins) continue;
      if (this.now() - entry.createdAt < this.ttlMs && this.entries.size <= this.maxEntries && bytes <= this.maxCacheBytes) continue;
      this.entries.delete(url);
      bytes -= entry.size;
    }
  }
}
