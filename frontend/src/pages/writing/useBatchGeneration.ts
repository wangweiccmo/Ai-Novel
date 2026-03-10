import { useCallback, useEffect, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";

import type { BatchGenerationTask, BatchGenerationTaskItem, GenerateForm } from "../../components/writing/types";
import { useProjectTaskEvents } from "../../hooks/useProjectTaskEvents";
import { createRequestSeqGuard } from "../../lib/requestSeqGuard";
import { ApiError, apiJson } from "../../services/apiClient";
import {
  cancelBatchGenerationTask,
  getActiveBatchGenerationTask,
  getBatchGenerationTask,
  getProjectTaskRuntime,
  hasFailedBatchGenerationItems,
  isBatchGenerationProjectTaskKind,
  isBatchGenerationTaskStatusRecoverable,
  pauseBatchGenerationTask,
  resumeBatchGenerationTask,
  retryFailedBatchGenerationTask,
  skipFailedBatchGenerationTask,
  type ProjectTaskRuntime,
} from "../../services/projectTaskRuntime";
import type { Chapter, ChapterListItem, LLMPreset } from "../../types";
import { extractMissingNumbers } from "./writingErrorUtils";

export function useBatchGeneration(args: {
  projectId: string | undefined;
  preset: LLMPreset | null;
  activeChapter: Chapter | null;
  chapters: ChapterListItem[];
  refreshChapters?: () => Promise<ChapterListItem[]>;
  genForm: GenerateForm;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  requestSelectChapter: (chapterId: string) => Promise<boolean>;
  toast: {
    toastError: (message: string, requestId?: string, action?: { label: string; onClick: () => void }) => void;
    toastSuccess: (message: string, requestId?: string) => void;
  };
}) {
  const {
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
  } = args;

  const [open, setOpen] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchCount, setBatchCount] = useState(3);
  const [batchIncludeExisting, setBatchIncludeExisting] = useState(false);
  const [batchTask, setBatchTask] = useState<BatchGenerationTask | null>(null);
  const [batchItems, setBatchItems] = useState<BatchGenerationTaskItem[]>([]);
  const [batchRuntime, setBatchRuntime] = useState<ProjectTaskRuntime | null>(null);
  const applyRunId = searchParams.get("applyRunId");
  const [batchApplying, setBatchApplying] = useState(false);

  const batchTaskRef = useRef<BatchGenerationTask | null>(null);
  const batchRefreshGuardRef = useRef(createRequestSeqGuard());
  const runtimeRefreshGuardRef = useRef(createRequestSeqGuard());
  const batchSyncTimerRef = useRef<number | null>(null);
  const batchApplyQueueRef = useRef<BatchGenerationTaskItem[]>([]);

  useEffect(() => {
    batchTaskRef.current = batchTask;
  }, [batchTask]);

  useEffect(() => {
    const batchRefreshGuard = batchRefreshGuardRef.current;
    const runtimeRefreshGuard = runtimeRefreshGuardRef.current;
    return () => {
      batchRefreshGuard.invalidate();
      runtimeRefreshGuard.invalidate();
      if (batchSyncTimerRef.current !== null) {
        window.clearTimeout(batchSyncTimerRef.current);
      }
    };
  }, []);

  const refreshBatchRuntime = useCallback(
    async (projectTaskId: string, opts?: { silent?: boolean; loading?: boolean }) => {
      const targetId = String(projectTaskId || "").trim();
      if (!targetId) {
        runtimeRefreshGuardRef.current.invalidate();
        setBatchRuntime(null);
        return;
      }
      const seq = runtimeRefreshGuardRef.current.next();
      try {
        const runtime = await getProjectTaskRuntime(targetId);
        if (!runtimeRefreshGuardRef.current.isLatest(seq)) return;
        setBatchRuntime(runtime);
      } catch (e) {
        if (!runtimeRefreshGuardRef.current.isLatest(seq)) return;
        if (!opts?.silent) {
          const err = e as ApiError;
          toast.toastError(`${err.message} (${err.code})`, err.requestId);
        }
      }
    },
    [toast],
  );

  const refreshBatchTask = useCallback(
    async (opts?: { silent?: boolean; taskId?: string | null }) => {
      if (!projectId) return;
      const seq = batchRefreshGuardRef.current.next();
      const fallbackTaskId = String(opts?.taskId || batchTaskRef.current?.id || "").trim();
      try {
        let data = await getActiveBatchGenerationTask(projectId);
        if (!data.task && fallbackTaskId) {
          try {
            data = await getBatchGenerationTask(fallbackTaskId);
          } catch (detailError) {
            if (!(detailError instanceof ApiError) || detailError.status !== 404) {
              throw detailError;
            }
          }
        }
        if (!batchRefreshGuardRef.current.isLatest(seq)) return;
        setBatchTask(data.task);
        setBatchItems(data.items);
        batchTaskRef.current = data.task;
        const projectTaskId = String(data.task?.project_task_id || "").trim();
        if (projectTaskId) {
          void refreshBatchRuntime(projectTaskId, { silent: true });
        } else {
          runtimeRefreshGuardRef.current.invalidate();
          setBatchRuntime(null);
        }
      } catch (e) {
        if (!batchRefreshGuardRef.current.isLatest(seq)) return;
        if (!opts?.silent) {
          const err = e as ApiError;
          toast.toastError(`${err.message} (${err.code})`, err.requestId);
        }
      }
    },
    [projectId, refreshBatchRuntime, toast],
  );

  useEffect(() => {
    batchApplyQueueRef.current = [];
    setBatchApplying(false);
    if (!projectId) {
      batchRefreshGuardRef.current.invalidate();
      runtimeRefreshGuardRef.current.invalidate();
      setBatchTask(null);
      setBatchItems([]);
      setBatchRuntime(null);
      return;
    }
    void refreshBatchTask({ silent: true });
  }, [projectId, refreshBatchTask]);

  const scheduleBatchSync = useCallback(
    (projectTaskId?: string | null) => {
      if (batchSyncTimerRef.current !== null) {
        window.clearTimeout(batchSyncTimerRef.current);
      }
      batchSyncTimerRef.current = window.setTimeout(() => {
        batchSyncTimerRef.current = null;
        void refreshBatchTask({ silent: true });
        const runtimeTaskId = String(projectTaskId || batchTaskRef.current?.project_task_id || "").trim();
        if (runtimeTaskId) {
          void refreshBatchRuntime(runtimeTaskId, { silent: true });
        }
      }, 120);
    },
    [refreshBatchRuntime, refreshBatchTask],
  );

  const projectTaskEvents = useProjectTaskEvents({
    projectId,
    enabled: Boolean(projectId),
    onSnapshot: (snapshot) => {
      const activeBatchTask = (snapshot.active_tasks || []).find((task) => isBatchGenerationProjectTaskKind(task.kind));
      if (activeBatchTask || batchTaskRef.current) {
        scheduleBatchSync(activeBatchTask?.id);
      }
    },
    onEvent: (event) => {
      if (!isBatchGenerationProjectTaskKind(event.kind)) return;
      const currentProjectTaskId = String(batchTaskRef.current?.project_task_id || "").trim();
      if (currentProjectTaskId && currentProjectTaskId !== event.task_id) return;
      scheduleBatchSync(event.task_id);
    },
  });

  useEffect(() => {
    if (projectTaskEvents.status === "open") return;
    if (!batchTask || !isBatchGenerationTaskStatusRecoverable(batchTask.status)) return;
    const id = window.setInterval(() => {
      void refreshBatchTask({ silent: true });
      const projectTaskId = String(batchTaskRef.current?.project_task_id || "").trim();
      if (projectTaskId) {
        void refreshBatchRuntime(projectTaskId, { silent: true });
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [batchTask, projectTaskEvents.status, refreshBatchRuntime, refreshBatchTask]);

  const openModal = useCallback(() => {
    setOpen(true);
    void refreshBatchTask();
  }, [refreshBatchTask]);

  const closeModal = useCallback(() => setOpen(false), []);

  const startBatchGeneration = useCallback(async () => {
    if (!projectId) return;
    if (!preset) {
      toast.toastError("请先在 Prompts 页面保存 LLM 配置。");
      return;
    }
    setBatchLoading(true);
    try {
      const headers: Record<string, string> = { "X-LLM-Provider": preset.provider };
      const safeTargetWordCount =
        typeof genForm.target_word_count === "number" && genForm.target_word_count >= 100
          ? genForm.target_word_count
          : null;
      const payload = {
        after_chapter_id: activeChapter?.id ?? null,
        count: batchCount,
        include_existing: batchIncludeExisting,
        instruction: genForm.instruction,
        target_word_count: safeTargetWordCount,
        plan_first: genForm.plan_first,
        post_edit: genForm.post_edit,
        post_edit_sanitize: genForm.post_edit_sanitize,
        content_optimize: genForm.content_optimize,
        style_id: genForm.style_id,
        context: {
          include_world_setting: genForm.context.include_world_setting,
          include_style_guide: genForm.context.include_style_guide,
          include_constraints: genForm.context.include_constraints,
          include_outline: genForm.context.include_outline,
          include_smart_context: genForm.context.include_smart_context,
          require_sequential: genForm.context.require_sequential,
          character_ids: genForm.context.character_ids,
          previous_chapter: genForm.context.previous_chapter === "none" ? null : genForm.context.previous_chapter,
        },
      };

      const res = await apiJson<{ task: BatchGenerationTask; items: BatchGenerationTaskItem[] }>(
        `/api/projects/${projectId}/batch_generation_tasks`,
        { method: "POST", headers, body: JSON.stringify(payload) },
      );
      setBatchTask(res.data.task);
      setBatchItems(res.data.items);
      batchTaskRef.current = res.data.task;
      if (res.data.task.project_task_id) {
        void refreshBatchRuntime(res.data.task.project_task_id, { silent: true });
      }
      try {
        await refreshChapters?.();
      } catch {
        // Ignore refresh failures; meta list handles its own error reporting.
      }
      toast.toastSuccess("批量生成已启动。", res.request_id);
    } catch (e) {
      const err = e as ApiError;
      const missingNumbers = extractMissingNumbers(err);
      if (missingNumbers.length > 0) {
        const targetNumber = missingNumbers[0]!;
        const target = chapters.find((chapter) => chapter.number === targetNumber);
        toast.toastError(
          `缺少前置章节内容：第 ${missingNumbers.join("、")} 章。`,
          err.requestId,
          target
            ? {
                label: `打开第 ${targetNumber} 章`,
                onClick: () => void requestSelectChapter(target.id),
              }
            : undefined,
        );
        return;
      }
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setBatchLoading(false);
    }
  }, [
    activeChapter?.id,
    batchCount,
    batchIncludeExisting,
    chapters,
    genForm,
    preset,
    projectId,
    refreshChapters,
    refreshBatchRuntime,
    requestSelectChapter,
    toast,
  ]);

  const cancelBatchGeneration = useCallback(async () => {
    if (!batchTask) return;
    setBatchLoading(true);
    try {
      await cancelBatchGenerationTask(batchTask.id);
      toast.toastSuccess("批量生成已取消。");
      await refreshBatchTask({ silent: true });
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setBatchLoading(false);
    }
  }, [batchTask, refreshBatchTask, toast]);

  const pauseBatchGeneration = useCallback(async () => {
    if (!batchTask) return;
    setBatchLoading(true);
    try {
      await pauseBatchGenerationTask(batchTask.id);
      toast.toastSuccess("批量生成已暂停。");
      await refreshBatchTask({ silent: true });
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setBatchLoading(false);
    }
  }, [batchTask, refreshBatchTask, toast]);

  const resumeBatchGeneration = useCallback(async () => {
    if (!batchTask) return;
    setBatchLoading(true);
    try {
      await resumeBatchGenerationTask(batchTask.id);
      toast.toastSuccess("批量生成已继续。");
      await refreshBatchTask({ silent: true });
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setBatchLoading(false);
    }
  }, [batchTask, refreshBatchTask, toast]);

  const retryFailedBatchGeneration = useCallback(async () => {
    if (!batchTask) return;
    setBatchLoading(true);
    try {
      await retryFailedBatchGenerationTask(batchTask.id);
      toast.toastSuccess("失败章节已加入重试队列。");
      await refreshBatchTask({ silent: true });
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setBatchLoading(false);
    }
  }, [batchTask, refreshBatchTask, toast]);

  const skipFailedBatchGeneration = useCallback(async () => {
    if (!batchTask) return;
    setBatchLoading(true);
    try {
      await skipFailedBatchGenerationTask(batchTask.id);
      toast.toastSuccess("失败章节已跳过。");
      await refreshBatchTask({ silent: true });
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setBatchLoading(false);
    }
  }, [batchTask, refreshBatchTask, toast]);

  const buildApplyQueue = useCallback(
    () =>
      [...batchItems]
        .filter((item) => item.status === "succeeded" && item.chapter_id && item.generation_run_id)
        .sort((a, b) => a.chapter_number - b.chapter_number),
    [batchItems],
  );

  const startNextBatchApply = useCallback(async () => {
    if (applyRunId) return;
    const queue = batchApplyQueueRef.current;
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || !next.chapter_id || !next.generation_run_id) continue;
      const ok = await requestSelectChapter(next.chapter_id);
      if (!ok) {
        batchApplyQueueRef.current = [];
        setBatchApplying(false);
        return;
      }
      const params = new URLSearchParams(searchParams);
      params.set("applyRunId", next.generation_run_id);
      setSearchParams(params, { replace: true });
      return;
    }
    setBatchApplying(false);
  }, [applyRunId, requestSelectChapter, searchParams, setSearchParams]);

  useEffect(() => {
    if (!batchApplying) return;
    if (applyRunId) return;
    void startNextBatchApply();
  }, [applyRunId, batchApplying, startNextBatchApply]);

  const applyAllToEditor = useCallback(async () => {
    if (batchApplying) return;
    if (applyRunId) {
      toast.toastError("已有正在应用的生成结果，请稍后再试。");
      return;
    }
    const queue = buildApplyQueue();
    if (queue.length === 0) {
      toast.toastError("暂无可应用的批量结果。");
      return;
    }
    batchApplyQueueRef.current = queue;
    setBatchApplying(true);
    setOpen(false);
  }, [applyRunId, batchApplying, buildApplyQueue, toast]);

  const applyBatchItemToEditor = useCallback(
    async (item: BatchGenerationTaskItem) => {
      if (batchApplying) return;
      if (applyRunId) {
        toast.toastError("宸叉湁姝ｅ湪搴旂敤鐨勭敓鎴愮粨鏋滐紝璇风◢鍚庡啀璇曘€?");
        return;
      }
      if (!item.chapter_id || !item.generation_run_id) return;
      setOpen(false);
      const ok = await requestSelectChapter(item.chapter_id);
      if (!ok) return;
      const next = new URLSearchParams(searchParams);
      next.set("applyRunId", item.generation_run_id);
      setSearchParams(next, { replace: true });
    },
    [applyRunId, batchApplying, requestSelectChapter, searchParams, setSearchParams, toast],
  );

  return {
    open,
    openModal,
    closeModal,
    batchLoading,
    batchCount,
    setBatchCount,
    batchIncludeExisting,
    setBatchIncludeExisting,
    batchTask,
    batchItems,
    batchRuntime,
    batchApplying,
    projectTaskStreamStatus: projectTaskEvents.status,
    refreshBatchTask,
    startBatchGeneration,
    cancelBatchGeneration,
    pauseBatchGeneration,
    resumeBatchGeneration,
    retryFailedBatchGeneration,
    skipFailedBatchGeneration,
    hasFailedBatchItems: hasFailedBatchGenerationItems(batchItems),
    applyBatchItemToEditor,
    applyAllToEditor,
  };
}
