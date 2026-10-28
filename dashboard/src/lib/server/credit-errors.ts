import { AiGatewayResponseError } from "./ai-gateway.ts";

export class CreditExecutionError extends Error {
  readonly code: "deadline";
  constructor(code: "deadline", message: string) {
    super(message);
    this.name = "CreditExecutionError";
    this.code = code;
  }
}

/** Safe categories only: never send upstream bodies, prompts or credentials to the UI/log. */
export function creditFailure(error: unknown): { code: string; message: string } {
  if (error instanceof Error && error.name === "SqlError") return { code: "session_storage", message: "会话状态暂时无法保存，请稍后重试，或将错误编号提供给管理员。" };
  if (error instanceof CreditExecutionError) return { code: error.code, message: "本次答复已达到时间上限，请稍后重试。" };
  if (error instanceof AiGatewayResponseError) {
    if (error.status === 429) return { code: "model_busy", message: "指定模型服务暂时繁忙或额度受限，请稍后重试。" };
    if (error.status === 408 || error.status === 504 || /timeout|timed out|aborted/i.test(error.message)) {
      return { code: "model_timeout", message: "模型响应超时，本次答复未完成，请稍后重试。" };
    }
    if (error.status !== null && error.status >= 400 && error.status < 500) {
      return { code: "model_configuration", message: "模型请求未被接受，请管理员检查 AI Gateway 的权限与请求配置。" };
    }
    return { code: error.status === 200 ? "model_output" : "model_unavailable", message: error.status === 200
      ? "模型输出中断或格式不完整，未返回未经核实的答复，请重试。"
      : "模型服务暂时不可用，本次答复未完成，请稍后重试。" };
  }
  return { code: "execution", message: "授信助手处理异常，本次答复未完成。请重试，或将错误编号提供给管理员。" };
}
