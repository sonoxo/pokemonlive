// Buy at most one session. Cancellation during POST still captures its id and
// cancels that exact session; consumers never retry an ambiguous paid request.
export function prefetchAttackSession(bodyPromise, { signal, fetchImpl = fetch } = {}) {
  let sessionId;
  let cancelled = false;
  const cancel = () => {
    if (!sessionId || cancelled) return;
    cancelled = true;
    void fetchImpl(`/api/attack-videos/${sessionId}`, { method: "DELETE", keepalive: true }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const pending = (async () => {
    const body = await bodyPromise;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await fetchImpl("/api/attack-videos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.session?.id) throw new Error(payload.error || "视频预生成请求失败");
    sessionId = payload.session.id;
    if (signal.aborted) { cancel(); throw new DOMException("Aborted", "AbortError"); }
    return payload;
  })();
  pending.catch(() => {});
  return pending;
}
