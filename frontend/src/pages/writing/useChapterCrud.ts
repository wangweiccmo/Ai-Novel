import { useCallback, useState } from "react";

import type { ConfirmApi } from "../../components/ui/confirm";
import type { ToastApi } from "../../components/ui/toast";
import type { CreateChapterForm } from "../../components/writing/types";
import { ApiError } from "../../services/apiClient";
import { chapterStore } from "../../services/chapterStore";
import { markWizardProjectChanged } from "../../services/wizard";
import type { Chapter, ChapterListItem } from "../../types";
import { nextChapterNumber } from "./writingUtils";

export function useChapterCrud(args: {
  projectId: string | undefined;
  chapters: ChapterListItem[];
  activeChapter: Chapter | null;
  setActiveId: (next: string | null) => void;
  requestSelectChapter: (chapterId: string) => Promise<boolean>;
  toast: ToastApi;
  confirm: ConfirmApi;
  bumpWizardLocal: () => void;
  refreshWizard: () => Promise<void>;
}) {
  const {
    projectId,
    chapters,
    activeChapter,
    setActiveId,
    requestSelectChapter,
    toast,
    confirm,
    bumpWizardLocal,
    refreshWizard,
  } = args;

  const [createOpen, setCreateOpen] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createForm, setCreateForm] = useState<CreateChapterForm>({ number: 1, title: "", plan: "" });

  const openCreate = useCallback(() => {
    setCreateForm({ number: nextChapterNumber(chapters), title: "", plan: "" });
    setCreateOpen(true);
  }, [chapters]);

  const createChapter = useCallback(async () => {
    if (!projectId) return;
    if (createSaving) return;
    if (!createForm.number || createForm.number < 1) {
      toast.toastError("章号必须 >= 1");
      return;
    }
    setCreateSaving(true);
    try {
      const chapter = await chapterStore.createProjectChapter(projectId, {
        number: createForm.number,
        title: createForm.title.trim() || null,
        plan: createForm.plan.trim() || null,
        status: "planned",
      });
      markWizardProjectChanged(projectId);
      bumpWizardLocal();
      void refreshWizard();
      toast.toastSuccess("已创建");
      setCreateOpen(false);
      await requestSelectChapter(chapter.id);
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setCreateSaving(false);
    }
  }, [bumpWizardLocal, createForm, createSaving, projectId, refreshWizard, requestSelectChapter, toast]);

  const deleteChapter = useCallback(async () => {
    if (!activeChapter) return;
    const ok = await confirm.confirm({
      title: "删除章节？",
      description: "删除后该章节正文与摘要将丢失。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;

    try {
      await chapterStore.deleteProjectChapter(activeChapter.id, { projectId: activeChapter.project_id });
      markWizardProjectChanged(activeChapter.project_id);
      bumpWizardLocal();
      void refreshWizard();
      toast.toastSuccess("已删除");
      const idx = chapters.findIndex((c) => c.id === activeChapter.id);
      const next = chapters[idx - 1]?.id ?? chapters[idx + 1]?.id ?? null;
      setActiveId(next);
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    }
  }, [activeChapter, bumpWizardLocal, chapters, confirm, refreshWizard, setActiveId, toast]);

  return {
    createOpen,
    setCreateOpen,
    createSaving,
    createForm,
    setCreateForm,
    openCreate,
    createChapter,
    deleteChapter,
  };
}
