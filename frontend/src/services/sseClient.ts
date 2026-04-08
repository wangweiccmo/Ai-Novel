import { ApiError, type ApiErrorPayload } from "./apiClient";
import { shouldNotifyUnauthorized } from "./unauthorizedPolicy";

export type SSEMessage =
  | {
      type: "start";
      message?: string;
      progress?: number;
      status?: "processing" | "success" | "error";
      char_count?: number;
      word_count?: number;
    }
  | {
      type: "progress";
      message: string;
      progress: number;
      status: "processing" | "success" | "error";
      char_count?: number;
      word_count?: number;
    }
  | { type: "chunk" | "token"; content: string }
  | { type: "result"; data: unknown }
  | { type: "error"; error: string; code?: number }
  | { type: "done" };

export type SSEClientOptions = {
  headers?: Record<string, string>;
  onProgress?: (msg: { message: string; progress: number; status: string; charCount?: number }) => void;
  onChunk?: (content: string) => void;
  onResult?: (data: unknown) => void;
  onError?: (error: string, code?: number) => void;
  onDone?: () => void;
  onOpen?: (info: { requestId?: string }) => void;
};

export class SSEError extends Error {
  code: string;
  requestId?: string;
  userFriendlyMessage?: string;

  constructor(args: { code: string; message: string; requestId?: string }) {
    super(args.message);
    this.name = "SSEError";
    this.code = args.code;
    this.requestId = args.requestId;
    this.userFriendlyMessage = SSE_ERROR_MESSAGES[args.code];
  }
}

/** User-friendly translations for SSE error codes. */
const SSE_ERROR_MESSAGES: Record<string, string> = {
  ABORTED: "连接被中断，请检查网络后重试",
  SSE_CONNECTION_ERROR: "无法连接到服务器，请检查网络连接",
  SSE_SERVER_ERROR: "服务器处理异常，请稍后重试",
  SSE_TIMEOUT: "请求超时，建议减少生成字数或切换非流式模式",
  SSE_BAD_RESPONSE: "服务器返回异常响应",
  SSE_PROTOCOL_ERROR: "通信协议异常，请刷新页面后重试",
  SSE_STREAM_ERROR: "数据流读取失败，请检查网络稳定性",
  SSE_EARLY_CLOSE: "连接提前断开，请检查网络后重试",
};

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function isApiErrorPayload(payload: unknown): payload is ApiErrorPayload {
  if (!payload || typeof payload !== "object") return false;
  return "ok" in payload && (payload as { ok?: unknown }).ok === false;
}

function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "name" in e && (e as { name?: unknown }).name === "AbortError";
}

function notifyUnauthorized(requestId?: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("ainovel:unauthorized", { detail: { requestId } }));
  } catch {
    // ignore
  }
}

/** Maximum time (ms) to wait between SSE chunks before considering the stream stalled. */
const SSE_CHUNK_TIMEOUT_MS = 60_000;

export class SSEPostClient {
  private url: string;
  private data: unknown;
  private options: SSEClientOptions;
  private abortController: AbortController;
  private requestId?: string;
  private accumulatedContent = "";
  private resultData: unknown = undefined;

  constructor(url: string, data: unknown, options: SSEClientOptions = {}) {
    this.url = url;
    this.data = data;
    this.options = options;
    this.abortController = new AbortController();
  }

  abort() {
    this.abortController.abort();
  }

  async connect(): Promise<{ requestId?: string; result?: unknown; accumulatedContent: string }> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(this.data),
        signal: this.abortController.signal,
      });
    } catch (e: unknown) {
      if (isAbortError(e)) {
        throw new SSEError({ code: "ABORTED", message: "已取消生成" });
      }
      throw new SSEError({ code: "SSE_CONNECTION_ERROR", message: "SSE 连接失败" });
    }

    this.requestId = response.headers.get("X-Request-Id") ?? undefined;
    this.options.onOpen?.({ requestId: this.requestId });

    if (!response.ok) {
      const payload = await parseJsonSafe(response);
      if (isApiErrorPayload(payload)) {
        if (shouldNotifyUnauthorized(response.status, payload.error.code))
          notifyUnauthorized(payload.request_id ?? this.requestId);
        throw new ApiError({
          code: payload.error.code,
          message: payload.error.message,
          details: payload.error.details,
          requestId: payload.request_id ?? this.requestId ?? "unknown",
          status: response.status,
        });
      }
      if (shouldNotifyUnauthorized(response.status, null)) notifyUnauthorized(this.requestId);
      throw new SSEError({ code: "SSE_BAD_RESPONSE", message: `HTTP ${response.status}`, requestId: this.requestId });
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new SSEError({ code: "SSE_PROTOCOL_ERROR", message: "响应不是 event-stream", requestId: this.requestId });
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new SSEError({ code: "SSE_STREAM_ERROR", message: "无法获取响应流", requestId: this.requestId });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let doneReceived = false;

    try {
      while (true) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<never>((_, reject) => {
          const id = setTimeout(() => {
            reject(new SSEError({ code: "SSE_TIMEOUT", message: "流式输出超时（60秒无数据）", requestId: this.requestId }));
          }, SSE_CHUNK_TIMEOUT_MS);
          // Clean up timer if read completes first
          readPromise.then(() => clearTimeout(id), () => clearTimeout(id));
        });
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r", "");

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          let eventName: string | null = null;
          const dataLines: string[] = [];
          for (const line of trimmed.split("\n")) {
            if (line.startsWith("event:")) {
              if (eventName === null) eventName = line.slice("event:".length).trim() || null;
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice("data:".length).trim());
            }
          }

          if (dataLines.length === 0) continue;
          const dataStr = dataLines.join("\n");

          let msg: unknown;
          try {
            msg = JSON.parse(dataStr) as SSEMessage;
          } catch {
            continue;
          }

          const obj = msg && typeof msg === "object" ? (msg as Record<string, unknown>) : null;
          const typeFromPayload = typeof obj?.type === "string" ? obj.type : null;
          const eventType = eventName || typeFromPayload;
          if (!eventType) continue;

          if (eventType === "start") {
            const message = typeof obj?.message === "string" ? obj.message : "开始生成...";
            const progress = typeof obj?.progress === "number" ? obj.progress : 0;
            const status = typeof obj?.status === "string" ? obj.status : "processing";
            this.options.onProgress?.({
              message,
              progress,
              status,
              charCount: (obj?.char_count as number | undefined) ?? (obj?.word_count as number | undefined),
            });
          } else if (eventType === "progress") {
            if (typeof obj?.message !== "string") continue;
            if (typeof obj?.progress !== "number") continue;
            if (typeof obj?.status !== "string") continue;
            this.options.onProgress?.({
              message: obj.message,
              progress: obj.progress,
              status: obj.status,
              charCount: (obj.char_count as number | undefined) ?? (obj.word_count as number | undefined),
            });
          } else if (eventType === "chunk" || eventType === "token") {
            if (typeof obj?.content !== "string") continue;
            this.accumulatedContent += obj.content;
            this.options.onChunk?.(obj.content);
          } else if (eventType === "result") {
            const data = obj?.data;
            this.resultData = data;
            this.options.onResult?.(data);
          } else if (eventType === "error") {
            const error = typeof obj?.error === "string" ? obj.error : "SSE error";
            const code = typeof obj?.code === "number" ? obj.code : undefined;
            this.options.onError?.(error, code);
            throw new SSEError({ code: "SSE_SERVER_ERROR", message: error, requestId: this.requestId });
          } else if (eventType === "done") {
            doneReceived = true;
            this.options.onDone?.();
            return { requestId: this.requestId, result: this.resultData, accumulatedContent: this.accumulatedContent };
          }
        }
      }
    } catch (e: unknown) {
      if (isAbortError(e)) {
        throw new SSEError({ code: "ABORTED", message: "已取消生成", requestId: this.requestId });
      }
      if (e instanceof SSEError || e instanceof ApiError) {
        throw e;
      }
      throw new SSEError({ code: "SSE_STREAM_ERROR", message: "SSE 读取失败", requestId: this.requestId });
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }

    if (this.abortController.signal.aborted) {
      throw new SSEError({ code: "ABORTED", message: "已取消生成", requestId: this.requestId });
    }
    if (!doneReceived) {
      if (this.resultData !== undefined) {
        // Some proxies may drop the terminal done event while result is already delivered.
        this.options.onDone?.();
        return { requestId: this.requestId, result: this.resultData, accumulatedContent: this.accumulatedContent };
      }
      throw new SSEError({ code: "SSE_EARLY_CLOSE", message: "SSE 连接提前结束", requestId: this.requestId });
    }
    return { requestId: this.requestId, result: this.resultData, accumulatedContent: this.accumulatedContent };
  }
}
