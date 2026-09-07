import { waitForAnchor, ATTACK_TAIL_URL_TTL_MS } from "./attack-scene-anchor.js";

export const FAL_TAIL_FRAME_MODEL = "fal-ai/ffmpeg-api/extract-frame";
export const CLOUD_TAIL_TTL_MS = ATTACK_TAIL_URL_TTL_MS;

export function cloudImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("TAIL_FRAME_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("TAIL_FRAME_URL_INVALID");
  return url.href;
}

// One paid request per video shared by continuation, state prewarm and archive.
// Cancelling a consumer stops its wait, not another consumer's extraction.
export class CloudTailFrames {
  constructor({ loadCredentials, fetchImpl = fetch, timeoutMs = 60000, ttlMs = CLOUD_TAIL_TTL_MS,
    maxEntries = 128, now = Date.now, metricSink = () => {} } = {}) {
    Object.assign(this, { loadCredentials, fetchImpl, timeoutMs, ttlMs, maxEntries, now, metricSink });
    this.entries = new Map();
  }

  url(videoUrl, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    try { videoUrl = cloudImageUrl(videoUrl); } catch (error) { return Promise.reject(error); }
    for (const [key, entry] of this.entries) {
      if (entry.settledAt != null && this.now() - entry.settledAt >= this.ttlMs) this.entries.delete(key);
    }
    let entry = this.entries.get(videoUrl);
    if (!entry) {
      // Do not evict an in-use extraction and accidentally buy it twice.
      if (this.entries.size >= this.maxEntries) return Promise.reject(new Error("TAIL_FRAME_CACHE_BUSY"));
      entry = { settledAt: null, timings: {} };
      this.entries.set(videoUrl, entry);
      entry.promise = this.extract(videoUrl, entry).finally(() => { entry.settledAt = this.now(); });
      entry.promise.catch(() => {});
    }
    return waitForAnchor(entry.promise, signal);
  }

  async extract(videoUrl, entry) {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let status = null;
    try {
      const credentials = await this.loadCredentials();
      controller.signal.throwIfAborted();
      if (!credentials) throw new Error("TAIL_FRAME_MISSING_FAL_KEY");
      // Native fetch deliberately has no automatic paid POST retries. A lost
      // response is not proof that the provider never accepted the request.
      const response = await this.fetchImpl(`https://fal.run/${FAL_TAIL_FRAME_MODEL}`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Key ${credentials}`, "Content-Type": "application/json", Accept: "application/json",
          "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: 3600 }) },
        body: JSON.stringify({ video_url: videoUrl, frame_type: "last" }),
      });
      status = response.status;
      entry.timings.cloudTailHeadersMs = Math.round(performance.now() - started);
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`TAIL_FRAME_CLOUD_HTTP_${status}`), { status });
      }
      const result = await response.json();
      if (result?.images?.length !== 1) throw new Error("TAIL_FRAME_IMAGE_MISSING");
      const url = cloudImageUrl(result.images[0]?.url);
      Object.assign(entry.timings, { tailSource: "cloud", cloudTailMs: Math.round(performance.now() - started), outcome: "ready" });
      return url;
    } catch (error) {
      Object.assign(entry.timings, { tailSource: "cloud", cloudTailMs: Math.round(performance.now() - started), outcome: "error" });
      // Do not expose credentials, signed URLs or provider response bodies.
      throw Object.assign(new Error(controller.signal.aborted ? "TAIL_FRAME_CLOUD_TIMEOUT" : "TAIL_FRAME_CLOUD_FAILED"), { status });
    } finally {
      clearTimeout(timeout);
      try {
        const pending = this.metricSink({ event: "fal_tail_frame_complete", ...entry.timings, httpStatus: status });
        pending?.catch?.(() => {});
      } catch { /* Diagnostic only. */ }
    }
  }
}
