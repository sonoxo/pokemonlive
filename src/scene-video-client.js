import { visualSceneKey } from "./visual-battle-state.js";
import { normalizeLanguage } from "./language.js";

const aborted = () => new DOMException("Aborted", "AbortError");
export function waitForScene(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted());
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(aborted()); return; }
  const stop = () => { clearTimeout(timer); reject(aborted()); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  signal.addEventListener("abort", stop, { once: true });
});

export async function requestSceneVideo(input, signal, fetchImpl = fetch) {
  let key, streaming = false;
  const cancel = () => { if (key) void fetchImpl(`/api/scene-videos/${key}`, { method: "DELETE", keepalive: true }).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw aborted();
    // Capture the server key even if the user skips during the create response.
    const response = await fetchImpl("/api/scene-videos", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(45000) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "场景动画请求失败");
    let job = payload.job;
    key = job.key;
    if (signal.aborted) { cancel(); throw aborted(); }
    const deadline = Date.now() + 12 * 60 * 1000;
    while (!job.playable && !(job.kind === "recovery" && job.streamable) && job.status !== "ready") {
      if (["error", "cancelled"].includes(job.status)) throw Object.assign(new Error(job.error || "场景动画未完成"), {
        retryable: job.retryable === true, retryAfterMs: job.retryAfterMs ?? 0, code: job.errorCode,
      });
      if (Date.now() > deadline) throw new Error("场景动画等待超时");
      await delay(300, signal);
      const status = await fetchImpl(`/api/scene-videos/${key}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!status.ok) throw new Error("场景动画状态读取失败");
      job = (await status.json()).job;
    }
    if (signal.aborted) throw aborted();
    streaming = job.kind === "recovery" && job.streamable && !job.playable;
    return job;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    // Streaming recovery can still be downloading when handed to the player.
    // Keep skip/restart cancellation attached until this run ends.
    if (!streaming) signal.removeEventListener("abort", cancel);
  }
}

export class SceneAssetCache {
  constructor({ request = requestSceneVideo, onReady = () => {}, wait = delay, language = "zh" } = {}) {
    Object.assign(this, { request, onReady, wait });
    this.language = normalizeLanguage(language);
    this.entries = new Map();
    this.recalls = new Map();
    this.retainedScenes = new Map();
  }
  get(scene) { return this.entries.get(visualSceneKey(scene)); }
  retain(scene, signal) {
    const key = visualSceneKey(scene);
    if (signal.aborted) return () => {};
    this.retainedScenes.set(key, (this.retainedScenes.get(key) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", release);
      const remaining = this.retainedScenes.get(key) - 1;
      if (remaining) this.retainedScenes.set(key, remaining);
      else this.retainedScenes.delete(key);
    };
    signal.addEventListener("abort", release, { once: true });
    return release;
  }
  async prepare(input, signal) {
    input = { ...input, language: this.language };
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(input, signal); }
      catch (error) {
        if (signal.aborted || error.name === "AbortError" || !error.retryable || attempt >= 2) throw error;
        await this.wait(Math.max(error.retryAfterMs || 0, attempt === 0 ? 2000 : 5000), signal);
        if (signal.aborted) throw aborted();
        // Retry only the existing paid request, even if its journal is missing.
        input = { ...input, recoverOnly: true };
      }
    }
  }
  warm(scene, source, { skipIdle = false } = {}) {
    const key = visualSceneKey(scene);
    const entry = this.entries.get(key) ?? { scene, source, controller: new AbortController(), idle: null, command: null, kinds: [], errors: [], failedKinds: new Set() };
    const kinds = (skipIdle ? ["command"] : ["idle", "command"]).filter(kind => !entry.kinds.includes(kind));
    if (!kinds.length) return entry;
    entry.kinds.push(...kinds);
    this.entries.set(key, entry);
    // Dispatch together; the server still waits for the source's actual tail.
    // Send-out sources may already be ready while a trainer/recall is playing.
    entry.done = Promise.all([entry.done, ...kinds.map(async kind => {
      try {
        const job = await this.prepare({ kind, scene, ...sceneSource(source), ...(entry.failedKinds.has(kind) ? { recoverOnly: true } : {}) }, entry.controller.signal);
        if (entry.controller.signal.aborted || this.entries.get(key) !== entry) return;
        if ((job.language ?? "zh") !== this.language || visualSceneKey(job.scene) !== key || job.kind !== kind) throw new Error("素材阵容或语言不匹配");
        entry[kind] = job;
        entry.failedKinds.delete(kind);
        this.onReady(entry, kind);
      } catch (error) {
        if (error.name !== "AbortError") {
          entry.errors.push(error.message);
          entry.failedKinds.add(kind);
          entry.kinds = entry.kinds.filter(value => value !== kind);
        }
      }
    })]);
    return entry;
  }
  getRecall(scene, side) { return this.recalls.get(`${visualSceneKey(scene)}|${side}`); }
  warmRecall(scene, source, side) {
    const key = `${visualSceneKey(scene)}|${side}`;
    const existing = this.recalls.get(key);
    if (existing && !existing.error) return existing;
    const entry = { scene, side, controller: new AbortController(), job: null, error: null };
    this.recalls.set(key, entry);
    entry.done = this.prepare({ kind: "recall", scene, side, ...sceneSource(source), ...(existing ? { recoverOnly: true } : {}) }, entry.controller.signal).then(job => {
      if (entry.controller.signal.aborted || this.recalls.get(key) !== entry) return null;
      if ((job.language ?? "zh") !== this.language || visualSceneKey(job.scene) !== visualSceneKey(scene) || job.kind !== "recall" || job.side !== side) throw new Error("收回素材不匹配");
      entry.job = job;
      this.onReady(entry, "recall");
      return job;
    }).catch(error => { if (error.name !== "AbortError") entry.error = error.message; return null; });
    return entry;
  }
  cancelPendingExcept(scene = null, recallScene = scene) {
    const keep = scene && visualSceneKey(scene);
    for (const [key, entry] of this.entries) {
      if (key === keep || this.retainedScenes.has(key) || (!entry.failedKinds.size && entry.kinds.every(kind => entry[kind]))) continue;
      entry.controller.abort();
      this.entries.delete(key);
    }
    const recallKeep = recallScene && visualSceneKey(recallScene);
    for (const [key, entry] of this.recalls) {
      if (visualSceneKey(entry.scene) === recallKeep || this.retainedScenes.has(visualSceneKey(entry.scene)) || entry.job) continue;
      entry.controller.abort();
      this.recalls.delete(key);
    }
  }
}

function sceneSource(source) {
  return typeof source === "string" ? { sourceKey: source } : { sourceAttack: source };
}
