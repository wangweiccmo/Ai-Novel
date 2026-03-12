import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { ConfirmApi } from "../../components/ui/confirm";
import type { ToastApi } from "../../components/ui/toast";
import type { GenerationRun } from "../../components/writing/types";
import { ApiError, apiJson } from "../../services/apiClient";
import { createChapterMarkerStreamParser } from "../../services/chapterMarkerStreamParser";
import type { Chapter } from "../../types";
import type { ChapterForm } from "./writingUtils";

export function useApplyGenerationRun(args: {
  applyRunId: string | null;
  activeChapter: Chapter | null;
  form: ChapterForm | null;
  dirty: boolean;
  confirm: ConfirmApi;
  toast: ToastApi;
  saveChapter: () => Promise<boolean>;
  searchParams: URLSearchParams;
  setSearchParams: (next: URLSearchParams, opts?: { replace?: boolean }) => void;
  setForm: Dispatch<SetStateAction<ChapterForm | null>>;
  onApplied?: (runId: string) => void;
}) {
  const {
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
    onApplied,
  } = args;

  useEffect(() => {
    if (!applyRunId) return;
    if (!activeChapter || !form) return;

    let canceled = false;
    let shouldClearApplyRunId = true;
    void (async () => {
      try {
        if (dirty) {
          const choice = await confirm.choose({
            title: "章节有未保存修改，是否应用生成记录？",
            description: "应用后会覆盖编辑器内容（不会自动保存）。",
            confirmText: "保存并应用",
            secondaryText: "直接应用（不保存）",
            cancelText: "取消",
          });
          if (choice === "cancel") return;
          if (choice === "confirm") {
            const ok = await saveChapter();
            if (!ok) return;
          }
        }

        const res = await apiJson<{ run: GenerationRun }>(`/api/generation_runs/${applyRunId}`);
        if (canceled) return;

        const run = res.data.run;
        if (run.chapter_id && run.chapter_id !== activeChapter.id) {
          // Batch apply can set applyRunId before the chapter switch finishes; keep the param and retry on chapter change.
          shouldClearApplyRunId = false;
          return;
        }
        const raw = typeof run.output_text === "string" ? run.output_text : "";
        if (!raw.trim()) {
          toast.toastError("生成记录为空，无法应用", res.request_id);
          return;
        }

        const parser = createChapterMarkerStreamParser();
        let content = "";
        let summary = "";
        const out1 = parser.push(raw);
        content += out1.contentDelta;
        summary += out1.summaryDelta;
        const out2 = parser.finalize();
        content += out2.contentDelta;
        summary += out2.summaryDelta;

        const nextContent = content.trim() || raw.trim();
        const nextSummary = summary.trim();
        setForm((prev) =>
          prev ? { ...prev, content_md: nextContent, summary: nextSummary || prev.summary, status: "drafting" } : prev,
        );
        toast.toastSuccess("已应用生成结果（别忘了保存）", res.request_id);
        onApplied?.(applyRunId);
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      }
      if (canceled) return;
      if (!shouldClearApplyRunId) return;
      const next = new URLSearchParams(searchParams);
      next.delete("applyRunId");
      setSearchParams(next, { replace: true });
    })();

    return () => {
      canceled = true;
    };
  }, [activeChapter, applyRunId, confirm, dirty, form, onApplied, saveChapter, searchParams, setForm, setSearchParams, toast]);
}
