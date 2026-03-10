import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Badge } from "../components/ui/Badge";
import { Drawer } from "../components/ui/Drawer";
import { useConfirm } from "../components/ui/confirm";
import { useToast } from "../components/ui/toast";
import { useProjectData } from "../hooks/useProjectData";
import { humanizeTaskStatus } from "../lib/humanize";
import { containsPinyinMatch, looksLikePinyinToken, tokenizeSearch } from "../lib/pinyin";
import { UI_COPY } from "../lib/uiCopy";
import type { ApiError } from "../services/apiClient";
import {
  bulkDeleteWorldBookEntries,
  bulkUpdateWorldBookEntries,
  createWorldBookEntry,
  deleteWorldBookEntry,
  duplicateWorldBookEntries,
  exportAllWorldBookEntries,
  getLatestWorldBookAutoUpdateTask,
  importAllWorldBookEntries,
  listWorldBookEntries,
  previewWorldBookTrigger,
  retryProjectTask as retryProjectTaskApi,
  triggerWorldBookAutoUpdate,
  type WorldBookEntry,
  type WorldBookExportAllV1,
  type WorldBookImportAllReport,
  type WorldBookImportMode,
  type WorldBookPreviewTriggerResult,
  type WorldBookPriority,
  type ProjectTask,
  updateWorldBookEntry,
} from "../services/worldbookApi";
import { useWorldBookFilters } from "./worldbook/useWorldBookFilters";
import { useWorldBookPagination } from "./worldbook/useWorldBookPagination";

type WorldBookEntryForm = {
  title: string;
  content_md: string;
  enabled: boolean;
  constant: boolean;
  keywords_raw: string;
  exclude_recursion: boolean;
  prevent_recursion: boolean;
  char_limit: number;
  priority: WorldBookPriority;
};

const EMPTY_WORLD_BOOK_ENTRIES: WorldBookEntry[] = [];

const WORLD_BOOK_ENTRY_RENDER_THRESHOLD = 150;
const WORLD_BOOK_ENTRY_PAGE_SIZE = 100;

function taskStatusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  const s = String(status || "").trim();
  if (s === "failed") return "danger";
  if (s === "running") return "warning";
  if (s === "queued") return "info";
  if (s === "done" || s === "succeeded") return "success";
  return "neutral";
}

function highlightText(text: string, tokens: string[]): ReactNode {
  const raw = String(text ?? "");
  if (!raw) return raw;
  if (!tokens.length) return raw;

  const lower = raw.toLowerCase();
  const active = tokens.map((t) => String(t || "").toLowerCase()).filter((t) => t.length > 0 && lower.includes(t));
  if (!active.length) return raw;

  const uniq = [...new Set(active)].sort((a, b) => b.length - a.length);
  const out: ReactNode[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    let bestIdx = -1;
    let bestToken = "";
    for (const t of uniq) {
      const idx = lower.indexOf(t, cursor);
      if (idx < 0) continue;
      if (bestIdx < 0 || idx < bestIdx || (idx === bestIdx && t.length > bestToken.length)) {
        bestIdx = idx;
        bestToken = t;
      }
    }
    if (bestIdx < 0) {
      out.push(raw.slice(cursor));
      break;
    }
    if (bestIdx > cursor) out.push(raw.slice(cursor, bestIdx));
    const seg = raw.slice(bestIdx, bestIdx + bestToken.length);
    out.push(
      <mark key={`${bestIdx}:${bestToken}:${cursor}`} className="rounded bg-warning/20 px-0.5 text-ink">
        {seg}
      </mark>,
    );
    cursor = bestIdx + bestToken.length;
  }

  return <>{out}</>;
}

function parseKeywords(raw: string): string[] {
  const tokens = raw
    .split(/[\n,，;；]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function joinKeywords(keywords: string[]): string {
  return (keywords ?? []).filter(Boolean).join("\n");
}

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toForm(entry: WorldBookEntry | null): WorldBookEntryForm {
  return {
    title: entry?.title ?? "",
    content_md: entry?.content_md ?? "",
    enabled: entry?.enabled ?? true,
    constant: entry?.constant ?? false,
    keywords_raw: joinKeywords(entry?.keywords ?? []),
    exclude_recursion: entry?.exclude_recursion ?? false,
    prevent_recursion: entry?.prevent_recursion ?? false,
    char_limit: entry?.char_limit ?? 12000,
    priority: entry?.priority ?? "important",
  };
}

export function WorldBookPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const entriesQuery = useProjectData<WorldBookEntry[]>(projectId, async (id) => listWorldBookEntries(id));
  const entries = entriesQuery.data ?? EMPTY_WORLD_BOOK_ENTRIES;
  const loading = entriesQuery.loading;
  const setEntries = entriesQuery.setData;

  const autoUpdateTaskQuery = useProjectData<ProjectTask | null>(projectId, async (id) =>
    getLatestWorldBookAutoUpdateTask(id),
  );
  const autoUpdateTask = autoUpdateTaskQuery.data;
  const [autoUpdateActionLoading, setAutoUpdateActionLoading] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<WorldBookEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const [baseline, setBaseline] = useState<WorldBookEntryForm | null>(null);
  const [form, setForm] = useState<WorldBookEntryForm>(() => toForm(null));

  const { searchText, setSearchText, sortMode, setSortMode } = useWorldBookFilters(projectId);

  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelectAllActive, setBulkSelectAllActive] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<string[]>([]);
  const [bulkExcludedIds, setBulkExcludedIds] = useState<string[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkPriority, setBulkPriority] = useState<WorldBookPriority>("important");
  const [bulkCharLimit, setBulkCharLimit] = useState(12000);

  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<WorldBookImportMode>("merge");
  const [importFileName, setImportFileName] = useState("");
  const [importJson, setImportJson] = useState<WorldBookExportAllV1 | null>(null);
  const [importReport, setImportReport] = useState<WorldBookImportAllReport | null>(null);
  const [importLoading, setImportLoading] = useState(false);

  const triggerAutoUpdate = useCallback(async () => {
    if (!projectId) {
      toast.toastError(UI_COPY.worldbook.missingProjectId);
      return;
    }
    if (autoUpdateActionLoading) return;
    setAutoUpdateActionLoading(true);
    try {
      await triggerWorldBookAutoUpdate(projectId);
      toast.toastSuccess("已触发世界书自动更新（后台任务）");
      await autoUpdateTaskQuery.refresh();
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`触发失败：${err.message} (${err.code})`, err.requestId);
    } finally {
      setAutoUpdateActionLoading(false);
    }
  }, [autoUpdateActionLoading, autoUpdateTaskQuery, projectId, toast]);

  const retryAutoUpdate = useCallback(async () => {
    const t = autoUpdateTask;
    if (!t || t.status !== "failed") return;
    if (autoUpdateActionLoading) return;
    setAutoUpdateActionLoading(true);
    try {
      await retryProjectTaskApi(t.id);
      toast.toastSuccess("已提交重试");
      await autoUpdateTaskQuery.refresh();
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`重试失败：${err.message} (${err.code})`, err.requestId);
    } finally {
      setAutoUpdateActionLoading(false);
    }
  }, [autoUpdateActionLoading, autoUpdateTask, autoUpdateTaskQuery, toast]);

  const bulkSelectedExplicitSet = useMemo(() => new Set(bulkSelectedIds), [bulkSelectedIds]);
  const bulkExcludedSet = useMemo(() => new Set(bulkExcludedIds), [bulkExcludedIds]);

  const openImportDrawer = useCallback(() => {
    setImportOpen(true);
    setImportReport(null);
    setImportJson(null);
    setImportFileName("");
  }, []);

  const closeImportDrawer = useCallback(() => {
    if (importLoading) return;
    setImportOpen(false);
  }, [importLoading]);

  const exportAll = useCallback(async () => {
    if (!projectId) {
      toast.toastError(UI_COPY.worldbook.missingProjectId);
      return;
    }
    if (exporting) return;
    setExporting(true);
    try {
      const out = await exportAllWorldBookEntries(projectId);
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      downloadJson(`worldbook_export_all_${projectId}_${stamp}.json`, out);
      toast.toastSuccess("已导出 JSON");
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`导出失败：${err.message} (${err.code})`, err.requestId);
    } finally {
      setExporting(false);
    }
  }, [exporting, projectId, toast]);

  const loadImportFile = useCallback(
    async (file: File | null) => {
      setImportReport(null);
      setImportJson(null);
      setImportFileName("");
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object") throw new Error("invalid json");
        const o = parsed as Record<string, unknown>;
        const schemaVersion = String(o.schema_version ?? "").trim();
        const entriesRaw = o.entries;
        if (!schemaVersion || !Array.isArray(entriesRaw)) throw new Error("missing schema_version/entries");
        setImportJson({ schema_version: schemaVersion, entries: entriesRaw as never[] } as WorldBookExportAllV1);
        setImportFileName(file.name || "import.json");
        toast.toastSuccess("已加载导入文件");
      } catch {
        toast.toastError("导入 JSON 解析失败");
      }
    },
    [toast],
  );

  const runImport = useCallback(
    async (dryRun: boolean) => {
      if (!projectId) {
        toast.toastError(UI_COPY.worldbook.missingProjectId);
        return;
      }
      if (!importJson) {
        toast.toastError("请先选择导入 JSON 文件");
        return;
      }
      if (importLoading) return;

      if (!dryRun && importMode === "overwrite") {
        const ok = await confirm.confirm({
          title: "确认覆盖导入？",
          description: "overwrite 会先删除当前所有条目，然后导入 JSON。",
          confirmText: "继续",
          cancelText: "取消",
        });
        if (!ok) return;
      }

      setImportLoading(true);
      try {
        const report = await importAllWorldBookEntries(projectId, {
          schema_version: importJson.schema_version,
          dry_run: dryRun,
          mode: importMode,
          entries: importJson.entries ?? [],
        });
        setImportReport(report);
        toast.toastSuccess(dryRun ? "dry_run 完成" : "导入完成");
        if (!dryRun) {
          setImportOpen(false);
          void entriesQuery.refresh();
          toast.toastWarning("WorldBook 已变更，建议到 RagPage 重新 build 知识库索引。");
        }
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`导入失败：${err.message} (${err.code})`, err.requestId);
      } finally {
        setImportLoading(false);
      }
    },
    [confirm, entriesQuery, importJson, importLoading, importMode, projectId, toast],
  );

  useEffect(() => {
    if (!bulkMode) return;
    if (!bulkSelectAllActive && bulkSelectedIds.length === 0 && bulkExcludedIds.length === 0) return;
    const idSet = new Set(entries.map((e) => e.id));
    setBulkSelectedIds((prev) => prev.filter((id) => idSet.has(id)));
    setBulkExcludedIds((prev) => prev.filter((id) => idSet.has(id)));
  }, [bulkExcludedIds.length, bulkMode, bulkSelectAllActive, bulkSelectedIds.length, entries]);

  const filterState = useMemo(() => {
    const tokens = tokenizeSearch(searchText);
    const priorityRank: Record<WorldBookPriority, number> = {
      must: 3,
      important: 2,
      optional: 1,
      drop_first: 0,
    };

    const metaById = new Map<string, { pinyinHit: boolean }>();

    const filtered = tokens.length
      ? entries.filter((e) => {
          const titleRaw = String(e.title || "");
          const title = titleRaw.toLowerCase();
          const keywordsRaw = (e.keywords ?? []).map((k) => String(k || ""));
          const keywords = keywordsRaw.map((k) => k.toLowerCase());
          const combined = `${titleRaw} ${keywordsRaw.join(" ")}`;
          let pinyinHit = false;
          const ok = tokens.every((t) => {
            if (title.includes(t)) return true;
            if (keywords.some((k) => k.includes(t))) return true;
            if (!looksLikePinyinToken(t)) return false;
            const m = containsPinyinMatch(combined, t);
            if (!m.matched) return false;
            pinyinHit = true;
            return true;
          });
          if (ok) metaById.set(e.id, { pinyinHit });
          return ok;
        })
      : entries;

    const out = [...filtered];
    const byUpdatedAt = (a: WorldBookEntry, b: WorldBookEntry) => {
      const at = Date.parse(a.updated_at);
      const bt = Date.parse(b.updated_at);
      const av = Number.isFinite(at) ? at : 0;
      const bv = Number.isFinite(bt) ? bt : 0;
      return av - bv;
    };
    const byPriority = (a: WorldBookEntry, b: WorldBookEntry) => priorityRank[a.priority] - priorityRank[b.priority];
    const byEnabled = (a: WorldBookEntry, b: WorldBookEntry) => Number(Boolean(a.enabled)) - Number(Boolean(b.enabled));

    out.sort((a, b) => {
      if (sortMode === "updated_asc") return byUpdatedAt(a, b) || a.id.localeCompare(b.id);
      if (sortMode === "updated_desc") return byUpdatedAt(b, a) || a.id.localeCompare(b.id);
      if (sortMode === "priority_asc") return byPriority(a, b) || byUpdatedAt(b, a) || a.id.localeCompare(b.id);
      if (sortMode === "priority_desc") return byPriority(b, a) || byUpdatedAt(b, a) || a.id.localeCompare(b.id);
      if (sortMode === "enabled_asc") return byEnabled(a, b) || byUpdatedAt(b, a) || a.id.localeCompare(b.id);
      if (sortMode === "enabled_desc") return byEnabled(b, a) || byUpdatedAt(b, a) || a.id.localeCompare(b.id);
      return byUpdatedAt(b, a) || a.id.localeCompare(b.id);
    });

    return { tokens, metaById, entries: out };
  }, [entries, searchText, sortMode]);

  const filteredEntries = filterState.entries;

  const bulkSelectedCount = bulkSelectAllActive
    ? Math.max(0, filteredEntries.length - bulkExcludedIds.length)
    : bulkSelectedIds.length;

  useEffect(() => {
    if (!bulkMode) return;
    if (!bulkSelectAllActive) return;
    if (bulkExcludedIds.length === 0) return;
    setBulkExcludedIds([]);
  }, [bulkMode, bulkExcludedIds.length, bulkSelectAllActive, searchText, sortMode]);

  const {
    paginate: paginateEntries,
    totalPages: totalEntryPages,
    pageIndex: entryPageIndexClamped,
    pageStart: entryPageStart,
    pageEnd: entryPageEnd,
    pageItems: visibleEntries,
    setPageIndex: setEntryPageIndex,
  } = useWorldBookPagination(filteredEntries, {
    threshold: WORLD_BOOK_ENTRY_RENDER_THRESHOLD,
    pageSize: WORLD_BOOK_ENTRY_PAGE_SIZE,
    resetToken: `${searchText}::${sortMode}`,
  });

  const bulkVisibleSelectedCount = useMemo(() => {
    if (!bulkMode) return 0;
    if (bulkSelectAllActive) return visibleEntries.filter((e) => !bulkExcludedSet.has(e.id)).length;
    return visibleEntries.filter((e) => bulkSelectedExplicitSet.has(e.id)).length;
  }, [bulkExcludedSet, bulkMode, bulkSelectAllActive, bulkSelectedExplicitSet, visibleEntries]);

  const bulkHiddenSelectedCount = Math.max(0, bulkSelectedCount - bulkVisibleSelectedCount);

  const dirty = useMemo(() => {
    if (!baseline) return false;
    return (
      form.title !== baseline.title ||
      form.content_md !== baseline.content_md ||
      form.enabled !== baseline.enabled ||
      form.constant !== baseline.constant ||
      form.keywords_raw !== baseline.keywords_raw ||
      form.exclude_recursion !== baseline.exclude_recursion ||
      form.prevent_recursion !== baseline.prevent_recursion ||
      form.char_limit !== baseline.char_limit ||
      form.priority !== baseline.priority
    );
  }, [baseline, form]);

  const openNew = () => {
    setEditing(null);
    const next = toForm(null);
    setForm(next);
    setBaseline(next);
    setDrawerOpen(true);
  };

  const openEdit = useCallback((entry: WorldBookEntry) => {
    setEditing(entry);
    const next = toForm(entry);
    setForm(next);
    setBaseline(next);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(async () => {
    if (dirty) {
      const ok = await confirm.confirm({
        title: UI_COPY.worldbook.discardChangesTitle,
        description: UI_COPY.worldbook.discardChangesDesc,
        confirmText: UI_COPY.worldbook.discardChangesConfirm,
        cancelText: UI_COPY.worldbook.discardChangesCancel,
        danger: true,
      });
      if (!ok) return;
    }
    setDrawerOpen(false);
  }, [confirm, dirty]);

  const saveEntry = useCallback(async () => {
    if (!projectId) return;
    if (!form.title.trim()) {
      toast.toastError(UI_COPY.worldbook.validationTitleRequired);
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        content_md: form.content_md ?? "",
        enabled: Boolean(form.enabled),
        constant: Boolean(form.constant),
        keywords: parseKeywords(form.keywords_raw),
        exclude_recursion: Boolean(form.exclude_recursion),
        prevent_recursion: Boolean(form.prevent_recursion),
        char_limit: Number.isFinite(form.char_limit) ? Math.max(0, Math.floor(form.char_limit)) : 12000,
        priority: form.priority,
      };
      const saved = editing
        ? await updateWorldBookEntry(editing.id, payload)
        : await createWorldBookEntry(projectId, payload);
      setEntries((prev) => {
        const list = prev ?? [];
        const idx = list.findIndex((e) => e.id === saved.id);
        if (idx >= 0) return list.map((e) => (e.id === saved.id ? saved : e));
        return [saved, ...list];
      });
      const nextBaseline = toForm(saved);
      setBaseline(nextBaseline);
      setForm((prev) => {
        if (
          prev.title === form.title &&
          prev.content_md === form.content_md &&
          prev.enabled === form.enabled &&
          prev.constant === form.constant &&
          prev.keywords_raw === form.keywords_raw &&
          prev.exclude_recursion === form.exclude_recursion &&
          prev.prevent_recursion === form.prevent_recursion &&
          prev.char_limit === form.char_limit &&
          prev.priority === form.priority
        ) {
          return nextBaseline;
        }
        return prev;
      });
      toast.toastSuccess(UI_COPY.worldbook.saved);
      setEditing(saved);
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }, [editing, form, projectId, setEntries, toast]);

  const deleteEntry = useCallback(async () => {
    if (!editing) return;
    const ok = await confirm.confirm({
      title: UI_COPY.worldbook.deleteTitle,
      description: UI_COPY.worldbook.deleteDesc,
      confirmText: UI_COPY.worldbook.deleteConfirm,
      cancelText: UI_COPY.worldbook.deleteCancel,
      danger: true,
    });
    if (!ok) return;

    setSaving(true);
    try {
      await deleteWorldBookEntry(editing.id);
      setEntries((prev) => (prev ?? []).filter((e) => e.id !== editing.id));
      toast.toastSuccess(UI_COPY.worldbook.deleted);
      setDrawerOpen(false);
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setSaving(false);
    }
  }, [confirm, editing, setEntries, toast]);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<{ message: string; code: string; requestId?: string } | null>(null);
  const [previewQueryText, setPreviewQueryText] = useState("");
  const [previewIncludeConstant, setPreviewIncludeConstant] = useState(true);
  const [previewEnableRecursion, setPreviewEnableRecursion] = useState(true);
  const [previewCharLimit, setPreviewCharLimit] = useState(12000);
  const [previewResult, setPreviewResult] = useState<WorldBookPreviewTriggerResult | null>(null);

  const runPreview = useCallback(async () => {
    if (!projectId) {
      setPreviewError({ message: UI_COPY.worldbook.missingProjectId, code: "NO_PROJECT" });
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const safeCharLimit = Number.isFinite(previewCharLimit) ? Math.max(0, Math.floor(previewCharLimit)) : 12000;
      const res = await previewWorldBookTrigger(projectId, {
        query_text: previewQueryText,
        include_constant: previewIncludeConstant,
        enable_recursion: previewEnableRecursion,
        char_limit: safeCharLimit,
      });
      setPreviewResult(res.data);
      setPreviewRequestId(res.request_id ?? null);
    } catch (e) {
      const err = e as ApiError;
      setPreviewError({ message: err.message, code: err.code, requestId: err.requestId });
      setPreviewResult(null);
      setPreviewRequestId(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [previewCharLimit, previewEnableRecursion, previewIncludeConstant, previewQueryText, projectId]);

  const setBulkModeSafe = useCallback((next: boolean) => {
    setBulkMode(next);
    setBulkSelectAllActive(false);
    setBulkSelectedIds([]);
    setBulkExcludedIds([]);
  }, []);

  const toggleBulkSelected = useCallback(
    (entryId: string) => {
      if (bulkSelectAllActive) {
        setBulkExcludedIds((prev) => {
          if (prev.includes(entryId)) return prev.filter((id) => id !== entryId);
          return [...prev, entryId];
        });
        return;
      }

      setBulkSelectedIds((prev) => {
        if (prev.includes(entryId)) return prev.filter((id) => id !== entryId);
        return [...prev, entryId];
      });
    },
    [bulkSelectAllActive],
  );

  const bulkSelectAll = useCallback(() => {
    setBulkSelectAllActive(true);
    setBulkSelectedIds([]);
    setBulkExcludedIds([]);
  }, []);

  const bulkClearSelection = useCallback(() => {
    setBulkSelectAllActive(false);
    setBulkSelectedIds([]);
    setBulkExcludedIds([]);
  }, []);

  const bulkUpdate = useCallback(
    async (opts: {
      title: string;
      description: string;
      patch: { enabled?: boolean; priority?: WorldBookPriority; char_limit?: number };
    }) => {
      if (!projectId) return;
      const excludedSet = new Set(bulkExcludedIds);
      const selectedIds = bulkSelectAllActive
        ? filteredEntries.filter((e) => !excludedSet.has(e.id)).map((e) => e.id)
        : bulkSelectedIds;
      if (selectedIds.length === 0) {
        toast.toastError(UI_COPY.worldbook.bulkNoSelection);
        return;
      }

      const ok = await confirm.confirm({
        title: opts.title,
        description: opts.description,
        confirmText: "确认",
        cancelText: "取消",
      });
      if (!ok) return;

      setBulkLoading(true);
      try {
        const updated = await bulkUpdateWorldBookEntries(projectId, { entry_ids: selectedIds, ...opts.patch });
        setEntries((prev) => {
          const list = prev ?? [];
          const byId = new Map(updated.map((e) => [e.id, e]));
          return list.map((e) => byId.get(e.id) ?? e);
        });
        toast.toastSuccess("已批量更新");
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`批量更新失败（${selectedIds.length}条）：${err.message} (${err.code})`, err.requestId);
      } finally {
        setBulkLoading(false);
      }
    },
    [bulkExcludedIds, bulkSelectAllActive, bulkSelectedIds, confirm, filteredEntries, projectId, setEntries, toast],
  );

  const bulkDelete = useCallback(async () => {
    if (!projectId) return;
    const excludedSet = new Set(bulkExcludedIds);
    const selectedIds = bulkSelectAllActive
      ? filteredEntries.filter((e) => !excludedSet.has(e.id)).map((e) => e.id)
      : bulkSelectedIds;
    if (selectedIds.length === 0) {
      toast.toastError(UI_COPY.worldbook.bulkNoSelection);
      return;
    }

    const ok = await confirm.confirm({
      title: UI_COPY.worldbook.bulkDeleteTitle,
      description: UI_COPY.worldbook.bulkDeleteDescPrefix + selectedIds.length + UI_COPY.worldbook.bulkDeleteDescSuffix,
      confirmText: UI_COPY.worldbook.deleteConfirm,
      cancelText: UI_COPY.worldbook.deleteCancel,
      danger: true,
    });
    if (!ok) return;

    setBulkLoading(true);
    try {
      const deletedIds = await bulkDeleteWorldBookEntries(projectId, selectedIds);
      const deletedSet = new Set(deletedIds);
      setEntries((prev) => (prev ?? []).filter((e) => !deletedSet.has(e.id)));
      toast.toastSuccess("已批量删除");
      setBulkSelectAllActive(false);
      setBulkSelectedIds([]);
      setBulkExcludedIds([]);
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`批量删除失败（${selectedIds.length}条）：${err.message} (${err.code})`, err.requestId);
    } finally {
      setBulkLoading(false);
    }
  }, [bulkExcludedIds, bulkSelectAllActive, bulkSelectedIds, confirm, filteredEntries, projectId, setEntries, toast]);

  const duplicateAndEdit = useCallback(
    async (entryId: string) => {
      if (!projectId) return;

      const ok = await confirm.confirm({
        title: UI_COPY.worldbook.bulkDuplicateTitle,
        description: UI_COPY.worldbook.bulkDuplicateDescPrefix + "1" + UI_COPY.worldbook.bulkDuplicateDescSuffix,
        confirmText: "复制",
        cancelText: "取消",
      });
      if (!ok) return;

      setBulkLoading(true);
      try {
        const created = await duplicateWorldBookEntries(projectId, [entryId]);
        if (created.length === 0) {
          toast.toastError("复制失败：返回为空");
          return;
        }
        const createdSet = new Set(created.map((e) => e.id));
        setEntries((prev) => {
          const list = prev ?? [];
          const rest = list.filter((e) => !createdSet.has(e.id));
          return [...created, ...rest];
        });
        setBulkMode(false);
        setBulkSelectAllActive(false);
        setBulkSelectedIds([]);
        setBulkExcludedIds([]);
        openEdit(created[0]);
        toast.toastSuccess("已复制并进入编辑");
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`复制失败：${err.message} (${err.code})`, err.requestId);
      } finally {
        setBulkLoading(false);
      }
    },
    [confirm, openEdit, projectId, setEntries, toast],
  );

  const bulkDuplicateEdit = useCallback(async () => {
    if (!bulkSelectAllActive) {
      if (bulkSelectedIds.length !== 1) {
        toast.toastError("复制并编辑需要选择 1 条条目");
        return;
      }
      await duplicateAndEdit(bulkSelectedIds[0]);
      return;
    }

    const excludedSet = new Set(bulkExcludedIds);
    let selectedId: string | null = null;
    let count = 0;
    for (const e of filteredEntries) {
      if (excludedSet.has(e.id)) continue;
      count += 1;
      selectedId = e.id;
      if (count > 1) break;
    }
    if (count !== 1 || !selectedId) {
      toast.toastError("复制并编辑需要选择 1 条条目");
      return;
    }
    await duplicateAndEdit(selectedId);
  }, [bulkExcludedIds, bulkSelectAllActive, bulkSelectedIds, duplicateAndEdit, filteredEntries, toast]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-subtext">
          {UI_COPY.worldbook.entriesCountPrefix}
          {filteredEntries.length}
          {filteredEntries.length === entries.length ? "" : ` / ${entries.length}`}
          {UI_COPY.worldbook.entriesCountSuffix}
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={() => void entriesQuery.refresh()} type="button">
            {UI_COPY.worldbook.refresh}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!projectId || exporting}
            onClick={() => void exportAll()}
            type="button"
          >
            {exporting ? "导出中..." : "导出 JSON"}
          </button>
          <button className="btn btn-secondary" disabled={!projectId} onClick={openImportDrawer} type="button">
            导入 JSON
          </button>
          <button className="btn btn-primary" onClick={openNew} type="button">
            {UI_COPY.worldbook.create}
          </button>
        </div>
      </div>

      <div className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-subtext">关系导航</div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-secondary"
              disabled={!projectId}
              onClick={() => projectId && navigate(`/projects/${projectId}/characters`)}
              type="button"
            >
              角色
            </button>
            <button
              className="btn btn-secondary"
              disabled={!projectId}
              onClick={() => projectId && navigate(`/projects/${projectId}/structured-memory?view=character-relations`)}
              type="button"
            >
              角色关系
            </button>
            <button
              className="btn btn-secondary"
              disabled={!projectId}
              onClick={() => projectId && navigate(`/projects/${projectId}/graph`)}
              type="button"
            >
              关系图谱
            </button>
            <button
              className="btn btn-secondary"
              disabled={!projectId}
              onClick={() => projectId && navigate(`/projects/${projectId}/chapter-analysis`)}
              type="button"
            >
              情节记忆
            </button>
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-ink">世界书自动更新</div>
            <div className="mt-1 text-xs text-subtext">章节定稿后会后台抽取并合并条目；失败不影响写作，可重试。</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn btn-secondary"
              disabled={!projectId || autoUpdateActionLoading}
              onClick={() => void autoUpdateTaskQuery.refresh()}
              type="button"
            >
              刷新状态
            </button>
            <button
              className="btn btn-secondary"
              disabled={!projectId || autoUpdateActionLoading || autoUpdateTask?.status !== "failed"}
              onClick={() => void retryAutoUpdate()}
              type="button"
            >
              重试
            </button>
            <button
              className="btn btn-primary"
              disabled={!projectId || autoUpdateActionLoading}
              onClick={() => void triggerAutoUpdate()}
              type="button"
            >
              {autoUpdateActionLoading ? "处理中..." : "手动触发"}
            </button>
            {projectId ? (
              <Link className="btn btn-secondary" to={`/projects/${projectId}/tasks`}>
                任务中心
              </Link>
            ) : (
              <button className="btn btn-secondary" disabled type="button">
                任务中心
              </button>
            )}
          </div>
        </div>

        <div className="mt-3">
          {autoUpdateTaskQuery.loading ? <div className="text-xs text-subtext">{UI_COPY.common.loading}</div> : null}
          {!autoUpdateTaskQuery.loading && !autoUpdateTask ? (
            <div className="text-xs text-subtext">暂无任务记录（章节定稿后会自动创建）。</div>
          ) : null}
          {autoUpdateTask ? (
            <div className="grid gap-1 text-xs text-subtext">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={taskStatusTone(autoUpdateTask.status)}>{humanizeTaskStatus(autoUpdateTask.status)}</Badge>
                <span className="font-mono text-subtext">{autoUpdateTask.kind}</span>
                <span className="font-mono text-subtext">({autoUpdateTask.id})</span>
              </div>

              <div className="flex flex-wrap gap-2">
                <span>request_id:</span>
                <span className="font-mono text-ink">
                  {typeof (autoUpdateTask.params as Record<string, unknown> | null)?.request_id === "string"
                    ? ((autoUpdateTask.params as Record<string, unknown>).request_id as string)
                    : "-"}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <span>chapter_id:</span>
                <span className="font-mono text-ink">
                  {typeof (autoUpdateTask.params as Record<string, unknown> | null)?.chapter_id === "string"
                    ? ((autoUpdateTask.params as Record<string, unknown>).chapter_id as string)
                    : "-"}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <span>run_id:</span>
                <span className="font-mono text-ink">
                  {typeof (autoUpdateTask.result as Record<string, unknown> | null)?.run_id === "string"
                    ? ((autoUpdateTask.result as Record<string, unknown>).run_id as string)
                    : "-"}
                </span>
              </div>

              {typeof (autoUpdateTask.result as Record<string, unknown> | null)?.applied === "object" &&
              (autoUpdateTask.result as Record<string, unknown>).applied ? (
                <div className="flex flex-wrap gap-2">
                  <span>applied:</span>
                  <span className="font-mono text-ink">
                    {JSON.stringify((autoUpdateTask.result as Record<string, unknown>).applied)}
                  </span>
                </div>
              ) : null}

              {autoUpdateTask.status === "failed" ? (
                <div className="text-xs text-danger">
                  {autoUpdateTask.error_type ? `${autoUpdateTask.error_type}: ` : ""}
                  {autoUpdateTask.error_message || "任务失败"}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <div className="text-sm text-ink">{UI_COPY.worldbook.entriesTitle}</div>
          <div className="mt-1 text-xs text-subtext">{UI_COPY.worldbook.entriesHint}</div>

          {loading ? <div className="mt-3 text-sm text-subtext">{UI_COPY.common.loading}</div> : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 sm:col-span-2">
              <span className="text-xs text-subtext">搜索（标题 / 关键词）</span>
              <input
                id="worldbook_search"
                className="input"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                aria-label="worldbook_search"
                placeholder="dragon"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-subtext">排序</span>
              <select
                id="worldbook_sort"
                className="select"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                aria-label="worldbook_sort"
              >
                <option value="updated_desc">更新时间（updated_at）↓</option>
                <option value="updated_asc">更新时间（updated_at）↑</option>
                <option value="priority_desc">优先级（priority）↓</option>
                <option value="priority_asc">优先级（priority）↑</option>
                <option value="enabled_desc">启用（enabled）↓</option>
                <option value="enabled_asc">启用（enabled）↑</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-ink">
              <span>{UI_COPY.worldbook.bulkMode}</span>
              <input
                id="worldbook_bulk_mode"
                className="checkbox"
                checked={bulkMode}
                disabled={bulkLoading}
                onChange={(e) => setBulkModeSafe(e.target.checked)}
                aria-label="worldbook_bulk_mode"
                type="checkbox"
              />
            </label>
          </div>

          {bulkMode ? (
            <div className="mt-4 rounded-atelier border border-border bg-canvas p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-subtext">
                  {UI_COPY.worldbook.bulkSelectedPrefix}
                  {bulkSelectedCount}
                  {UI_COPY.worldbook.bulkSelectedSuffix}
                  {bulkHiddenSelectedCount > 0 ? (
                    <span className="ml-2">（含 {bulkHiddenSelectedCount} 个未显示）</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={bulkLoading || loading}
                    onClick={bulkSelectAll}
                    aria-label="worldbook_bulk_select_all"
                    type="button"
                  >
                    {UI_COPY.worldbook.bulkSelectAll}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={bulkLoading || loading}
                    onClick={bulkClearSelection}
                    aria-label="worldbook_bulk_clear_selection"
                    type="button"
                  >
                    {UI_COPY.worldbook.bulkClearSelection}
                  </button>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-subtext">{UI_COPY.worldbook.bulkModeHint}</div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="btn btn-secondary"
                  disabled={bulkLoading || loading || drawerOpen}
                  onClick={() =>
                    void bulkUpdate({
                      title: UI_COPY.worldbook.bulkEnableTitle,
                      description:
                        UI_COPY.worldbook.bulkEnableDescPrefix +
                        bulkSelectedCount +
                        UI_COPY.worldbook.bulkEnableDescSuffix,
                      patch: { enabled: true },
                    })
                  }
                  aria-label="worldbook_bulk_enable"
                  type="button"
                >
                  {UI_COPY.worldbook.bulkEnable}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={bulkLoading || loading || drawerOpen}
                  onClick={() =>
                    void bulkUpdate({
                      title: UI_COPY.worldbook.bulkDisableTitle,
                      description:
                        UI_COPY.worldbook.bulkDisableDescPrefix +
                        bulkSelectedCount +
                        UI_COPY.worldbook.bulkDisableDescSuffix,
                      patch: { enabled: false },
                    })
                  }
                  aria-label="worldbook_bulk_disable"
                  type="button"
                >
                  {UI_COPY.worldbook.bulkDisable}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={bulkLoading || loading || drawerOpen || bulkSelectedCount !== 1}
                  onClick={() => void bulkDuplicateEdit()}
                  aria-label="worldbook_bulk_duplicate_edit"
                  type="button"
                >
                  {UI_COPY.worldbook.bulkDuplicateEdit}
                </button>
                <button
                  className="btn btn-danger"
                  disabled={bulkLoading || loading || drawerOpen}
                  onClick={() => void bulkDelete()}
                  aria-label="worldbook_bulk_delete"
                  type="button"
                >
                  {UI_COPY.worldbook.bulkDelete}
                </button>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="flex items-end gap-2">
                  <label className="grid flex-1 gap-1">
                    <span className="text-xs text-subtext">{UI_COPY.worldbook.bulkPriority}</span>
                    <select
                      id="worldbook_bulk_priority"
                      className="select"
                      value={bulkPriority}
                      onChange={(e) => setBulkPriority(e.target.value as WorldBookPriority)}
                      disabled={bulkLoading || loading}
                      aria-label="worldbook_bulk_priority"
                    >
                      <option value="must">必须（must）</option>
                      <option value="important">重要（important）</option>
                      <option value="optional">可选（optional）</option>
                      <option value="drop_first">优先丢弃（drop_first）</option>
                    </select>
                  </label>
                  <button
                    className="btn btn-secondary"
                    disabled={bulkLoading || loading || drawerOpen}
                    onClick={() =>
                      void bulkUpdate({
                        title: UI_COPY.worldbook.bulkUpdateTitle,
                        description:
                          UI_COPY.worldbook.bulkUpdateDescPrefix +
                          bulkSelectedCount +
                          UI_COPY.worldbook.bulkUpdateDescSuffix,
                        patch: { priority: bulkPriority },
                      })
                    }
                    aria-label="worldbook_bulk_apply_priority"
                    type="button"
                  >
                    {UI_COPY.worldbook.bulkApply}
                  </button>
                </div>

                <div className="flex items-end gap-2">
                  <label className="grid flex-1 gap-1">
                    <span className="text-xs text-subtext">{UI_COPY.worldbook.bulkCharLimit}</span>
                    <input
                      id="worldbook_bulk_char_limit"
                      className="input"
                      min={0}
                      type="number"
                      value={bulkCharLimit}
                      onChange={(e) => setBulkCharLimit(e.currentTarget.valueAsNumber)}
                      disabled={bulkLoading || loading}
                      aria-label="worldbook_bulk_char_limit"
                    />
                  </label>
                  <button
                    className="btn btn-secondary"
                    disabled={bulkLoading || loading || drawerOpen}
                    onClick={() => {
                      const safeCharLimit = Number.isFinite(bulkCharLimit)
                        ? Math.max(0, Math.floor(bulkCharLimit))
                        : 12000;
                      void bulkUpdate({
                        title: UI_COPY.worldbook.bulkUpdateTitle,
                        description:
                          UI_COPY.worldbook.bulkUpdateDescPrefix +
                          bulkSelectedCount +
                          UI_COPY.worldbook.bulkUpdateDescSuffix,
                        patch: { char_limit: safeCharLimit },
                      });
                    }}
                    aria-label="worldbook_bulk_apply_char_limit"
                    type="button"
                  >
                    {UI_COPY.worldbook.bulkApply}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3">
            {filteredEntries.length === 0 ? (
              <div className="text-sm text-subtext">{UI_COPY.worldbook.empty}</div>
            ) : (
              visibleEntries.map((e) => {
                const selected = bulkSelectAllActive ? !bulkExcludedSet.has(e.id) : bulkSelectedExplicitSet.has(e.id);
                const meta = filterState.metaById.get(e.id) ?? { pinyinHit: false };
                const keywordSnippet = (e.keywords ?? []).slice(0, 6).join("、") || UI_COPY.worldbook.keywordsNone;
                return (
                  <button
                    key={e.id}
                    className={
                      bulkMode && selected
                        ? "panel-interactive ui-focus-ring border-accent/60 bg-surface-hover p-4 text-left"
                        : "panel-interactive ui-focus-ring p-4 text-left"
                    }
                    disabled={bulkMode && bulkLoading}
                    onClick={() => (bulkMode ? toggleBulkSelected(e.id) : openEdit(e))}
                    type="button"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        {bulkMode ? (
                          <div className="mt-1 shrink-0" aria-hidden="true">
                            <div
                              className={
                                selected
                                  ? "flex h-5 w-5 items-center justify-center rounded-atelier border border-accent bg-accent text-xs text-white"
                                  : "h-5 w-5 rounded-atelier border border-border bg-canvas"
                              }
                            >
                              {selected ? "✓" : null}
                            </div>
                          </div>
                        ) : null}
                        <div className="min-w-0">
                          <div className="truncate font-content text-lg text-ink">
                            {highlightText(e.title, filterState.tokens)}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-subtext">
                            <span>{e.enabled ? UI_COPY.worldbook.tagEnabled : UI_COPY.worldbook.tagDisabled}</span>
                            <span>{e.constant ? UI_COPY.worldbook.tagBlue : UI_COPY.worldbook.tagGreen}</span>
                            <span>{UI_COPY.worldbook.tagPriorityPrefix + e.priority}</span>
                            <span>{UI_COPY.worldbook.tagCharLimitPrefix + e.char_limit}</span>
                            {filterState.tokens.length && meta.pinyinHit ? (
                              <span className="rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-subtext">
                                拼音
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 text-[11px] text-subtext">{e.updated_at}</div>
                    </div>
                    {e.constant ? null : (
                      <div className="mt-2 line-clamp-2 text-xs text-subtext">
                        {UI_COPY.worldbook.keywordsPrefix}
                        {highlightText(keywordSnippet, filterState.tokens)}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {paginateEntries ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-subtext">
              <div>
                已显示 {entryPageStart + 1}-{entryPageEnd}/{filteredEntries.length} 条（超过{" "}
                {WORLD_BOOK_ENTRY_RENDER_THRESHOLD} 条时分页渲染）
                <span className="ml-2">
                  第 {entryPageIndexClamped + 1}/{totalEntryPages} 页
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-secondary"
                  disabled={entryPageIndexClamped === 0}
                  onClick={() => setEntryPageIndex((prev) => Math.max(0, prev - 1))}
                  aria-label="worldbook_page_prev"
                  type="button"
                >
                  上一页
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={entryPageIndexClamped >= totalEntryPages - 1}
                  onClick={() => setEntryPageIndex((prev) => Math.min(totalEntryPages - 1, prev + 1))}
                  aria-label="worldbook_load_more"
                  type="button"
                >
                  下一页
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="panel p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm text-ink">{UI_COPY.worldbook.previewTitle}</div>
              <div className="mt-1 text-xs text-subtext">
                {UI_COPY.worldbook.previewHint}
                {previewRequestId ? <span className="ml-2">request_id: {previewRequestId}</span> : null}
              </div>
            </div>
            <div className="grid justify-items-end gap-1">
              <button
                className="btn btn-secondary"
                disabled={previewLoading || drawerOpen}
                title={drawerOpen ? UI_COPY.worldbook.previewUseInDrawerHint : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void runPreview();
                }}
                type="button"
              >
                {UI_COPY.worldbook.previewRun}
              </button>
              {drawerOpen ? (
                <Badge className="max-w-[320px] whitespace-normal" tone="warning">
                  {UI_COPY.worldbook.previewUseInDrawerHint}
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="mt-4 grid gap-3">
            <label className="grid gap-1">
              <span className="text-xs text-subtext">{UI_COPY.worldbook.previewQueryLabel}</span>
              <textarea
                id="worldbook_preview_query_text"
                className="textarea atelier-content"
                name="query_text"
                rows={4}
                value={previewQueryText}
                onChange={(e) => setPreviewQueryText(e.target.value)}
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-2 text-sm text-ink">
                <span>{UI_COPY.worldbook.previewIncludeConstant}</span>
                <input
                  id="worldbook_preview_include_constant"
                  className="checkbox"
                  checked={previewIncludeConstant}
                  name="include_constant"
                  onChange={(e) => setPreviewIncludeConstant(e.target.checked)}
                  type="checkbox"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm text-ink">
                <span>{UI_COPY.worldbook.previewEnableRecursion}</span>
                <input
                  id="worldbook_preview_enable_recursion"
                  className="checkbox"
                  checked={previewEnableRecursion}
                  name="enable_recursion"
                  onChange={(e) => setPreviewEnableRecursion(e.target.checked)}
                  type="checkbox"
                />
              </label>
              <label className="grid gap-1 sm:col-span-2">
                <span className="text-xs text-subtext">{UI_COPY.worldbook.previewCharLimit}</span>
                <input
                  id="worldbook_preview_char_limit"
                  className="input"
                  min={0}
                  name="char_limit"
                  type="number"
                  value={previewCharLimit}
                  onChange={(e) => setPreviewCharLimit(e.currentTarget.valueAsNumber)}
                />
              </label>
            </div>

            {previewLoading ? <div className="text-sm text-subtext">{UI_COPY.common.loading}</div> : null}
            {previewError ? (
              <div className="rounded-atelier border border-border bg-surface p-3 text-sm text-subtext">
                <div className="text-ink">{UI_COPY.worldbook.previewFailed}</div>
                <div className="mt-1 text-xs text-subtext">
                  {previewError.message} ({previewError.code})
                  {previewError.requestId ? <span className="ml-2">request_id: {previewError.requestId}</span> : null}
                </div>
              </div>
            ) : null}

            {previewResult ? (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-subtext">
                  <span>
                    {UI_COPY.worldbook.previewTriggeredPrefix}
                    {previewResult.triggered.length}
                    {UI_COPY.worldbook.previewTriggeredSuffix}
                  </span>
                  {previewResult.truncated ? (
                    <Badge className="shrink-0" tone="warning">
                      {UI_COPY.worldbook.previewTruncated}
                    </Badge>
                  ) : null}
                </div>
                <details open>
                  <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                    {UI_COPY.worldbook.previewTriggeredList}
                  </summary>
                  <div className="mt-2 grid gap-2">
                    {previewResult.triggered.length === 0 ? (
                      <div className="text-sm text-subtext">{UI_COPY.worldbook.previewNoTriggered}</div>
                    ) : (
                      previewResult.triggered.map((t) => (
                        <div key={t.id} className="rounded-atelier border border-border bg-surface p-2 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-ink">{t.title}</div>
                              <div className="mt-1 text-subtext">
                                {t.reason} | priority:{t.priority}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </details>
                <details open>
                  <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                    {UI_COPY.worldbook.previewText}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                    {previewResult.text_md || UI_COPY.worldbook.previewTextEmpty}
                  </pre>
                </details>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Drawer
        open={importOpen}
        onClose={closeImportDrawer}
        ariaLabel="世界书导入"
        panelClassName="h-full w-full max-w-xl border-l border-border bg-canvas p-6 shadow-sm"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-content text-2xl text-ink">世界书导入</div>
            <div className="mt-1 text-xs text-subtext">
              上传导出的整套 JSON（export_all），支持 dry_run 预演查看冲突并确认应用。
            </div>
          </div>
          <button className="btn btn-secondary" disabled={importLoading} onClick={closeImportDrawer} type="button">
            {UI_COPY.worldbook.close}
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          <div className="surface p-4">
            <div className="text-sm text-ink">导入文件</div>
            <div className="mt-3 grid gap-3">
              <label className="grid gap-1">
                <span className="text-xs text-subtext">导入 JSON 文件</span>
                <input
                  id="worldbook_import_file"
                  aria-label="导入 JSON 文件"
                  className="input"
                  accept="application/json,.json"
                  onChange={(e) => void loadImportFile(e.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-xs text-subtext">导入模式</span>
                <select
                  id="worldbook_import_mode"
                  aria-label="导入模式"
                  className="select"
                  disabled={importLoading}
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value as WorldBookImportMode)}
                >
                  <option value="merge">merge（按 title 创建/更新）</option>
                  <option value="overwrite">overwrite（先删除全部再导入）</option>
                </select>
              </label>

              <div className="text-[11px] text-subtext">
                merge：同名 title 直接更新；overwrite：先删后导入（危险，需二次确认）。
              </div>

              {importFileName ? <div className="text-xs text-subtext">已选择: {importFileName}</div> : null}
              {importJson ? (
                <div className="text-xs text-subtext">
                  schema_version: <span className="text-ink">{importJson.schema_version}</span> | entries:{" "}
                  <span className="text-ink">{importJson.entries?.length ?? 0}</span>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-secondary"
                  disabled={!importJson || importLoading}
                  onClick={() => void runImport(true)}
                  type="button"
                >
                  {importLoading ? "处理中..." : "dry_run 预览"}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!importJson || importLoading}
                  onClick={() => void runImport(false)}
                  type="button"
                >
                  {importLoading ? "导入中..." : "应用导入"}
                </button>
              </div>
            </div>
          </div>

          {importReport ? (
            <div className="surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink">导入报告</div>
                  <div className="mt-1 text-xs text-subtext">
                    dry_run: {String(importReport.dry_run)} | mode: {importReport.mode}
                  </div>
                  <div className="mt-1 text-[11px] text-subtext">
                    字段解释：dry_run=预演（不写入）；mode=merge 合并更新 / overwrite 覆盖导入。
                  </div>
                </div>
              </div>

              <div className="mt-3 grid gap-1 text-xs text-subtext">
                <div>
                  created: <span className="text-ink">{importReport.created}</span> | updated:{" "}
                  <span className="text-ink">{importReport.updated}</span> | deleted:{" "}
                  <span className="text-ink">{importReport.deleted}</span> | skipped:{" "}
                  <span className="text-ink">{importReport.skipped}</span>
                </div>
                <div className="text-[11px] text-subtext">
                  created 新建 | updated 更新 | deleted 删除 | skipped 跳过
                </div>
                <div>
                  conflicts: <span className="text-ink">{importReport.conflicts?.length ?? 0}</span> | actions:{" "}
                  <span className="text-ink">{importReport.actions?.length ?? 0}</span>
                </div>
              </div>

              <details className="mt-3" open>
                <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                  冲突（conflicts）({importReport.conflicts?.length ?? 0})
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                  {JSON.stringify(importReport.conflicts ?? [], null, 2)}
                </pre>
              </details>

              <details className="mt-3">
                <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                  变更（actions）({importReport.actions?.length ?? 0})
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-atelier border border-border bg-surface p-3 text-xs text-ink">
                  {JSON.stringify(importReport.actions ?? [], null, 2)}
                </pre>
              </details>
            </div>
          ) : null}
        </div>
      </Drawer>

      <Drawer
        open={drawerOpen}
        onClose={() => void closeDrawer()}
        ariaLabel={UI_COPY.worldbook.drawerTitle}
        panelClassName="h-full w-full max-w-2xl border-l border-border bg-canvas p-6 shadow-sm"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-content text-2xl text-ink">{UI_COPY.worldbook.drawerTitle}</div>
            <div className="mt-1 text-xs text-subtext">{editing ? editing.id : UI_COPY.worldbook.newEntryHint}</div>
          </div>
          <div className="flex items-center gap-2">
            {editing ? (
              <button className="btn btn-secondary" disabled={saving} onClick={() => void deleteEntry()} type="button">
                {UI_COPY.worldbook.delete}
              </button>
            ) : null}
            {editing ? (
              <button
                className="btn btn-secondary"
                disabled={saving || bulkLoading}
                onClick={() => void duplicateAndEdit(editing.id)}
                type="button"
              >
                {UI_COPY.worldbook.bulkDuplicateEdit}
              </button>
            ) : null}
            <button className="btn btn-secondary" onClick={() => void closeDrawer()} type="button">
              {UI_COPY.worldbook.close}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-4">
          <div className="surface p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm text-ink">{UI_COPY.worldbook.previewTitle}</div>
                <div className="mt-1 text-xs text-subtext">
                  {UI_COPY.worldbook.previewHint}
                  {previewRequestId ? <span className="ml-2">request_id: {previewRequestId}</span> : null}
                </div>
              </div>
              <div className="grid justify-items-end gap-1">
                <button
                  className="btn btn-secondary"
                  disabled={previewLoading || dirty}
                  title={dirty ? UI_COPY.worldbook.previewRequiresSaveHint : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void runPreview();
                  }}
                  type="button"
                >
                  {UI_COPY.worldbook.previewRun}
                </button>
                {dirty ? (
                  <Badge className="max-w-[320px] whitespace-normal" tone="warning">
                    {UI_COPY.worldbook.previewRequiresSaveHint}
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-3">
              <label className="grid gap-1">
                <span className="text-xs text-subtext">{UI_COPY.worldbook.previewQueryLabel}</span>
                <textarea
                  id="worldbook_entry_preview_query_text"
                  className="textarea atelier-content"
                  name="query_text"
                  rows={3}
                  value={previewQueryText}
                  onChange={(e) => setPreviewQueryText(e.target.value)}
                />
              </label>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-2 text-sm text-ink">
                  <span>{UI_COPY.worldbook.previewIncludeConstant}</span>
                  <input
                    id="worldbook_entry_preview_include_constant"
                    className="checkbox"
                    checked={previewIncludeConstant}
                    name="include_constant"
                    onChange={(e) => setPreviewIncludeConstant(e.target.checked)}
                    type="checkbox"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-sm text-ink">
                  <span>{UI_COPY.worldbook.previewEnableRecursion}</span>
                  <input
                    id="worldbook_entry_preview_enable_recursion"
                    className="checkbox"
                    checked={previewEnableRecursion}
                    name="enable_recursion"
                    onChange={(e) => setPreviewEnableRecursion(e.target.checked)}
                    type="checkbox"
                  />
                </label>
                <label className="grid gap-1 sm:col-span-2">
                  <span className="text-xs text-subtext">{UI_COPY.worldbook.previewCharLimit}</span>
                  <input
                    id="worldbook_entry_preview_char_limit"
                    className="input"
                    min={0}
                    name="char_limit"
                    type="number"
                    value={previewCharLimit}
                    onChange={(e) => setPreviewCharLimit(e.currentTarget.valueAsNumber)}
                  />
                </label>
              </div>

              {previewLoading ? <div className="text-sm text-subtext">{UI_COPY.common.loading}</div> : null}
              {previewError ? (
                <div className="rounded-atelier border border-border bg-canvas p-3 text-sm text-subtext">
                  <div className="text-ink">{UI_COPY.worldbook.previewFailed}</div>
                  <div className="mt-1 text-xs text-subtext">
                    {previewError.message} ({previewError.code})
                    {previewError.requestId ? <span className="ml-2">request_id: {previewError.requestId}</span> : null}
                  </div>
                </div>
              ) : null}

              {previewResult ? (
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-subtext">
                    <span>
                      {UI_COPY.worldbook.previewTriggeredPrefix}
                      {previewResult.triggered.length}
                      {UI_COPY.worldbook.previewTriggeredSuffix}
                    </span>
                    {previewResult.truncated ? (
                      <Badge className="shrink-0" tone="warning">
                        {UI_COPY.worldbook.previewTruncated}
                      </Badge>
                    ) : null}
                  </div>
                  <details>
                    <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                      {UI_COPY.worldbook.previewTriggeredList}
                    </summary>
                    <div className="mt-2 grid gap-2">
                      {previewResult.triggered.length === 0 ? (
                        <div className="text-sm text-subtext">{UI_COPY.worldbook.previewNoTriggered}</div>
                      ) : (
                        previewResult.triggered.map((t) => (
                          <div key={t.id} className="rounded-atelier border border-border bg-canvas p-2 text-xs">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-ink">{t.title}</div>
                                <div className="mt-1 text-subtext">
                                  {t.reason} | priority:{t.priority}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </details>
                  <details open>
                    <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                      {UI_COPY.worldbook.previewText}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-atelier border border-border bg-canvas p-3 text-xs text-ink">
                      {previewResult.text_md || UI_COPY.worldbook.previewTextEmpty}
                    </pre>
                  </details>
                </div>
              ) : null}
            </div>
          </div>

          <label className="grid gap-1">
            <span className="text-xs text-subtext">{UI_COPY.worldbook.formTitle}</span>
            <input
              id="worldbook_entry_title"
              className="input"
              disabled={saving}
              name="title"
              value={form.title}
              onChange={(e) => setForm((v) => ({ ...v, title: e.target.value }))}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-2 text-sm text-ink">
              <span>{UI_COPY.worldbook.formEnabled}</span>
              <input
                id="worldbook_entry_enabled"
                className="checkbox"
                checked={form.enabled}
                disabled={saving}
                name="enabled"
                onChange={(e) => setForm((v) => ({ ...v, enabled: e.target.checked }))}
                type="checkbox"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-ink">
              <span>{UI_COPY.worldbook.formConstant}</span>
              <input
                id="worldbook_entry_constant"
                className="checkbox"
                checked={form.constant}
                disabled={saving}
                name="constant"
                onChange={(e) => setForm((v) => ({ ...v, constant: e.target.checked }))}
                type="checkbox"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-ink">
              <span>{UI_COPY.worldbook.formExcludeRecursion}</span>
              <input
                id="worldbook_entry_exclude_recursion"
                className="checkbox"
                checked={form.exclude_recursion}
                disabled={saving}
                name="exclude_recursion"
                onChange={(e) => setForm((v) => ({ ...v, exclude_recursion: e.target.checked }))}
                type="checkbox"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-ink">
              <span>{UI_COPY.worldbook.formPreventRecursion}</span>
              <input
                id="worldbook_entry_prevent_recursion"
                className="checkbox"
                checked={form.prevent_recursion}
                disabled={saving}
                name="prevent_recursion"
                onChange={(e) => setForm((v) => ({ ...v, prevent_recursion: e.target.checked }))}
                type="checkbox"
              />
            </label>
            <label className="grid gap-1 sm:col-span-2">
              <span className="text-xs text-subtext">{UI_COPY.worldbook.formKeywords}</span>
              <textarea
                id="worldbook_entry_keywords"
                className="textarea atelier-content"
                disabled={saving}
                name="keywords"
                rows={2}
                value={form.keywords_raw}
                onChange={(e) => setForm((v) => ({ ...v, keywords_raw: e.target.value }))}
              />
              <div className="text-[11px] text-subtext">{UI_COPY.worldbook.formKeywordsHint}</div>
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-subtext">{UI_COPY.worldbook.formCharLimit}</span>
              <input
                id="worldbook_entry_char_limit"
                className="input"
                disabled={saving}
                min={0}
                name="char_limit"
                type="number"
                value={form.char_limit}
                onChange={(e) => setForm((v) => ({ ...v, char_limit: e.currentTarget.valueAsNumber }))}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-subtext">{UI_COPY.worldbook.formPriority}</span>
              <select
                id="worldbook_entry_priority"
                className="select"
                disabled={saving}
                name="priority"
                value={form.priority}
                onChange={(e) => setForm((v) => ({ ...v, priority: e.target.value as WorldBookPriority }))}
              >
                <option value="must">must</option>
                <option value="important">important</option>
                <option value="optional">optional</option>
                <option value="drop_first">drop_first</option>
              </select>
            </label>
          </div>

          <label className="grid gap-1">
            <span className="text-xs text-subtext">{UI_COPY.worldbook.formContent}</span>
            <textarea
              id="worldbook_entry_content_md"
              className="textarea atelier-content"
              disabled={saving}
              name="content_md"
              rows={10}
              value={form.content_md}
              onChange={(e) => setForm((v) => ({ ...v, content_md: e.target.value }))}
            />
          </label>

          <div className="flex items-center justify-end gap-2">
            <button className="btn btn-secondary" disabled={saving} onClick={() => void closeDrawer()} type="button">
              {UI_COPY.worldbook.cancel}
            </button>
            <button
              className="btn btn-primary"
              disabled={saving || !dirty}
              onClick={() => void saveEntry()}
              type="button"
            >
              {saving ? UI_COPY.worldbook.saving : UI_COPY.worldbook.save}
            </button>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
