// Only retain known error categories, never provider payloads (which may echo inputs/keys).
const MODEL_FAILURES = new Set(["internal_server_error", "generation_timeout", "downstream_service_error", "downstream_service_unavailable", "runner_error", "runner_restart", "no_media_generated"]);
export function falVideoFailure(error, stage) {
  const status = error?.status ?? error?.statusCode;
  const body = error?.body;
  const detail = body?.detail;
  const type = body?.error_type ?? (Array.isArray(detail) ? detail[0]?.type : null);
  // Legacy H3 responses have no structured error_type for the TOP_UP lock.
  const topUp = type === "insufficient_credits" || type === "top_up_required"
    || (typeof detail === "string" && /User is locked\. Reason: TOP_UP\.?$/i.test(detail));
  const policy = type === "content_policy_violation";
  const modelFailure = MODEL_FAILURES.has(type);
  const rejected = stage === "submit" && [400, 401, 403, 404, 422, 429].includes(status);
  const confirmed = rejected || (stage === "result" && (topUp || policy || modelFailure));
  const code = topUp ? "FAL_TOP_UP_REQUIRED" : policy ? "FAL_CONTENT_POLICY"
    : status === 401 ? "FAL_AUTH_FAILED" : status === 403 ? "FAL_ACCESS_DENIED"
      : status === 429 ? "FAL_RATE_LIMITED" : modelFailure ? "FAL_GENERATION_FAILED"
        : [400, 404, 422].includes(status) ? "FAL_INVALID_REQUEST" : "FAL_REQUEST_UNCONFIRMED";
  const regenerable = confirmed && !policy && status !== 401
    && (topUp || modelFailure || [403, 429].includes(status));
  return { code, stage, status: Number.isInteger(status) ? status : null, confirmed, regenerable };
}

export function falVideoFailureMessage(failure) {
  return ({
    FAL_TOP_UP_REQUIRED: "fal 拒绝此任务：账户被标记为需充值（TOP_UP）",
    FAL_CONTENT_POLICY: "fal 内容检查未通过，请修改输入后再试",
    FAL_AUTH_FAILED: "fal 身份验证失败，请检查 API 密钥",
    FAL_ACCESS_DENIED: "fal 拒绝访问此请求，请检查账户或模型权限",
    FAL_RATE_LIMITED: "fal 请求受到限流",
    FAL_GENERATION_FAILED: "fal 已确认视频生成失败",
    FAL_INVALID_REQUEST: "fal 请求参数或任务地址无效",
  })[failure?.code] ?? "fal 请求结果尚未确认，不能重复提交";
}
