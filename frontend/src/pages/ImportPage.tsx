import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { DebugDetails, DebugPageShell } from "../components/atelier/DebugPageShell";
import { GhostwriterIndicator } from "../components/atelier/GhostwriterIndicator";
import { useToast } from "../components/ui/toast";
import { ApiError, apiForm, apiJson, sanitizeFilename } from "../services/apiClient";

type ImportDocument = {
  id: string;
  project_id: string;
  actor_user_id: string | null;
  filename: string;
  content_type: string;
  status: string;
  progress: number;
  progress_message: string | null;
  chunk_count: number;
  kb_id: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ImportDocumentDetail = {
  document: ImportDocument;
  content_preview: string;
  vector_ingest_result: unknown;
  worldbook_proposal: unknown;
  story_memory_proposal: unknown;
};

type ImportChunk = {
  id: string;
  chunk_index: number;
  preview: string;
  vector_chunk_id: string | null;
};

type ProposalPreview = {
  summary: string;
  sampleTitles: string[];
  keys: string[];
};

function humanizeStatus(status: string): string {
  const s = (status || "").trim().toLowerCase();
  if (s === "queued") return "排队中";
  if (s === "running") return "处理中";
  if (s === "done") return "完成";
  if (s === "failed") return "失败";
  return status || "unknown";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

export function ImportPage() {
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();
  const toast = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);

  const [listLoading, setListLoading] = useState(false);
  const [documents, setDocuments] = useState<ImportDocument[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<ImportDocumentDetail | null>(null);

  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunks, setChunks] = useState<ImportChunk[]>([]);

  const [applyWorldbookLoading, setApplyWorldbookLoading] = useState(false);
  const [applyStoryMemoryLoading, setApplyStoryMemoryLoading] = useState(false);

  const [pollPaused, setPollPaused] = useState(false);

  const autoOpenedDocIdRef = useRef<string | null>(null);
  const lastPolledRef = useRef<{ id: string; status: string } | null>(null);

  const selectedDoc = useMemo(() => {
    if (!selectedId) return null;
    const d = documents.find((x) => x.id === selectedId) ?? null;
    return d;
  }, [documents, selectedId]);

  const statusDoc = useMemo(() => selectedDoc ?? detail?.document ?? null, [detail?.document, selectedDoc]);
  const proposalPreview = useMemo(() => {
    const summarize = (value: unknown, arrayKeys: string[]): ProposalPreview => {
      if (value == null) return { summary: "（空）", sampleTitles: [], keys: [] };
      if (Array.isArray(value)) {
        const sampleTitles = value
          .map((it) => {
            if (!it || typeof it !== "object") return "";
            const o = it as Record<string, unknown>;
            const title = typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : "";
            return title.trim();
          })
          .filter(Boolean)
          .slice(0, 8);
        return { summary: `array(${value.length})`, sampleTitles, keys: [] };
      }
      if (typeof value !== "object") return { summary: String(value), sampleTitles: [], keys: [] };
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      for (const key of arrayKeys) {
        const arr = obj[key];
        if (!Array.isArray(arr)) continue;
        const sampleTitles = arr
          .map((it) => {
            if (!it || typeof it !== "object") return "";
            const o = it as Record<string, unknown>;
            const title = typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : "";
            return title.trim();
          })
          .filter(Boolean)
          .slice(0, 8);
        return { summary: `${key}: ${arr.length}`, sampleTitles, keys };
      }
      return {
        summary: keys.length ? `keys: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? "…" : ""}` : "(empty)",
        sampleTitles: [],
        keys,
      };
    };

    return {
      worldbook: summarize(detail?.worldbook_proposal, ["entries", "worldbook_entries", "items"]),
      storyMemory: summarize(detail?.story_memory_proposal, ["memories", "items", "records"]),
    };
  }, [detail?.story_memory_proposal, detail?.worldbook_proposal]);

  const pollStatus = String(selectedDoc?.status ?? detail?.document.status ?? "")
    .trim()
    .toLowerCase();
  const shouldPoll = !pollPaused && (pollStatus === "queued" || pollStatus === "running");
  const lastUpdateMs = useMemo(() => {
    const raw = statusDoc?.updated_at || statusDoc?.created_at || "";
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }, [statusDoc?.created_at, statusDoc?.updated_at]);
  const lastUpdateAgoMs = useMemo(() => {
    if (!lastUpdateMs) return null;
    return Date.now() - lastUpdateMs;
  }, [lastUpdateMs]);
  const isPollingStalled = useMemo(() => {
    if (pollStatus !== "queued" && pollStatus !== "running") return false;
    if (lastUpdateAgoMs == null) return false;
    return lastUpdateAgoMs >= 5 * 60_000;
  }, [lastUpdateAgoMs, pollStatus]);

  const loadList = useCallback(async () => {
    if (!projectId) return;
    if (listLoading) return;
    setListLoading(true);
    try {
      const res = await apiJson<{ documents: ImportDocument[] }>(`/api/projects/${projectId}/imports`);
      setDocuments(Array.isArray(res.data.documents) ? res.data.documents : []);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setListLoading(false);
    }
  }, [listLoading, projectId, toast]);

  const selectDocAndLoad = useCallback(
    async (docId: string) => {
      if (!projectId) return;
      const id = String(docId || "").trim();
      if (!id) return;
      setPollPaused(false);
      setSelectedId(id);
      setChunks([]);
      setDetail(null);
      setDetailLoading(true);
      try {
        const res = await apiJson<ImportDocumentDetail>(`/api/projects/${projectId}/imports/${encodeURIComponent(id)}`);
        setDetail(res.data);
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setDetailLoading(false);
      }
    },
    [projectId, toast],
  );

  const retryImport = useCallback(
    async (docId: string) => {
      if (!projectId) return;
      const id = String(docId || "").trim();
      if (!id) return;
      try {
        const res = await apiJson<{ document: ImportDocument }>(
          `/api/projects/${projectId}/imports/${encodeURIComponent(id)}/retry`,
          { method: "POST", body: JSON.stringify({}) },
        );
        toast.toastSuccess("已重试导入", res.request_id);
        setSelectedId(res.data.document.id);
        await loadList();
        await selectDocAndLoad(res.data.document.id);
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      }
    },
    [loadList, projectId, selectDocAndLoad, toast],
  );

  const loadChunks = useCallback(async () => {
    if (!projectId) return;
    if (!selectedId) return;
    if (chunksLoading) return;
    setChunksLoading(true);
    try {
      const res = await apiJson<{ chunks: ImportChunk[] }>(
        `/api/projects/${projectId}/imports/${encodeURIComponent(selectedId)}/chunks?limit=200`,
      );
      setChunks(Array.isArray(res.data.chunks) ? res.data.chunks : []);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setChunksLoading(false);
    }
  }, [chunksLoading, projectId, selectedId, toast]);

  const createImport = useCallback(async () => {
    if (!projectId) return;
    if (!file) return;
    if (creating) return;

    const safeName = sanitizeFilename(file.name) || "import.txt";
    const maxBytes = 5_000_000;
    if (file.size > maxBytes) {
      toast.toastError(
        `文件过大：${Math.ceil(file.size / 1024)} KB（上限 ${Math.ceil(maxBytes / 1024)} KB）`,
        "client",
      );
      return;
    }

    setCreating(true);
    try {
      const form = new FormData();
      form.append("file", file, safeName);
      const res = await apiForm<{ document: ImportDocument; job_id: string | null }>(
        `/api/projects/${projectId}/imports/upload`,
        form,
        { method: "POST", timeoutMs: 180_000 },
      );
      toast.toastSuccess("已提交导入任务", res.request_id);
      await loadList();
      await selectDocAndLoad(res.data.document.id);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setCreating(false);
    }
  }, [creating, file, loadList, projectId, selectDocAndLoad, toast]);

  const applyWorldbook = useCallback(async () => {
    if (!projectId) return;
    if (!detail) return;
    if (applyWorldbookLoading) return;
    setApplyWorldbookLoading(true);
    try {
      const res = await apiJson(`/api/projects/${projectId}/worldbook_entries/import_all`, {
        method: "POST",
        body: JSON.stringify(detail.worldbook_proposal ?? {}),
      });
      toast.toastSuccess("已应用 WorldBook 提案", res.request_id);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setApplyWorldbookLoading(false);
    }
  }, [applyWorldbookLoading, detail, projectId, toast]);

  const applyStoryMemory = useCallback(async () => {
    if (!projectId) return;
    if (!detail) return;
    if (applyStoryMemoryLoading) return;
    setApplyStoryMemoryLoading(true);
    try {
      const res = await apiJson(`/api/projects/${projectId}/story_memories/import_all`, {
        method: "POST",
        body: JSON.stringify(detail.story_memory_proposal ?? {}),
      });
      toast.toastSuccess("已应用 story_memory 提案", res.request_id);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setApplyStoryMemoryLoading(false);
    }
  }, [applyStoryMemoryLoading, detail, projectId, toast]);

  useEffect(() => {
    if (!projectId) return;
    const requested = String(searchParams.get("docId") ?? "").trim();
    void Promise.resolve().then(async () => {
      await loadList();
      if (!requested) return;
      if (autoOpenedDocIdRef.current === requested) return;
      autoOpenedDocIdRef.current = requested;
      await selectDocAndLoad(requested);
    });
  }, [loadList, projectId, searchParams, selectDocAndLoad]);

  useEffect(() => {
    if (!shouldPoll) return;
    const intervalMs = 2000;
    const timerId = window.setInterval(() => {
      void loadList();
    }, intervalMs);
    return () => window.clearInterval(timerId);
  }, [loadList, shouldPoll]);

  useEffect(() => {
    if (!selectedId) return;
    const prev = lastPolledRef.current;
    lastPolledRef.current = { id: selectedId, status: pollStatus };
    if (!prev || prev.id !== selectedId) return;

    const prevRunning = prev.status === "queued" || prev.status === "running";
    const nowDone = pollStatus === "done" || pollStatus === "failed";
    if (!prevRunning || !nowDone) return;

    void selectDocAndLoad(selectedId);
  }, [pollStatus, selectedId, selectDocAndLoad]);

  return (
    <DebugPageShell
      title="导入小说/资料"
      description={
        <div className="grid gap-2">
          <div>流程：上传 txt/md/docx/epub → 后端解析与切分 chunk →（可选）写入向量 KB → 生成提案（proposal）。</div>
          <ul className="grid list-disc gap-1 pl-5 text-xs text-subtext">
            <li>
              世界书（worldbook）：会生成 WorldBookEntry
              的候选条目；应用后可在「世界书」页查看，也可在写作时用于上下文注入。
            </li>
            <li>故事记忆（story_memory）：会生成 StoryMemory 的候选条目；应用后可在记忆预览/检索中命中。</li>
            <li>向量 KB（vector_kb / kb）：用于 RAG 语义检索（可在「RAG」页管理）。</li>
            <li>Chunk（chunk）：系统切分后的文本片段（用于检索与溯源）。</li>
          </ul>
          <div className="callout-warning">提示：导入后请先预览，再选择性应用（默认不会自动写入长期记忆）。</div>
        </div>
      }
      actions={
        projectId ? (
          <Link className="btn btn-secondary" to={`/projects/${projectId}/rag`}>
            返回 RAG
          </Link>
        ) : null
      }
    >
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-ink">上传文件</div>
          <button
            className="btn btn-secondary"
            aria-label="import_refresh"
            onClick={() => void loadList()}
            type="button"
          >
            刷新列表
          </button>
        </div>
        <div className="grid gap-3 rounded-atelier border border-border bg-canvas p-4">
          <div className="grid gap-1">
            <div className="text-xs text-subtext">选择文件（txt/md/docx/epub，≤ 5MB）</div>
            <input
              aria-label="import_file"
              accept=".txt,.md,.markdown,.docx,.epub,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/epub+zip"
              className="input"
              disabled={creating}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              type="file"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn btn-primary"
              disabled={!projectId || !file || creating}
              onClick={() => void createImport()}
              type="button"
            >
              {creating ? "导入中…" : "开始导入"}
            </button>
            {creating ? <GhostwriterIndicator label="正在提交导入并处理…" /> : null}
          </div>
        </div>
      </section>

      <section className="grid gap-3">
        <div className="text-sm font-semibold text-ink">导入记录</div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-2">
            {listLoading ? <div className="text-xs text-subtext">加载中…</div> : null}
            {documents.length === 0 && !listLoading ? (
              <div className="rounded-atelier border border-border bg-canvas p-4 text-sm text-subtext">
              暂无导入记录。请先上传 txt/md/docx/epub 文件。
              </div>
            ) : null}
            <div className="grid gap-2">
              {documents.map((d) => {
                const active = d.id === selectedId;
                return (
                  <button
                    key={d.id}
                    className={
                      active
                        ? "panel-interactive ui-focus-ring border-accent/60 bg-surface-hover p-4 text-left"
                        : "panel-interactive ui-focus-ring p-4 text-left"
                    }
                    onClick={() => void selectDocAndLoad(d.id)}
                    type="button"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-ink">{d.filename || "import.txt"}</div>
                        <div className="mt-1 text-xs text-subtext">
                          {humanizeStatus(d.status)} · {Math.max(0, Math.min(100, Math.floor(d.progress ?? 0)))}% ·{" "}
                          {d.progress_message || ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-xs text-subtext">{d.chunk_count ?? 0} chunks</div>
                    </div>
                    {d.error_message ? (
                      <div className="mt-2 rounded-atelier border border-border bg-surface p-2 text-xs text-danger">
                        {d.error_message}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3">
            {!selectedId ? (
              <div className="rounded-atelier border border-border bg-canvas p-4 text-sm text-subtext">
                请选择左侧导入记录以查看详情。
              </div>
            ) : detailLoading ? (
              <div className="rounded-atelier border border-border bg-canvas p-4 text-sm text-subtext">加载详情中…</div>
            ) : detail?.document?.id === selectedId ? (
              <div className="grid gap-3 rounded-atelier border border-border bg-canvas p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{statusDoc?.filename || "import.txt"}</div>
                    <div className="mt-1 text-xs text-subtext">
                      {humanizeStatus(statusDoc?.status ?? detail.document.status)} ·{" "}
                      {Math.max(0, Math.min(100, Math.floor(statusDoc?.progress ?? 0)))}% ·{" "}
                      {statusDoc?.progress_message || ""}
                      {shouldPoll ? " · 自动刷新中…" : ""}
                    </div>
                    {isPollingStalled ? (
                      <div className="mt-2 rounded-atelier border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                        该导入已超过 5
                        分钟未更新进度，可能卡住。建议：先取消自动刷新，再尝试重试或稍后回到此页查看结果。
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {pollPaused && (pollStatus === "queued" || pollStatus === "running") ? (
                      <button className="btn btn-secondary" onClick={() => setPollPaused(false)} type="button">
                        恢复自动刷新
                      </button>
                    ) : shouldPoll ? (
                      <button className="btn btn-secondary" onClick={() => setPollPaused(true)} type="button">
                        取消自动刷新
                      </button>
                    ) : null}
                    {selectedDoc?.status === "failed" || isPollingStalled ? (
                      <button className="btn btn-secondary" onClick={() => void retryImport(selectedId)} type="button">
                        重试
                      </button>
                    ) : null}
                    <button
                      className="btn btn-secondary"
                      onClick={() => void selectDocAndLoad(selectedId)}
                      type="button"
                    >
                      刷新
                    </button>
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="text-xs text-subtext">内容预览</div>
                  <div className="whitespace-pre-wrap rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                    {detail.content_preview || "（空）"}
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-subtext">Chunks（{statusDoc?.chunk_count ?? 0}）</div>
                    <button
                      className="btn btn-secondary"
                      disabled={chunksLoading}
                      onClick={() => void loadChunks()}
                      type="button"
                    >
                      {chunksLoading ? "加载中…" : "加载 chunks"}
                    </button>
                  </div>
                  {chunks.length ? (
                    <div className="grid gap-2">
                      {chunks.slice(0, 40).map((c) => (
                        <div key={c.id} className="rounded-atelier border border-border bg-surface p-3">
                          <div className="text-xs text-subtext">#{c.chunk_index}</div>
                          <div className="mt-1 whitespace-pre-wrap text-xs text-ink">{c.preview}</div>
                        </div>
                      ))}
                      {chunks.length > 40 ? <div className="text-xs text-subtext">仅展示前 40 条。</div> : null}
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className="btn btn-primary"
                      disabled={applyWorldbookLoading}
                      onClick={() => void applyWorldbook()}
                      type="button"
                    >
                      {applyWorldbookLoading ? "应用中…" : "应用到 WorldBook"}
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={applyStoryMemoryLoading}
                      onClick={() => void applyStoryMemory()}
                      type="button"
                    >
                      {applyStoryMemoryLoading ? "应用中…" : "应用到 story_memory"}
                    </button>
                  </div>
                  <div className="text-xs text-subtext">
                    世界书（worldbook）：写入 WorldBookEntry（应用后在「世界书」页可见）。故事记忆（story_memory）：写入
                    StoryMemory （应用后在记忆预览/检索中可命中）。
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="text-xs text-subtext">WorldBook 提案预览</div>
                  <div className="rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                    <div>{proposalPreview.worldbook.summary}</div>
                    {proposalPreview.worldbook.sampleTitles.length ? (
                      <div className="mt-1 text-subtext">示例：{proposalPreview.worldbook.sampleTitles.join("、")}</div>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="text-xs text-subtext">story_memory 提案预览</div>
                  <div className="rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                    <div>{proposalPreview.storyMemory.summary}</div>
                    {proposalPreview.storyMemory.sampleTitles.length ? (
                      <div className="mt-1 text-subtext">
                        示例：{proposalPreview.storyMemory.sampleTitles.join("、")}
                      </div>
                    ) : null}
                  </div>
                </div>

                <DebugDetails title="WorldBook 提案 (JSON)">
                  <pre className="overflow-auto whitespace-pre-wrap text-xs text-subtext">
                    {safeStringify(detail.worldbook_proposal)}
                  </pre>
                </DebugDetails>
                <DebugDetails title="story_memory 提案 (JSON)">
                  <pre className="overflow-auto whitespace-pre-wrap text-xs text-subtext">
                    {safeStringify(detail.story_memory_proposal)}
                  </pre>
                </DebugDetails>
                <DebugDetails title="向量写入结果 (JSON)">
                  <pre className="overflow-auto whitespace-pre-wrap text-xs text-subtext">
                    {safeStringify(detail.vector_ingest_result)}
                  </pre>
                </DebugDetails>
              </div>
            ) : (
              <div className="rounded-atelier border border-border bg-canvas p-4 text-sm text-subtext">
                未找到导入详情，请点击左侧重试加载。
              </div>
            )}
          </div>
        </div>
      </section>
    </DebugPageShell>
  );
}
