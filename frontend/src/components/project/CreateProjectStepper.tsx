import clsx from "clsx";
import { Check, ChevronLeft, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Modal } from "../ui/Modal";
import { useToast } from "../ui/toast";
import { useProjects } from "../../contexts/projects";
import { ApiError, apiJson } from "../../services/apiClient";
import type { LLMProfile, Project } from "../../types";
import { GENRE_TAGS, PROJECT_TEMPLATES, type ProjectTemplate } from "./projectTemplates";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Step = 1 | 2 | 3;

export type CreateProjectStepperProps = {
  open: boolean;
  onClose: () => void;
  /** Pre-fill from a template when opened */
  initialTemplate?: ProjectTemplate | null;
};

/* ------------------------------------------------------------------ */
/*  Step indicator                                                     */
/* ------------------------------------------------------------------ */

const STEP_LABELS: Record<Step, string> = { 1: "基本信息", 2: "创作设定", 3: "模型配置" };

function StepIndicator({ current }: { current: Step }) {
  return (
    <div className="flex items-center justify-center gap-1">
      {([1, 2, 3] as Step[]).map((s) => {
        const done = s < current;
        const active = s === current;
        return (
          <div key={s} className="flex items-center gap-1">
            {s > 1 ? <div className={clsx("h-px w-6", done || active ? "bg-accent" : "bg-border")} /> : null}
            <div
              className={clsx(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium",
                done
                  ? "bg-accent text-white"
                  : active
                    ? "border-2 border-accent bg-accent/10 text-accent"
                    : "border border-border bg-canvas text-subtext",
              )}
            >
              {done ? <Check size={14} /> : s}
            </div>
            <span className={clsx("hidden text-xs sm:inline", active ? "text-ink" : "text-subtext")}>
              {STEP_LABELS[s]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function CreateProjectStepper({ open, onClose, initialTemplate }: CreateProjectStepperProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useProjects();

  /* Step state */
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);

  /* Step 1 — Basic info */
  const [name, setName] = useState("");
  const [genre, setGenre] = useState("");
  const [logline, setLogline] = useState("");
  const [templateExpanded, setTemplateExpanded] = useState(false);

  /* Step 2 — Settings */
  const [worldSetting, setWorldSetting] = useState("");
  const [styleGuide, setStyleGuide] = useState("");
  const [constraints, setConstraints] = useState("");

  /* Step 3 — LLM */
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  /* Reset when modal opens */
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSubmitting(false);
    setName("");
    setGenre("");
    setLogline("");
    setWorldSetting("");
    setStyleGuide("");
    setConstraints("");
    setTemplateExpanded(false);
    setSelectedProfileId(null);

    if (initialTemplate) {
      setName(`${initialTemplate.title} 项目`);
      setGenre(initialTemplate.genre);
      setLogline(initialTemplate.logline);
      setWorldSetting(initialTemplate.world_setting);
      setStyleGuide(initialTemplate.style_guide);
      setConstraints(initialTemplate.constraints);
    }
  }, [open, initialTemplate]);

  /* Load LLM profiles when reaching step 3 */
  useEffect(() => {
    if (step !== 3) return;
    let cancelled = false;
    void (async () => {
      setProfilesLoading(true);
      try {
        const res = await apiJson<{ profiles: LLMProfile[] }>("/api/llm_profiles");
        if (cancelled) return;
        setProfiles(res.data.profiles);
        if (res.data.profiles.length > 0 && !selectedProfileId) {
          setSelectedProfileId(res.data.profiles[0].id);
        }
      } catch {
        // ignore — will show empty list
      } finally {
        if (!cancelled) setProfilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Apply template */
  const applyTemplate = useCallback((tpl: ProjectTemplate) => {
    setName(`${tpl.title} 项目`);
    setGenre(tpl.genre);
    setLogline(tpl.logline);
    setWorldSetting(tpl.world_setting);
    setStyleGuide(tpl.style_guide);
    setConstraints(tpl.constraints);
    setTemplateExpanded(false);
  }, []);

  /* Toggle genre tag */
  const toggleGenreTag = useCallback(
    (tag: string) => {
      const current = genre
        .split(/[/／、，,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (current.includes(tag)) {
        setGenre(current.filter((t) => t !== tag).join(" / "));
      } else {
        setGenre([...current, tag].join(" / "));
      }
    },
    [genre],
  );

  /* Validation */
  const canGoStep2 = name.trim().length > 0;
  const canGoStep3 = true; // step 2 is optional
  const canSubmit = name.trim().length > 0;

  /* Navigation helpers */
  const goNext = useCallback(() => {
    if (step === 1 && canGoStep2) setStep(2);
    else if (step === 2 && canGoStep3) setStep(3);
  }, [canGoStep2, canGoStep3, step]);

  const goBack = useCallback(() => {
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
  }, [step]);

  /* ---- Submit ---- */
  const submit = useCallback(
    async (skipLlm: boolean) => {
      if (!canSubmit || submitting) return;
      setSubmitting(true);
      try {
        /* 1. Create project */
        const res = await apiJson<{ project: Project }>("/api/projects", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            genre: genre.trim() || undefined,
            logline: logline.trim() || undefined,
          }),
        });
        const projectId = res.data.project.id;

        /* 2. Save settings (if any filled) */
        const hasSettings =
          worldSetting.trim().length > 0 || styleGuide.trim().length > 0 || constraints.trim().length > 0;
        if (hasSettings) {
          await apiJson(`/api/projects/${projectId}/settings`, {
            method: "PUT",
            body: JSON.stringify({
              world_setting: worldSetting.trim(),
              style_guide: styleGuide.trim(),
              constraints: constraints.trim(),
            }),
          });
        }

        /* 3. Bind LLM profile (if selected) */
        if (!skipLlm && selectedProfileId) {
          await apiJson(`/api/projects/${projectId}`, {
            method: "PUT",
            body: JSON.stringify({ llm_profile_id: selectedProfileId }),
          });
        }

        /* 4. Refresh + navigate */
        await refresh();
        toast.toastSuccess("项目已创建");
        onClose();
        navigate(`/projects/${projectId}/wizard`);
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, constraints, genre, logline, name, navigate, onClose, refresh, selectedProfileId, styleGuide, submitting, toast, worldSetting],
  );

  /* Current genre tags (for highlighting) */
  const currentGenres = useMemo(
    () =>
      genre
        .split(/[/／、，,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [genre],
  );

  /* Profiles that have API key configured */
  const readyProfiles = useMemo(() => profiles.filter((p) => p.has_api_key), [profiles]);

  /* ------------------------------------------------------------------ */
  /*  Render                                                             */
  /* ------------------------------------------------------------------ */

  return (
    <Modal open={open} onClose={onClose} panelClassName="surface max-w-2xl p-0" ariaLabel="创建项目">
      {/* Header + stepper */}
      <div className="border-b border-border px-6 py-4">
        <div className="font-content text-xl text-ink">创建新项目</div>
        <div className="mt-3">
          <StepIndicator current={step} />
        </div>
      </div>

      {/* Body */}
      <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
        {/* ========== STEP 1 ========== */}
        {step === 1 ? (
          <div className="grid gap-4">
            <label className="grid gap-1">
              <span className="text-sm text-ink">
                项目名 <span className="text-accent">*</span>
              </span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：我的第一本小说"
                autoFocus
              />
            </label>

            <div className="grid gap-1">
              <span className="text-sm text-ink">题材</span>
              <div className="flex flex-wrap gap-1.5">
                {GENRE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    className={clsx(
                      "ui-transition-fast rounded-full border px-3 py-1 text-xs",
                      currentGenres.includes(tag)
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-border bg-canvas text-subtext hover:border-ink hover:text-ink",
                    )}
                    onClick={() => toggleGenreTag(tag)}
                    type="button"
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <input
                className="input mt-1"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                placeholder="也可以自由输入，例如：末日 / 求生"
              />
            </div>

            <label className="grid gap-1">
              <span className="text-sm text-ink">一句话梗概</span>
              <textarea
                className="textarea"
                rows={2}
                value={logline}
                onChange={(e) => setLogline(e.target.value)}
                placeholder="用一两句话概括故事核心冲突，例如：一个失忆的少年在废土中寻找自己的过去..."
              />
              <span className="text-[11px] text-subtext">选填，可以之后再补充</span>
            </label>

            {/* Template quick-fill */}
            <div className="rounded-atelier border border-border bg-canvas">
              <button
                className="ui-focus-ring ui-transition-fast flex w-full items-center justify-between px-4 py-2.5 text-left text-xs text-subtext hover:text-ink"
                onClick={() => setTemplateExpanded(!templateExpanded)}
                type="button"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles size={14} />
                  从模板快速填充
                </span>
                <ChevronRight
                  size={14}
                  className={clsx("ui-transition-fast", templateExpanded ? "rotate-90" : "")}
                />
              </button>
              {templateExpanded ? (
                <div className="grid gap-2 border-t border-border px-4 py-3">
                  <div className="text-[11px] text-subtext">选择模板后会自动填充所有步骤的内容，你可以随时修改</div>
                  {PROJECT_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      className="surface ui-focus-ring ui-transition-fast w-full rounded-atelier p-3 text-left hover:border-accent/40"
                      onClick={() => applyTemplate(tpl)}
                      type="button"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-ink">{tpl.title}</div>
                        <div className="text-[11px] text-subtext">{tpl.genre}</div>
                      </div>
                      <div className="mt-1 line-clamp-1 text-xs text-subtext">{tpl.logline}</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ========== STEP 2 ========== */}
        {step === 2 ? (
          <div className="grid gap-4">
            <div className="rounded-atelier border border-border bg-canvas px-3 py-2 text-xs text-subtext">
              这些内容会直接影响 AI 生成的质量。不确定的话可以先跳过，之后在「项目设置」里随时补充。
            </div>

            <label className="grid gap-1">
              <span className="text-sm text-ink">世界观</span>
              <textarea
                className="textarea atelier-content"
                rows={4}
                value={worldSetting}
                onChange={(e) => setWorldSetting(e.target.value)}
                placeholder="故事发生在什么样的世界？&#10;例如：现代都市，互联网时代，社交媒体深度影响年轻人生活..."
                autoFocus
              />
            </label>

            <label className="grid gap-1">
              <span className="text-sm text-ink">写作风格</span>
              <textarea
                className="textarea atelier-content"
                rows={4}
                value={styleGuide}
                onChange={(e) => setStyleGuide(e.target.value)}
                placeholder="你希望什么样的文风？&#10;例如：节奏紧凑，对白有张力，善用留白和伏笔..."
              />
            </label>

            <label className="grid gap-1">
              <span className="text-sm text-ink">写作约束</span>
              <textarea
                className="textarea atelier-content"
                rows={3}
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                placeholder="例如：总字数 10 万字左右；每章 3000 字；不要出现超自然元素..."
              />
            </label>
          </div>
        ) : null}

        {/* ========== STEP 3 ========== */}
        {step === 3 ? (
          <div className="grid gap-4">
            <div className="rounded-atelier border border-border bg-canvas px-3 py-2 text-xs text-subtext">
              选择一个已配置好的模型，用于 AI 生成大纲和章节。没有配置过？可以先跳过，之后在「模型配置」页面设置。
            </div>

            {profilesLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-subtext">
                <Loader2 size={16} className="animate-spin" />
                加载模型列表...
              </div>
            ) : readyProfiles.length === 0 ? (
              <div className="py-6 text-center">
                <div className="text-sm text-subtext">
                  {profiles.length === 0
                    ? "还没有模型配置"
                    : "已有模型配置但尚未设置 API Key"}
                </div>
                <div className="mt-2 text-xs text-subtext">
                  创建项目后，到「模型配置」页面添加 API Key 并测试连接即可使用 AI 生成功能。
                </div>
              </div>
            ) : (
              <div className="grid gap-2">
                <div className="text-sm text-ink">选择模型配置</div>
                {readyProfiles.map((p) => (
                  <button
                    key={p.id}
                    className={clsx(
                      "ui-focus-ring ui-transition-fast w-full rounded-atelier border p-3 text-left",
                      selectedProfileId === p.id
                        ? "border-accent bg-accent/5"
                        : "border-border bg-canvas hover:border-ink/30",
                    )}
                    onClick={() => setSelectedProfileId(p.id)}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-ink">{p.name}</div>
                        <div className="mt-0.5 truncate text-xs text-subtext">
                          {p.provider} / {p.model}
                        </div>
                      </div>
                      <div
                        className={clsx(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                          selectedProfileId === p.id
                            ? "border-accent bg-accent text-white"
                            : "border-border bg-canvas",
                        )}
                      >
                        {selectedProfileId === p.id ? <Check size={12} /> : null}
                      </div>
                    </div>
                    {p.has_api_key ? (
                      <div className="mt-1 text-[11px] text-success">API Key 已配置</div>
                    ) : (
                      <div className="mt-1 text-[11px] text-warning">未配置 API Key</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-6 py-4">
        <div>
          {step > 1 ? (
            <button
              className="btn btn-ghost inline-flex items-center gap-1.5 text-sm"
              onClick={goBack}
              disabled={submitting}
              type="button"
            >
              <ChevronLeft size={16} />
              上一步
            </button>
          ) : (
            <button className="btn btn-ghost text-sm" onClick={onClose} disabled={submitting} type="button">
              取消
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {step === 2 ? (
            <button className="btn btn-ghost text-xs text-subtext" onClick={() => setStep(3)} type="button">
              跳过此步
            </button>
          ) : null}

          {step === 3 ? (
            <>
              <button
                className="btn btn-secondary text-xs"
                disabled={submitting || !canSubmit}
                onClick={() => void submit(true)}
                type="button"
              >
                跳过，稍后配置
              </button>
              <button
                className="btn btn-primary inline-flex items-center gap-1.5"
                disabled={submitting || !canSubmit || (!selectedProfileId && readyProfiles.length > 0)}
                onClick={() => void submit(false)}
                type="button"
              >
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    创建中...
                  </>
                ) : (
                  "创建项目"
                )}
              </button>
            </>
          ) : null}

          {step < 3 ? (
            <button
              className="btn btn-primary inline-flex items-center gap-1.5"
              disabled={step === 1 ? !canGoStep2 : false}
              onClick={goNext}
              type="button"
            >
              下一步
              <ChevronRight size={16} />
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
