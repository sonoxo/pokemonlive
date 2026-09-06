import { bufferVideo, playVideo } from "./inline-cinema.js";

// Local, reusable five-second video, never a generation reference. A failed
// cut-in falls through to the original battle scene instead of blocking play.
export function playTrainerCutIn(video, outgoing, signal, { onFrame = () => {}, onMark = () => {} } = {}) {
  let resolveStarted, rejectStarted;
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  started.catch(() => {});
  let visible = outgoing;
  const ended = (async () => {
    await bufferVideo(video, video.getAttribute("src"), signal, { timeoutMs: 2000 });
    video.muted = true; // Selected move speech is a separate, reusable channel.
    const playback = playVideo(video, outgoing, signal, {
      frameTimeoutMs: 2000, stallTimeoutMs: 2000,
      onFrame: () => {
        visible = video;
        onFrame();
        onMark("trainer_playing");
        resolveStarted();
      },
    });
    await playback.started;
    await playback.ended;
    resolveStarted();
    onMark("trainer_ended");
    return visible;
  })().catch(error => {
    if (signal.aborted || error.name === "AbortError") { rejectStarted(error); throw error; }
    onMark("trainer_failed");
    resolveStarted(); // Speech may still play over the original close-up.
    return visible;
  });
  ended.catch(() => {});
  return { started, ended };
}
