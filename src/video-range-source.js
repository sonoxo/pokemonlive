import { waitForAnchor } from "./attack-scene-anchor.js";
import { supportsTailRange } from "./video-tail-range.js";

const HEADER_BYTES = 128 * 1024;
const BLOCK_BYTES = 1024 * 1024;

// One serialized CDN reader per video. Tail seeking, playback and archiving
// share a sparse buffer; no byte range is fetched again after it is cached.
export class VideoRangeSource {
  constructor(url, { fetchImpl = fetch, timeoutMs = 45000, maxBytes = 64 * 1024 * 1024, onMetrics = () => {} } = {}) {
    if (!supportsTailRange(url)) throw new Error("TAIL_RANGE_SOURCE_UNSUPPORTED");
    Object.assign(this, { url, fetchImpl, maxBytes, onMetrics });
    this.controller = new AbortController();
    this.timeout = setTimeout(() => this.fail(new Error("VIDEO_RANGE_TIMEOUT")), timeoutMs);
    this.timeout.unref?.();
    this.startedAt = performance.now();
    this.ranges = [];
    this.queue = [];
    this.metrics = { downloadMode: "range-only", rangeRequests: 0, rangeBytes: 0 };
    this.headers = this.read(0, HEADER_BYTES - 1, { priority: 3 }).then(() => this.size);
    this.headers.catch(() => {});
  }

  read(start, end, { signal, priority = 1 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.error) return Promise.reject(this.error);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return Promise.reject(new Error("VIDEO_RANGE_INVALID_BOUNDS"));
    }
    if (this.size !== undefined && start >= this.size) return Promise.reject(new Error("VIDEO_RANGE_INVALID_BOUNDS"));
    if (this.size !== undefined && this.ranges.some(range => range.start <= start && range.end >= Math.min(end, this.size - 1))) {
      return Promise.resolve(this.buffer.subarray(start, Math.min(end + 1, this.size)));
    }
    const pending = new Promise((resolve, reject) => {
      this.queue.push({ start, end, signal, priority, resolve, reject });
      void this.pump();
    });
    return waitForAnchor(pending, signal);
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => b.priority - a.priority);
        const task = this.queue.shift();
        try {
          task.signal?.throwIfAborted();
          if (this.error) throw this.error;
          await this.fill(task.start, task.end);
          task.resolve(this.buffer.subarray(task.start, Math.min(task.end + 1, this.size)));
        } catch (error) { task.reject(error); }
      }
    } finally { this.running = false; }
  }

  async fill(start, requestedEnd) {
    let offset = start;
    if (this.size !== undefined && start >= this.size) throw new Error("VIDEO_RANGE_INVALID_BOUNDS");
    while (offset <= Math.min(requestedEnd, this.size === undefined ? requestedEnd : this.size - 1)) {
      const cached = this.ranges.find(range => range.start <= offset && range.end >= offset);
      if (cached) { offset = cached.end + 1; continue; }
      const next = this.ranges.find(range => range.start > offset);
      const end = Math.min(requestedEnd, offset + BLOCK_BYTES - 1, next ? next.start - 1 : Infinity,
        this.size === undefined ? Infinity : this.size - 1);
      await this.fetchRange(offset, end);
      offset = end + 1;
    }
  }

  async fetchRange(start, end) {
    let reader, response;
    try {
      this.controller.signal.throwIfAborted();
      this.metrics.rangeRequests++;
      response = await this.fetchImpl(this.url, { redirect: "error", signal: this.controller.signal,
        headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity", ...(this.validator ? { "If-Range": this.validator } : {}) },
      });
      this.metrics.headersMs ??= Math.round(performance.now() - this.startedAt);
      // A CDN which ignores Range must not silently start a full GET fallback.
      if (response.status !== 206 || !response.body) throw new Error("VIDEO_RANGE_UNSUPPORTED");
      if (response.url && response.url !== new URL(this.url).href) throw new Error("VIDEO_RANGE_REDIRECT");
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
      const [from, to, total] = match ? match.slice(1).map(Number) : [];
      const length = to - from + 1;
      const encoding = response.headers.get("content-encoding");
      if (![from, to, total].every(Number.isSafeInteger) || total <= 0 || total > this.maxBytes
        || from !== start || to !== Math.min(end, total - 1) || length <= 0
        || (this.size !== undefined && total !== this.size) || (encoding && encoding !== "identity")
        || (response.headers.has("content-length") && Number(response.headers.get("content-length")) !== length)) {
        throw new Error("VIDEO_RANGE_INVALID_RESPONSE");
      }
      const etag = response.headers.get("etag");
      const validator = etag && !etag.startsWith("W/") ? etag : response.headers.get("last-modified");
      if (this.size !== undefined && validator !== this.validator) throw new Error("VIDEO_RANGE_CHANGED");
      if (this.size === undefined) {
        this.size = total; this.validator = validator; this.buffer = Buffer.alloc(total);
      }
      reader = response.body.getReader();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.metrics.firstByteMs ??= Math.round(performance.now() - this.startedAt);
        this.metrics.rangeBytes += value.byteLength;
        if (received + value.byteLength > length) throw new Error("VIDEO_RANGE_TOO_LARGE");
        this.buffer.set(value, start + received); received += value.byteLength;
      }
      if (received !== length) throw new Error("VIDEO_RANGE_LENGTH_MISMATCH");
      this.ranges.push({ start, end: to });
      this.ranges.sort((a, b) => a.start - b.start);
      // Merge only adjacent validated ranges; a truncated response is never cached.
      this.ranges = this.ranges.reduce((ranges, range) => {
        const previous = ranges.at(-1);
        if (previous && previous.end + 1 === range.start) previous.end = range.end;
        else ranges.push(range);
        return ranges;
      }, []);
      this.onMetrics({ ...this.metrics });
      if (this.ranges.length === 1 && this.ranges[0].start === 0 && this.ranges[0].end === this.size - 1) clearTimeout(this.timeout);
    } catch (error) { const failure = this.error || error; this.fail(failure); throw failure; }
    finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {});
    }
  }

  async complete() {
    await this.headers;
    while (true) {
      if (this.error) throw this.error;
      // Start at the first actual hole, not a fixed file-aligned boundary.
      // This avoids tiny remainder requests after a cached header/tail seek.
      const offset = this.ranges[0]?.start === 0 ? this.ranges[0].end + 1 : 0;
      if (offset >= this.size) break;
      const next = this.ranges.find(range => range.start > offset);
      await this.read(offset, Math.min(offset + BLOCK_BYTES - 1, next ? next.start - 1 : this.size - 1), { priority: 0 });
      // Re-enter the queue after each block so playback/tail readers can win.
    }
    return this.buffer;
  }

  fail(error) {
    this.error ??= error;
    clearTimeout(this.timeout);
    this.controller.abort();
    // Failed sources stay as small error tombstones to prevent re-downloading.
    // Their partially populated allocation is never playable and must be freed.
    this.buffer = null;
    this.ranges = [];
    this.onMetrics({ ...this.metrics });
  }
}
