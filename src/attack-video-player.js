import { bufferVideo, playVideo } from "./inline-cinema.js";

const aborted = () => new DOMException("Aborted", "AbortError");

// One playing clip, one next clip, one spare (held frame or media recovery).
// Generation order is owned by the server, not by these playback slots.
export class AttackVideoPlayer {
  constructor({ videos, signal, waitForClip, protectedVideo, configureVideo, mark }) {
    Object.assign(this, { videos, signal, waitForClip, configureVideo, mark });
    this.occupied = new Set(videos.includes(protectedVideo) ? [protectedVideo] : []);
    this.protectedVideo = protectedVideo;
    this.prepared = new Map();
    this.waiters = new Set();
    signal.addEventListener("abort", () => {
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }, { once: true });
  }

  async acquire() {
    while (!this.signal.aborted) {
      const video = this.videos.find(candidate => !this.occupied.has(candidate));
      if (video) {
        this.occupied.add(video);
        video.classList.remove("is-visible");
        video.setAttribute("aria-hidden", "true");
        this.configureVideo(video);
        return video;
      }
      await new Promise(resolve => this.waiters.add(resolve));
    }
    throw aborted();
  }

  release(video) {
    if (!video) return;
    this.occupied.delete(video);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  prepare(index) {
    if (this.prepared.has(index)) return this.prepared.get(index);
    const pending = (async () => {
      const { clip, session } = await this.waitForClip(index);
      if (this.signal.aborted) throw aborted();
      const video = await this.acquire();
      // Share the server's already-running download/tail/archive connection.
      // CDN remains a single bounded fallback, not a second eager download.
      const item = { clip, session, video, source: clip.localVideoUrl ? "local" : "cdn", tried: new Set() };
      try {
        await this.buffer(item, clip.localVideoUrl || clip.videoUrl, item.source, 8000);
      } catch (error) {
        if (this.signal.aborted || !this.fallback(item)) throw error;
        this.mark(`${item.source}_buffer_fallback`, index);
        const source = this.fallback(item);
        await this.buffer(item, source.url, source.name, 8000);
      }
      this.mark("clip_buffered", index);
      return item;
    })();
    // The next clip can fail while the current bridge/clip is still playing.
    const result = pending.then(value => ({ value }), error => ({ error }));
    this.prepared.set(index, result);
    return result;
  }

  async buffer(item, url, source, timeoutMs = 45000) {
    item.source = source;
    item.tried.add(source);
    this.mark(`media_load_${source}`, item.clip.index);
    const start = performance.now();
    await bufferVideo(item.video, url, this.signal, {
      timeoutMs, onMark: name => this.mark(name, item.clip.index),
    });
    this.mark("media_buffer_ms", item.clip.index, Math.round(performance.now() - start));
  }

  fallback(item) {
    if (!item.tried.has("cdn") && item.clip.videoUrl) return { name: "cdn", url: item.clip.videoUrl };
    if (!item.tried.has("local") && item.clip.localVideoUrl) return { name: "local", url: item.clip.localVideoUrl };
    return null;
  }

  play(item, outgoing, { onFrame, onTime, onBlocked }) {
    let resolveStarted, rejectStarted;
    const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const ended = (async () => {
      let revealed = false;
      let startTime = 0;
      let previous = outgoing;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.signal.aborted) throw aborted();
        const playback = playVideo(item.video, previous, this.signal, {
          startTime, onTime, onBlocked,
          stallTimeoutMs: 8000,
          frameTimeoutMs: 8000,
          onStall: (name, value) => this.mark(name, item.clip.index, Math.round(value)),
          onFrame: () => {
            this.release(previous);
            this.release(this.protectedVideo);
            this.protectedVideo = null;
            if (!revealed) { revealed = true; onFrame(); resolveStarted(); }
            else this.mark("clip_resumed", item.clip.index);
          },
        });
        try {
          await playback.started;
          if (!revealed) throw new Error("VIDEO_FRAME_NOT_PRESENTED");
          await playback.ended;
          return;
        } catch (error) {
          const fallback = this.fallback(item);
          if (this.signal.aborted || !fallback) throw error;
          this.mark(`${item.source}_playback_fallback`, item.clip.index);
          startTime = revealed ? item.video.currentTime : 0;
          // Keep the failed player's actual frame visible while decoding a
          // replacement; do not repeat logical start/impact or replay the clip.
          if (revealed) {
            previous = item.video;
            item.video = await this.acquire();
          }
          await this.buffer(item, fallback.url, fallback.name, 8000);
        }
      }
    })().catch(error => { rejectStarted(error); throw error; });
    ended.catch(() => {});
    return { started, ended };
  }
}
