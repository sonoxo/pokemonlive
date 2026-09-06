// A single voice channel, independent of the video pipeline. Unlock Web Audio
// in the command click, then decode and play the server-generated short MP3.
export class BattleNarrator {
  constructor({ fetchImpl = (...args) => fetch(...args), createContext = () => new (window.AudioContext || window.webkitAudioContext)(), maxWaitMs = 4500 } = {}) {
    this.fetchImpl = fetchImpl;
    this.createContext = createContext;
    this.maxWaitMs = maxWaitMs;
    this.current = null;
    this.context = null;
  }

  stop() {
    const current = this.current;
    if (!current) return;
    this.current = null;
    clearTimeout(current.timer);
    current.signal?.removeEventListener("abort", current.abort);
    current.controller.abort();
    if (current.source) {
      current.source.onended = null;
      try { current.source.stop(); } catch { /* A source that failed to start cannot be stopped. */ }
      current.source.disconnect();
    }
    current.onEnd();
  }

  resume() {
    if (!this.context) return;
    this.context.resume().then(() => this.playReady(this.current)).catch(() => this.current?.onBlocked());
  }

  playReady(current) {
    if (!current || this.current !== current || !current.playAllowed || !current.buffer || current.source) return;
    if (this.context.state !== "running") { current.onBlocked(); return; }
    clearTimeout(current.timer);
    try {
      const source = this.context.createBufferSource();
      current.source = source;
      source.buffer = current.buffer;
      source.connect(this.context.destination);
      source.onended = () => { if (this.current === current) this.stop(); };
      source.start();
      current.onMark("voice_playing");
    } catch { current.onMark("voice_failed"); this.stop(); }
  }

  async speak(text, { signal, language = "zh", onMark = () => {}, onBlocked = () => {}, onEnd = () => {}, playAfter = Promise.resolve() } = {}) {
    this.stop();
    if (signal?.aborted) { onEnd(); return; }
    const current = { controller: new AbortController(), signal, onMark, onBlocked, onEnd, playAllowed: false };
    this.current = current;
    Promise.resolve(playAfter).then(() => {
      if (this.current !== current) return;
      current.playAllowed = true;
      this.playReady(current);
    }, () => { if (this.current === current) this.stop(); });
    current.abort = () => { if (this.current === current) this.stop(); };
    signal?.addEventListener("abort", current.abort, { once: true });
    // A very late shout would refer to an already-finished move. Drop it;
    // the server can still finish and cache the purchased line for next time.
    current.timer = setTimeout(() => {
      if (this.current === current) { onMark("voice_late_dropped"); this.stop(); }
    }, this.maxWaitMs);
    try {
      this.context ??= this.createContext();
      this.resume();
      onMark("voice_requested");
      const response = await this.fetchImpl("/api/battle-speech", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, language }), signal: current.controller.signal,
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/mpeg")) throw new Error("VOICE_UNAVAILABLE");
      const bytes = await response.arrayBuffer();
      if (this.current !== current) return;
      current.buffer = await this.context.decodeAudioData(bytes);
      if (this.current !== current) return;
      onMark("voice_ready");
      this.playReady(current);
    } catch {
      if (this.current === current) { onMark("voice_failed"); this.stop(); }
    }
  }
}
