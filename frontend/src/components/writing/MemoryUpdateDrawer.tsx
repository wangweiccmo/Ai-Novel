import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { UI_COPY } from "../../lib/uiCopy";
import { ApiError, apiJson } from "../../services/apiClient";
import { Drawer } from "../ui/Drawer";
import { useToast } from "../ui/toast";

type Props = {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  chapterId?: string;
};

type MemoryChangeSet = {
  id: string;
  project_id: string;
  actor_user_id?: string | null;
  generation_run_id?: string | null;
  request_id?: string | null;
  idempotency_key: string;
  title?: string | null;
  summary_md?: string | null;
  status: string;
  created_at?: string | null;
  applied_at?: string | null;
  rolled_back_at?: string | null;
};

type MemoryChangeSetItem = {
  id: string;
  item_index: number;
  target_table: string;
  target_id?: string | null;
  op: string;
  before_json?: string | null;
  after_json?: string | null;
  evidence_ids_json?: string | null;
};

type ProposeResult = {
  idempotent: boolean;
  change_set: MemoryChangeSet;
  items: MemoryChangeSetItem[];
  conflicts?: Array<{
    item_index?: number;
    target_table?: string;
    target_id?: string | null;
    conflict_type?: string;
    field?: string;
    message?: string;
    existing?: unknown;
    proposed?: unknown;
  }>;
};

type ApplyResult = {
  idempotent: boolean;
  change_set: MemoryChangeSet;
  warnings: Array<{ code?: string; message?: string; item_id?: string }>;
};

type StructuredEntity = {
  id: string;
  entity_type: string;
  name: string;
  deleted_at?: string | null;
};

type StructuredMemory = {
  entities: StructuredEntity[];
  counts?: Record<string, number>;
};

const EXAMPLE_OPS = JSON.stringify(
  [
    {
      op: "upsert",
      target_table: "entities",
      after: { entity_type: "character", name: "Alice", summary_md: "主角", attributes: { age: 18 } },
    },
  ],
  null,
  2,
);

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const raw = (text || "").trim();
  if (!raw) return { ok: false, error: "请输入 JSON" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON 解析失败" };
  }
}

function toOpsPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const ops = (value as Record<string, unknown>).ops;
    if (Array.isArray(ops)) return ops;
  }
  return [];
}

function humanStatus(status: string): string {
  if (status === "proposed") return "未应用（Proposed）";
  if (status === "applied") return "已应用（Applied）";
  if (status === "rolled_back") return "已回滚（Rolled Back）";
  if (status === "failed") return "失败（Failed）";
  return status || "未知";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function removeIdField(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const o = { ...(value as Record<string, unknown>) };
  delete o.id;
  return o;
}

function safeParseJsonField(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function MemoryUpdateDrawer(props: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const { chapterId, onClose, open, projectId } = props;
  const titleId = useId();
  const copy = UI_COPY.writing.memoryUpdateDrawer;
  const [inputJson, setInputJson] = useState(EXAMPLE_OPS);
  const [autoFocus, setAutoFocus] = useState("");

  const [proposeLoading, setProposeLoading] = useState(false);
  const [proposeError, setProposeError] = useState<ApiError | null>(null);
  const [proposeResult, setProposeResult] = useState<ProposeResult | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});

  const [applyLoading, setApplyLoading] = useState(false);
  const [applyError, setApplyError] = useState<ApiError | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [lastApplyChangeSetId, setLastApplyChangeSetId] = useState<string | null>(null);

  const [structuredLoading, setStructuredLoading] = useState(false);
  const [structuredError, setStructuredError] = useState<ApiError | null>(null);
  const [structured, setStructured] = useState<StructuredMemory | null>(null);

  useEffect(() => {
    if (!open) return;
    setProposeError(null);
    setApplyError(null);
    setStructuredError(null);
  }, [open]);

  useEffect(() => {
    if (!proposeResult) return;
    const next: Record<string, boolean> = {};
    for (const item of proposeResult.items ?? []) next[item.id] = true;
    setAccepted(next);
  }, [proposeResult]);

  const groups = useMemo(() => {
    const items = proposeResult?.items ?? [];
    const out = new Map<string, MemoryChangeSetItem[]>();
    for (const item of items) {
      const key = item.target_table || "unknown";
      const list = out.get(key) ?? [];
      list.push(item);
      out.set(key, list);
    }
    return Array.from(out.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [proposeResult]);

  const runPropose = useCallback(async () => {
    if (!chapterId) {
      toast.toastError("请先选择章节");
      return;
    }
    setProposeLoading(true);
    setProposeError(null);
    setApplyResult(null);
    setApplyError(null);
    try {
      const parsed = safeJsonParse(inputJson);
      if (!parsed.ok)
        throw new ApiError({ code: "INVALID_JSON", message: parsed.error, requestId: "local", status: 0 });
      const ops = toOpsPayload(parsed.value);
      if (!ops.length)
        throw new ApiError({
          code: "INVALID_OPS",
          message: "JSON 必须是 ops 数组或包含 ops 字段",
          requestId: "local",
          status: 0,
        });

      const idempotencyKey = `memupd-${crypto.randomUUID().slice(0, 12)}`;
      const req = {
        schema_version: "memory_update_v1",
        idempotency_key: idempotencyKey,
        title: "Memory Update (review)",
        ops,
      };

      const res = await apiJson<ProposeResult>(`/api/chapters/${chapterId}/memory/propose`, {
        method: "POST",
        body: JSON.stringify(req),
      });
      setProposeResult(res.data);
      toast.toastSuccess("已生成提议");
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      setProposeError(err);
    } finally {
      setProposeLoading(false);
    }
  }, [chapterId, inputJson, toast]);

  const runAutoPropose = useCallback(async () => {
    if (!chapterId) {
      toast.toastError("请先选择章节");
      return;
    }
    setProposeLoading(true);
    setProposeError(null);
    setApplyResult(null);
    setApplyError(null);
    try {
      const idempotencyKey = `memupd-auto-${crypto.randomUUID().slice(0, 12)}`;
      const res = await apiJson<ProposeResult>(`/api/chapters/${chapterId}/memory/propose/auto`, {
        method: "POST",
        body: JSON.stringify({ idempotency_key: idempotencyKey, focus: autoFocus.trim() || null }),
      });
      setProposeResult(res.data);
      toast.toastSuccess("已生成提议（自动）");
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      setProposeError(err);
    } finally {
      setProposeLoading(false);
    }
  }, [autoFocus, chapterId, toast]);

  const runApplyAccepted = useCallback(async () => {
    if (!chapterId) {
      toast.toastError("请先选择章节");
      return;
    }
    if (!proposeResult) {
      toast.toastError("请先生成提议（Propose）");
      return;
    }
    const acceptedItems = (proposeResult.items ?? []).filter((item) => accepted[item.id] !== false);
    if (!acceptedItems.length) {
      toast.toastError("没有可应用的条目（全部已拒绝）");
      return;
    }

    setApplyLoading(true);
    setApplyError(null);
    try {
      const ops = acceptedItems.map((item) => {
        const evidenceIds = safeParseJsonField(item.evidence_ids_json);
        if (item.op === "delete") {
          const base: Record<string, unknown> = {
            op: "delete",
            target_table: item.target_table,
            target_id: item.target_id,
          };
          if (Array.isArray(evidenceIds) && evidenceIds.length) base.evidence_ids = evidenceIds;
          return base;
        }
        const afterRaw = safeParseJsonField(item.after_json);
        const after = removeIdField(afterRaw);
        const base: Record<string, unknown> = {
          op: "upsert",
          target_table: item.target_table,
          target_id: item.target_id,
          after,
        };
        if (Array.isArray(evidenceIds) && evidenceIds.length) base.evidence_ids = evidenceIds;
        return base;
      });

      const idempotencyKey = `memupd-${crypto.randomUUID().slice(0, 12)}`;
      const proposeReq = {
        schema_version: "memory_update_v1",
        idempotency_key: idempotencyKey,
        title: "Memory Update (applied)",
        ops,
      };
      const proposed = await apiJson<ProposeResult>(`/api/chapters/${chapterId}/memory/propose`, {
        method: "POST",
        body: JSON.stringify(proposeReq),
      });
      const changeSetId = proposed.data?.change_set?.id;
      if (!changeSetId) {
        throw new ApiError({
          code: "BAD_RESPONSE",
          message: "缺少 change_set.id",
          requestId: proposed.request_id,
          status: 200,
        });
      }
      setLastApplyChangeSetId(changeSetId);

      const applied = await apiJson<ApplyResult>(`/api/memory_change_sets/${changeSetId}/apply`, { method: "POST" });
      setApplyResult(applied.data);
      toast.toastSuccess("已应用");
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      setApplyError(err);
    } finally {
      setApplyLoading(false);
    }
  }, [accepted, chapterId, proposeResult, toast]);

  const retryApply = useCallback(async () => {
    if (!lastApplyChangeSetId) {
      toast.toastError("没有可重试的 change_set_id");
      return;
    }
    setApplyLoading(true);
    setApplyError(null);
    try {
      const applied = await apiJson<ApplyResult>(`/api/memory_change_sets/${lastApplyChangeSetId}/apply`, {
        method: "POST",
      });
      setApplyResult(applied.data);
      toast.toastSuccess("已应用（重试）");
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      setApplyError(err);
    } finally {
      setApplyLoading(false);
    }
  }, [lastApplyChangeSetId, toast]);

  const refreshStructured = useCallback(async () => {
    if (!projectId) {
      toast.toastError("缺少 projectId");
      return;
    }
    setStructuredLoading(true);
    setStructuredError(null);
    try {
      const res = await apiJson<StructuredMemory>(`/api/projects/${projectId}/memory/structured`, {
        method: "GET",
      });
      setStructured(res.data);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      setStructuredError(err);
    } finally {
      setStructuredLoading(false);
    }
  }, [projectId, toast]);

  const openTaskCenter = useCallback(() => {
    if (!projectId) return;
    const qs = new URLSearchParams();
    if (chapterId) qs.set("chapterId", chapterId);
    navigate(`/projects/${projectId}/tasks${qs.toString() ? `?${qs.toString()}` : ""}`);
    onClose();
  }, [chapterId, navigate, onClose, projectId]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      ariaLabelledBy={titleId}
      panelClassName="h-full w-full max-w-[860px] overflow-hidden border-l border-border bg-surface shadow-sm"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm text-ink" id={titleId}>
              {copy.title}
            </div>
            <div className="mt-0.5 truncate text-xs text-subtext">{copy.subtitle}</div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-secondary" disabled={!projectId} onClick={openTaskCenter} type="button">
              任务中心
            </button>
            <button className="btn btn-secondary" aria-label="关闭" onClick={onClose} type="button">
              关闭
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <div className="grid gap-3">
            <div className="rounded-atelier border border-border bg-surface p-3">
              <div className="text-sm text-ink">{copy.step1}</div>
              <div className="mt-1 text-xs text-subtext">{copy.inputTitle}</div>
              <div className="mt-0.5 text-xs text-subtext">{copy.inputHint}</div>
              <div className="mt-1 text-[11px] text-subtext">{copy.step1Hint}</div>
              <label className="mt-2 block text-xs text-subtext">
                {copy.focusLabel}
                <input
                  className="input mt-1 w-full"
                  aria-label="memory_update_focus"
                  name="memory_update_focus"
                  value={autoFocus}
                  onChange={(e) => setAutoFocus(e.target.value)}
                  placeholder={copy.focusPlaceholder}
                />
              </label>
              <label className="mt-2 block text-xs text-subtext">
                {copy.jsonLabel}
                <textarea
                  className="textarea mt-1 min-h-40 w-full font-mono text-xs"
                  aria-label="memory_update_json"
                  name="memory_update_json"
                  value={inputJson}
                  onChange={(e) => setInputJson(e.target.value)}
                />
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-primary"
                  onClick={() => void runAutoPropose()}
                  disabled={proposeLoading}
                  type="button"
                >
                  {proposeLoading ? copy.proposing : copy.autoPropose}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => void runPropose()}
                  disabled={proposeLoading}
                  type="button"
                >
                  {proposeLoading ? copy.proposing : copy.propose}
                </button>
              </div>

              {proposeError ? (
                <div className="mt-3 rounded-atelier border border-border bg-surface p-3 text-xs text-subtext">
                  <div className="text-ink">{copy.proposeFailed}</div>
                  <div className="mt-1">
                    {proposeError.message} ({proposeError.code}){" "}
                    {proposeError.requestId ? `| request_id: ${proposeError.requestId}` : ""}
                  </div>
                </div>
              ) : null}
            </div>

            {proposeResult ? (
              <div className="rounded-atelier border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-ink">{copy.step2}</div>
                  <div className="text-xs text-subtext">
                    {copy.reviewTitle} | 状态：{humanStatus(proposeResult.change_set.status)} | 条目：
                    {proposeResult.items.length}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-subtext">{copy.step2Hint}</div>
                <div className="mt-1 text-xs text-subtext">
                  change_set_id: {proposeResult.change_set.id}{" "}
                  {proposeResult.change_set.request_id ? `| request_id: ${proposeResult.change_set.request_id}` : ""}
                </div>

                {proposeResult.conflicts && proposeResult.conflicts.length ? (
                  <details className="mt-2 rounded-atelier border border-border bg-surface p-2">
                    <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                      发现冲突 {proposeResult.conflicts.length} 条（点击查看）
                    </summary>
                    <pre className="mt-2 max-h-56 overflow-auto rounded-atelier border border-border bg-surface p-2 text-[11px] text-ink">
                      {safeJsonStringify(proposeResult.conflicts)}
                    </pre>
                    <div className="mt-1 text-[11px] text-subtext">
                      提示：冲突不会阻止提案，但建议先核对再应用。
                    </div>
                  </details>
                ) : null}

                <div className="mt-3 grid gap-2">
                  {groups.map(([table, items]) => (
                    <details key={table} open className="rounded-atelier border border-border bg-surface p-2">
                      <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                        {table}（{items.length}）
                      </summary>
                      <div className="mt-2 grid gap-2">
                        {items.map((item) => {
                          const before = safeParseJsonField(item.before_json);
                          const after = safeParseJsonField(item.after_json);
                          return (
                            <div key={item.id} className="rounded-atelier border border-border bg-surface p-2 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <label className="flex items-center gap-2 text-ink">
                                  <input
                                    className="checkbox"
                                    type="checkbox"
                                    checked={accepted[item.id] !== false}
                                    onChange={(e) => setAccepted((prev) => ({ ...prev, [item.id]: e.target.checked }))}
                                  />
                                  {copy.accept}
                                </label>
                                <div className="text-subtext">
                                  #{item.item_index} {item.op} {item.target_table}{" "}
                                  {item.target_id ? `| ${item.target_id}` : ""}
                                </div>
                              </div>

                              <details className="mt-2">
                                <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                                  {copy.diffPreview}
                                </summary>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                  <div>
                                    <div className="text-[11px] text-subtext">{copy.before}</div>
                                    <pre className="mt-1 max-h-56 overflow-auto rounded-atelier border border-border bg-surface p-2 text-[11px] text-ink">
                                      {safeJsonStringify(before) || "null"}
                                    </pre>
                                  </div>
                                  <div>
                                    <div className="text-[11px] text-subtext">{copy.after}</div>
                                    <pre className="mt-1 max-h-56 overflow-auto rounded-atelier border border-border bg-surface p-2 text-[11px] text-ink">
                                      {safeJsonStringify(after) || "null"}
                                    </pre>
                                  </div>
                                </div>
                              </details>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="rounded-atelier border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink">{copy.step3}</div>
                {applyResult ? (
                  <div className="text-xs text-subtext">
                    状态：{humanStatus(applyResult.change_set.status)} {applyResult.idempotent ? "（幂等）" : ""}
                  </div>
                ) : null}
              </div>
              <div className="mt-1 text-[11px] text-subtext">{copy.step3Hint}</div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-secondary"
                  onClick={() => void runApplyAccepted()}
                  disabled={applyLoading || !proposeResult}
                  type="button"
                >
                  {applyLoading ? copy.applying : copy.applyAccepted}
                </button>
                {!proposeResult ? <div className="text-xs text-subtext">{copy.missingProposeHint}</div> : null}
              </div>

              {applyError ? (
                <div className="mt-3 rounded-atelier border border-border bg-surface p-3 text-xs text-subtext">
                  <div className="text-ink">{copy.applyFailed}</div>
                  <div className="mt-1">
                    {applyError.message} ({applyError.code}){" "}
                    {applyError.requestId ? `| request_id: ${applyError.requestId}` : ""}
                  </div>
                  {lastApplyChangeSetId ? <div className="mt-1">change_set_id: {lastApplyChangeSetId}</div> : null}
                  <div className="mt-2">
                    <button
                      className="btn btn-secondary"
                      onClick={() => void retryApply()}
                      disabled={applyLoading}
                      type="button"
                    >
                      {copy.retryApply}
                    </button>
                  </div>
                </div>
              ) : null}

              {applyResult ? (
                <div className="mt-3">
                  <div className="text-sm text-ink">{copy.applyResultTitle}</div>
                  <div className="mt-1 text-xs text-subtext">change_set_id: {applyResult.change_set.id}</div>
                  {applyResult.warnings?.length ? (
                    <details className="mt-2">
                      <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                        {copy.warnings}（{applyResult.warnings.length}）
                      </summary>
                      <pre className="mt-2 max-h-56 overflow-auto rounded-atelier border border-border bg-surface p-2 text-[11px] text-ink">
                        {safeJsonStringify(applyResult.warnings)}
                      </pre>
                    </details>
                  ) : (
                    <div className="mt-2 text-xs text-subtext">{copy.warningsZero}</div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="rounded-atelier border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink">结构化记忆（调试）</div>
                <button
                  className="btn btn-secondary"
                  onClick={() => void refreshStructured()}
                  disabled={structuredLoading}
                  type="button"
                >
                  {structuredLoading ? "刷新..." : "刷新"}
                </button>
              </div>

              {structuredError ? (
                <div className="mt-2 text-xs text-subtext">
                  {structuredError.message} ({structuredError.code}) | request_id: {structuredError.requestId}
                </div>
              ) : null}

              {structured ? (
                <div className="mt-2">
                  <div className="text-xs text-subtext">
                    counts:{" "}
                    {structured.counts
                      ? Object.entries(structured.counts)
                          .map(([k, v]) => `${k}:${v}`)
                          .join(" | ")
                      : "-"}
                  </div>
                  <div className="mt-2 grid gap-2">
                    {(structured.entities ?? []).slice(0, 12).map((e) => (
                      <div key={e.id} className="rounded-atelier border border-border bg-surface p-2 text-xs">
                        <div className="text-ink">
                          {e.entity_type}:{e.name}
                        </div>
                        <div className="mt-1 text-subtext">
                          {e.deleted_at ? `deleted_at: ${e.deleted_at}` : "active"}
                        </div>
                      </div>
                    ))}
                    {(structured.entities ?? []).length === 0 ? (
                      <div className="text-xs text-subtext">entities: 0</div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-xs text-subtext">提示：应用后点“刷新”确认结构化事实已落库。</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
