import { visualSceneKey } from "./visual-battle-state.js";

// Select once, as soon as a matching command has decoded, or at the end of the
// trainer cut-in. The attack request and command playback share this decision.
export function prepareCommandBridge({ video, scene, language, getJob, bind, signal }) {
  const sceneKey = visualSceneKey(scene);
  let settled = false;
  let resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  ready.catch(() => {});
  const cleanup = () => {
    video.removeEventListener("canplay", check);
    signal.removeEventListener("abort", abort);
  };
  const finish = value => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(value);
  };
  function abort() {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new DOMException("Aborted", "AbortError"));
  }
  function check() {
    if (settled || signal.aborted) return;
    const job = getJob();
    if (!job || job.kind !== "command" || (job.language ?? "zh") !== language
      || visualSceneKey(job.scene) !== sceneKey || !job.videoUrl) return;
    bind(job);
    if (video.dataset.sceneKey === sceneKey && video.dataset.assetKey === job.key
      && video.getAttribute("src") === job.videoUrl && video.readyState >= 3 && !video.error) {
      finish({ key: job.key, videoUrl: job.videoUrl });
    }
  }
  video.addEventListener("canplay", check);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  else check();
  return { ready, check, finish: () => { check(); finish(null); } };
}
