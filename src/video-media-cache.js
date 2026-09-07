import { downloadVideo, extractVideoTailFrame } from "./video-tail-frame.js";
import { waitForAnchor } from "./attack-scene-anchor.js";
import { extractVideoTailFrameRange, supportsTailRange } from "./video-tail-range.js";
import { VideoRangeSource } from "./video-range-source.js";

// fal videos use one shared Range source, never a competing full download.
// Consumer cancellation stops only that wait; other readers may need the data.
export class VideoMediaCache {
  constructor({ fetchImpl = fetch, tailExtractor = extractVideoTailFrame, rangeTailExtractor = extractVideoTailFrameRange, timeoutMs = 45000,
    maxVideoBytes = 64 * 1024 * 1024, maxCacheBytes = 128 * 1024 * 1024, maxEntries = 32,
    ttlMs = 5 * 60 * 1000, now = Date.now, extractRangeTail = true } = {}) {
    Object.assign(this, { fetchImpl, tailExtractor, rangeTailExtractor, timeoutMs, maxVideoBytes, maxCacheBytes, maxEntries, ttlMs, now, extractRangeTail });
    this.entries = new Map();
  }

  prepare(url) {
    this.trim();
    if (this.entries.has(url)) return this.entries.get(url);
    if (this.entries.size >= this.maxEntries) throw new Error("VIDEO_MEDIA_CACHE_BUSY");
    const entry = { createdAt: this.now(), settled: false, size: 0, pins: 0, readers: 0, timings: {}, chunks: [], listeners: new Set() };
    this.entries.set(url, entry);
    if (supportsTailRange(url)) return this.prepareRange(url, entry);
    let resolveHeaders, rejectHeaders;
    entry.headers = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    entry.headers.catch(() => {});
    const start = entry.startedAt = performance.now();
    entry.bytes = downloadVideo(url, { fetchImpl: this.fetchImpl, maxBytes: this.maxVideoBytes,
      signal: AbortSignal.timeout(this.timeoutMs),
      onHeaders: (size, headers) => {
        entry.timings.headersMs = Math.round(performance.now() - start);
        const etag = headers.get("etag");
        entry.validator = etag && !etag.startsWith("W/") ? etag : headers.get("last-modified");
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

  prepareRange(url, entry) {
    const start = entry.startedAt = performance.now();
    const source = new VideoRangeSource(url, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, maxBytes: this.maxVideoBytes,
      onMetrics: metrics => { Object.assign(entry.timings, metrics); },
    });
    entry.headers = source.headers;
    entry.readRange = (from, to, signal) => source.read(from, to, { signal, priority: 1 });
    if (!this.extractRangeTail) {
      // Production cloud anchoring never launches local FFmpeg/tail ranges.
      // Only playback and the archive consume this shared Range source.
      entry.bytes = source.complete().then(bytes => {
        entry.size = bytes.length;
        Object.assign(entry.timings, { downloadBytes: bytes.length, downloadMs: Math.round(performance.now() - start) });
        return bytes;
      }).catch(error => { entry.error = error; throw error; }).finally(() => { entry.settled = true; this.trim(); });
      entry.bytes.catch(() => {});
      return entry;
    }
    entry.pins++;
    const partial = Promise.resolve().then(() => this.rangeTailExtractor(url, {
      rangeSource: source, timeoutMs: this.timeoutMs, maxVideoBytes: this.maxVideoBytes,
      readPrefix: async (length, signal) => {
        await waitForAnchor(source.headers, signal);
        return { bytes: await source.read(0, Math.min(length, source.size) - 1, { signal, priority: 2 }), size: source.size, validator: source.validator };
      },
      // Logical decoder reads differ from the source's deduplicated wire bytes.
      onMetrics: ({ rangeBytes, rangeRequests, ...metrics }) => Object.assign(entry.timings, metrics,
        { tailRangeBytes: rangeBytes, tailRangeRequests: rangeRequests }),
    }));
    // Tail seeking gets the first turn. The archive then fills only missing
    // ranges; playback can request its own bytes from the same serialized source.
    entry.bytes = partial.catch(() => {}).then(() => source.complete()).then(bytes => {
      entry.size = bytes.length;
      Object.assign(entry.timings, { downloadBytes: bytes.length, downloadMs: Math.round(performance.now() - start) });
      return bytes;
    }).catch(error => { entry.error = error; throw error; }).finally(() => { entry.settled = true; this.trim(); });
    entry.bytes.catch(() => {});
    entry.tail = partial.then(frame => ({ frame, tailSource: "range" })).catch(async () => {
      // Decoder/budget failure may need the whole file, but it is assembled
      // from the SAME Range cache. This fallback never makes a new full GET.
      const bytes = await entry.bytes, tailStart = performance.now();
      const frame = await this.tailExtractor("http://127.0.0.1/shared-video.mp4", {
        fetchImpl: async () => new Response(bytes), timeoutMs: this.timeoutMs, maxVideoBytes: this.maxVideoBytes,
      });
      return { frame, tailSource: "range-complete", tailFrameMs: Math.round(performance.now() - tailStart) };
    }).then(({ frame, ...metrics }) => {
      Object.assign(entry.timings, metrics, { tailReadyMs: Math.round(performance.now() - start) });
      return frame;
    }).finally(() => { entry.pins = Math.max(0, entry.pins - 1); this.trim(); });
    entry.tailWork = Promise.allSettled([entry.tail]);
    entry.tail.catch(() => {});
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

  tail(url, { signal } = {}) {
    if (!this.extractRangeTail) return Promise.reject(new Error("LOCAL_TAIL_EXTRACTION_DISABLED"));
    const entry = this.prepare(url);
    if (!entry.tail) {
      entry.pins++;
      entry.tail = entry.bytes.then(async bytes => {
        const start = performance.now();
        const frame = await this.tailExtractor("http://127.0.0.1/shared-video.mp4", {
          fetchImpl: async () => new Response(bytes), timeoutMs: this.timeoutMs,
          maxVideoBytes: this.maxVideoBytes,
        });
        Object.assign(entry.timings, { tailSource: "full", tailFrameMs: Math.round(performance.now() - start),
          tailReadyMs: Math.round(performance.now() - entry.startedAt) });
        return frame;
      }).finally(() => {
        entry.pins = Math.max(0, entry.pins - 1); this.trim();
      });
      entry.tailWork = Promise.allSettled([entry.tail]);
      entry.tail.catch(() => {});
    }
    return waitForAnchor(entry.tail, signal);
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
