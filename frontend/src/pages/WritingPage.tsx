import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { GhostwriterIndicator } from "../components/atelier/GhostwriterIndicator";
import { MarkdownEditor } from "../components/atelier/MarkdownEditor";
import { WizardNextBar } from "../components/atelier/WizardNextBar";
import { ToolContent } from "../components/layout/AppShell";
import { Drawer } from "../components/ui/Drawer";
import { ProgressBar } from "../components/ui/ProgressBar";
import { AiGenerateDrawer } from "../components/writing/AiGenerateDrawer";
import { BatchGenerationModal } from "../components/writing/BatchGenerationModal";
import { ChapterListPanel } from "../components/writing/ChapterListPanel";
import { ChapterDiffDrawer } from "../components/writing/ChapterDiffDrawer";
import { CreateChapterDialog } from "../components/writing/CreateChapterDialog";
import { ChapterAnalysisModal } from "../components/writing/ChapterAnalysisModal";
import { ChapterPlanSidebar } from "../components/writing/ChapterPlanSidebar";
import { ContentOptimizeCompareDrawer } from "../components/writing/ContentOptimizeCompareDrawer";
import { ContextPreviewDrawer } from "../components/writing/ContextPreviewDrawer";
import { ForeshadowDrawer } from "../components/writing/ForeshadowDrawer";
import { GenerationHistoryDrawer } from "../components/writing/GenerationHistoryDrawer";
import { MemoryUpdateDrawer } from "../components/writing/MemoryUpdateDrawer";
import { PostEditCompareDrawer } from "../components/writing/PostEditCompareDrawer";
import { PromptInspectorDrawer } from "../components/writing/PromptInspectorDrawer";
import { TablesPanel } from "../components/writing/TablesPanel";
import { WritingStatsBar } from "../components/writing/WritingStatsBar";
import { WritingToolbar } from "../components/writing/WritingToolbar";
import { useConfirm } from "../components/ui/confirm";
import { useToast } from "../components/ui/toast";
import { usePersistentOutletIsActive } from "../hooks/usePersistentOutlet";
import { useProjectData } from "../hooks/useProjectData";
import { useWizardProgress } from "../hooks/useWizardProgress";
import { UnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { ApiError, apiJson } from "../services/apiClient";
import { chapterStore } from "../services/chapterStore";
import { getWizardProjectChangedAt } from "../services/wizard";
import { useApplyGenerationRun } from "./writing/useApplyGenerationRun";
import { useBatchGeneration } from "./writing/useBatchGeneration";
import { useChapterAnalysis } from "./writing/useChapterAnalysis";
import { useChapterCrud } from "./writing/useChapterCrud";
import { useChapterEditor } from "./writing/useChapterEditor";
import { useChapterGeneration } from "./writing/useChapterGeneration";
import { useGenerationHistory } from "./writing/useGenerationHistory";
import { useOutlineSwitcher } from "./writing/useOutlineSwitcher";
import { humanizeChapterStatus } from "../lib/humanize";
import type { ChapterStatus, Character, LLMPreset, Outline, OutlineListItem } from "../types";

type WritingLoaded = { outlines: OutlineListItem[]; outline: Outline; preset: LLMPreset; characters: Character[] };

const CHAPTER_LIST_SIDEBAR_WIDTH_CLASS = "w-[260px]" as const;

type ChapterAutoUpdatesTriggerResult = {
  tasks: Record<string, string | null>;
  chapter_token: string | null;
};

type EditorView = "outline" | "draft" | "final" | "polish";

type OutlineGenChapter = { number: number; title: string; beats: string[] };
type OutlineGenResult = {
  outline_md: string;
  chapters: OutlineGenChapter[];
  raw_output: string;
  parse_error?: { code: string; message: string };
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function pickFirstProjectTaskId(tasks: Record<string, string | null> | null | undefined): string | null {
  if (!tasks) return null;
  for (const v of Object.values(tasks)) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function WritingPage() {
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedChapterId = searchParams.get("chapterId");
  const applyRunId = searchParams.get("applyRunId");
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const outletActive = usePersistentOutletIsActive();
  const wizard = useWizardProgress(projectId);
  const refreshWizard = wizard.refresh;
  const bumpWizardLocal = wizard.bumpLocal;
  const lastProjectChangedAtRef = useRef<string | null>(null);

  const [chapterListOpen, setChapterListOpen] = useState(false);
  const writingQuery = useProjectData<WritingLoaded>(projectId, async (id) => {
    const [outlineRes, presetRes, charactersRes] = await Promise.all([
      apiJson<{ outline: Outline }>(`/api/projects/${id}/outline`),
      apiJson<{ llm_preset: LLMPreset }>(`/api/projects/${id}/llm_preset`),
      apiJson<{ characters: Character[] }>(`/api/projects/${id}/characters`),
    ]);
    const outlinesRes = await apiJson<{ outlines: OutlineListItem[] }>(`/api/projects/${id}/outlines`);
    return {
      outlines: outlinesRes.data.outlines,
      outline: outlineRes.data.outline,
      preset: presetRes.data.llm_preset,
      characters: charactersRes.data.characters,
    };
  });
  const outlines = writingQuery.data?.outlines ?? [];
  const outline = writingQuery.data?.outline ?? null;
  const characters = writingQuery.data?.characters ?? [];
  const preset = writingQuery.data?.preset ?? null;
  const refreshWriting = writingQuery.refresh;

  const chapterEditor = useChapterEditor({
    projectId,
    requestedChapterId,
    searchParams,
    setSearchParams,
    toast,
    confirm,
    refreshWizard,
    bumpWizardLocal,
  });
  const {
    loading,
    chapters,
    refreshChapters,
    activeId,
    setActiveId,
    activeChapter,
    baseline,
    form,
    setForm,
    dirty,
    saveChapter,
    requestSelectChapter: requestSelectChapterBase,
    loadingChapter,
    saving,
  } = chapterEditor;
  const contentTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [contentEditorTab, setContentEditorTab] = useState<"edit" | "preview">("edit");
  const [editorView, setEditorView] = useState<EditorView>("draft");

  useEffect(() => {
    if (!projectId) {
      lastProjectChangedAtRef.current = null;
      return;
    }
    lastProjectChangedAtRef.current = getWizardProjectChangedAt(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    if (!outletActive) return;
    if (dirty) return;

    const changedAt = getWizardProjectChangedAt(projectId);
    if ((changedAt ?? null) === (lastProjectChangedAtRef.current ?? null)) return;
    lastProjectChangedAtRef.current = changedAt;

    void refreshWriting();
    void refreshChapters();
    void refreshWizard();
  }, [dirty, outletActive, projectId, refreshChapters, refreshWriting, refreshWizard]);

  const [aiOpen, setAiOpen] = useState(false);
  const [promptInspectorOpen, setPromptInspectorOpen] = useState(false);
  const [postEditCompareOpen, setPostEditCompareOpen] = useState(false);
  const [contentOptimizeCompareOpen, setContentOptimizeCompareOpen] = useState(false);
  const [chapterDiffOpen, setChapterDiffOpen] = useState(false);
  const [quickStartRunning, setQuickStartRunning] = useState(false);
  const [tablesOpen, setTablesOpen] = useState(false);
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [memoryUpdateOpen, setMemoryUpdateOpen] = useState(false);
  const [foreshadowOpen, setForeshadowOpen] = useState(false);
  const [autoUpdatesTriggering, setAutoUpdatesTriggering] = useState(false);
  const autoGenerateNextRef = useRef<{ chapterId: string; mode: "replace" | "append" } | null>(null);
  const isDoneReadonly = Boolean(baseline && form && baseline.status === "done" && form.status === "done");

  useEffect(() => {
    if (!activeChapter) autoGenerateNextRef.current = null;
  }, [activeChapter]);

  useApplyGenerationRun({
    applyRunId,
    activeChapter,
    form,
    dirty,
    confirm,
    toast,
    saveChapter,
    searchParams,
    setSearchParams,
    setForm,
  });

  const requestSelectChapter = useCallback(
    async (id: string) => {
      autoGenerateNextRef.current = null;
      return await requestSelectChapterBase(id);
    },
    [requestSelectChapterBase],
  );

  const chapterCrud = useChapterCrud({
    projectId,
    chapters,
    activeChapter,
    setActiveId,
    requestSelectChapter,
    toast,
    confirm,
    bumpWizardLocal,
    refreshWizard,
  });

  const chapterListEmptyState = (
    <div className="grid gap-2 text-center text-sm text-subtext">
      <div>暂无章节</div>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          className="btn btn-primary"
          disabled={quickStartRunning}
          onClick={() => {
            setChapterListOpen(false);
            void autoOutlineAndChapters();
          }}
          type="button"
        >
          {quickStartRunning ? "生成中..." : "一键生成大纲+章节"}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => {
            setChapterListOpen(false);
            chapterCrud.openCreate();
          }}
          type="button"
        >
          新建章节
        </button>
        <button
          className="btn btn-secondary"
          disabled={!projectId}
          onClick={() => {
            if (!projectId) return;
            setChapterListOpen(false);
            navigate(`/projects/${projectId}/outline`);
          }}
          type="button"
        >
          前往大纲
        </button>
        <button
          className="btn btn-secondary"
          disabled={!projectId}
          onClick={() => {
            if (!projectId) return;
            setChapterListOpen(false);
            navigate(`/projects/${projectId}/wizard`);
          }}
          type="button"
        >
          开工向导
        </button>
      </div>
    </div>
  );

  const editorViewOptions: { key: EditorView; label: string; hint: string }[] = [
    { key: "outline", label: "大纲", hint: "聚焦本章要点与摘要" },
    { key: "draft", label: "草稿", hint: "编辑正文内容" },
    { key: "final", label: "成稿", hint: "只读预览与校对" },
    { key: "polish", label: "润色", hint: "调用 AI 进行润色/优化" },
  ];
  const editorViewHint = editorViewOptions.find((v) => v.key === editorView)?.hint ?? "";

  const generation = useChapterGeneration({
    projectId,
    activeChapter,
    chapters,
    form,
    setForm,
    preset,
    dirty,
    saveChapter,
    requestSelectChapter,
    toast,
    confirm,
  });
  const {
    generating,
    genRequestId,
    genStreamProgress,
    genForm,
    setGenForm,
    postEditCompare,
    applyPostEditVariant,
    contentOptimizeCompare,
    applyContentOptimizeVariant,
    generate,
    abortGenerate,
  } = generation;

  const batch = useBatchGeneration({
    projectId,
    preset,
    activeChapter,
    chapters,
    refreshChapters,
    genForm,
    searchParams,
    setSearchParams,
    requestSelectChapter,
    toast,
  });

  const analysis = useChapterAnalysis({ activeChapter, preset, genForm, form, setForm, dirty, saveChapter, toast });
  const history = useGenerationHistory({ projectId, toast });

  const activeOutlineId = outline?.id ?? "";
  const switchOutline = useOutlineSwitcher({
    projectId,
    activeOutlineId,
    dirty,
    confirm,
    toast,
    saveChapter,
    bumpWizardLocal,
    refreshWizard,
    refreshChapters,
    refreshWriting,
  });

  const selectedCharacterNames = useMemo(() => {
    const ids = new Set(genForm.context.character_ids ?? []);
    if (!ids.size) return [];
    return characters
      .filter((c) => ids.has(c.id))
      .map((c) => c.name)
      .filter((v): v is string => Boolean(v && v.trim()));
  }, [characters, genForm.context.character_ids]);

  const locateInEditor = useCallback(
    (excerpt: string) => {
      if (!excerpt || !form) return;
      const needleRaw = excerpt.trim();
      if (!needleRaw) return;

      const haystack = form.content_md ?? "";
      let needle = needleRaw;
      let index = haystack.indexOf(needle);
      if (index < 0 && needle.length > 20) {
        needle = needle.slice(0, 20);
        index = haystack.indexOf(needle);
      }
      if (index < 0) {
        toast.toastError("未在正文中找到该引用片段（可复制后 Ctrl/Cmd+F 搜索）");
        return;
      }

      setContentEditorTab("edit");
      window.requestAnimationFrame(() => {
        const el = contentTextareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(index, Math.min(haystack.length, index + needle.length));
      });
    },
    [contentTextareaRef, form, setContentEditorTab, toast],
  );

  const saveAndTriggerAutoUpdates = useCallback(async () => {
    if (!projectId || !activeChapter) return;
    if (autoUpdatesTriggering) return;
    if (!dirty) return;

    setAutoUpdatesTriggering(true);
    try {
      const ok = await saveChapter({ silent: true });
      if (!ok) return;

      const res = await apiJson<ChapterAutoUpdatesTriggerResult>(
        `/api/chapters/${activeChapter.id}/trigger_auto_updates`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      const taskId = pickFirstProjectTaskId(res.data.tasks);
      toast.toastSuccess(
        "已保存并创建无感更新任务",
        res.request_id,
        taskId
          ? {
              label: "打开 TaskCenter",
              onClick: () => navigate(`/projects/${projectId}/tasks?project_task_id=${encodeURIComponent(taskId)}`),
            }
          : undefined,
      );
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setAutoUpdatesTriggering(false);
    }
  }, [activeChapter, autoUpdatesTriggering, dirty, projectId, saveChapter, toast, navigate]);

  const saveAndGenerateNext = useCallback(async () => {
    if (!activeChapter) return;

    const ok = await saveChapter();
    if (!ok) return;

    const sorted = [...chapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const idx = sorted.findIndex((c) => c.id === activeChapter.id);
    const next =
      idx >= 0
        ? (sorted[idx + 1] ?? null)
        : (sorted.find((c) => (c.number ?? 0) > (activeChapter.number ?? 0)) ?? null);

    if (!next) {
      toast.toastSuccess("已保存，已是最后一章");
      return;
    }

    const nextHasContent = Boolean(next.has_content || next.has_summary);
    if (nextHasContent) {
      const replaceOk = await confirm.confirm({
        title: `下一章（第 ${next.number} 章）已有内容，仍要开始生成？`,
        description: "将以“替换”模式生成草稿（生成结果不会自动保存）。",
        confirmText: "继续",
        cancelText: "取消",
        danger: true,
      });
      if (!replaceOk) return;
    }

    autoGenerateNextRef.current = { chapterId: next.id, mode: "replace" };
    setActiveId(next.id);
    setAiOpen(true);
  }, [activeChapter, chapters, confirm, saveChapter, setActiveId, setAiOpen, toast]);

  const restoreToBaseline = useCallback(async () => {
    if (!baseline || !form) return;
    if (!dirty) return;
    const ok = await confirm.confirm({
      title: "恢复到已保存版本？",
      description: "将丢弃未保存修改。",
      confirmText: "恢复",
      danger: true,
    });
    if (!ok) return;
    setForm({ ...baseline });
    toast.toastSuccess("已恢复到已保存版本");
  }, [baseline, confirm, dirty, form, setForm, toast]);

  const openPolish = useCallback(
    (mode: "post_edit" | "content_optimize") => {
      if (!activeChapter) {
        toast.toastWarning("请先选择章节再进行润色/优化。");
        return;
      }
      setGenForm((v) => ({
        ...v,
        post_edit: mode === "post_edit",
        post_edit_sanitize: mode === "post_edit",
        content_optimize: mode === "content_optimize",
      }));
      setAiOpen(true);
    },
    [activeChapter, setAiOpen, setGenForm, toast],
  );

  const runSelfCheck = useCallback(async () => {
    if (!activeChapter || !form) {
      toast.toastWarning("请先选择章节再进行自检。");
      return;
    }
    analysis.openModal();
    await analysis.analyzeChapter();
  }, [activeChapter, analysis, form, toast]);

  const autoOutlineAndChapters = useCallback(async () => {
    if (!projectId) return;
    if (quickStartRunning) return;
    if (!preset) {
      toast.toastError("请先在 Prompts 页保存 LLM 配置");
      navigate(`/projects/${projectId}/prompts`);
      return;
    }

    const ok = await confirm.confirm({
      title: "一键生成大纲并创建章节骨架？",
      description: "将调用模型生成大纲，并创建章节骨架，完成后会跳到首章生成。",
      confirmText: "开始",
    });
    if (!ok) return;

    setQuickStartRunning(true);
    try {
      const headers: Record<string, string> = { "X-LLM-Provider": preset.provider };
      const outlineGen = await apiJson<OutlineGenResult>(`/api/projects/${projectId}/outline/generate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          requirements: {
            chapter_count: 12,
            tone: "偏现实，克制但有爆点",
            pacing: "前3章强钩子，中段升级，结尾反转",
          },
          context: {
            include_world_setting: true,
            include_characters: true,
          },
        }),
      });

      const outlineMd = outlineGen.data.outline_md ?? "";
      const genChapters = outlineGen.data.chapters ?? [];
      if (genChapters.length === 0) {
        toast.toastError("已生成大纲，但未解析出章节结构；请到大纲页手动调整并创建章节。");
        navigate(`/projects/${projectId}/outline`);
        return;
      }

      await apiJson<{ outline: Outline }>(`/api/projects/${projectId}/outlines`, {
        method: "POST",
        body: JSON.stringify({
          title: `AI 大纲 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
          content_md: outlineMd,
          structure: { chapters: genChapters },
        }),
      });

      const payload = {
        chapters: genChapters.map((c) => ({
          number: c.number,
          title: c.title,
          plan: (c.beats ?? []).join("；"),
        })),
      };

      const created = await chapterStore.bulkCreateProjectChapters(projectId, payload);
      toast.toastSuccess(`已生成大纲并创建 ${created.length} 章`);
      bumpWizardLocal();
      await Promise.all([refreshWriting(), refreshChapters(), refreshWizard()]);
      const first = [...created].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))[0];
      if (first) {
        setActiveId(first.id);
        setAiOpen(true);
      }
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setQuickStartRunning(false);
    }
  }, [
    bumpWizardLocal,
    confirm,
    navigate,
    preset,
    projectId,
    quickStartRunning,
    refreshChapters,
    refreshWizard,
    refreshWriting,
    setActiveId,
    setAiOpen,
    toast,
  ]);

  const selectAdjacentChapter = useCallback(
    (direction: -1 | 1) => {
      if (chapters.length === 0) return;
      const sorted = [...chapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      const currentIndex = activeId ? sorted.findIndex((c) => c.id === activeId) : -1;
      const nextIndex =
        currentIndex < 0 ? (direction > 0 ? 0 : sorted.length - 1) : currentIndex + direction;
      const next = sorted[nextIndex] ?? null;
      if (!next) return;
      void requestSelectChapter(next.id);
    },
    [activeId, chapters, requestSelectChapter],
  );

  useEffect(() => {
    const overlayOpen =
      aiOpen ||
      promptInspectorOpen ||
      postEditCompareOpen ||
      contentOptimizeCompareOpen ||
      chapterDiffOpen ||
      tablesOpen ||
      contextPreviewOpen ||
      memoryUpdateOpen ||
      foreshadowOpen ||
      chapterListOpen ||
      batch.open ||
      analysis.open ||
      history.open ||
      chapterCrud.createOpen;

    if (overlayOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;

      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;

      if (mod && !e.shiftKey && !e.altKey && key === "enter") {
        if (!activeChapter) {
          toast.toastWarning("请先选择章节再进行 AI 生成。");
          return;
        }
        e.preventDefault();
        setAiOpen(true);
        return;
      }

      if (!mod && e.altKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        selectAdjacentChapter(e.key === "ArrowUp" ? -1 : 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeChapter,
    aiOpen,
    analysis.open,
    batch.open,
    chapterCrud.createOpen,
    chapterDiffOpen,
    chapterListOpen,
    contentOptimizeCompareOpen,
    contextPreviewOpen,
    foreshadowOpen,
    history.open,
    memoryUpdateOpen,
    postEditCompareOpen,
    promptInspectorOpen,
    selectAdjacentChapter,
    setAiOpen,
    tablesOpen,
    toast,
  ]);

  useEffect(() => {
    const pending = autoGenerateNextRef.current;
    if (!pending) return;
    if (!activeChapter || !form) return;
    if (activeChapter.id !== pending.chapterId) return;
    if (generating) return;
    autoGenerateNextRef.current = null;
    void generate(pending.mode);
  }, [activeChapter, form, generate, generating]);

  const planField = (
    <label className="grid gap-1">
      <span className="text-xs text-subtext">本章要点</span>
      <textarea
        className="textarea atelier-content"
        name="plan"
        rows={4}
        value={form?.plan ?? ""}
        readOnly={isDoneReadonly}
        onChange={(e) => {
          setForm((v) => (v ? { ...v, plan: e.target.value } : v));
        }}
      />
    </label>
  );

  const summaryField = (
    <label className="grid gap-1">
      <span className="text-xs text-subtext">摘要（可选）</span>
      <textarea
        className="textarea atelier-content"
        name="summary"
        rows={3}
        value={form?.summary ?? ""}
        readOnly={isDoneReadonly}
        onChange={(e) => {
          setForm((v) => (v ? { ...v, summary: e.target.value } : v));
        }}
      />
    </label>
  );

  const contentField = (
    <label className="grid gap-1">
      <span className="text-xs text-subtext">正文（Markdown）</span>
      <MarkdownEditor
        value={form?.content_md ?? ""}
        onChange={(next) => {
          setForm((v) => (v ? { ...v, content_md: next } : v));
        }}
        placeholder="开始写作..."
        minRows={16}
        name="content_md"
        readOnly={isDoneReadonly}
        tab={contentEditorTab}
        onTabChange={setContentEditorTab}
        textareaRef={(el) => {
          contentTextareaRef.current = el;
        }}
      />
    </label>
  );

  if (loading) return <ToolContent className="text-subtext">加载中...</ToolContent>;

  return (
    <ToolContent className="grid gap-4 pb-24">
      {dirty && outletActive ? <UnsavedChangesGuard when={dirty} /> : null}
      <WritingToolbar
        outlines={outlines}
        activeOutlineId={activeOutlineId}
        chaptersCount={chapters.length}
        batchProgressText={
          batch.batchTask && (batch.batchTask.status === "queued" || batch.batchTask.status === "running")
            ? `（${batch.batchTask.completed_count}/${batch.batchTask.total_count}）`
            : ""
        }
        aiGenerateDisabled={!activeChapter || loadingChapter}
        onSwitchOutline={(outlineId) => void switchOutline(outlineId)}
        onOpenChapterList={() => setChapterListOpen(true)}
        onOpenBatch={batch.openModal}
        onOpenHistory={history.openDrawer}
        onOpenAiGenerate={() => setAiOpen(true)}
        onOpenMemoryUpdate={() => {
          if (!activeChapter) return;
          if (dirty) {
            toast.toastWarning("请先保存当前章节后再进行记忆更新。");
            return;
          }
          if (activeChapter.status !== "done") {
            toast.toastWarning(
              `仅状态为 ${humanizeChapterStatus("done")} 的章节允许记忆更新；请先将章节标记为 ${humanizeChapterStatus("done")}。`,
            );
            return;
          }
          setMemoryUpdateOpen(true);
        }}
        onOpenTaskCenter={() => {
          if (!projectId) return;
          const qs = new URLSearchParams();
          if (activeId) qs.set("chapterId", activeId);
          navigate(`/projects/${projectId}/tasks${qs.toString() ? `?${qs.toString()}` : ""}`);
        }}
        onOpenForeshadow={() => setForeshadowOpen(true)}
        onOpenTables={() => setTablesOpen(true)}
        onOpenContextPreview={() => setContextPreviewOpen(true)}
        onCreateChapter={chapterCrud.openCreate}
      />

      <div className="flex gap-4">
        <aside className={`hidden ${CHAPTER_LIST_SIDEBAR_WIDTH_CLASS} shrink-0 lg:block`}>
          <ChapterListPanel
            chapters={chapters}
            activeId={activeId}
            projectId={projectId}
            onSelectChapter={(chapterId) => void requestSelectChapter(chapterId)}
            emptyState={chapterListEmptyState}
          />
        </aside>

        <section className="min-w-0 flex-1">
                    {!activeChapter || !form ? (
            <div className="mx-auto w-full max-w-4xl rounded-atelier border border-border bg-surface p-8 text-sm text-subtext shadow-sm">
              {chapters.length === 0 ? (
                <div className="grid gap-4">
                  <div className="font-content text-xl text-ink">还没有章节</div>
                  <div className="text-sm text-subtext">建议按 3 步完成首章生成：</div>
                  <ol className="list-decimal pl-5 text-sm text-subtext">
                    <li>完善大纲，或使用 AI 生成大纲。</li>
                    <li>从大纲生成章节骨架。</li>
                    <li>回到写作页，用 AI 生成首章或开始编辑。</li>
                  </ol>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn btn-primary"
                      disabled={quickStartRunning}
                      onClick={() => void autoOutlineAndChapters()}
                      type="button"
                    >
                      {quickStartRunning ? "生成中..." : "一键生成大纲+章节"}
                    </button>
                    <button className="btn btn-secondary" onClick={chapterCrud.openCreate} type="button">
                      新建章节
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={!projectId}
                      onClick={() => {
                        if (!projectId) return;
                        navigate(`/projects/${projectId}/outline`);
                      }}
                      type="button"
                    >
                      前往大纲
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={!projectId}
                      onClick={() => {
                        if (!projectId) return;
                        navigate(`/projects/${projectId}/wizard`);
                      }}
                      type="button"
                    >
                      开工向导
                    </button>
                  </div>
                  <div className="text-xs text-subtext">
                    快捷键：Ctrl/Cmd+Enter 打开 AI 生成 · Alt+Up/Down 切换章节
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 text-sm text-subtext">
                  <div>请选择章节开始写作，或新建章节。</div>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn btn-primary" onClick={chapterCrud.openCreate} type="button">
                      新建章节
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mx-auto w-full max-w-4xl rounded-atelier border border-border bg-surface p-5 shadow-sm">
              {isDoneReadonly ? (
                <div className="callout-warning mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs">
                    本章已定稿：为避免误操作，编辑区默认只读。如需修改，请先回退为 {humanizeChapterStatus("drafting")}。
                  </div>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setForm((v) => (v ? { ...v, status: "drafting" } : v))}
                    type="button"
                  >
                    回退为 {humanizeChapterStatus("drafting")} 并编辑
                  </button>
                </div>
              ) : null}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-content text-2xl text-ink">
                    第 {activeChapter.number} 章 <span className="text-subtext">{dirty ? "（未保存）" : ""}</span>
                  </div>
                  <div className="mt-1 text-xs text-subtext">
                    已保存：{activeChapter.updated_at}
                    <span className="mx-2 text-subtext/60">·</span>
                    状态：{dirty ? "未保存" : "已保存"}
                    <span className="mx-2 text-subtext/60">·</span>
                    自动保存：开启
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={loadingChapter || generating}
                    onClick={analysis.openModal}
                    type="button"
                  >
                    分析
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={!activeChapter || loadingChapter}
                    onClick={() => setChapterDiffOpen(true)}
                    type="button"
                  >
                    对比
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={!projectId || loadingChapter || generating}
                    onClick={() => {
                      if (!projectId || !activeChapter) return;
                      navigate(`/projects/${projectId}/chapter-analysis?chapterId=${activeChapter.id}`);
                    }}
                    type="button"
                  >
                    标注回溯
                  </button>
                  <button
                    className="btn btn-ghost text-accent hover:bg-accent/10"
                    disabled={loadingChapter || generating}
                    onClick={() => void chapterCrud.deleteChapter()}
                    type="button"
                  >
                    删除
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={!dirty || loadingChapter || saving || generating}
                    onClick={() => void restoreToBaseline()}
                    type="button"
                  >
                    恢复到已保存
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={!dirty || saving || loadingChapter || generating || autoUpdatesTriggering}
                    onClick={() => void saveAndTriggerAutoUpdates()}
                    type="button"
                  >
                    {autoUpdatesTriggering ? "保存并触发中..." : "一键保存并触发更新"}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!dirty || saving || loadingChapter || generating}
                    onClick={() => void saveChapter()}
                    type="button"
                  >
                    {saving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>

              {generating ? (
                <GhostwriterIndicator
                  className="mt-4"
                  label={
                    genForm.stream && genStreamProgress
                      ? `${genStreamProgress.message}（${genStreamProgress.progress}%）`
                      : "墨迹渗入纸张中…生成需要一点时间"
                  }
                />
              ) : null}

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <label className="grid gap-1 sm:col-span-2">
                  <span className="text-xs text-subtext">标题</span>
                  <input
                    className="input-underline font-content text-xl"
                    name="title"
                    value={form.title}
                    readOnly={isDoneReadonly}
                    onChange={(e) => {
                      setForm((v) => (v ? { ...v, title: e.target.value } : v));
                    }}
                  />
                </label>
                <label className="grid gap-1 sm:col-span-1">
                  <span className="text-xs text-subtext">状态</span>
                  <select
                    className="select"
                    name="status"
                    value={form.status}
                    onChange={(e) => {
                      const next = e.target.value as ChapterStatus;
                      setForm((v) => (v ? { ...v, status: next } : v));
                    }}
                  >
                    <option value="planned">{humanizeChapterStatus("planned")}</option>
                    <option value="drafting">{humanizeChapterStatus("drafting")}</option>
                    <option value="proofreading">{humanizeChapterStatus("proofreading")}</option>
                    <option value="done">{humanizeChapterStatus("done")}</option>
                  </select>
                  <div className="text-[11px] text-subtext">
                    状态流转：{humanizeChapterStatus("planned")} → {humanizeChapterStatus("drafting")} →{" "}
                    {humanizeChapterStatus("proofreading")} → {humanizeChapterStatus("done")}。仅状态为{" "}
                    {humanizeChapterStatus("done")} 的章节允许进行记忆更新（Memory Update）写入长期记忆；定稿章默认只读，
                    修改请先切回 {humanizeChapterStatus("drafting")}。
                  </div>
                </label>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-subtext">视图</span>
                  {editorViewOptions.map((view) => (
                    <button
                      key={view.key}
                      className={editorView === view.key ? "btn btn-primary" : "btn btn-secondary"}
                      onClick={() => setEditorView(view.key)}
                      type="button"
                    >
                      {view.label}
                    </button>
                  ))}
                </div>
                <div className="text-xs text-subtext">{editorViewHint}</div>
              </div>

              {editorView === "outline" ? (
                <div className="mt-4 grid gap-3">
                  {planField}
                  {summaryField}
                </div>
              ) : editorView === "draft" ? (
                <div className="mt-4 grid gap-3">
                  {planField}
                  {contentField}
                  {summaryField}
                </div>
              ) : editorView === "final" ? (
                <div className="mt-4 grid gap-3">
                  <div className="rounded-atelier border border-border bg-surface p-4">
                    <div className="text-xs text-subtext">正文预览</div>
                    <div className="atelier-content max-w-none pt-3 text-ink">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {form.content_md ? form.content_md : "_（空）_"}
                      </ReactMarkdown>
                    </div>
                  </div>
                  <div className="rounded-atelier border border-border bg-surface p-4">
                    <div className="text-xs text-subtext">摘要</div>
                    <div className="mt-2 whitespace-pre-wrap text-sm text-ink">{form.summary?.trim() || "（空）"}</div>
                  </div>
                  <div className="rounded-atelier border border-border bg-surface p-4">
                    <div className="text-sm text-ink">记忆摘要层</div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-atelier border border-border bg-canvas p-3">
                        <div className="text-[11px] text-subtext">章节</div>
                        <div className="mt-1 text-sm text-ink">{form.title?.trim() || "（未命名）"}</div>
                        <div className="mt-1 text-xs text-subtext">
                          {form.summary?.trim() || "（摘要为空，可在草稿视图补充）"}
                        </div>
                      </div>
                      <div className="rounded-atelier border border-border bg-canvas p-3">
                        <div className="text-[11px] text-subtext">情节</div>
                        <div className="mt-1 whitespace-pre-wrap text-xs text-ink">
                          {form.plan?.trim() || "（要点为空，可在大纲/草稿视图补充）"}
                        </div>
                      </div>
                      <div className="rounded-atelier border border-border bg-canvas p-3">
                        <div className="text-[11px] text-subtext">人物弧</div>
                        {selectedCharacterNames.length ? (
                          <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink">
                            {selectedCharacterNames.map((name) => (
                              <span key={name} className="rounded-atelier border border-border bg-surface px-2 py-0.5">
                                {name}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-1 text-xs text-subtext">（未选择角色，可在 AI 生成面板中勾选）</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 grid gap-3">
                  <div className="rounded-atelier border border-border bg-surface p-4">
                    <div className="text-sm text-ink">润色与优化</div>
                    <div className="mt-1 text-xs text-subtext">
                      将调用 AI 进行润色或正文优化；生成结果不会自动保存，可用“章节对比”查看差异。
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn btn-primary" onClick={() => openPolish("post_edit")} type="button">
                        一键润色
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => openPolish("content_optimize")}
                        type="button"
                      >
                        正文优化
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={!activeChapter}
                        onClick={() => setChapterDiffOpen(true)}
                        type="button"
                      >
                        查看对比
                      </button>
                    </div>
                  </div>
                  <div className="rounded-atelier border border-border bg-canvas p-3 text-xs text-subtext">
                    提示：若需修改润色参数，可先打开 AI 生成面板再调整高级选项。
                  </div>
                </div>
              )}

              <div className="mt-4">
                <WritingStatsBar
                  chapters={chapters}
                  currentContentMd={form?.content_md ?? ""}
                  currentChapterNumber={activeChapter?.number ?? null}
                />
              </div>
            </div>
          )}
        </section>

        {activeChapter && form ? (
          <ChapterPlanSidebar
            plan={form.plan ?? ""}
            summary={form.summary ?? ""}
            chapterNumber={activeChapter.number ?? null}
            readOnly={isDoneReadonly}
            onPlanChange={(v) => setForm((prev) => (prev ? { ...prev, plan: v } : prev))}
          />
        ) : null}
      </div>

      <CreateChapterDialog
        open={chapterCrud.createOpen}
        saving={chapterCrud.createSaving}
        form={chapterCrud.createForm}
        setForm={chapterCrud.setCreateForm}
        onClose={() => chapterCrud.setCreateOpen(false)}
        onSubmit={() => void chapterCrud.createChapter()}
      />

      <BatchGenerationModal
        open={batch.open}
        batchLoading={batch.batchLoading}
        activeChapterNumber={activeChapter?.number ?? null}
        batchCount={batch.batchCount}
        setBatchCount={batch.setBatchCount}
        batchIncludeExisting={batch.batchIncludeExisting}
        setBatchIncludeExisting={batch.setBatchIncludeExisting}
        batchTask={batch.batchTask}
        batchItems={batch.batchItems}
        batchRuntime={batch.batchRuntime}
        projectTaskStreamStatus={batch.projectTaskStreamStatus}
        taskCenterHref={
          projectId && batch.batchTask?.project_task_id
            ? `/projects/${projectId}/tasks?project_task_id=${encodeURIComponent(batch.batchTask.project_task_id)}`
            : null
        }
        onClose={batch.closeModal}
        onCancelTask={() => void batch.cancelBatchGeneration()}
        onPauseTask={() => void batch.pauseBatchGeneration()}
        onResumeTask={() => void batch.resumeBatchGeneration()}
        onRetryFailedTask={() => void batch.retryFailedBatchGeneration()}
        onSkipFailedTask={() => void batch.skipFailedBatchGeneration()}
        onStartTask={() => void batch.startBatchGeneration()}
        onApplyItemToEditor={(it) => void batch.applyBatchItemToEditor(it)}
        batchApplying={batch.batchApplying}
        onApplyAllToEditor={() => void batch.applyAllToEditor()}
      />

      <ChapterAnalysisModal
        open={analysis.open}
        analysisLoading={analysis.analysisLoading}
        rewriteLoading={analysis.rewriteLoading}
        applyLoading={analysis.applyLoading}
        analysisFocus={analysis.analysisFocus}
        setAnalysisFocus={analysis.setAnalysisFocus}
        analysisResult={analysis.analysisResult}
        rewriteInstruction={analysis.rewriteInstruction}
        setRewriteInstruction={analysis.setRewriteInstruction}
        onClose={analysis.closeModal}
        onAnalyze={() => void analysis.analyzeChapter()}
        onApplyAnalysisToMemory={() => void analysis.applyAnalysisToMemory()}
        onLocateInEditor={locateInEditor}
        onRewriteFromAnalysis={() => void analysis.rewriteFromAnalysis()}
      />

      <Drawer
        open={chapterListOpen}
        onClose={() => setChapterListOpen(false)}
        side="left"
        overlayClassName="lg:hidden"
        ariaLabel="章节列表"
        panelClassName={`h-full ${CHAPTER_LIST_SIDEBAR_WIDTH_CLASS} overflow-hidden border-r border-border bg-surface shadow-sm`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm text-ink">章节列表</div>
          <button className="btn btn-secondary" onClick={() => setChapterListOpen(false)} type="button">
            关闭
          </button>
        </div>

        <div className="h-full p-2">
          <ChapterListPanel
            chapters={chapters}
            activeId={activeId}
            projectId={projectId}
            containerClassName="h-full"
            onSelectChapter={(chapterId) => {
              setChapterListOpen(false);
              void requestSelectChapter(chapterId);
            }}
            emptyState={chapterListEmptyState}
          />
        </div>
      </Drawer>

      <AiGenerateDrawer
        open={aiOpen}
        generating={generating}
        preset={preset}
        projectId={projectId}
        activeChapter={Boolean(activeChapter)}
        dirty={dirty}
        saving={saving || loadingChapter}
        genForm={genForm}
        setGenForm={setGenForm}
        characters={characters}
        streamProgress={genStreamProgress}
        onClose={() => setAiOpen(false)}
        onSave={() => void saveChapter()}
        onSaveAndGenerateNext={() => void saveAndGenerateNext()}
        onGenerateAppend={() => void generate("append")}
        onGenerateReplace={() => void generate("replace")}
        onCancelGenerate={abortGenerate}
        onOpenPromptInspector={() => setPromptInspectorOpen(true)}
        onOpenSelfCheck={runSelfCheck}
        postEditCompareAvailable={Boolean(postEditCompare)}
        onOpenPostEditCompare={() => setPostEditCompareOpen(true)}
        contentOptimizeCompareAvailable={Boolean(contentOptimizeCompare)}
        onOpenContentOptimizeCompare={() => setContentOptimizeCompareOpen(true)}
      />

      <PostEditCompareDrawer
        open={postEditCompareOpen && Boolean(postEditCompare)}
        onClose={() => setPostEditCompareOpen(false)}
        rawContentMd={postEditCompare?.rawContentMd ?? ""}
        editedContentMd={postEditCompare?.editedContentMd ?? ""}
        requestId={postEditCompare?.requestId ?? null}
        appliedChoice={postEditCompare?.appliedChoice ?? "post_edit"}
        onApplyRaw={() => void applyPostEditVariant("raw")}
        onApplyPostEdit={() => void applyPostEditVariant("post_edit")}
      />

      <ContentOptimizeCompareDrawer
        open={contentOptimizeCompareOpen && Boolean(contentOptimizeCompare)}
        onClose={() => setContentOptimizeCompareOpen(false)}
        rawContentMd={contentOptimizeCompare?.rawContentMd ?? ""}
        optimizedContentMd={contentOptimizeCompare?.optimizedContentMd ?? ""}
        requestId={contentOptimizeCompare?.requestId ?? null}
        appliedChoice={contentOptimizeCompare?.appliedChoice ?? "content_optimize"}
        onApplyRaw={() => void applyContentOptimizeVariant("raw")}
        onApplyOptimized={() => void applyContentOptimizeVariant("content_optimize")}
      />

      <ChapterDiffDrawer
        open={chapterDiffOpen && Boolean(activeChapter)}
        onClose={() => setChapterDiffOpen(false)}
        baselineContentMd={baseline?.content_md ?? ""}
        currentContentMd={form?.content_md ?? ""}
        baselineLabel={activeChapter?.updated_at ? `已保存：${activeChapter.updated_at}` : "已保存版本"}
        currentLabel={dirty ? "当前草稿（未保存）" : "当前版本"}
      />

      <PromptInspectorDrawer
        open={promptInspectorOpen}
        onClose={() => setPromptInspectorOpen(false)}
        preset={preset}
        chapterId={activeChapter?.id ?? undefined}
        draftContentMd={form?.content_md ?? ""}
        generating={generating}
        genForm={genForm}
        setGenForm={setGenForm}
        onGenerate={generate}
      />

      <ContextPreviewDrawer
        open={contextPreviewOpen}
        onClose={() => setContextPreviewOpen(false)}
        projectId={projectId}
        memoryInjectionEnabled={genForm.memory_injection_enabled}
        genInstruction={genForm.instruction}
        genChapterPlan={activeChapter?.plan ?? ""}
        genMemoryQueryText={genForm.memory_query_text}
        genMemoryModules={genForm.memory_modules}
        onChangeMemoryInjectionEnabled={(enabled) =>
          setGenForm((v) => ({ ...v, memory_injection_enabled: Boolean(enabled) }))
        }
      />

      <TablesPanel open={tablesOpen} onClose={() => setTablesOpen(false)} projectId={projectId} />

      <MemoryUpdateDrawer
        open={memoryUpdateOpen}
        onClose={() => setMemoryUpdateOpen(false)}
        projectId={projectId}
        chapterId={activeId ?? undefined}
      />

      <ForeshadowDrawer
        open={foreshadowOpen}
        onClose={() => setForeshadowOpen(false)}
        projectId={projectId}
        activeChapterId={activeId ?? undefined}
      />

      {generating && genForm.stream && !aiOpen ? (
        <div className="fixed inset-x-4 bottom-24 z-40 flex justify-center sm:inset-auto sm:bottom-8 sm:right-8 sm:justify-end">
          <div className="w-full max-w-sm rounded-atelier border border-border bg-surface/90 p-3 shadow-sm backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-ink">AI 流式生成中</div>
                <div className="mt-1 truncate text-xs text-subtext">{genStreamProgress?.message ?? "处理中..."}</div>
                {genRequestId ? (
                  <div className="mt-1 truncate text-[11px] text-subtext">request_id: {genRequestId}</div>
                ) : null}
              </div>
              {genStreamProgress ? (
                <div className="shrink-0 text-xs text-subtext">
                  {Math.max(0, Math.min(100, genStreamProgress.progress))}%
                </div>
              ) : null}
            </div>
            <ProgressBar ariaLabel="写作页流式生成进度" className="mt-2" value={genStreamProgress?.progress ?? 0} />
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setAiOpen(true)} type="button">
                展开
              </button>
              <button className="btn btn-secondary" onClick={abortGenerate} type="button">
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <GenerationHistoryDrawer
        open={history.open}
        onClose={history.closeDrawer}
        loading={history.runsLoading}
        runs={history.runs}
        selectedRun={history.selectedRun}
        onSelectRun={(run) => void history.selectRun(run)}
      />

      <WizardNextBar
        projectId={projectId}
        currentStep="writing"
        progress={wizard.progress}
        loading={wizard.loading}
        dirty={dirty}
        saving={saving || loadingChapter || generating}
        onSave={saveChapter}
      />
    </ToolContent>
  );
}







