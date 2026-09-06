import { waitForAnchor } from "./attack-scene-anchor.js";

// The installed SDK's subscribeToStatus(streaming) ignores abortSignal and its
// timeout throws outside the promise. Own the stream lifetime instead. Losing
// this read-only channel must never resubmit or cancel an accepted paid job.
export async function waitForFalStatus(client, model, {
  requestId, signal, onQueueUpdate, onTransport, idleTimeoutMs = 8000,
}) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (typeof client.queue.streamStatus === "function") {
    let stream, timer, stop;
    let disposed = false;
    try {
      onTransport("streaming");
      await new Promise((resolve, reject) => {
        stop = () => reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", stop, { once: true });
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error("FAL_STATUS_STREAM_IDLE")), idleTimeoutMs);
        };
        arm();
        Promise.resolve().then(() => client.queue.streamStatus(model, {
          requestId, logs: false, connectionMode: "server",
        })).then(value => {
          stream = value;
          if (disposed || signal.aborted) { stream.abort(); stop(); return; }
          const update = status => {
            if (disposed || signal.aborted) return;
            arm();
            onQueueUpdate(status);
            if (status?.status === "COMPLETED") resolve();
          };
          stream.on("data", update);
          stream.done().then(status => {
            if (status?.status === "COMPLETED") { update(status); resolve(); }
            else reject(new Error("FAL_STATUS_STREAM_INCOMPLETE"));
          }, reject);
        }).catch(reject);
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return;
    } catch (error) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      onTransport("polling-fallback");
    } finally {
      disposed = true;
      clearTimeout(timer);
      if (stop) signal.removeEventListener("abort", stop);
      stream?.abort();
    }
  } else onTransport("polling");
  // The runway's existing deadline/remote cancellation remains the sole owner.
  await waitForAnchor(client.queue.subscribeToStatus(model, {
    requestId, mode: "polling", pollInterval: 350, logs: false,
    abortSignal: signal, onQueueUpdate,
  }), signal);
}
