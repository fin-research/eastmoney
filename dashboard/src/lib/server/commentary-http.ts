import { z } from "zod";
import { PolicyRepositoryError } from "./policy-repository.ts";
import { BondLedgerUploadError } from "./bond-ledger.ts";
import { AiGatewayResponseError, AiGatewayRetryError } from "./ai-gateway.ts";
export const commentaryHeaders = { "Cache-Control": "no-store" };
export function commentaryError(error: unknown): Response {
  if (error instanceof AiGatewayResponseError || error instanceof AiGatewayRetryError) {
    const failures = error instanceof AiGatewayRetryError ? error.failures : [error.toFailure()];
    const last = failures[failures.length - 1] ?? { message: "", status: null };
    const timedOut = /timeout|timed out/i.test(last.message);
    const invalid = /business schema|output_text|response completion|terminal event/i.test(last.message);
    const code = timedOut ? "AI_RESPONSE_TIMEOUT" : invalid ? "AI_OUTPUT_INVALID" : "AI_UPSTREAM_ERROR";
    const gatewayLogIds = failures.map(f => f.gatewayLogId).filter(id => /^[a-zA-Z0-9_-]{1,80}$/.test(id));
    const message = timedOut
      ? `AI在限时内未返回完整结果（${failures.length}次尝试${last.status ? `，上游HTTP ${last.status}` : ""}）`
      : invalid ? "AI返回内容未通过原文选材校验，未保存草稿"
      : `AI上游调用失败${last.status ? `（HTTP ${last.status}）` : "（连接异常）"}`;
    console.error(JSON.stringify({ event: "commentary_failed", code, attempts: failures.length,
      statuses: failures.map(f => f.status), gateway_log_ids: gatewayLogIds }));
    return Response.json({ error: `${message}；错误码 ${code}${gatewayLogIds.length ? `；追踪 ${gatewayLogIds.join(" / ")}` : ""}`,
      code, attempts: failures.length, gatewayLogIds }, { status: timedOut ? 504 : 502, headers: commentaryHeaders });
  }
  const known = error instanceof PolicyRepositoryError || error instanceof BondLedgerUploadError;
  const status = known ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
  return Response.json({ error: known ? error.message : status === 400 ? "请检查主题、日期与点评内容" : "跟踪点评操作失败，请稍后重试" }, { status, headers: commentaryHeaders });
}
export function requireCommentaryEnv(platform: App.Platform | undefined): Env {
  if (!platform?.env?.DB) throw new PolicyRepositoryError(503, "D1 尚未配置");
  return platform.env;
}
