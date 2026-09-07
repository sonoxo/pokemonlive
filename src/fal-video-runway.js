import { randomUUID } from "node:crypto";
import { normalizeLanguage, videoLanguageDirection } from "./language.js";

import { createFalClient } from "@fal-ai/client";

import { extractVideoTailFrame } from "./video-tail-frame.js";
import { waitForFalStatus } from "./fal-status.js";
import { falVideoFailure, falVideoFailureMessage } from "./fal-video-failure.js";

export const FAL_VIDEO_MODEL = "minimax/h3-max-turbo/image-to-video";
export const FAL_VIDEO_REFERENCE_MODEL = "minimax/h3-max/reference-to-video";
export const FAL_VIDEO_DURATION_SECONDS = 5;
// Shared by all new battle/scene clips; this does not seed the battle rules RNG.
export const FAL_VIDEO_SEED = 42;
export const FAL_VIDEO_RESOLUTIONS = new Set(["480P", "768P"]);

const MAX_CLIPS = 4;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLIP_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 60 * 1000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 45 * 1000;
const DEFAULT_CANCEL_TIMEOUT_MS = 15 * 1000;
const ACTIVE_SESSION_STATES = new Set(["generating", "cancelling"]);
const REFERENCE_SIDES = ["player", "opponent"];

function withDeadline(promise, timeoutMs, message, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      onTimeout?.();
      finish(reject, new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function validateBeats(beats) {
  if (!Array.isArray(beats) || beats.length < 1 || beats.length > MAX_CLIPS) {
    throw new TypeError("视频跑道必须包含 1 至 4 个动态分镜");
  }
  return beats.map((beat, index) => {
    if (beat?.index !== index || typeof beat.motionPrompt !== "string") {
      throw new TypeError("视频分镜顺序或提示词无效");
    }
    if (beat.durationSeconds !== FAL_VIDEO_DURATION_SECONDS) {
      throw new TypeError("H3 Max Turbo 分镜时长必须为 5 秒");
    }
    return {
      index,
      attackId: beat.attackId,
      purpose: beat.purpose,
      motionPrompt: beat.motionPrompt,
      durationSeconds: FAL_VIDEO_DURATION_SECONDS,
    };
  });
}

function validateReferenceImageUrl(value, maxLength = 1024 * 1024) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError("宝可梦参考图地址无效");
  }
  if (/^data:image\/(?:png|jpeg);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("宝可梦参考图地址无效");
  }
  if (url.protocol !== "https:") throw new TypeError("宝可梦参考图必须使用 HTTPS 或 PNG/JPEG Data URL");
  return url.href;
}

function validateReferenceImages(value) {
  if (!Array.isArray(value) || value.length !== REFERENCE_SIDES.length) {
    throw new TypeError("首段必须包含我方和对方两张宝可梦参考图");
  }
  return value.map((reference, index) => {
    const expectedSide = REFERENCE_SIDES[index];
    if (reference?.side !== expectedSide || !/^[a-z0-9-]{1,64}$/.test(reference?.speciesId ?? "")) {
      throw new TypeError("宝可梦参考图顺序或物种无效");
    }
    if (typeof reference.name !== "string" || !reference.name || reference.name.length > 40) {
      throw new TypeError("宝可梦参考图名称无效");
    }
    return {
      side: expectedSide,
      speciesId: reference.speciesId,
      name: reference.name,
      imageUrl: validateReferenceImageUrl(reference.imageUrl),
    };
  });
}

function publicError(error) {
  if (error?.name === "AbortError") return "生成已取消";
  const status = error?.status ?? error?.statusCode;
  if (status === 401 || status === 403) return "fal API 密钥无效或没有模型权限";
  if (status === 429) return "fal 当前请求过多或额度不足";
  if (status >= 500) return "fal 视频服务暂时不可用";
  if (/TAIL_FRAME|FFMPEG|VIDEO_DOWNLOAD/.test(error?.message ?? "")) return "无法提取上一分镜尾帧";
  return "fal 视频生成失败";
}

function videoUrlFromResult(result) {
  const value = result?.data?.video?.url;
  if (typeof value !== "string") throw new Error("FAL_VIDEO_URL_MISSING");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("FAL_VIDEO_URL_INVALID");
  }
  return url.href;
}

function tailFrameUrlFromUpload(value) {
  if (typeof value !== "string" || !value) throw new Error("FAL_TAIL_FRAME_UPLOAD_URL_MISSING");
  if (value.length <= 4 * 1024 * 1024 && /^data:image\/jpeg;base64,[a-zA-Z0-9+/]+={0,2}$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FAL_TAIL_FRAME_UPLOAD_URL_INVALID");
  }
  if (url.protocol !== "https:") throw new Error("FAL_TAIL_FRAME_UPLOAD_URL_INVALID");
  return url.href;
}

export function createVideoFalClient(credentials, fetchImpl = fetch) {
  const client = createFalClient({ credentials, fetch: fetchImpl });
  // SDK queue.submit retries POST even after unknown network failures. Own the
  // paid POST so only our confirmed-failure policy can submit it a second time.
  client.queue.submit = async (model, { input, abortSignal }) => {
    if (![FAL_VIDEO_MODEL, FAL_VIDEO_REFERENCE_MODEL].includes(model)) throw new TypeError("fal 视频模型无效");
    const response = await fetchImpl(`https://queue.fal.run/${model}`, {
      method: "POST", signal: abortSignal, redirect: "error",
      headers: { Authorization: `Key ${credentials}`, "Content-Type": "application/json", Accept: "application/json",
        "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: 3600 }) },
      body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error("FAL_SUBMISSION_REJECTED"), { status: response.status, body });
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(body?.request_id ?? "")) throw new Error("FAL_SUBMISSION_UNCONFIRMED");
    return body;
  };
  return client;
}

export class FalVideoRunway {
  constructor({
    clientFactory = createVideoFalClient,
    tailFrameExtractor = extractVideoTailFrame,
    tailFrameUploader = (client, frame) => client.storage.upload(frame, { lifecycle: { expiresIn: "1h" } }),
    resolution = "480P",
    now = () => Date.now(),
    monotonicNow = () => performance.now(),
    makeId = () => randomUUID(),
    ttlMs = DEFAULT_TTL_MS,
    clipTimeoutMs = DEFAULT_CLIP_TIMEOUT_MS,
    uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
    submitTimeoutMs = DEFAULT_SUBMIT_TIMEOUT_MS,
    cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
    metricSink = () => {},
    clipSink = async () => {},
    submittedSink = async () => {},
    maxRegenerations = 1,
  } = {}) {
    if (!FAL_VIDEO_RESOLUTIONS.has(resolution)) throw new TypeError("fal 分辨率无效");
    if (typeof metricSink !== "function") throw new TypeError("metricSink 必须为函数");
    if (typeof monotonicNow !== "function") throw new TypeError("monotonicNow 必须为函数");
    for (const [label, value] of Object.entries({
      clipTimeoutMs,
      uploadTimeoutMs,
      submitTimeoutMs,
      cancelTimeoutMs,
      ttlMs,
    })) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} 必须为正数`);
    }
    this.clientFactory = clientFactory;
    this.tailFrameExtractor = tailFrameExtractor;
    this.tailFrameUploader = tailFrameUploader;
    this.resolution = resolution;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.makeId = makeId;
    this.ttlMs = ttlMs;
    this.clipTimeoutMs = clipTimeoutMs;
    this.uploadTimeoutMs = uploadTimeoutMs;
    this.submitTimeoutMs = submitTimeoutMs;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.metricSink = metricSink;
    this.clipSink = clipSink;
    this.submittedSink = submittedSink;
    if (![0, 1].includes(maxRegenerations)) throw new RangeError("视频最多自动重新生成一次");
    this.maxRegenerations = maxRegenerations;
    this.sessions = new Map();
  }

  create({ credentials, beats, referenceImages, battleEpoch, turn, language = "zh", openingFrame = null, closingFrame = null, contextImages = [] }) {
    language = normalizeLanguage(language);
    if (typeof credentials !== "string" || !credentials) {
      const error = new Error("未配置 FAL_KEY");
      error.code = "MISSING_FAL_KEY";
      throw error;
    }
    const normalizedBeats = validateBeats(beats).map(beat => ({ ...beat, motionPrompt: `${beat.motionPrompt} ${videoLanguageDirection(language)}` }));
    const normalizedReferences = validateReferenceImages(referenceImages);
    if (!Array.isArray(contextImages) || contextImages.length > 2) throw new TypeError("场景参考图数量无效");
    const normalizedContext = contextImages.map(value => validateReferenceImageUrl(value, 4 * 1024 * 1024));
    this.cleanup();
    if ([...this.sessions.values()].some((session) => ACTIVE_SESSION_STATES.has(session.status))) {
      const error = new Error("已有 fal 视频任务正在生成或取消，请稍后再试");
      error.code = "FAL_RUNWAY_BUSY";
      throw error;
    }

    const createdAt = this.now();
    const session = {
      id: this.makeId(),
      battleEpoch,
      language,
      turn,
      strategy: openingFrame ? "command_tail_then_tail_frames" : "character_references_then_tail_frames",
      openingFrame,
      closingFrame,
      models: {
        opening: openingFrame ? FAL_VIDEO_MODEL : FAL_VIDEO_REFERENCE_MODEL,
        continuation: FAL_VIDEO_MODEL,
      },
      referenceImages: normalizedReferences,
      contextImages: normalizedContext,
      resolution: this.resolution,
      seed: FAL_VIDEO_SEED,
      status: "generating",
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      cancelled: false,
      archives: [],
      activeControllers: new Map(),
      client: null,
      abortUpload: null,
      clips: normalizedBeats.map((beat, index) => ({
        ...beat,
        model: index === 0 && !openingFrame ? FAL_VIDEO_REFERENCE_MODEL : FAL_VIDEO_MODEL,
        status: "queued",
        inputMode: index === 0 ? openingFrame ? "command_tail_frame" : "character_references" : "previous_tail_frame",
        sourceClipIndex: index === 0 ? null : index - 1,
        requestId: null,
        videoUrl: null,
        expandedPrompt: null,
        generationStartedAt: null,
        generationCompletedAt: null,
        generationMs: null,
        anchoringMs: null,
        inferenceSeconds: null,
        submitMs: null,
        queueWaitMs: null,
        providerRunMs: null,
        resultMs: null,
        statusTransport: null,
        error: null,
        failure: null,
        regenerationCount: 0,
      })),
    };
    this.sessions.set(session.id, session);
    void this.run(session, credentials);
    return this.snapshot(session);
  }

  get(id) {
    this.cleanup();
    const session = this.sessions.get(id);
    return session ? this.snapshot(session) : null;
  }

  cancel(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (!ACTIVE_SESSION_STATES.has(session.status)) return true;
    session.cancelled = true;
    session.status = "cancelling";
    session.updatedAt = this.now();
    session.abortUpload?.();
    for (const clip of session.clips) {
      if (clip.status !== "ready" && clip.status !== "error") {
        clip.status = "cancelling";
        if (clip.requestId && session.client) void this.cancelRemote(session.client, clip);
      }
    }
    for (const controller of session.activeControllers.values()) controller.abort();
    return true;
  }

  cleanup() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.finishedAt != null && session.finishedAt < cutoff) this.sessions.delete(id);
    }
  }

  snapshot(session) {
    return {
      id: session.id,
      battleEpoch: session.battleEpoch,
      language: session.language,
      turn: session.turn,
      strategy: session.strategy,
      models: session.models,
      resolution: session.resolution,
      seed: session.seed,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      finishedAt: session.finishedAt,
      references: session.referenceImages.map(({ side, speciesId, name }) => ({ side, speciesId, name })),
      clips: session.clips.map((clip) => ({
        index: clip.index,
        attackId: clip.attackId,
        purpose: clip.purpose,
        durationSeconds: clip.durationSeconds,
        model: clip.model,
        seed: session.seed,
        inputMode: clip.inputMode,
        sourceClipIndex: clip.sourceClipIndex,
        status: clip.status,
        requestId: clip.requestId,
        videoUrl: clip.videoUrl,
        expandedPrompt: clip.expandedPrompt,
        generationStartedAt: clip.generationStartedAt,
        generationCompletedAt: clip.generationCompletedAt,
        generationMs: clip.generationMs,
        anchoringMs: clip.anchoringMs,
        inferenceSeconds: clip.inferenceSeconds,
        submitMs: clip.submitMs,
        queueWaitMs: clip.queueWaitMs,
        providerRunMs: clip.providerRunMs,
        resultMs: clip.resultMs,
        statusTransport: clip.statusTransport,
        error: clip.error,
        failure: clip.failure,
        regenerationCount: clip.regenerationCount,
      })),
    };
  }

  async run(session, credentials) {
    let client;
    try {
      client = this.clientFactory(credentials);
      session.client = client;
      let sourceImageUrl = session.openingFrame;
      for (let index = 0; index < session.clips.length && !session.cancelled; index += 1) {
        const clip = session.clips[index];
        const ready = await this.generateClip(client, session, clip, sourceImageUrl);
        if (!ready) {
          if (!session.cancelled) {
            for (const laterClip of session.clips.slice(index + 1)) {
              laterClip.status = "error";
              laterClip.error = "上一分镜未完成，无法继续动画";
            }
          }
          break;
        }
        if (session.cancelled || index + 1 >= session.clips.length) break;
        sourceImageUrl = await this.createContinuationFrame(client, session, clip, session.clips[index + 1]);
        if (!sourceImageUrl) break;
      }
    } catch (error) {
      if (!session.cancelled) {
        const message = publicError(error);
        for (const clip of session.clips) {
          if (clip.status !== "ready" && clip.status !== "error") {
            clip.status = "error";
            clip.error = message;
          }
        }
      }
    } finally {
      session.abortUpload = null;
      if (session.cancelled) {
        session.status = "cancelled";
        for (const clip of session.clips) {
          if (clip.status !== "ready" && clip.status !== "error") clip.status = "cancelled";
        }
        session.finishedAt = this.now();
        session.updatedAt = session.finishedAt;
      } else {
        const readyCount = session.clips.filter((clip) => clip.status === "ready").length;
        session.status = readyCount === session.clips.length
          ? "ready"
          : readyCount > 0 ? "partial" : "failed";
        session.finishedAt = this.now();
        session.updatedAt = session.finishedAt;
      }
    }
  }

  async createContinuationFrame(client, session, clip, nextClip) {
    const anchorStarted = this.monotonicNow();
    const controller = new AbortController();
    session.activeControllers.set(`tail-${clip.index}`, controller);
    nextClip.status = "anchoring";
    session.updatedAt = this.now();
    try {
      const frame = await withDeadline(
        this.tailFrameExtractor(clip.videoUrl, { signal: controller.signal }),
        this.uploadTimeoutMs,
        "TAIL_FRAME_EXTRACT_TIMEOUT",
        () => controller.abort(),
      );
      if (session.cancelled) return null;
      // Cloud extraction already returns a usable image URL. Never download or
      // upload it on the continuation path. Blob support is for local tooling.
      if (typeof frame === "string") {
        const url = tailFrameUrlFromUpload(frame);
        nextClip.status = "queued";
        return url;
      }
      const uploadCancelled = new Promise((_, reject) => {
        session.abortUpload = () => reject(new DOMException("Aborted", "AbortError"));
      });
      const uploaded = await Promise.race([
        withDeadline(
          this.tailFrameUploader(client, frame),
          this.uploadTimeoutMs,
          "FAL_TAIL_FRAME_UPLOAD_TIMEOUT",
        ),
        uploadCancelled,
      ]);
      session.abortUpload = null;
      if (session.cancelled) return null;
      const url = tailFrameUrlFromUpload(uploaded);
      nextClip.status = "queued";
      return url;
    } catch (error) {
      if (session.cancelled || error?.name === "AbortError") {
        nextClip.status = "cancelled";
        return null;
      }
      nextClip.status = "error";
      nextClip.error = publicError(error);
      for (const laterClip of session.clips.slice(nextClip.index + 1)) {
        laterClip.status = "error";
        laterClip.error = "上一分镜未完成，无法继续动画";
      }
      return null;
    } finally {
      nextClip.anchoringMs = Math.round(this.monotonicNow() - anchorStarted);
      session.abortUpload = null;
      session.activeControllers.delete(`tail-${clip.index}`);
      session.updatedAt = this.now();
    }
  }

  async generateClip(client, session, clip, sourceImageUrl) {
    for (let attempt = 0; attempt <= this.maxRegenerations; attempt++) {
      if (session.cancelled) return false;
      clip.regenerationCount = attempt;
      const ready = await this.generateClipAttempt(client, session, clip, sourceImageUrl);
      if (ready || session.cancelled || !clip.failure?.regenerable || attempt === this.maxRegenerations) return ready;
      // A definite failure owns no usable video. Retry just this shot with the
      // exact same prompt, seed and source tail; never buy previous ready clips.
      clip.requestId = null;
      delete clip.cancelPromise;
      clip.failure = null;
      clip.error = null;
      clip.submitMs = clip.queueWaitMs = clip.providerRunMs = clip.resultMs = null;
    }
    return false;
  }

  async generateClipAttempt(client, session, clip, sourceImageUrl) {
    // Do not connect user cancellation to the submit request. fal may already
    // have accepted a paid job while its request_id response is still in
    // flight. We keep waiting (within the hard submit deadline), capture that
    // id, and then explicitly cancel the remote queue item.
    const submitController = new AbortController();
    let requestController = null;
    let stage = "input";
    clip.status = "submitting";
    session.updatedAt = this.now();
    const startedAt = this.now();
    const startedMonotonic = this.monotonicNow();
    clip.generationStartedAt = startedAt;
    const timeout = setTimeout(() => {
      submitController.abort();
      requestController?.abort();
    }, this.clipTimeoutMs);
    try {
      const input = {
        prompt: clip.motionPrompt,
        duration: FAL_VIDEO_DURATION_SECONDS,
        resolution: this.resolution,
        seed: session.seed,
        enable_safety_checker: true,
        prompt_expansion_mode: "balanced",
      };
      if (clip.index === 0 && !sourceImageUrl) {
        input.aspect_ratio = "16:9";
        input.reference_image_urls = [...session.referenceImages.map((reference) => reference.imageUrl), ...session.contextImages];
      } else if (sourceImageUrl) {
        input.image_url = sourceImageUrl;
      } else {
        throw new Error("FAL_CONTINUATION_FRAME_MISSING");
      }
      if (session.closingFrame && clip.index === session.clips.length - 1) input.end_image_url = session.closingFrame;
      stage = "submit";
      const queued = await withDeadline(
        client.queue.submit(clip.model, {
          input,
          storageSettings: { expiresIn: "1h" },
          abortSignal: submitController.signal,
        }),
        this.submitTimeoutMs,
        "FAL_SUBMIT_TIMEOUT",
        () => submitController.abort(),
      );
      clip.requestId = queued.request_id;
      stage = "journal";
      const submittedAt = this.monotonicNow();
      clip.submitMs = Math.max(0, Math.round(submittedAt - startedMonotonic));
      await withDeadline(this.submittedSink({ session: this.snapshot(session), clip: this.snapshot(session).clips[clip.index] }), this.submitTimeoutMs, "SUBMIT_JOURNAL_TIMEOUT");
      if (session.cancelled || submitController.signal.aborted) {
        await this.cancelRemote(client, clip);
        clip.status = "cancelled";
        return;
      }
      requestController = new AbortController();
      session.activeControllers.set(clip.index, requestController);
      clip.status = "queued";
      session.updatedAt = this.now();
      let firstRunningAt = null;
      let completedStatusAt = null;
      stage = "status";
      await waitForFalStatus(client, clip.model, {
        requestId: clip.requestId,
        signal: requestController.signal,
        onTransport: mode => { clip.statusTransport = mode; },
        onQueueUpdate: (status) => {
          const observedAt = this.monotonicNow();
          if (status.status === "IN_PROGRESS" && firstRunningAt === null) {
            firstRunningAt = observedAt;
            clip.queueWaitMs = Math.max(0, Math.round(observedAt - submittedAt));
          }
          if (status.status === "COMPLETED" && completedStatusAt === null) {
            completedStatusAt = observedAt;
            clip.providerRunMs = firstRunningAt === null ? null : Math.max(0, Math.round(observedAt - firstRunningAt));
          }
          if (!session.cancelled) {
            clip.status = status.status === "IN_PROGRESS" ? "generating" : "queued";
          }
          session.updatedAt = this.now();
        },
      });
      if (session.cancelled || requestController.signal.aborted) {
        await this.cancelRemote(client, clip);
        clip.status = "cancelled";
        return;
      }
      const resultStarted = this.monotonicNow();
      stage = "result";
      const result = await client.queue.result(clip.model, {
        requestId: clip.requestId,
        abortSignal: requestController.signal,
      });
      if (session.cancelled) return;
      stage = "output";
      clip.resultMs = Math.max(0, Math.round(this.monotonicNow() - resultStarted));
      clip.videoUrl = videoUrlFromResult(result);
      clip.expandedPrompt = typeof result.data?.expanded_prompt === "string"
        ? result.data.expanded_prompt
        : null;
      clip.status = "ready";
      clip.generationCompletedAt = this.now();
      clip.generationMs = Math.max(0, Math.round(this.monotonicNow() - startedMonotonic));
      clip.inferenceSeconds = Number.isFinite(result.data?.timings?.inference) ? result.data.timings.inference : null;
      this.recordMetric(session, clip);
      session.archives.push(Promise.resolve().then(() => this.clipSink({ session: this.snapshot(session), clip: this.snapshot(session).clips[clip.index], prompt: clip.motionPrompt })).catch(() => {
        // Recording is diagnostic only; never retry a paid generation on a disk error.
        console.warn("Attack clip archive failed", session.id, clip.index);
      }));
      return true;
    } catch (error) {
      if (session.cancelled || error?.name === "AbortError") {
        await this.cancelRemote(client, clip);
        clip.status = "cancelled";
      } else {
        // A failed read is not evidence that the accepted paid task failed.
        // Leave it available for read-only recovery instead of cancelling it.
        clip.failure = falVideoFailure(error, stage);
        clip.status = "error";
        clip.error = clip.failure.code === "FAL_REQUEST_UNCONFIRMED" ? publicError(error) : falVideoFailureMessage(clip.failure);
        clip.generationMs = Math.max(0, Math.round(this.monotonicNow() - startedMonotonic));
      }
      return false;
    } finally {
      clearTimeout(timeout);
      session.activeControllers.delete(clip.index);
      session.updatedAt = this.now();
    }
  }

  recordMetric(session, clip) {
    const metric = {
      event: "fal_video_clip_ready",
      recordedAt: clip.generationCompletedAt,
      sessionId: session.id,
      battleEpoch: session.battleEpoch,
      turn: session.turn,
      clipIndex: clip.index,
      openingClip: clip.index === 0,
      model: clip.model,
      seed: session.seed,
      inputMode: clip.inputMode,
      generationStartedAt: clip.generationStartedAt,
      generationCompletedAt: clip.generationCompletedAt,
      generationMs: clip.generationMs,
      submitMs: clip.submitMs,
      queueWaitMs: clip.queueWaitMs,
      providerRunMs: clip.providerRunMs,
      resultMs: clip.resultMs,
      statusTransport: clip.statusTransport,
    };
    try {
      const pending = this.metricSink(metric);
      pending?.catch?.(() => {});
    } catch {
      // Metrics must never interrupt a paid generation that already succeeded.
    }
  }

  async cancelRemote(client, clip) {
    if (!clip.requestId) return;
    if (!clip.cancelPromise) {
      clip.cancelPromise = withDeadline(
        client.queue.cancel(clip.model, { requestId: clip.requestId }),
        this.cancelTimeoutMs,
        "FAL_CANCEL_TIMEOUT",
      ).catch(() => {});
    }
    await clip.cancelPromise;
  }
}
