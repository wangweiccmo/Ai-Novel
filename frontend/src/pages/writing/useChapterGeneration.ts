import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { GenerateForm } from "../../components/writing/types";
import type { ConfirmApi } from "../../components/ui/confirm";
import type { ToastApi } from "../../components/ui/toast";
import { UI_COPY } from "../../lib/uiCopy";
import { ApiError, apiJson } from "../../services/apiClient";
import { createChapterMarkerStreamParser } from "../../services/chapterMarkerStreamParser";
import { getCurrentUserId } from "../../services/currentUser";
import { SSEError, SSEPostClient } from "../../services/sseClient";
import { writingMemoryInjectionEnabledStorageKey } from "../../services/uiState";
import type { Chapter, ChapterListItem, LLMPreset } from "../../types";
import { extractMissingNumbers } from "./writingErrorUtils";
import { appendMarkdown } from "./writingUtils";
import type { ChapterForm } from "./writingUtils";

type StreamProgress = {
  message: string;
  progress: number;
  status: string;
  charCount?: number;
};

type GenerateResponse = {
  content_md: string;
  summary: string;
  raw_output: string;
  dropped_params?: string[];
  generation_run_id?: string;
  post_edit_applied?: boolean;
  post_edit_raw_content_md?: string;
  post_edit_edited_content_md?: string;
  post_edit_run_id?: string;
  content_optimize_applied?: boolean;
  content_optimize_raw_content_md?: string;
  content_optimize_optimized_content_md?: string;
  content_optimize_run_id?: string;
};

export type PostEditCompare = {
  requestId: string | null;
  generationRunId: string | null;
  postEditRunId: string | null;
  rawContentMd: string;
  editedContentMd: string;
  appliedChoice: "raw" | "post_edit";
};

export type ContentOptimizeCompare = {
  requestId: string | null;
  generationRunId: string | null;
  contentOptimizeRunId: string | null;
  rawContentMd: string;
  optimizedContentMd: string;
  appliedChoice: "raw" | "content_optimize";
};

const DEFAULT_GEN_FORM: GenerateForm = {
  instruction: "写出本章冲突升级，结尾留钩子。",
  target_word_count: 3000,
  stream: false,
  plan_first: false,
  post_edit: false,
  post_edit_sanitize: false,
  content_optimize: false,
  style_id: null,
  memory_injection_enabled: true,
  memory_query_text: "",
  memory_modules: {
    worldbook: true,
    story_memory: true,
    semantic_history: false,
    foreshadow_open_loops: false,
    structured: true,
    tables: true,
    vector_rag: true,
    graph: true,
    fractal: true,
  },
  context: {
    include_world_setting: true,
    include_style_guide: true,
    include_constraints: true,
    include_outline: true,
    include_smart_context: true,
    require_sequential: false,
    character_ids: [],
    previous_chapter: "summary",
  },
};

function loadMemoryInjectionEnabled(projectId: string | undefined): boolean {
  if (!projectId) return DEFAULT_GEN_FORM.memory_injection_enabled;
  const key = writingMemoryInjectionEnabledStorageKey(getCurrentUserId(), projectId);
  const raw = localStorage.getItem(key);
  if (raw === null) return DEFAULT_GEN_FORM.memory_injection_enabled;
  return raw === "1";
}

export function useChapterGeneration(args: {
  projectId?: string;
  activeChapter: Chapter | null;
  chapters: ChapterListItem[];
  form: ChapterForm | null;
  setForm: Dispatch<SetStateAction<ChapterForm | null>>;
  preset: LLMPreset | null;
  dirty: boolean;
  saveChapter: () => Promise<boolean>;
  requestSelectChapter: (chapterId: string) => Promise<boolean>;
  toast: ToastApi;
  confirm: ConfirmApi;
}) {
  const {
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
  } = args;

  const [generating, setGenerating] = useState(false);
  const [genRequestId, setGenRequestId] = useState<string | null>(null);
  const [genStreamProgress, setGenStreamProgress] = useState<StreamProgress | null>(null);
  const genStreamClientRef = useRef<SSEPostClient | null>(null);
  const genStreamHasChunkRef = useRef(false);
  const [postEditCompare, setPostEditCompare] = useState<PostEditCompare | null>(null);
  const [contentOptimizeCompare, setContentOptimizeCompare] = useState<ContentOptimizeCompare | null>(null);

  const [genForm, setGenForm] = useState<GenerateForm>(() => ({
    ...DEFAULT_GEN_FORM,
    memory_injection_enabled: loadMemoryInjectionEnabled(projectId),
  }));

  const lastProjectIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (lastProjectIdRef.current === projectId) return;
    lastProjectIdRef.current = projectId;
    const enabled = loadMemoryInjectionEnabled(projectId);
    setGenForm((prev) => ({
      ...prev,
      memory_injection_enabled: enabled,
      memory_query_text: "",
      memory_modules: { ...DEFAULT_GEN_FORM.memory_modules },
    }));
  }, [projectId]);

  useEffect(() => {
    setPostEditCompare(null);
    setContentOptimizeCompare(null);
  }, [activeChapter?.id]);

  useEffect(() => {
    if (!projectId) return;
    const key = writingMemoryInjectionEnabledStorageKey(getCurrentUserId(), projectId);
    localStorage.setItem(key, genForm.memory_injection_enabled ? "1" : "0");
  }, [genForm.memory_injection_enabled, projectId]);

  const abortGenerate = useCallback(() => genStreamClientRef.current?.abort(), []);

  const applyPostEditVariant = useCallback(
    async (choice: PostEditCompare["appliedChoice"]) => {
      if (!activeChapter) return;
      if (!postEditCompare) return;
      const nextContent = choice === "raw" ? postEditCompare.rawContentMd : postEditCompare.editedContentMd;
      setForm((prev) => {
        if (!prev) return prev;
        return { ...prev, content_md: nextContent, status: "drafting" };
      });
      setPostEditCompare((prev) => (prev ? { ...prev, appliedChoice: choice } : prev));
      toast.toastSuccess(
        choice === "raw" ? "已采用原稿（别忘了保存）" : "已采用后处理稿（别忘了保存）",
        postEditCompare.requestId ?? undefined,
      );

      if (!postEditCompare.generationRunId) return;
      try {
        await apiJson(`/api/chapters/${activeChapter.id}/post_edit_adoption`, {
          method: "POST",
          body: JSON.stringify({
            generation_run_id: postEditCompare.generationRunId,
            post_edit_run_id: postEditCompare.postEditRunId,
            choice,
          }),
        });
      } catch (e) {
        const err = e as ApiError;
        toast.toastWarning(`记录采用策略失败：${err.message} (${err.code})`, err.requestId);
      }
    },
    [activeChapter, postEditCompare, setForm, toast],
  );

  const applyContentOptimizeVariant = useCallback(
    async (choice: ContentOptimizeCompare["appliedChoice"]) => {
      if (!contentOptimizeCompare) return;
      const nextContent =
        choice === "raw" ? contentOptimizeCompare.rawContentMd : contentOptimizeCompare.optimizedContentMd;
      setForm((prev) => {
        if (!prev) return prev;
        return { ...prev, content_md: nextContent, status: "drafting" };
      });
      setContentOptimizeCompare((prev) => (prev ? { ...prev, appliedChoice: choice } : prev));
      toast.toastSuccess(
        choice === "raw" ? "已采用优化前原稿（别忘了保存）" : "已采用正文优化稿（别忘了保存）",
        contentOptimizeCompare.requestId ?? undefined,
      );
    },
    [contentOptimizeCompare, setForm, toast],
  );

  const generate = useCallback(
    async (
      mode: "replace" | "append",
      overrides?: { macro_seed?: string | null; prompt_override?: GenerateForm["prompt_override"] },
    ) => {
      if (!activeChapter || !form) return;
      if (!preset) {
        toast.toastError("请先在 Prompts 页保存 LLM 配置");
        return;
      }
      const headers: Record<string, string> = { "X-LLM-Provider": preset.provider };
      const streamProviderSupported = preset.provider.startsWith("openai");

      setPostEditCompare(null);
      setContentOptimizeCompare(null);
      if (dirty) {
        const choice = await confirm.choose({
          title: "章节有未保存修改，如何生成？",
          description: "生成结果会写入编辑器，但不会自动保存。",
          confirmText: "保存并生成",
          secondaryText: "直接生成（不保存当前修改）",
          cancelText: "取消",
        });
        if (choice === "cancel") return;
        if (choice === "confirm") {
          const ok = await saveChapter();
          if (!ok) return;
        }
      }

      setGenerating(true);
      setGenRequestId(null);
      setGenStreamProgress(null);
      genStreamClientRef.current = null;
      genStreamHasChunkRef.current = false;
      try {
        const macroSeed =
          overrides && Object.prototype.hasOwnProperty.call(overrides, "macro_seed")
            ? overrides.macro_seed
            : genForm.macro_seed;
        const promptOverride =
          overrides && Object.prototype.hasOwnProperty.call(overrides, "prompt_override")
            ? overrides.prompt_override
            : genForm.prompt_override;

        const currentDraftTail = mode === "append" ? (form.content_md ?? "").trimEnd().slice(-1200) : null;
        const safeTargetWordCount =
          typeof genForm.target_word_count === "number" && genForm.target_word_count >= 100
            ? genForm.target_word_count
            : null;

        const payload = {
          mode,
          instruction: genForm.instruction,
          target_word_count: safeTargetWordCount,
          plan_first: genForm.plan_first,
          post_edit: genForm.post_edit,
          post_edit_sanitize: genForm.post_edit_sanitize,
          content_optimize: genForm.content_optimize,
          ...(typeof macroSeed === "string" && macroSeed.trim() ? { macro_seed: macroSeed.trim() } : {}),
          ...(promptOverride != null ? { prompt_override: promptOverride } : {}),
          style_id: genForm.style_id,
          memory_injection_enabled: genForm.memory_injection_enabled,
          memory_query_text: genForm.memory_query_text.trim() ? genForm.memory_query_text : null,
          memory_modules: genForm.memory_modules,
          context: {
            include_world_setting: genForm.context.include_world_setting,
            include_style_guide: genForm.context.include_style_guide,
            include_constraints: genForm.context.include_constraints,
            include_outline: genForm.context.include_outline,
            include_smart_context: genForm.context.include_smart_context,
            require_sequential: genForm.context.require_sequential,
            character_ids: genForm.context.character_ids,
            previous_chapter: genForm.context.previous_chapter === "none" ? null : genForm.context.previous_chapter,
            current_draft_tail: currentDraftTail,
          },
        };

        const baseContent = form.content_md;
        const baseSummary = form.summary;

        const shouldStream = genForm.stream && streamProviderSupported;
        if (genForm.stream && !streamProviderSupported) {
          toast.toastWarning("已回退非流式生成");
        }

        if (shouldStream) {
          const parser = createChapterMarkerStreamParser();
          let parsedContent = "";
          let parsedSummary = "";
          const startContent =
            mode === "append"
              ? (() => {
                  const trimmed = (baseContent ?? "").trimEnd();
                  return trimmed ? `${trimmed}\n\n` : "";
                })()
              : "";
          let requestId: string | undefined;
          let nonFatalNoticed = false;
          let droppedParams: string[] = [];

          const processChunk = (chunk: string) => {
            const out = parser.push(chunk);
            if (out.contentDelta) parsedContent += out.contentDelta;
            if (out.summaryDelta) parsedSummary += out.summaryDelta;
            return out;
          };

          setForm((prev) => {
            if (!prev) return prev;
            return { ...prev, content_md: startContent, status: "drafting" };
          });

          const client = new SSEPostClient(`/api/chapters/${activeChapter.id}/generate-stream`, payload, {
            headers,
            onOpen: ({ requestId: rid }) => {
              requestId = rid;
              setGenRequestId(rid ?? null);
            },
            onProgress: ({ message, progress, status, charCount }) => {
              setGenStreamProgress({ message, progress, status, charCount });
              if (!nonFatalNoticed && status === "error") {
                nonFatalNoticed = true;
                toast.toastError(message, requestId);
              }
            },
            onChunk: (chunk) => {
              genStreamHasChunkRef.current = true;
              const out = processChunk(chunk);
              if (out.contentDelta) {
                setForm((prev) => {
                  if (!prev) return prev;
                  return { ...prev, content_md: (prev.content_md ?? "") + out.contentDelta, status: "drafting" };
                });
              }
            },
            onResult: (data) => {
              const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
              const content = typeof obj?.content_md === "string" ? obj.content_md : "";
              const summary = typeof obj?.summary === "string" ? obj.summary : "";
              const genRunId = typeof obj?.generation_run_id === "string" ? obj.generation_run_id : null;
              const postEditApplied = Boolean(obj?.post_edit_applied);
              const postEditRaw =
                typeof obj?.post_edit_raw_content_md === "string" ? obj.post_edit_raw_content_md : null;
              const postEditEdited =
                typeof obj?.post_edit_edited_content_md === "string" ? obj.post_edit_edited_content_md : null;
              const postEditRunId = typeof obj?.post_edit_run_id === "string" ? obj.post_edit_run_id : null;
              const contentOptimizeApplied = Boolean(obj?.content_optimize_applied);
              const contentOptimizeRaw =
                typeof obj?.content_optimize_raw_content_md === "string" ? obj.content_optimize_raw_content_md : null;
              const contentOptimizeOptimized =
                typeof obj?.content_optimize_optimized_content_md === "string"
                  ? obj.content_optimize_optimized_content_md
                  : null;
              const contentOptimizeRunId =
                typeof obj?.content_optimize_run_id === "string" ? obj.content_optimize_run_id : null;
              const dropped = Array.isArray(obj?.dropped_params)
                ? obj.dropped_params.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
                : [];
              droppedParams = dropped;
              const parseErrObj =
                obj?.parse_error && typeof obj.parse_error === "object"
                  ? (obj.parse_error as Record<string, unknown>)
                  : null;
              const parseErrCode = typeof parseErrObj?.code === "string" ? parseErrObj.code : undefined;
              const parseErrMessage = typeof parseErrObj?.message === "string" ? parseErrObj.message : undefined;
              if (parseErrCode === "OUTPUT_TRUNCATED") {
                toast.toastError(parseErrMessage ?? "输出被截断", requestId);
              }
              setForm((prev) => {
                if (!prev) return prev;
                const expectedContent = startContent + parsedContent;
                const nextContent = mode === "append" ? appendMarkdown(baseContent, content) : content;
                const nextSummaryRaw = summary || parsedSummary.trim();
                const shouldOverrideSummary = prev.summary === baseSummary;
                return {
                  ...prev,
                  content_md: prev.content_md === expectedContent ? nextContent : prev.content_md,
                  summary: shouldOverrideSummary ? nextSummaryRaw || prev.summary || baseSummary : prev.summary,
                  status: "drafting",
                };
              });

              const postEditRawTrimmed = postEditRaw?.trim() ?? "";
              const postEditEditedTrimmed = postEditEdited?.trim() ?? "";
              if (
                genForm.post_edit &&
                postEditRawTrimmed &&
                postEditEditedTrimmed &&
                postEditRawTrimmed !== postEditEditedTrimmed
              ) {
                const rawFull =
                  mode === "append" ? appendMarkdown(baseContent, postEditRawTrimmed) : postEditRawTrimmed;
                const editedFull =
                  mode === "append" ? appendMarkdown(baseContent, postEditEditedTrimmed) : postEditEditedTrimmed;
                setPostEditCompare({
                  requestId: requestId ?? null,
                  generationRunId: genRunId,
                  postEditRunId,
                  rawContentMd: rawFull,
                  editedContentMd: editedFull,
                  appliedChoice: postEditApplied ? "post_edit" : "raw",
                });
              } else {
                setPostEditCompare(null);
              }

              const contentOptimizeRawTrimmed = contentOptimizeRaw?.trim() ?? "";
              const contentOptimizeOptimizedTrimmed = contentOptimizeOptimized?.trim() ?? "";
              if (
                genForm.content_optimize &&
                contentOptimizeRawTrimmed &&
                contentOptimizeOptimizedTrimmed &&
                contentOptimizeRawTrimmed !== contentOptimizeOptimizedTrimmed
              ) {
                const rawFull =
                  mode === "append"
                    ? appendMarkdown(baseContent, contentOptimizeRawTrimmed)
                    : contentOptimizeRawTrimmed;
                const optimizedFull =
                  mode === "append"
                    ? appendMarkdown(baseContent, contentOptimizeOptimizedTrimmed)
                    : contentOptimizeOptimizedTrimmed;
                setContentOptimizeCompare({
                  requestId: requestId ?? null,
                  generationRunId: genRunId,
                  contentOptimizeRunId,
                  rawContentMd: rawFull,
                  optimizedContentMd: optimizedFull,
                  appliedChoice: contentOptimizeApplied ? "content_optimize" : "raw",
                });
              } else {
                setContentOptimizeCompare(null);
              }
            },
          });
          genStreamClientRef.current = client;

          try {
            await client.connect();
            toast.toastSuccess("生成完成（别忘了保存）", requestId);
            if (!genStreamHasChunkRef.current) {
              toast.toastSuccess("未收到流式分片（可能上游未返回分片或输出为空）", requestId);
            }
            if (droppedParams.length > 0) {
              toast.toastSuccess(`${UI_COPY.common.droppedParamsPrefix}${droppedParams.join("、")}`, requestId);
            }
          } catch (e) {
            const err = e as unknown;
            if (err instanceof SSEError && err.code === "ABORTED") {
              setForm((prev) => {
                if (!prev) return prev;
                const expectedContent = startContent + parsedContent;
                const expectedSummary = prev.summary === baseSummary;
                return {
                  ...prev,
                  content_md: prev.content_md === expectedContent ? baseContent : prev.content_md,
                  summary: expectedSummary ? baseSummary : prev.summary,
                };
              });
              toast.toastSuccess("已取消生成", err.requestId ?? requestId);
              return;
            }
            if (err instanceof SSEError && err.code !== "SSE_SERVER_ERROR") {
              if (!genStreamHasChunkRef.current) {
                toast.toastError("流式生成失败，已回退非流式", err.requestId ?? requestId);
                const res = await apiJson<GenerateResponse>(`/api/chapters/${activeChapter.id}/generate`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(payload),
                });

                const postEditRawTrimmed = (res.data.post_edit_raw_content_md ?? "").trim();
                const postEditEditedTrimmed = (res.data.post_edit_edited_content_md ?? "").trim();
                const contentOptimizeRawTrimmed = (res.data.content_optimize_raw_content_md ?? "").trim();
                const contentOptimizeOptimizedTrimmed = (res.data.content_optimize_optimized_content_md ?? "").trim();

                setForm((prev) => {
                  if (!prev) return prev;
                  const nextContent =
                    mode === "append"
                      ? appendMarkdown(prev.content_md, res.data.content_md ?? "")
                      : (res.data.content_md ?? "");
                  return {
                    ...prev,
                    content_md: nextContent,
                    summary: res.data.summary ?? prev.summary,
                    status: "drafting",
                  };
                });

                if (
                  genForm.post_edit &&
                  postEditRawTrimmed &&
                  postEditEditedTrimmed &&
                  postEditRawTrimmed !== postEditEditedTrimmed
                ) {
                  const rawFull =
                    mode === "append" ? appendMarkdown(baseContent, postEditRawTrimmed) : postEditRawTrimmed;
                  const editedFull =
                    mode === "append" ? appendMarkdown(baseContent, postEditEditedTrimmed) : postEditEditedTrimmed;
                  setPostEditCompare({
                    requestId: res.request_id ?? null,
                    generationRunId: res.data.generation_run_id ?? null,
                    postEditRunId: res.data.post_edit_run_id ?? null,
                    rawContentMd: rawFull,
                    editedContentMd: editedFull,
                    appliedChoice: res.data.post_edit_applied ? "post_edit" : "raw",
                  });
                } else {
                  setPostEditCompare(null);
                }

                if (
                  genForm.content_optimize &&
                  contentOptimizeRawTrimmed &&
                  contentOptimizeOptimizedTrimmed &&
                  contentOptimizeRawTrimmed !== contentOptimizeOptimizedTrimmed
                ) {
                  const rawFull =
                    mode === "append"
                      ? appendMarkdown(baseContent, contentOptimizeRawTrimmed)
                      : contentOptimizeRawTrimmed;
                  const optimizedFull =
                    mode === "append"
                      ? appendMarkdown(baseContent, contentOptimizeOptimizedTrimmed)
                      : contentOptimizeOptimizedTrimmed;
                  setContentOptimizeCompare({
                    requestId: res.request_id ?? null,
                    generationRunId: res.data.generation_run_id ?? null,
                    contentOptimizeRunId: res.data.content_optimize_run_id ?? null,
                    rawContentMd: rawFull,
                    optimizedContentMd: optimizedFull,
                    appliedChoice: res.data.content_optimize_applied ? "content_optimize" : "raw",
                  });
                } else {
                  setContentOptimizeCompare(null);
                }

                toast.toastSuccess("生成完成（别忘了保存）", res.request_id);
                const dp = res.data.dropped_params ?? [];
                if (dp.length > 0) {
                  toast.toastSuccess(`${UI_COPY.common.droppedParamsPrefix}${dp.join("、")}`, res.request_id);
                }
                return;
              }
              toast.toastError(`${err.message} (${err.code})`, err.requestId);
              return;
            }
            if (err instanceof SSEError && err.code === "SSE_SERVER_ERROR") {
              toast.toastError(`${err.message} (${err.code})`, err.requestId);
              return;
            }
            if (err instanceof ApiError) {
              const missingNumbers = extractMissingNumbers(err);
              if (missingNumbers.length > 0) {
                const targetNumber = missingNumbers[0]!;
                const target = chapters.find((c) => c.number === targetNumber);
                toast.toastError(
                  `缺少前置章节内容：第 ${missingNumbers.join("、")} 章`,
                  err.requestId,
                  target
                    ? {
                        label: `跳转到第 ${targetNumber} 章`,
                        onClick: () => void requestSelectChapter(target.id),
                      }
                    : undefined,
                );
                return;
              }
              toast.toastError(`${err.message} (${err.code})`, err.requestId);
              return;
            }
            toast.toastError("生成失败");
          }
        } else {
          const res = await apiJson<GenerateResponse>(`/api/chapters/${activeChapter.id}/generate`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });

          const postEditRawTrimmed = (res.data.post_edit_raw_content_md ?? "").trim();
          const postEditEditedTrimmed = (res.data.post_edit_edited_content_md ?? "").trim();
          const contentOptimizeRawTrimmed = (res.data.content_optimize_raw_content_md ?? "").trim();
          const contentOptimizeOptimizedTrimmed = (res.data.content_optimize_optimized_content_md ?? "").trim();

          setForm((prev) => {
            if (!prev) return prev;
            const nextContent =
              mode === "append"
                ? appendMarkdown(prev.content_md, res.data.content_md ?? "")
                : (res.data.content_md ?? "");
            return {
              ...prev,
              content_md: nextContent,
              summary: res.data.summary ?? prev.summary,
              status: "drafting",
            };
          });

          if (
            genForm.post_edit &&
            postEditRawTrimmed &&
            postEditEditedTrimmed &&
            postEditRawTrimmed !== postEditEditedTrimmed
          ) {
            const rawFull = mode === "append" ? appendMarkdown(baseContent, postEditRawTrimmed) : postEditRawTrimmed;
            const editedFull =
              mode === "append" ? appendMarkdown(baseContent, postEditEditedTrimmed) : postEditEditedTrimmed;
            setPostEditCompare({
              requestId: res.request_id ?? null,
              generationRunId: res.data.generation_run_id ?? null,
              postEditRunId: res.data.post_edit_run_id ?? null,
              rawContentMd: rawFull,
              editedContentMd: editedFull,
              appliedChoice: res.data.post_edit_applied ? "post_edit" : "raw",
            });
          } else {
            setPostEditCompare(null);
          }

          if (
            genForm.content_optimize &&
            contentOptimizeRawTrimmed &&
            contentOptimizeOptimizedTrimmed &&
            contentOptimizeRawTrimmed !== contentOptimizeOptimizedTrimmed
          ) {
            const rawFull =
              mode === "append" ? appendMarkdown(baseContent, contentOptimizeRawTrimmed) : contentOptimizeRawTrimmed;
            const optimizedFull =
              mode === "append"
                ? appendMarkdown(baseContent, contentOptimizeOptimizedTrimmed)
                : contentOptimizeOptimizedTrimmed;
            setContentOptimizeCompare({
              requestId: res.request_id ?? null,
              generationRunId: res.data.generation_run_id ?? null,
              contentOptimizeRunId: res.data.content_optimize_run_id ?? null,
              rawContentMd: rawFull,
              optimizedContentMd: optimizedFull,
              appliedChoice: res.data.content_optimize_applied ? "content_optimize" : "raw",
            });
          } else {
            setContentOptimizeCompare(null);
          }

          toast.toastSuccess("生成完成（别忘了保存）", res.request_id);
          const dp = res.data.dropped_params ?? [];
          if (dp.length > 0) {
            toast.toastSuccess(`${UI_COPY.common.droppedParamsPrefix}${dp.join("、")}`, res.request_id);
          }
        }
      } catch (e) {
        const err = e as ApiError;
        const missingNumbers = extractMissingNumbers(err);
        if (missingNumbers.length > 0) {
          const targetNumber = missingNumbers[0]!;
          const target = chapters.find((c) => c.number === targetNumber);
          toast.toastError(
            `缺少前置章节内容：第 ${missingNumbers.join("、")} 章`,
            err.requestId,
            target
              ? {
                  label: `跳转到第 ${targetNumber} 章`,
                  onClick: () => void requestSelectChapter(target.id),
                }
              : undefined,
          );
          return;
        }
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setGenerating(false);
      }
    },
    [activeChapter, chapters, confirm, dirty, form, genForm, preset, requestSelectChapter, saveChapter, setForm, toast],
  );

  return {
    generating,
    genRequestId,
    genStreamProgress,
    genStreamClientRef,
    genForm,
    setGenForm,
    postEditCompare,
    applyPostEditVariant,
    contentOptimizeCompare,
    applyContentOptimizeVariant,
    generate,
    abortGenerate,
  };
}
