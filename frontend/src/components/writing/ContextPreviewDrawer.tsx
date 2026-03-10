import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { UI_COPY } from "../../lib/uiCopy";
import { ApiError, apiJson } from "../../services/apiClient";
import { Drawer } from "../ui/Drawer";
import { useToast } from "../ui/toast";
import type { MemoryContextPack } from "./types";
import { VectorRagDebugPanel } from "./contextPreview/VectorRagDebugPanel";
import { WorldbookPreviewPanel } from "./contextPreview/WorldbookPreviewPanel";
import { useVectorRagQuery } from "./contextPreview/useVectorRagQuery";
import { downloadJson, writeClipboardText } from "./contextPreview/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  memoryInjectionEnabled: boolean;
  onChangeMemoryInjectionEnabled?: (enabled: boolean) => void;
  genInstruction?: string;
  genChapterPlan?: string;
  genMemoryQueryText?: string;
  genMemoryModules?: {
    worldbook: boolean;
    story_memory: boolean;
    semantic_history?: boolean;
    foreshadow_open_loops?: boolean;
    structured: boolean;
    tables?: boolean;
    vector_rag: boolean;
    graph: boolean;
    fractal: boolean;
  };
};

type MemoryContextPackLogItem = {
  section: string;
  enabled: boolean;
  disabled_reason: string | null;
  note: string | null;
};

type MemorySectionEnabled = {
  worldbook: boolean;
  story_memory: boolean;
  semantic_history: boolean;
  foreshadow_open_loops: boolean;
  structured: boolean;
  tables: boolean;
  vector_rag: boolean;
  graph: boolean;
  fractal: boolean;
};

type ContextOptimizerBlockLog = {
  identifier: string;
  changed: boolean;
  before_tokens: number;
  after_tokens: number;
  before_chars: number;
  after_chars: number;
  details: unknown;
};

type ContextOptimizerLog = {
  enabled: boolean;
  saved_tokens_estimate: number;
  blocks: ContextOptimizerBlockLog[];
};

type OptimizerCompare = {
  baseline: { worldbook: string; structured: string };
  optimized: { worldbook: string; structured: string };
  optimizerLog: ContextOptimizerLog | null;
};

const DEFAULT_PREVIEW_SECTIONS: MemorySectionEnabled = {
  worldbook: true,
  story_memory: true,
  semantic_history: false,
  foreshadow_open_loops: false,
  structured: true,
  tables: true,
  vector_rag: true,
  graph: true,
  fractal: true,
};

const DEFAULT_BUDGET_INPUTS: Record<string, string> = {
  worldbook: "",
  story_memory: "",
  semantic_history: "",
  foreshadow_open_loops: "",
  structured: "",
  tables: "",
  vector_rag: "",
  graph: "",
  fractal: "",
};

const EMPTY_PACK: MemoryContextPack = {
  worldbook: {},
  story_memory: {},
  semantic_history: {},
  foreshadow_open_loops: {},
  structured: {},
  tables: {},
  vector_rag: {},
  graph: {},
  fractal: {},
  logs: [],
};

function hasOwn<K extends string>(obj: unknown, key: K): obj is Record<K, unknown> {
  return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeContextOptimizerLog(renderLog: unknown): ContextOptimizerLog | null {
  if (!renderLog || typeof renderLog !== "object") return null;
  const o = renderLog as Record<string, unknown>;
  const ctx = o.context_optimizer;
  if (!ctx || typeof ctx !== "object") return null;
  const c = ctx as Record<string, unknown>;
  const savedRaw = c.saved_tokens_estimate;
  const saved = typeof savedRaw === "number" ? savedRaw : Number(savedRaw);
  const blocksRaw = Array.isArray(c.blocks) ? c.blocks : [];
  const blocks: ContextOptimizerBlockLog[] = [];
  for (const b of blocksRaw) {
    if (!b || typeof b !== "object") continue;
    const it = b as Record<string, unknown>;
    const identifier = typeof it.identifier === "string" ? it.identifier : "";
    if (!identifier) continue;
    const beforeTokensRaw = it.before_tokens;
    const afterTokensRaw = it.after_tokens;
    const beforeCharsRaw = it.before_chars;
    const afterCharsRaw = it.after_chars;
    const beforeTokens = typeof beforeTokensRaw === "number" ? beforeTokensRaw : Number(beforeTokensRaw);
    const afterTokens = typeof afterTokensRaw === "number" ? afterTokensRaw : Number(afterTokensRaw);
    const beforeChars = typeof beforeCharsRaw === "number" ? beforeCharsRaw : Number(beforeCharsRaw);
    const afterChars = typeof afterCharsRaw === "number" ? afterCharsRaw : Number(afterCharsRaw);
    blocks.push({
      identifier,
      changed: Boolean(it.changed),
      before_tokens: Number.isFinite(beforeTokens) ? beforeTokens : 0,
      after_tokens: Number.isFinite(afterTokens) ? afterTokens : 0,
      before_chars: Number.isFinite(beforeChars) ? beforeChars : 0,
      after_chars: Number.isFinite(afterChars) ? afterChars : 0,
      details: hasOwn(it, "details") ? it.details : null,
    });
  }

  return {
    enabled: Boolean(c.enabled),
    saved_tokens_estimate: Number.isFinite(saved) ? saved : 0,
    blocks,
  };
}

function getPromptPreviewBlockText(preview: unknown, identifier: string): string {
  if (!preview || typeof preview !== "object") return "";
  const o = preview as Record<string, unknown>;
  const blocks = Array.isArray(o.blocks) ? o.blocks : [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const it = b as Record<string, unknown>;
    if (typeof it.identifier !== "string") continue;
    if (it.identifier !== identifier) continue;
    return typeof it.text === "string" ? it.text : "";
  }
  return "";
}

function formatContextOptimizerDetails(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const o = details as Record<string, unknown>;
  const changed = Boolean(o.changed);
  const reason = typeof o.reason === "string" ? o.reason : null;
  if (!changed && reason) return reason;

  const entriesInRaw = o.entries_in;
  const rowsOutRaw = o.rows_out;
  const entriesIn = typeof entriesInRaw === "number" ? entriesInRaw : Number(entriesInRaw);
  const rowsOut = typeof rowsOutRaw === "number" ? rowsOutRaw : Number(rowsOutRaw);
  if (Number.isFinite(entriesIn) && Number.isFinite(rowsOut)) {
    const parsedRaw = o.entries_parsed;
    const parsed = typeof parsedRaw === "number" ? parsedRaw : Number(parsedRaw);
    return `entries:${entriesIn} → rows:${rowsOut}` + (Number.isFinite(parsed) ? ` | parsed:${parsed}` : "");
  }

  const sectionsRaw = o.sections;
  if (Array.isArray(sectionsRaw)) {
    let sections = 0;
    let itemsIn = 0;
    let rowsOut = 0;
    for (const s of sectionsRaw) {
      if (!s || typeof s !== "object") continue;
      const it = s as Record<string, unknown>;
      const itemsInRaw = it.items_in;
      const rowsOutRaw2 = it.rows_out;
      const itemsInNum = typeof itemsInRaw === "number" ? itemsInRaw : Number(itemsInRaw);
      const rowsOutNum = typeof rowsOutRaw2 === "number" ? rowsOutRaw2 : Number(rowsOutRaw2);
      if (Number.isFinite(itemsInNum)) itemsIn += itemsInNum;
      if (Number.isFinite(rowsOutNum)) rowsOut += rowsOutNum;
      sections++;
    }
    if (sections > 0) return `sections:${sections} | items:${itemsIn} → rows:${rowsOut}`;
  }

  return null;
}

function normalizePackLogItem(raw: unknown): MemoryContextPackLogItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const section = typeof o.section === "string" ? o.section : "";
  const enabled = typeof o.enabled === "boolean" ? o.enabled : Boolean(o.enabled);
  if (!section) return null;
  return {
    section,
    enabled,
    disabled_reason: typeof o.disabled_reason === "string" ? o.disabled_reason : null,
    note: typeof o.note === "string" ? o.note : null,
  };
}

export function ContextPreviewDrawer(props: Props) {
  const {
    onClose,
    open,
    projectId,
    memoryInjectionEnabled,
    onChangeMemoryInjectionEnabled,
    genInstruction,
    genChapterPlan,
    genMemoryQueryText,
    genMemoryModules,
  } = props;
  const titleId = useId();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [pack, setPack] = useState<MemoryContextPack>(EMPTY_PACK);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string } | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [contextOptimizerEnabled, setContextOptimizerEnabled] = useState<boolean | null>(null);
  const [contextOptimizerSettingsLoading, setContextOptimizerSettingsLoading] = useState(false);
  const [contextOptimizerSettingsError, setContextOptimizerSettingsError] = useState<{
    code: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [optimizerCompareLoading, setOptimizerCompareLoading] = useState(false);
  const [optimizerCompareError, setOptimizerCompareError] = useState<{
    code: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [optimizerCompare, setOptimizerCompare] = useState<OptimizerCompare | null>(null);
  const lastOptimizerCompareKeyRef = useRef<string | null>(null);

  const syncedOnceRef = useRef(false);

  const [previewQueryText, setPreviewQueryText] = useState("");
  const [previewSections, setPreviewSections] = useState<MemorySectionEnabled>(DEFAULT_PREVIEW_SECTIONS);
  const [budgetOverrideInputs, setBudgetOverrideInputs] = useState<Record<string, string>>(DEFAULT_BUDGET_INPUTS);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  const vector = useVectorRagQuery({ open, projectId, toast });

  const effectivePack = useMemo(() => (memoryInjectionEnabled ? pack : EMPTY_PACK), [memoryInjectionEnabled, pack]);

  const parsedBudgetOverrides = useMemo(() => {
    const out: Record<string, number> = {};
    for (const key of [
      "worldbook",
      "story_memory",
      "semantic_history",
      "foreshadow_open_loops",
      "structured",
      "tables",
      "vector_rag",
      "graph",
      "fractal",
    ] as const) {
      const raw = String(budgetOverrideInputs[key] ?? "").trim();
      if (!raw) continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) continue;
      out[key] = Math.floor(parsed);
    }
    return out;
  }, [budgetOverrideInputs]);

  const downloadPreviewBundle = useCallback(() => {
    if (!projectId) {
      toast.toastError(UI_COPY.writing.contextPreviewMissingProjectId);
      return;
    }
    try {
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const hint = requestId || stamp;
      const filename = `context_preview_bundle_${projectId}_${hint}.json`;
      downloadJson(filename, {
        schema_version: "context_preview_bundle_v1",
        created_at: new Date().toISOString(),
        project_id: projectId,
        request_id: requestId,
        synced_at: syncedAt,
        preview: {
          query_text: previewQueryText,
          sections: previewSections,
          budget_overrides: parsedBudgetOverrides,
          budget_override_inputs: budgetOverrideInputs,
          memory_injection_enabled: memoryInjectionEnabled,
        },
        pack: effectivePack ?? EMPTY_PACK,
        vector_query: {
          request_id: vector.vectorRequestId,
          query_text: vector.vectorQueryText,
          sources: vector.selectedVectorSources,
          raw_query_text: vector.vectorRawQueryText,
          normalized_query_text: vector.vectorNormalizedQueryText,
          preprocess_obs: vector.vectorPreprocessObs,
          result: vector.vectorResult,
        },
        generate: {
          instruction: genInstruction ?? null,
          chapter_plan: genChapterPlan ?? null,
          memory_query_text: genMemoryQueryText ?? null,
          memory_modules: genMemoryModules ?? null,
        },
      });
      toast.toastSuccess("已导出预览 bundle", requestId ?? undefined);
    } catch {
      toast.toastError("导出失败");
    }
  }, [
    budgetOverrideInputs,
    effectivePack,
    genChapterPlan,
    genInstruction,
    genMemoryModules,
    genMemoryQueryText,
    memoryInjectionEnabled,
    parsedBudgetOverrides,
    previewQueryText,
    previewSections,
    projectId,
    requestId,
    syncedAt,
    toast,
    vector.selectedVectorSources,
    vector.vectorNormalizedQueryText,
    vector.vectorPreprocessObs,
    vector.vectorQueryText,
    vector.vectorRawQueryText,
    vector.vectorRequestId,
    vector.vectorResult,
  ]);

  const computeEffectiveQueryTextFromGenerate = useCallback((): string => {
    const requested = String(genMemoryQueryText ?? "").trim();
    if (requested) return requested;

    const instruction = String(genInstruction ?? "").trim();
    const plan = String(genChapterPlan ?? "").trim();
    if (!instruction && !plan) return "";
    return plan ? `${instruction}\n\n${plan}`.trim() : instruction;
  }, [genChapterPlan, genInstruction, genMemoryQueryText]);

  const isEmptyPack = useMemo(() => {
    const getTextMd = (raw: unknown): string => {
      if (!raw || typeof raw !== "object") return "";
      const o = raw as Record<string, unknown>;
      return typeof o.text_md === "string" ? o.text_md.trim() : "";
    };
    return (
      !getTextMd(effectivePack.worldbook) &&
      !getTextMd(effectivePack.story_memory) &&
      !getTextMd(effectivePack.semantic_history) &&
      !getTextMd(effectivePack.foreshadow_open_loops) &&
      !getTextMd(effectivePack.structured) &&
      !getTextMd(effectivePack.tables) &&
      !getTextMd(effectivePack.vector_rag) &&
      !getTextMd(effectivePack.graph) &&
      !getTextMd(effectivePack.fractal)
    );
  }, [effectivePack]);

  const packLogs = useMemo(() => {
    const rawLogs = Array.isArray(effectivePack.logs) ? effectivePack.logs : [];
    return rawLogs.map(normalizePackLogItem).filter((v): v is MemoryContextPackLogItem => Boolean(v));
  }, [effectivePack.logs]);

  const packLogStats = useMemo(() => {
    const enabledCount = packLogs.filter((it) => it.enabled).length;
    return { enabledCount, disabledCount: packLogs.length - enabledCount };
  }, [packLogs]);

  const memoryConfidence = useMemo(() => {
    if (!memoryInjectionEnabled) return { score: 0, level: "关闭", filled: 0, total: 0 };
    const getTextMd = (raw: unknown): string => {
      if (!raw || typeof raw !== "object") return "";
      const o = raw as Record<string, unknown>;
      return typeof o.text_md === "string" ? o.text_md.trim() : "";
    };
    const sections = [
      effectivePack.worldbook,
      effectivePack.story_memory,
      effectivePack.semantic_history,
      effectivePack.foreshadow_open_loops,
      effectivePack.structured,
      effectivePack.tables,
      effectivePack.vector_rag,
      effectivePack.graph,
      effectivePack.fractal,
    ];
    const total = sections.length;
    const filled = sections.filter((s) => getTextMd(s)).length;
    const score = total > 0 ? Math.round((filled / total) * 100) : 0;
    const level = score >= 70 ? "高" : score >= 40 ? "中" : "低";
    return { score, level, filled, total };
  }, [effectivePack, memoryInjectionEnabled]);

  const loadContextOptimizerSetting = useCallback(async () => {
    if (!projectId) return;
    setContextOptimizerSettingsLoading(true);
    setContextOptimizerSettingsError(null);
    try {
      const res = await apiJson<{ settings: { context_optimizer_enabled?: unknown } }>(
        `/api/projects/${projectId}/settings`,
      );
      setContextOptimizerEnabled(Boolean(res.data?.settings?.context_optimizer_enabled));
    } catch (e) {
      if (e instanceof ApiError) {
        setContextOptimizerSettingsError({ code: e.code, message: e.message, requestId: e.requestId });
      } else {
        setContextOptimizerSettingsError({ code: "UNKNOWN", message: "加载失败" });
      }
      setContextOptimizerEnabled(null);
    } finally {
      setContextOptimizerSettingsLoading(false);
    }
  }, [projectId]);

  const fetchOptimizerCompare = useCallback(async () => {
    if (!projectId) return;
    if (!memoryInjectionEnabled) return;

    const values: Record<string, unknown> = {
      memory: effectivePack,
      memory_injection_enabled: Boolean(memoryInjectionEnabled),
    };

    setOptimizerCompareLoading(true);
    setOptimizerCompareError(null);
    try {
      const baselineRes = await apiJson<{ preview: unknown; render_log?: unknown }>(
        `/api/projects/${projectId}/prompt_preview`,
        {
          method: "POST",
          body: JSON.stringify({ task: "chapter_generate", values: { ...values, context_optimizer_enabled: false } }),
        },
      );
      const optimizedRes = await apiJson<{ preview: unknown; render_log?: unknown }>(
        `/api/projects/${projectId}/prompt_preview`,
        {
          method: "POST",
          body: JSON.stringify({ task: "chapter_generate", values: { ...values, context_optimizer_enabled: true } }),
        },
      );

      const baselinePreview = baselineRes.data?.preview;
      const optimizedPreview = optimizedRes.data?.preview;
      const optimizerLog = normalizeContextOptimizerLog(optimizedRes.data?.render_log ?? null);

      setOptimizerCompare({
        baseline: {
          worldbook: getPromptPreviewBlockText(baselinePreview, "sys.memory.worldbook"),
          structured: getPromptPreviewBlockText(baselinePreview, "sys.memory.structured"),
        },
        optimized: {
          worldbook: getPromptPreviewBlockText(optimizedPreview, "sys.memory.worldbook"),
          structured: getPromptPreviewBlockText(optimizedPreview, "sys.memory.structured"),
        },
        optimizerLog,
      });
    } catch (e) {
      if (e instanceof ApiError) {
        setOptimizerCompareError({ code: e.code, message: e.message, requestId: e.requestId });
      } else {
        setOptimizerCompareError({ code: "UNKNOWN", message: "加载失败" });
      }
      setOptimizerCompare(null);
    } finally {
      setOptimizerCompareLoading(false);
    }
  }, [effectivePack, memoryInjectionEnabled, projectId]);

  const worldbookPreview = useMemo(() => {
    const raw = (effectivePack.worldbook ?? {}) as Record<string, unknown>;
    const triggered = Array.isArray(raw.triggered) ? raw.triggered : [];
    const textMd = typeof raw.text_md === "string" ? raw.text_md : "";
    const truncated = Boolean(raw.truncated);
    return { triggered, textMd, truncated, raw };
  }, [effectivePack.worldbook]);

  const fetchPreview = useCallback(
    async (params: { queryText: string; sections: MemorySectionEnabled; budgets: Record<string, number> }) => {
      if (!projectId) {
        setError({ code: "NO_PROJECT", message: UI_COPY.writing.contextPreviewMissingProjectId });
        return;
      }
      const safeQueryText = String(params.queryText ?? "").slice(0, 5000);
      setLoading(true);
      setError(null);
      try {
        const res = await apiJson<MemoryContextPack>(`/api/projects/${projectId}/memory/preview`, {
          method: "POST",
          body: JSON.stringify({
            query_text: safeQueryText,
            section_enabled: params.sections,
            budget_overrides: params.budgets,
          }),
        });
        setPack(res.data ?? EMPTY_PACK);
        setRequestId(res.request_id ?? null);
      } catch (e) {
        if (e instanceof ApiError) {
          setError({ code: e.code, message: e.message, requestId: e.requestId });
        } else {
          setError({ code: "UNKNOWN", message: "加载失败" });
        }
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  const syncPreviewFromGenerate = useCallback(async () => {
    const queryText = computeEffectiveQueryTextFromGenerate();
    const sections: MemorySectionEnabled = { ...DEFAULT_PREVIEW_SECTIONS, ...(genMemoryModules ?? {}) };
    setPreviewQueryText(queryText);
    setPreviewSections(sections);
    setBudgetOverrideInputs(DEFAULT_BUDGET_INPUTS);
    setSyncedAt(new Date().toISOString().replace("T", " ").slice(0, 19));
    await fetchPreview({ queryText, sections, budgets: {} });
  }, [computeEffectiveQueryTextFromGenerate, fetchPreview, genMemoryModules]);

  const load = useCallback(async () => {
    if (!projectId) {
      setError({ code: "NO_PROJECT", message: UI_COPY.writing.contextPreviewMissingProjectId });
      return;
    }
    await fetchPreview({ queryText: previewQueryText, sections: previewSections, budgets: parsedBudgetOverrides });
  }, [fetchPreview, parsedBudgetOverrides, previewQueryText, previewSections, projectId]);

  useEffect(() => {
    if (!open) return;
    if (!memoryInjectionEnabled) return;
    if (syncedOnceRef.current) return;
    syncedOnceRef.current = true;
    void syncPreviewFromGenerate();
  }, [memoryInjectionEnabled, open, syncPreviewFromGenerate]);

  useEffect(() => {
    if (!open) return;
    void loadContextOptimizerSetting();
  }, [loadContextOptimizerSetting, open]);

  useEffect(() => {
    if (!open) return;
    if (!memoryInjectionEnabled) return;
    if (!contextOptimizerEnabled) {
      lastOptimizerCompareKeyRef.current = null;
      setOptimizerCompare(null);
      setOptimizerCompareError(null);
      setOptimizerCompareLoading(false);
      return;
    }
    const key = `${projectId ?? ""}:${requestId ?? ""}:${contextOptimizerEnabled ? "1" : "0"}`;
    if (!key.trim() || lastOptimizerCompareKeyRef.current === key) return;
    lastOptimizerCompareKeyRef.current = key;
    void fetchOptimizerCompare();
  }, [contextOptimizerEnabled, fetchOptimizerCompare, memoryInjectionEnabled, open, projectId, requestId]);

  useEffect(() => {
    if (open) return;
    syncedOnceRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (memoryInjectionEnabled) return;
    syncedOnceRef.current = false;
    setLoading(false);
    setError(null);
    setPack(EMPTY_PACK);
    setRequestId(null);
  }, [memoryInjectionEnabled, open]);

  useEffect(() => {
    if (!open) return;
    setOptimizerCompare(null);
    setOptimizerCompareError(null);
    setOptimizerCompareLoading(false);
    lastOptimizerCompareKeyRef.current = null;
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      ariaLabelledBy={titleId}
      panelClassName="h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-canvas p-6 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-content text-2xl text-ink" id={titleId}>
            {UI_COPY.writing.contextPreviewTitle}
          </div>
          <div className="mt-1 text-xs text-subtext">
            {UI_COPY.writing.contextPreviewSubtitle}
            {requestId ? <span className="ml-2">request_id: {requestId}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-secondary"
            disabled={!projectId}
            onClick={() => downloadPreviewBundle()}
            type="button"
          >
            下载预览 bundle
          </button>
          <button
            className="btn btn-secondary"
            disabled={loading || !memoryInjectionEnabled || !projectId}
            onClick={() => void load()}
            type="button"
          >
            {UI_COPY.writing.contextPreviewRefresh}
          </button>
          <button className="btn btn-secondary" aria-label="关闭" onClick={onClose} type="button">
            {UI_COPY.writing.contextPreviewClose}
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-atelier border border-border bg-surface p-3 text-[11px] text-subtext">
        <div className="text-xs text-ink">用途</div>
        <div className="mt-1">
          用于预览“生成前可能注入的上下文”与调试信息（WorldBook / RAG / 结构化记忆等），帮助排查“为什么写成这样”。
        </div>
        <div className="mt-2 text-xs text-ink">风险</div>
        <ul className="mt-1 list-disc pl-5">
          <li>页面可能包含隐私/敏感内容：分享/截图前请确认，并避免公开传播</li>
          <li>可用“下载预览 bundle”导出排障材料；按设计不应包含 API Key（分享前仍建议自行快速检索）</li>
        </ul>
      </div>

      <div className="mt-5 grid gap-4">
        <div className="panel p-3">
          <label className="flex items-center justify-between gap-3 text-sm text-ink">
            <span>{UI_COPY.writing.memoryInjectionToggle}</span>
            <input
              className="checkbox"
              checked={memoryInjectionEnabled}
              disabled={!onChangeMemoryInjectionEnabled}
              onChange={(e) => onChangeMemoryInjectionEnabled?.(e.target.checked)}
              type="checkbox"
            />
          </label>
          <div className="mt-1 text-[11px] text-subtext">
            {memoryInjectionEnabled
              ? UI_COPY.writing.memoryInjectionHint
              : UI_COPY.writing.memoryInjectionDisabledPreview}
          </div>
          {memoryInjectionEnabled && packLogs.length ? (
            <div className="mt-2 text-[11px] text-subtext">
              模块状态：已启用 {packLogStats.enabledCount} 项，已禁用 {packLogStats.disabledCount} 项（展开“Pack
              sections”查看原因）。
            </div>
          ) : null}
          {memoryInjectionEnabled ? (
            <div className="mt-1 text-[11px] text-subtext">
              记忆可信度：{memoryConfidence.score}%（{memoryConfidence.level}，{memoryConfidence.filled}/
              {memoryConfidence.total} 模块有内容）
            </div>
          ) : null}
        </div>

        {memoryInjectionEnabled ? (
          <div className="panel p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-ink">预览参数（preview API）</div>
                <div className="mt-1 text-[11px] text-subtext">
                  当前预览应尽量与“AI 生成”抽屉一致；可手动修改后点刷新。
                  {syncedAt ? <span className="ml-2">synced_at: {syncedAt}</span> : null}
                </div>
              </div>
              <button
                className="btn btn-secondary"
                disabled={loading || !projectId}
                onClick={() => void syncPreviewFromGenerate()}
                type="button"
              >
                同步生成设置
              </button>
            </div>

            <div className="mt-4 grid gap-3">
              <label className="text-xs text-subtext">
                memory_query_text（用于 pack 预览）
                <textarea
                  className="textarea mt-1 min-h-24 w-full"
                  name="memory_preview_query_text"
                  value={previewQueryText}
                  placeholder="例如：本章要写的角色/地点/冲突（用于检索相关记忆）"
                  onChange={(e) => setPreviewQueryText(e.target.value)}
                />
              </label>

              <div className="grid gap-2">
                <div className="text-xs text-subtext">modules（section_enabled）</div>
                {(
                  [
                    ["worldbook", "世界书（worldbook）"],
                    ["story_memory", "剧情记忆（story_memory）"],
                    ["semantic_history", "语义历史（semantic_history）"],
                    ["foreshadow_open_loops", "未回收伏笔（foreshadow_open_loops）"],
                    ["structured", "结构化记忆（structured）"],
                    ["tables", "表格系统（tables）"],
                    ["vector_rag", "向量 RAG（vector_rag）"],
                    ["graph", "关系图（graph）"],
                    ["fractal", "Fractal（fractal）"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between gap-3 text-sm text-ink">
                    <span>{label}</span>
                    <input
                      className="checkbox"
                      checked={previewSections[key]}
                      onChange={(e) => setPreviewSections((prev) => ({ ...prev, [key]: e.target.checked }))}
                      type="checkbox"
                    />
                  </label>
                ))}
              </div>

              <details className="rounded-atelier border border-border bg-surface p-3">
                <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                  预算覆盖（budget_overrides，可选）
                </summary>
                <div className="mt-3 grid gap-2">
                  {(
                    [
                      ["worldbook", "worldbook char_limit"],
                      ["story_memory", "story_memory char_limit"],
                      ["semantic_history", "semantic_history char_limit"],
                      ["foreshadow_open_loops", "foreshadow_open_loops char_limit"],
                      ["structured", "structured char_limit"],
                      ["tables", "tables char_limit"],
                      ["vector_rag", "vector_rag char_limit"],
                      ["graph", "graph char_limit"],
                      ["fractal", "fractal char_limit"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="grid gap-1 text-xs text-subtext">
                      <span>{label}</span>
                      <input
                        className="input"
                        inputMode="numeric"
                        placeholder="留空=默认"
                        value={budgetOverrideInputs[key]}
                        onChange={(e) =>
                          setBudgetOverrideInputs((prev) => ({
                            ...prev,
                            [key]: e.currentTarget.value.replace(/[^\d]/g, ""),
                          }))
                        }
                      />
                    </label>
                  ))}
                  <div className="text-[11px] text-subtext">仅影响预览，不会改变实际生成的注入预算。</div>
                </div>
              </details>
            </div>
          </div>
        ) : null}

        {loading ? <div className="text-sm text-subtext">{UI_COPY.common.loading}</div> : null}
        {error ? (
          <div className="rounded-atelier border border-border bg-surface p-3 text-sm text-subtext">
            <div className="text-ink">{UI_COPY.writing.contextPreviewLoadFailedTitle}</div>
            <div className="mt-1 text-xs text-subtext">
              {error.message} ({error.code})
              {error.requestId ? <span className="ml-2">request_id: {error.requestId}</span> : null}
            </div>
          </div>
        ) : null}

        {memoryInjectionEnabled && isEmptyPack ? (
          <div className="text-sm text-subtext">{UI_COPY.writing.memoryPackEmpty}</div>
        ) : null}

        {memoryInjectionEnabled ? (
          <details className="panel p-4">
            <summary className="ui-transition-fast cursor-pointer text-sm text-ink hover:text-ink">
              Pack sections
            </summary>
            {packLogs.length ? (
              <div className="mt-3 grid gap-2">
                {packLogs.map((it) => (
                  <div key={it.section} className="rounded-atelier border border-border bg-surface p-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-ink">{it.section}</span>
                      {it.enabled ? (
                        <span className="text-success">enabled</span>
                      ) : (
                        <span className="text-warning">disabled: {it.disabled_reason ?? "unknown"}</span>
                      )}
                    </div>
                    {it.note ? <div className="mt-1 text-[11px] text-subtext">{it.note}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 text-sm text-subtext">No logs available.</div>
            )}
          </details>
        ) : null}

        {memoryInjectionEnabled ? (
          <details className="panel p-4">
            <summary className="ui-transition-fast cursor-pointer text-sm text-ink hover:text-ink">
              原始数据（JSON）
            </summary>
            <div className="mt-3 text-xs text-subtext">
              建议优先用顶部「下载预览 bundle」导出文件。需要复制粘贴时，可用下方按钮。
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  void (async () => {
                    try {
                      await writeClipboardText(JSON.stringify(effectivePack ?? EMPTY_PACK, null, 2));
                      toast.toastSuccess("已复制 pack JSON");
                    } catch {
                      toast.toastError("复制失败");
                    }
                  })();
                }}
                type="button"
              >
                复制 pack JSON
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  void (async () => {
                    try {
                      await writeClipboardText(
                        JSON.stringify(
                          {
                            query_text: previewQueryText,
                            sections: previewSections,
                            budget_overrides: parsedBudgetOverrides,
                            budget_override_inputs: budgetOverrideInputs,
                            memory_injection_enabled: memoryInjectionEnabled,
                          },
                          null,
                          2,
                        ),
                      );
                      toast.toastSuccess("已复制预览设置 JSON");
                    } catch {
                      toast.toastError("复制失败");
                    }
                  })();
                }}
                type="button"
              >
                复制预览设置 JSON
              </button>
            </div>

            <pre className="mt-3 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
              {JSON.stringify(
                {
                  query_text: previewQueryText,
                  sections: previewSections,
                  budget_overrides: parsedBudgetOverrides,
                  memory_injection_enabled: memoryInjectionEnabled,
                },
                null,
                2,
              )}
            </pre>
          </details>
        ) : null}

        {memoryInjectionEnabled ? (
          <div className="panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-ink">Context Optimizer</div>
              <button
                className="btn btn-ghost px-2 py-1 text-xs"
                disabled={contextOptimizerSettingsLoading}
                onClick={() => void loadContextOptimizerSetting()}
                type="button"
              >
                刷新状态
              </button>
            </div>
            <div className="mt-1 text-[11px] text-subtext">
              status:{" "}
              {contextOptimizerSettingsLoading
                ? "loading…"
                : contextOptimizerEnabled === null
                  ? "unknown"
                  : contextOptimizerEnabled
                    ? "enabled"
                    : "disabled"}
            </div>
            {contextOptimizerSettingsError ? (
              <div className="mt-2 text-xs text-danger">
                settings 加载失败：{contextOptimizerSettingsError.message} ({contextOptimizerSettingsError.code})
                {contextOptimizerSettingsError.requestId ? (
                  <span className="ml-2">request_id: {contextOptimizerSettingsError.requestId}</span>
                ) : null}
              </div>
            ) : null}

            {contextOptimizerEnabled ? (
              <div className="mt-3 grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-subtext">基于后端 prompt_preview 对比（sys.memory.*）</div>
                  <button
                    className="btn btn-ghost px-2 py-1 text-xs"
                    disabled={optimizerCompareLoading}
                    onClick={() => {
                      lastOptimizerCompareKeyRef.current = null;
                      void fetchOptimizerCompare();
                    }}
                    type="button"
                  >
                    刷新对比
                  </button>
                </div>

                {optimizerCompareLoading ? <div className="text-xs text-subtext">{UI_COPY.common.loading}</div> : null}
                {optimizerCompareError ? (
                  <div className="text-xs text-danger">
                    对比失败：{optimizerCompareError.message} ({optimizerCompareError.code})
                    {optimizerCompareError.requestId ? (
                      <span className="ml-2">request_id: {optimizerCompareError.requestId}</span>
                    ) : null}
                  </div>
                ) : null}

                {optimizerCompare?.optimizerLog ? (
                  <div className="rounded-atelier border border-border bg-surface p-3">
                    <div className="text-xs text-ink">
                      saved_tokens_estimate:{" "}
                      <span className="font-mono">{optimizerCompare.optimizerLog.saved_tokens_estimate}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-subtext">
                      changed_blocks:{" "}
                      <span className="font-mono">
                        {optimizerCompare.optimizerLog.blocks.filter((b) => b.changed).length}/
                        {optimizerCompare.optimizerLog.blocks.length}
                      </span>
                    </div>
                    <div className="mt-2 grid gap-2">
                      {optimizerCompare.optimizerLog.blocks.map((b) => (
                        <div key={b.identifier} className="rounded-atelier border border-border bg-surface p-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="font-mono text-ink">{b.identifier}</span>
                            <span className="font-mono text-subtext">
                              {b.before_tokens} → {b.after_tokens}
                            </span>
                          </div>
                          <div className="mt-1 text-[11px] text-subtext">
                            {b.changed ? "changed" : "unchanged"}
                            {formatContextOptimizerDetails(b.details) ? (
                              <span className="ml-2 font-mono">{formatContextOptimizerDetails(b.details)}</span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {optimizerCompare ? (
                  <details className="rounded-atelier border border-border bg-surface p-3">
                    <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                      diff（sys.memory.worldbook / sys.memory.structured）
                    </summary>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <div className="text-[11px] text-subtext">baseline</div>
                        <pre className="mt-1 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                          {`${optimizerCompare.baseline.worldbook || "（worldbook 为空）"}\n\n${optimizerCompare.baseline.structured || "（structured 为空）"}`}
                        </pre>
                      </div>
                      <div>
                        <div className="text-[11px] text-subtext">optimized</div>
                        <pre className="mt-1 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                          {`${optimizerCompare.optimized.worldbook || "（worldbook 为空）"}\n\n${optimizerCompare.optimized.structured || "（structured 为空）"}`}
                        </pre>
                      </div>
                    </div>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="mt-3 text-xs text-subtext">
                未启用时不会执行对比请求。可在 SettingsPage 开启后再查看摘要与 diff。
              </div>
            )}
          </div>
        ) : null}

        {memoryInjectionEnabled ? (
          <div className="panel p-4">
            <div className="text-sm text-ink">Memory text_md</div>
            {(
              ["story_memory", "semantic_history", "foreshadow_open_loops", "structured", "graph", "fractal"] as const
            ).map((key) => {
              const raw = (effectivePack[key] ?? {}) as Record<string, unknown>;
              const textMd = typeof raw.text_md === "string" ? raw.text_md : "";
              return (
                <details key={key} className="mt-3">
                  <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                    {key}.text_md
                  </summary>
                  <div className="mt-2 flex justify-end">
                    <button
                      className="btn btn-ghost px-2 py-1 text-xs"
                      onClick={() => {
                        void (async () => {
                          try {
                            await writeClipboardText(textMd || "");
                            toast.toastSuccess("已复制 text_md");
                          } catch {
                            toast.toastError("复制失败");
                          }
                        })();
                      }}
                      type="button"
                    >
                      复制
                    </button>
                  </div>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                    {textMd || "（空）"}
                  </pre>
                </details>
              );
            })}
          </div>
        ) : null}

        {memoryInjectionEnabled ? (
          <div className="panel p-4">
            {(() => {
              const raw = (effectivePack.tables ?? {}) as Record<string, unknown>;
              const enabled = Boolean(raw.enabled);
              const disabledReason = typeof raw.disabled_reason === "string" ? raw.disabled_reason : null;
              const truncated = Boolean(raw.truncated);
              const textMd = typeof raw.text_md === "string" ? raw.text_md : "";
              const errorCode = typeof raw.error === "string" ? raw.error : null;
              const counts =
                raw.counts && typeof raw.counts === "object" ? (raw.counts as Record<string, unknown>) : {};
              const rawTables = typeof counts.tables === "number" ? counts.tables : Number(counts.tables ?? 0);
              const rawRows = typeof counts.rows === "number" ? counts.rows : Number(counts.rows ?? 0);
              const tablesCount = Number.isFinite(rawTables) ? rawTables : 0;
              const rowsCount = Number.isFinite(rawRows) ? rawRows : 0;

              return (
                <>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="text-sm text-ink">Tables（sys.memory.tables）</div>
                    <div className="text-[11px] text-subtext">
                      {enabled ? "enabled" : `disabled: ${disabledReason ?? "unknown"}`} · tables:{tablesCount} · rows:
                      {rowsCount} · truncated:{truncated ? "true" : "false"}
                    </div>
                  </div>
                  {errorCode ? <div className="mt-2 text-xs text-danger">error: {errorCode}</div> : null}
                  <details className="mt-3">
                    <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                      tables.text_md（最终注入文本）
                    </summary>
                    <div className="mt-2 flex justify-end">
                      <button
                        className="btn btn-ghost px-2 py-1 text-xs"
                        onClick={() => {
                          void (async () => {
                            try {
                              await writeClipboardText(textMd || "");
                              toast.toastSuccess("已复制 tables text_md");
                            } catch {
                              toast.toastError("复制失败");
                            }
                          })();
                        }}
                        type="button"
                      >
                        复制
                      </button>
                    </div>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                      {textMd || "（空）"}
                    </pre>
                  </details>
                </>
              );
            })()}
          </div>
        ) : null}

        {memoryInjectionEnabled ? (
          <div className="panel p-4">
            <div className="text-sm text-ink">Items（semantic_history / foreshadow_open_loops）</div>
            <div className="mt-3 grid gap-3">
              {(["semantic_history", "foreshadow_open_loops"] as const).map((key) => {
                const raw = (effectivePack[key] ?? {}) as Record<string, unknown>;
                const enabled = Boolean(raw.enabled);
                const disabledReason = typeof raw.disabled_reason === "string" ? raw.disabled_reason : null;
                const items = Array.isArray(raw.items) ? raw.items : [];
                return (
                  <details key={key} className="rounded-atelier border border-border bg-surface p-3">
                    <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                      {key}.items ({items.length}){enabled ? "" : ` — disabled:${disabledReason ?? "unknown"}`}
                    </summary>
                    <div className="mt-2 flex justify-end">
                      <button
                        className="btn btn-ghost px-2 py-1 text-xs"
                        onClick={() => {
                          void (async () => {
                            try {
                              await writeClipboardText(JSON.stringify(items, null, 2));
                              toast.toastSuccess("已复制 items JSON");
                            } catch {
                              toast.toastError("复制失败");
                            }
                          })();
                        }}
                        type="button"
                      >
                        复制 JSON
                      </button>
                    </div>
                    {items.length === 0 ? (
                      <div className="mt-2 text-sm text-subtext">（空）</div>
                    ) : (
                      <pre className="mt-2 max-h-64 overflow-auto rounded-atelier border border-border bg-canvas p-3 text-xs text-ink">
                        {JSON.stringify(items, null, 2)}
                      </pre>
                    )}
                  </details>
                );
              })}
            </div>
          </div>
        ) : null}

        {memoryInjectionEnabled ? (
          <WorldbookPreviewPanel effectivePack={effectivePack} worldbookPreview={worldbookPreview} />
        ) : null}

        <VectorRagDebugPanel projectId={projectId} toast={toast} vector={vector} />
      </div>
    </Drawer>
  );
}
