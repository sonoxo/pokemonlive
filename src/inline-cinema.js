const abortError = () => new DOMException("Aborted", "AbortError");

export function bufferVideo(video, url, signal, { timeoutMs = 45000, onMark = () => {} } = {}) {
  if (signal.aborted) return Promise.reject(abortError());
  if (video.getAttribute?.("src") === url && video.readyState >= 3) return Promise.resolve();
  video.pause();
  video.src = url;
  video.load();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("error", failed);
      video.removeEventListener("loadedmetadata", metadata);
      video.removeEventListener("loadeddata", decoded);
      signal.removeEventListener("abort", aborted);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error("VIDEO_BUFFER_FAILED"));
    const aborted = () => finish(abortError());
    const metadata = () => onMark("media_metadata");
    const decoded = () => onMark("media_decoded");
    const timer = setTimeout(() => finish(new Error("VIDEO_BUFFER_TIMEOUT")), timeoutMs);
    video.addEventListener("canplay", ready);
    video.addEventListener("error", failed);
    video.addEventListener("loadedmetadata", metadata);
    video.addEventListener("loadeddata", decoded);
    signal.addEventListener("abort", aborted, { once: true });
    if (video.readyState >= 3) ready();
  });
}

// Visibility changes only after an actual decoded video frame, never on src assignment.
// The outgoing player's final frame stays on screen throughout generation/buffering.
export function playVideo(video, outgoing, signal, { onFrame = () => {}, onTime = () => {}, onBlocked = () => {},
  onStall = () => {}, startTime = 0, stallTimeoutMs = 45000, frameTimeoutMs = 45000 } = {}) {
  let resolveStart, rejectStart, resolveEnd, rejectEnd;
  const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  const ended = new Promise((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
  // Consumers await started before ended; abort in that interval must be handled.
  ended.catch(() => {});
  let visible = false;
  let finished = false;
  let frameId;
  let rafId;
  let stallStarted = null;
  let stallTimer;
  const timer = setTimeout(() => finish(new Error("VIDEO_PLAYBACK_TIMEOUT")), 90000);
  const frameTimer = setTimeout(() => finish(new Error("VIDEO_FIRST_FRAME_TIMEOUT")), frameTimeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(frameTimer);
    clearTimeout(stallTimer);
    video.removeEventListener("playing", playing);
    video.removeEventListener("ended", done);
    video.removeEventListener("timeupdate", tick);
    video.removeEventListener("error", failed);
    video.removeEventListener("waiting", stalled);
    video.removeEventListener("stalled", stalled);
    signal.removeEventListener("abort", aborted);
    if (frameId != null) video.cancelVideoFrameCallback?.(frameId);
    if (rafId != null) cancelAnimationFrame(rafId);
  };
  const reveal = () => {
    if (finished || signal.aborted || visible) return;
    visible = true;
    clearTimeout(frameTimer);
    video.classList.add("is-visible");
    video.setAttribute("aria-hidden", "false");
    video.style.zIndex = "2";
    if (outgoing && outgoing !== video) {
      outgoing.pause();
      outgoing.classList.remove("is-visible");
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.style.zIndex = "1";
    }
    onFrame();
    resolveStart();
  };
  const tick = () => { if (visible && !finished) onTime(video.currentTime); };
  const finish = (error) => {
    if (finished) return;
    finished = true;
    if (stallStarted !== null) onStall("playback_stall_ms", performance.now() - stallStarted);
    cleanup();
    if (error) {
      video.pause();
      if (!visible) rejectStart(error);
      rejectEnd(error);
    } else {
      if (!visible) resolveStart();
      resolveEnd();
    }
  };
  const done = () => { tick(); finish(); };
  const failed = () => finish(new Error("VIDEO_PLAYBACK_FAILED"));
  const aborted = () => finish(abortError());
  const playing = () => {
    if (stallStarted !== null) {
      clearTimeout(stallTimer);
      onStall("playback_stall_ms", performance.now() - stallStarted);
      stallStarted = null;
    }
    if (!video.requestVideoFrameCallback) rafId = requestAnimationFrame(reveal);
  };
  const stalled = () => {
    if (!visible || finished || stallStarted !== null) return;
    stallStarted = performance.now();
    stallTimer = setTimeout(() => finish(new Error("VIDEO_STALL_TIMEOUT")), stallTimeoutMs);
    onStall("playback_waiting", video.currentTime);
  };
  video.addEventListener("playing", playing);
  video.addEventListener("ended", done);
  video.addEventListener("timeupdate", tick);
  video.addEventListener("error", failed);
  video.addEventListener("waiting", stalled);
  video.addEventListener("stalled", stalled);
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) { aborted(); return { started, ended }; }
  video.currentTime = startTime;
  if (video.requestVideoFrameCallback) frameId = video.requestVideoFrameCallback(reveal);
  video.play().catch(error => {
    if (finished) return;
    if (error.name === "NotAllowedError" && !video.muted) {
      video.muted = true;
      onBlocked();
      video.play().catch(finish);
    } else finish(error);
  });
  return { started, ended };
}
