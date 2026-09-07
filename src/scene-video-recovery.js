import { createFalClient } from "@fal-ai/client";
import { FAL_VIDEO_MODEL, FAL_VIDEO_REFERENCE_MODEL } from "./fal-video-runway.js";
import { falVideoFailure, falVideoFailureMessage } from "./fal-video-failure.js";

export const recoveryError = code => Object.assign(new Error(code), { code });

export function validatePaidScene(paid, job) {
  if (paid.key !== job.key || paid.kind !== job.kind || paid.status !== "submitted"
    || (paid.language ?? "zh") !== (job.language ?? "zh")
    || ![FAL_VIDEO_MODEL, FAL_VIDEO_REFERENCE_MODEL].includes(paid.model)
    || typeof paid.requestId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(paid.requestId)) {
    throw recoveryError("UNCONFIRMED_SUBMISSION");
  }
}

// Deliberately no submit/subscribe/cancel API here. A recovery timeout only
// aborts our reads; it must not cancel or replace the original paid request.
export async function recoverSceneClip(paid, { credentials, signal, clientFactory = createFalClient } = {}) {
  const client = clientFactory({ credentials });
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  while (true) {
    const status = await client.queue.status(paid.model, { requestId: paid.requestId, logs: false, abortSignal: readSignal });
    if (status.status === "COMPLETED") break;
    if (!["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) throw recoveryError("PAID_TASK_UNAVAILABLE");
    await new Promise((resolve, reject) => {
      if (readSignal.aborted) { reject(readSignal.reason); return; }
      const stop = () => { clearTimeout(timer); reject(readSignal.reason); };
      const timer = setTimeout(() => { readSignal.removeEventListener("abort", stop); resolve(); }, 500);
      readSignal.addEventListener("abort", stop, { once: true });
    });
  }
  let result;
  try {
    result = await client.queue.result(paid.model, { requestId: paid.requestId, abortSignal: readSignal });
  } catch (error) {
    if (readSignal.aborted) throw error;
    const failure = falVideoFailure(error, "result");
    throw Object.assign(new Error(falVideoFailureMessage(failure)), { failure, status: failure.status });
  }
  const videoUrl = result.data?.video?.url;
  if (typeof videoUrl !== "string" || new URL(videoUrl).protocol !== "https:") throw recoveryError("PAID_TASK_UNAVAILABLE");
  return { requestId: paid.requestId, model: paid.model, videoUrl };
}
