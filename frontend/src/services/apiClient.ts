import { shouldNotifyUnauthorized } from "./unauthorizedPolicy";

export type ApiErrorPayload = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
  request_id: string;
};

export type ApiOkPayload<T> = {
  ok: true;
  data: T;
  request_id: string;
};

export class ApiError extends Error {
  code: string;
  requestId: string;
  details?: unknown;
  status: number;

  constructor(args: { code: string; message: string; requestId: string; status: number; details?: unknown }) {
    super(args.message);
    this.name = "ApiError";
    this.code = args.code;
    this.requestId = args.requestId;
    this.details = args.details;
    this.status = args.status;
  }
}

export type ApiRequestInit = RequestInit & {
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function fetchWithTimeout(path: string, init?: ApiRequestInit): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, ...rest } = init ?? {};
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  const timeoutEnabled = timeoutMs > 0;
  const timeoutId = timeoutEnabled
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  try {
    return await fetch(path, { ...rest, credentials: rest.credentials ?? "include", signal: controller.signal });
  } catch (e) {
    if (timedOut) {
      throw new ApiError({
        code: "TIMEOUT",
        message: "请求超时，请稍后重试",
        requestId: "unknown",
        status: 0,
        details: e instanceof Error ? e.message : String(e),
      });
    }

    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError({
        code: "REQUEST_ABORTED",
        message: "请求已取消",
        requestId: "unknown",
        status: 0,
        details: e.message,
      });
    }

    throw new ApiError({
      code: "NETWORK_ERROR",
      message: "网络错误，请检查后端是否启动",
      requestId: "unknown",
      status: 0,
      details: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

function notifyUnauthorized(requestId?: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("ainovel:unauthorized", { detail: { requestId } }));
  } catch {
    // ignore
  }
}

export async function apiJson<T>(path: string, init?: ApiRequestInit): Promise<ApiOkPayload<T>> {
  const res = await fetchWithTimeout(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const requestIdHeader = res.headers.get("X-Request-Id") ?? undefined;
  const payload = (await parseJsonSafe(res)) as ApiOkPayload<T> | ApiErrorPayload | unknown;

  if (typeof payload === "object" && payload && "ok" in payload) {
    const typed = payload as ApiOkPayload<T> | ApiErrorPayload;
    if (typed.ok) return typed as ApiOkPayload<T>;
    if (shouldNotifyUnauthorized(res.status, typed.error.code))
      notifyUnauthorized(typed.request_id ?? requestIdHeader ?? "unknown");
    throw new ApiError({
      code: typed.error.code,
      message: typed.error.message,
      details: typed.error.details,
      requestId: typed.request_id ?? requestIdHeader ?? "unknown",
      status: res.status,
    });
  }

  if (shouldNotifyUnauthorized(res.status, null)) notifyUnauthorized(requestIdHeader ?? "unknown");
  throw new ApiError({
    code: "BAD_RESPONSE",
    message: "响应格式错误",
    requestId: requestIdHeader ?? "unknown",
    status: res.status,
    details: payload,
  });
}

export async function apiForm<T>(
  path: string,
  form: FormData,
  init?: ApiRequestInit,
): Promise<ApiOkPayload<T>> {
  const headers = new Headers(init?.headers ?? {});
  headers.delete("Content-Type");

  const res = await fetchWithTimeout(path, {
    ...init,
    headers,
    body: form,
  });

  const requestIdHeader = res.headers.get("X-Request-Id") ?? undefined;
  const payload = (await parseJsonSafe(res)) as ApiOkPayload<T> | ApiErrorPayload | unknown;

  if (typeof payload === "object" && payload && "ok" in payload) {
    const typed = payload as ApiOkPayload<T> | ApiErrorPayload;
    if (typed.ok) return typed as ApiOkPayload<T>;
    if (shouldNotifyUnauthorized(res.status, typed.error.code))
      notifyUnauthorized(typed.request_id ?? requestIdHeader ?? "unknown");
    throw new ApiError({
      code: typed.error.code,
      message: typed.error.message,
      details: typed.error.details,
      requestId: typed.request_id ?? requestIdHeader ?? "unknown",
      status: res.status,
    });
  }

  if (shouldNotifyUnauthorized(res.status, null)) notifyUnauthorized(requestIdHeader ?? "unknown");
  throw new ApiError({
    code: "BAD_RESPONSE",
    message: "响应格式错误",
    requestId: requestIdHeader ?? "unknown",
    status: res.status,
    details: payload,
  });
}

export async function apiDownloadMarkdown(path: string): Promise<{ filename: string; content: string }> {
  const res = await fetchWithTimeout(path);
  const contentType = res.headers.get("Content-Type") ?? "";
  const requestIdHeader = res.headers.get("X-Request-Id") ?? "unknown";

  if (contentType.includes("text/markdown")) {
    const content = await res.text();
    const cd = res.headers.get("Content-Disposition") ?? "";
    const filename = parseContentDispositionFilename(cd) || "ainovel.md";
    return { filename, content };
  }

  const payload = (await parseJsonSafe(res)) as ApiErrorPayload | unknown;
  if (typeof payload === "object" && payload && "ok" in payload && (payload as ApiErrorPayload).ok === false) {
    const typed = payload as ApiErrorPayload;
    if (shouldNotifyUnauthorized(res.status, typed.error.code)) notifyUnauthorized(typed.request_id ?? requestIdHeader);
    throw new ApiError({
      code: typed.error.code,
      message: typed.error.message,
      details: typed.error.details,
      requestId: typed.request_id ?? requestIdHeader,
      status: res.status,
    });
  }

  if (shouldNotifyUnauthorized(res.status, null)) notifyUnauthorized(requestIdHeader);
  throw new ApiError({
    code: "BAD_RESPONSE",
    message: "导出失败",
    requestId: requestIdHeader,
    status: res.status,
    details: payload,
  });
}

export async function apiDownloadAttachment(
  path: string,
): Promise<{ filename: string; blob: Blob; requestId: string }> {
  const res = await fetchWithTimeout(path);
  const requestIdHeader = res.headers.get("X-Request-Id") ?? "unknown";
  const cd = res.headers.get("Content-Disposition") ?? "";
  const filename = parseContentDispositionFilename(cd);

  if (res.ok && filename) {
    const blob = await res.blob();
    return { filename, blob, requestId: requestIdHeader };
  }

  const payload = (await parseJsonSafe(res)) as ApiErrorPayload | unknown;
  if (typeof payload === "object" && payload && "ok" in payload && (payload as ApiErrorPayload).ok === false) {
    const typed = payload as ApiErrorPayload;
    if (shouldNotifyUnauthorized(res.status, typed.error.code)) notifyUnauthorized(typed.request_id ?? requestIdHeader);
    throw new ApiError({
      code: typed.error.code,
      message: typed.error.message,
      details: typed.error.details,
      requestId: typed.request_id ?? requestIdHeader,
      status: res.status,
    });
  }

  if (shouldNotifyUnauthorized(res.status, null)) notifyUnauthorized(requestIdHeader);
  throw new ApiError({
    code: "BAD_RESPONSE",
    message: "下载失败",
    requestId: requestIdHeader,
    status: res.status,
    details: payload,
  });
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return trimmed.slice(1, -1);
  return trimmed;
}

export function sanitizeFilename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lastSegment = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const withoutNull = lastSegment.replaceAll("\0", "");
  const safe = withoutNull.replaceAll(/[\\/:*?"<>|]+/g, "_").trim();
  return safe.slice(0, 80);
}

function parseContentDispositionFilename(header: string): string | null {
  if (!header) return null;

  const filenameStarMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (filenameStarMatch?.[1]) {
    const raw = unquoteHeaderValue(filenameStarMatch[1]);
    const parts = /^([^']*)'[^']*'(.*)$/.exec(raw);
    const encoded = parts?.[2] ?? raw;
    try {
      const decoded = decodeURIComponent(encoded);
      return sanitizeFilename(decoded) || null;
    } catch {
      return sanitizeFilename(encoded) || null;
    }
  }

  const filenameQuotedMatch = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (filenameQuotedMatch?.[1]) return sanitizeFilename(filenameQuotedMatch[1]) || null;

  const filenameMatch = /filename\s*=\s*([^;]+)/i.exec(header);
  if (filenameMatch?.[1]) return sanitizeFilename(unquoteHeaderValue(filenameMatch[1])) || null;

  return null;
}
