import { ApiError } from "../../services/apiClient";
import { SSEError } from "../../services/sseClient";

// ---------------------------------------------------------------------------
// Error guidance mapping (P0 optimization: actionable error messages)
// ---------------------------------------------------------------------------

const ERROR_GUIDANCE: Record<string, string> = {
  // LLM errors
  LLM_TIMEOUT: "生成超时。建议：1) 减少目标字数 2) 检查网络连接 3) 切换为非流式模式",
  LLM_UPSTREAM_ERROR: "LLM 服务端异常。建议：1) 稍后重试 2) 检查 API Key 是否有效 3) 尝试切换模型",
  LLM_RATE_LIMIT: "API 请求频率超限。建议：1) 等待 30 秒后重试 2) 切换到其他 LLM 配置",
  LLM_CIRCUIT_OPEN: "LLM 服务连续失败已自动熔断。建议：1) 等待 1 分钟后重试 2) 检查 API 服务状态 3) 切换到备用 Provider",
  LLM_AUTH_ERROR: "API 认证失败。建议：检查 LLM 配置中的 API Key 是否正确",
  LLM_MODEL_NOT_FOUND: "模型不可用。建议：检查模型名称是否正确或切换其他模型",

  // Generation errors
  OUTPUT_TRUNCATED: "生成内容被截断。建议：1) 减少目标字数 2) 增大模型 max_tokens 设置",
  GENERATION_FAILED: "生成失败。建议：1) 检查 LLM 配置 2) 减少上下文记忆模块 3) 重试",
  CONTEXT_TOO_LARGE: "上下文超出模型限制。建议：1) 减少启用的记忆模块 2) 切换到更大上下文窗口的模型",
  CHAPTER_PREREQ_MISSING: "前置章节缺失。建议：先完成缺失的章节后再生成",

  // Network errors
  TIMEOUT: "请求超时。建议：1) 检查网络连接 2) 减少生成字数 3) 切换非流式模式",
  NETWORK_ERROR: "网络连接异常。建议：1) 检查网络连接 2) 确认后端服务是否启动",
  REQUEST_ABORTED: "请求被取消",

  // SSE errors (comprehensive coverage)
  SSE_TIMEOUT: "流式传输超时。建议：1) 减少目标字数 2) 检查网络稳定性 3) 切换为非流式模式",
  SSE_SERVER_ERROR: "服务器流式处理异常。建议：1) 稍后重试 2) 切换为非流式模式",
  SSE_CONNECTION_ERROR: "无法连接到服务器。建议：1) 检查网络连接 2) 确认后端服务是否启动",
  SSE_STREAM_ERROR: "数据流读取失败。建议：1) 检查网络稳定性 2) 尝试刷新页面",
  SSE_EARLY_CLOSE: "连接提前断开。建议：1) 检查网络连接 2) 稍后重试",
  SSE_PROTOCOL_ERROR: "通信协议异常。建议：刷新页面后重试",
  SSE_BAD_RESPONSE: "服务器返回异常。建议：1) 稍后重试 2) 检查后端日志",
  ABORTED: "连接被中断。建议：检查网络连接后重试",

  // Auth / Permission
  UNAUTHORIZED: "登录已过期。建议：重新登录",
  FORBIDDEN: "无操作权限。建议：联系项目管理员",

  // Batch generation
  BATCH_LIMIT_EXCEEDED: "批量生成数量超限。建议：减少批量生成的章节数量",

  // Validation
  VALIDATION_ERROR: "参数错误。建议：检查输入内容是否完整",

  // Pipeline fallback warnings (for display in generation results)
  "fallback:content_optimize_skipped": "内容优化步骤已跳过，使用原始生成结果",
  "fallback:content_optimize_exception": "内容优化步骤异常，已降级为原始生成结果",
  "fallback:post_edit_skipped": "后期润色步骤已跳过",
  "fallback:post_edit_exception": "后期润色步骤异常，已降级",
};

/**
 * Get actionable guidance text for an error code.
 * Returns undefined if no specific guidance is available.
 */
export function getErrorGuidance(code: string): string | undefined {
  return ERROR_GUIDANCE[code];
}

/**
 * Format a user-friendly error message with actionable guidance.
 * Handles both ApiError and SSEError with code-based lookup.
 */
export function formatErrorWithGuidance(err: unknown): string {
  // Handle SSEError with user-friendly message
  if (err instanceof SSEError) {
    const guidance = getErrorGuidance(err.code);
    if (guidance) return guidance;
    return err.userFriendlyMessage || err.message;
  }

  if (err instanceof ApiError) {
    const guidance = getErrorGuidance(err.code);
    if (guidance) return guidance;
    return err.message || "发生未知错误，请稍后重试";
  }

  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Get a short summary suitable for toast notifications.
 * Returns the first sentence of the guidance (before the first period).
 */
export function getErrorToastMessage(err: unknown): string {
  // Handle SSEError
  if (err instanceof SSEError) {
    const guidance = getErrorGuidance(err.code);
    if (guidance) {
      const firstLine = guidance.split("。")[0];
      return firstLine + "。";
    }
    return err.userFriendlyMessage || err.message;
  }

  if (!(err instanceof ApiError)) {
    if (err instanceof Error) return err.message;
    return "操作失败";
  }

  const guidance = getErrorGuidance(err.code);
  if (guidance) {
    // For toasts, just use the first suggestion line
    const firstLine = guidance.split("。")[0];
    return firstLine + "。";
  }

  return err.message || "操作失败";
}

/**
 * Get the requestId from an error for debugging reference.
 */
export function getErrorRequestId(err: unknown): string | undefined {
  if (err instanceof SSEError) return err.requestId;
  if (err instanceof ApiError) return err.requestId;
  return undefined;
}

export function extractMissingNumbers(err: unknown): number[] {
  if (!(err instanceof ApiError)) return [];
  if (err.code !== "CHAPTER_PREREQ_MISSING") return [];

  const details = err.details;
  if (!details || typeof details !== "object") return [];
  if (!("missing_numbers" in details)) return [];

  const missing = (details as { missing_numbers?: unknown }).missing_numbers;
  if (!Array.isArray(missing)) return [];
  return missing.filter((n): n is number => typeof n === "number");
}
