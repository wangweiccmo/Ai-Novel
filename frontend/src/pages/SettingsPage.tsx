import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useToast } from "../components/ui/toast";
import { WizardNextBar } from "../components/atelier/WizardNextBar";
import { useAuth } from "../contexts/auth";
import { useProjects } from "../contexts/projects";
import { useAutoSave } from "../hooks/useAutoSave";
import { usePersistentOutletIsActive } from "../hooks/usePersistentOutlet";
import { useProjectData } from "../hooks/useProjectData";
import { useSaveHotkey } from "../hooks/useSaveHotkey";
import { UnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { useWizardProgress } from "../hooks/useWizardProgress";
import { copyText } from "../lib/copyText";
import { humanizeMemberRole } from "../lib/humanize";
import { UI_COPY } from "../lib/uiCopy";
import { ApiError, apiJson } from "../services/apiClient";
import { getCurrentUserId } from "../services/currentUser";
import { writingMemoryInjectionEnabledStorageKey } from "../services/uiState";
import { markWizardProjectChanged } from "../services/wizard";
import type { Project, ProjectSettings } from "../types";
import {
  createDefaultProjectForm,
  createDefaultSettingsForm,
  mapLoadedSettingsToForms,
  type ProjectForm,
  type ProjectMembershipItem,
  type SaveSnapshot,
  type SettingsForm,
  type SettingsLoaded,
} from "./settings/models";

export function SettingsPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const auth = useAuth();
  const { refresh } = useProjects();
  const outletActive = usePersistentOutletIsActive();
  const wizard = useWizardProgress(projectId);
  const refreshWizard = wizard.refresh;
  const bumpWizardLocal = wizard.bumpLocal;

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const settingsSavePendingRef = useRef(false);
  const queuedSaveRef = useRef<null | { silent: boolean; snapshot?: SaveSnapshot }>(null);
  const wizardRefreshTimerRef = useRef<number | null>(null);
  const projectsRefreshTimerRef = useRef<number | null>(null);
  const [baselineProject, setBaselineProject] = useState<Project | null>(null);
  const [baselineSettings, setBaselineSettings] = useState<ProjectSettings | null>(null);
  const [loadError, setLoadError] = useState<null | { message: string; code: string; requestId?: string }>(null);

  const [projectForm, setProjectForm] = useState<ProjectForm>(() => createDefaultProjectForm());
  const [settingsForm, setSettingsForm] = useState<SettingsForm>(() => createDefaultSettingsForm());
  const [writingMemoryInjectionEnabled, setWritingMemoryInjectionEnabled] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    const key = writingMemoryInjectionEnabledStorageKey(getCurrentUserId(), projectId);
    const raw = localStorage.getItem(key);
    if (raw === null) {
      setWritingMemoryInjectionEnabled(true);
      return;
    }
    setWritingMemoryInjectionEnabled(raw === "1");
  }, [projectId]);

  const saveWritingMemoryInjectionEnabled = useCallback(
    (enabled: boolean) => {
      if (!projectId) return;
      setWritingMemoryInjectionEnabled(enabled);
      const key = writingMemoryInjectionEnabledStorageKey(getCurrentUserId(), projectId);
      localStorage.setItem(key, enabled ? "1" : "0");
      toast.toastSuccess(enabled ? UI_COPY.featureDefaults.toastEnabled : UI_COPY.featureDefaults.toastDisabled);
    },
    [projectId, toast],
  );

  const resetWritingMemoryInjectionEnabled = useCallback(() => {
    if (!projectId) return;
    setWritingMemoryInjectionEnabled(true);
    const key = writingMemoryInjectionEnabledStorageKey(getCurrentUserId(), projectId);
    localStorage.removeItem(key);
    toast.toastSuccess(UI_COPY.featureDefaults.toastReset);
  }, [projectId, toast]);

  const settingsQuery = useProjectData<SettingsLoaded>(projectId, async (id) => {
    try {
      const [pRes, sRes] = await Promise.all([
        apiJson<{ project: Project }>(`/api/projects/${id}`),
        apiJson<{ settings: ProjectSettings }>(`/api/projects/${id}/settings`),
      ]);
      setLoadError(null);
      return { project: pRes.data.project, settings: sRes.data.settings };
    } catch (e) {
      if (e instanceof ApiError) {
        setLoadError({ message: e.message, code: e.code, requestId: e.requestId });
      } else {
        setLoadError({ message: "请求失败", code: "UNKNOWN_ERROR" });
      }
      throw e;
    }
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    const { project, settings } = settingsQuery.data;
    const mapped = mapLoadedSettingsToForms(settingsQuery.data);
    setBaselineProject(project);
    setBaselineSettings(settings);
    setProjectForm(mapped.projectForm);
    setSettingsForm(mapped.settingsForm);
  }, [settingsQuery.data]);

  const [membershipsLoading, setMembershipsLoading] = useState(false);
  const [membershipSaving, setMembershipSaving] = useState(false);
  const [memberships, setMemberships] = useState<ProjectMembershipItem[]>([]);
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor">("viewer");

  const canManageMemberships = useMemo(() => {
    if (!baselineProject) return false;
    const uid = auth.user?.id ?? "";
    return Boolean(uid) && baselineProject.owner_user_id === uid;
  }, [auth.user?.id, baselineProject]);

  const loadMemberships = useCallback(async () => {
    if (!projectId) return;
    setMembershipsLoading(true);
    try {
      const res = await apiJson<{ memberships: ProjectMembershipItem[] }>(`/api/projects/${projectId}/memberships`);
      const next = Array.isArray(res.data.memberships) ? res.data.memberships : [];
      next.sort((a, b) => String(a.user?.id ?? "").localeCompare(String(b.user?.id ?? "")));
      setMemberships(next);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setMembershipsLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    if (!canManageMemberships) return;
    void loadMemberships();
  }, [canManageMemberships, loadMemberships]);

  const inviteMember = useCallback(async () => {
    if (!projectId) return;
    const targetUserId = inviteUserId.trim();
    if (!targetUserId) {
      toast.toastError("user_id 不能为空");
      return;
    }
    setMembershipSaving(true);
    try {
      await apiJson<{ membership: unknown }>(`/api/projects/${projectId}/memberships`, {
        method: "POST",
        body: JSON.stringify({ user_id: targetUserId, role: inviteRole }),
      });
      setInviteUserId("");
      toast.toastSuccess("已邀请成员");
      await loadMemberships();
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setMembershipSaving(false);
    }
  }, [inviteRole, inviteUserId, loadMemberships, projectId, toast]);

  const updateMemberRole = useCallback(
    async (targetUserId: string, role: "viewer" | "editor") => {
      if (!projectId) return;
      setMembershipSaving(true);
      try {
        await apiJson<{ membership: unknown }>(`/api/projects/${projectId}/memberships/${targetUserId}`, {
          method: "PUT",
          body: JSON.stringify({ role }),
        });
        toast.toastSuccess("已更新角色");
        await loadMemberships();
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setMembershipSaving(false);
      }
    },
    [loadMemberships, projectId, toast],
  );

  const removeMember = useCallback(
    async (targetUserId: string) => {
      if (!projectId) return;
      setMembershipSaving(true);
      try {
        await apiJson<Record<string, never>>(`/api/projects/${projectId}/memberships/${targetUserId}`, {
          method: "DELETE",
        });
        toast.toastSuccess("已移除成员");
        await loadMemberships();
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setMembershipSaving(false);
      }
    },
    [loadMemberships, projectId, toast],
  );

  const dirty = useMemo(() => {
    if (!baselineProject || !baselineSettings) return false;
    return (
      projectForm.name !== baselineProject.name ||
      projectForm.genre !== (baselineProject.genre ?? "") ||
      projectForm.logline !== (baselineProject.logline ?? "") ||
      settingsForm.world_setting !== baselineSettings.world_setting ||
      settingsForm.style_guide !== baselineSettings.style_guide ||
      settingsForm.constraints !== baselineSettings.constraints ||
      settingsForm.context_optimizer_enabled !== baselineSettings.context_optimizer_enabled
    );
  }, [baselineProject, baselineSettings, projectForm, settingsForm]);

  useEffect(() => {
    return () => {
      if (wizardRefreshTimerRef.current !== null) window.clearTimeout(wizardRefreshTimerRef.current);
      if (projectsRefreshTimerRef.current !== null) window.clearTimeout(projectsRefreshTimerRef.current);
    };
  }, []);

  const save = useCallback(
    async (opts?: { silent?: boolean; snapshot?: SaveSnapshot }): Promise<boolean> => {
      if (!projectId) return false;
      if (savingRef.current) {
        queuedSaveRef.current = { silent: Boolean(opts?.silent), snapshot: opts?.snapshot };
        return false;
      }
      const silent = Boolean(opts?.silent);
      const snapshot = opts?.snapshot;
      const nextProjectForm = snapshot?.projectForm ?? projectForm;
      const nextSettingsForm = snapshot?.settingsForm ?? settingsForm;

      if (!baselineProject || !baselineSettings) return false;
      const projectDirty =
        nextProjectForm.name.trim() !== baselineProject.name ||
        nextProjectForm.genre.trim() !== (baselineProject.genre ?? "") ||
        nextProjectForm.logline.trim() !== (baselineProject.logline ?? "");
      const settingsDirty =
        nextSettingsForm.world_setting !== baselineSettings.world_setting ||
        nextSettingsForm.style_guide !== baselineSettings.style_guide ||
        nextSettingsForm.constraints !== baselineSettings.constraints ||
        nextSettingsForm.context_optimizer_enabled !== baselineSettings.context_optimizer_enabled;
      if (!projectDirty && !settingsDirty) return true;

      const scheduleWizardRefresh = () => {
        if (wizardRefreshTimerRef.current !== null) window.clearTimeout(wizardRefreshTimerRef.current);
        wizardRefreshTimerRef.current = window.setTimeout(() => void refreshWizard(), 1200);
      };
      const scheduleProjectsRefresh = () => {
        if (projectsRefreshTimerRef.current !== null) window.clearTimeout(projectsRefreshTimerRef.current);
        projectsRefreshTimerRef.current = window.setTimeout(() => void refresh(), 1200);
      };

      settingsSavePendingRef.current = settingsDirty;
      savingRef.current = true;
      setSaving(true);
      try {
        const [pRes, sRes] = await Promise.all([
          projectDirty
            ? apiJson<{ project: Project }>(`/api/projects/${projectId}`, {
                method: "PUT",
                body: JSON.stringify({
                  name: nextProjectForm.name.trim(),
                  genre: nextProjectForm.genre.trim() || null,
                  logline: nextProjectForm.logline.trim() || null,
                }),
              })
            : null,
          settingsDirty
            ? apiJson<{ settings: ProjectSettings }>(`/api/projects/${projectId}/settings`, {
                method: "PUT",
                body: JSON.stringify({
                  world_setting: nextSettingsForm.world_setting,
                  style_guide: nextSettingsForm.style_guide,
                  constraints: nextSettingsForm.constraints,
                  context_optimizer_enabled: Boolean(nextSettingsForm.context_optimizer_enabled),
                }),
              })
            : null,
        ]);

        if (pRes) setBaselineProject(pRes.data.project);
        if (sRes) setBaselineSettings(sRes.data.settings);
        settingsSavePendingRef.current = false;
        markWizardProjectChanged(projectId);
        bumpWizardLocal();
        if (silent) {
          scheduleProjectsRefresh();
          scheduleWizardRefresh();
        } else {
          await refresh();
          await refreshWizard();
          toast.toastSuccess("已保存");
        }
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
        settingsSavePendingRef.current = false;
        return false;
      } finally {
        setSaving(false);
        savingRef.current = false;
        settingsSavePendingRef.current = false;
        if (queuedSaveRef.current) {
          const queued = queuedSaveRef.current;
          queuedSaveRef.current = null;
          void save({ silent: queued.silent, snapshot: queued.snapshot });
        }
      }
    },
    [baselineProject, baselineSettings, bumpWizardLocal, projectForm, projectId, refresh, refreshWizard, settingsForm, toast],
  );

  useSaveHotkey(() => void save(), dirty);

  useAutoSave({
    enabled: Boolean(projectId && baselineProject && baselineSettings),
    dirty,
    delayMs: 1200,
    getSnapshot: () => ({ projectForm: { ...projectForm }, settingsForm: { ...settingsForm } }),
    onSave: async (snapshot) => {
      await save({ silent: true, snapshot });
    },
    deps: [
      projectForm.name,
      projectForm.genre,
      projectForm.logline,
      settingsForm.world_setting,
      settingsForm.style_guide,
      settingsForm.constraints,
      settingsForm.context_optimizer_enabled,
    ],
  });

  const gotoCharacters = useCallback(async () => {
    if (!projectId) return;
    if (saving) return;
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    navigate(`/projects/${projectId}/characters`);
  }, [dirty, navigate, projectId, save, saving]);

  const loading = settingsQuery.loading;
  if (loading) {
    return (
      <div className="grid gap-6 pb-24" aria-busy="true" aria-live="polite">
        <span className="sr-only">正在加载设置…</span>
        <section className="panel p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-2">
              <div className="skeleton h-6 w-32" />
              <div className="skeleton h-4 w-56" />
            </div>
            <div className="skeleton h-9 w-40" />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1 sm:col-span-1">
              <div className="skeleton h-4 w-16" />
              <div className="skeleton h-10 w-full" />
            </div>
            <div className="grid gap-1 sm:col-span-1">
              <div className="skeleton h-4 w-16" />
              <div className="skeleton h-10 w-full" />
            </div>
            <div className="grid gap-1 sm:col-span-3">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-16 w-full" />
            </div>
          </div>
        </section>

        <section className="panel p-6">
          <div className="grid gap-2">
            <div className="skeleton h-6 w-44" />
            <div className="skeleton h-4 w-72" />
          </div>
          <div className="mt-4 grid gap-4">
            <div className="skeleton h-28 w-full" />
            <div className="skeleton h-28 w-full" />
            <div className="skeleton h-28 w-full" />
          </div>
        </section>

        <section className="panel p-6">
          <div className="grid gap-2">
            <div className="skeleton h-6 w-48" />
            <div className="skeleton h-4 w-full max-w-2xl" />
            <div className="skeleton h-4 w-full max-w-xl" />
          </div>
        </section>

        <section className="panel p-6">
          <div className="grid gap-2">
            <div className="skeleton h-6 w-56" />
            <div className="skeleton h-4 w-full max-w-2xl" />
            <div className="skeleton h-4 w-full max-w-xl" />
          </div>
        </section>

        <section className="panel p-6">
          <div className="grid gap-2">
            <div className="skeleton h-6 w-56" />
            <div className="skeleton h-4 w-full max-w-2xl" />
            <div className="skeleton h-4 w-full max-w-xl" />
          </div>
        </section>

        <section className="panel p-6">
          <div className="grid gap-2">
            <div className="skeleton h-6 w-60" />
            <div className="skeleton h-4 w-full max-w-2xl" />
            <div className="skeleton h-4 w-full max-w-xl" />
          </div>
        </section>
      </div>
    );
  }

  if (!baselineProject || !baselineSettings) {
    return (
      <div className="grid gap-6 pb-24">
        <div className="error-card">
          <div className="state-title">加载失败</div>
          <div className="state-desc">{loadError ? `${loadError.message} (${loadError.code})` : "项目加载失败"}</div>
          {loadError?.requestId ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-subtext">
              <span>request_id: {loadError.requestId}</span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => void copyText(loadError.requestId!, { title: "复制 request_id" })}
                type="button"
              >
                复制 request_id
              </button>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => void settingsQuery.refresh()} type="button">
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div className="grid gap-6 pb-24">
      {dirty && outletActive ? <UnsavedChangesGuard when={dirty} /> : null}
      <section className="panel p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-2">
            <div className="font-content text-xl">项目信息</div>
            <div className="text-xs text-subtext">名称 / 题材 / 一句话梗概（logline）</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button className="btn btn-secondary" disabled={saving} onClick={() => void gotoCharacters()} type="button">
              {dirty ? "保存并下一步：角色卡" : "下一步：角色卡"}
            </button>
            <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()} type="button">
              保存
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 sm:col-span-1">
            <span className="text-xs text-subtext">项目名</span>
            <input
              className="input"
              name="project_name"
              value={projectForm.name}
              onChange={(e) => setProjectForm((v) => ({ ...v, name: e.target.value }))}
            />
          </label>
          <label className="grid gap-1 sm:col-span-1">
            <span className="text-xs text-subtext">题材</span>
            <input
              className="input"
              name="project_genre"
              value={projectForm.genre}
              onChange={(e) => setProjectForm((v) => ({ ...v, genre: e.target.value }))}
            />
          </label>
          <label className="grid gap-1 sm:col-span-3">
            <span className="text-xs text-subtext">一句话梗概（logline）</span>
            <textarea
              className="textarea"
              name="project_logline"
              rows={2}
              value={projectForm.logline}
              onChange={(e) => setProjectForm((v) => ({ ...v, logline: e.target.value }))}
            />
          </label>
        </div>
      </section>

      <section className="panel p-6">
        <div className="grid gap-1">
          <div className="font-content text-xl">创作设定（必填）</div>
          <div className="text-xs text-subtext">写作/大纲生成会引用这里的内容；建议尽量具体。</div>
        </div>
        <div className="mt-4 grid gap-4">
          <label className="grid gap-1">
            <span className="text-xs text-subtext">世界观</span>
            <textarea
              className="textarea atelier-content"
              name="world_setting"
              rows={6}
              value={settingsForm.world_setting}
              onChange={(e) => setSettingsForm((v) => ({ ...v, world_setting: e.target.value }))}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-subtext">风格</span>
            <textarea
              className="textarea atelier-content"
              name="style_guide"
              rows={6}
              value={settingsForm.style_guide}
              onChange={(e) => setSettingsForm((v) => ({ ...v, style_guide: e.target.value }))}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-subtext">约束</span>
            <textarea
              className="textarea atelier-content"
              name="constraints"
              rows={6}
              value={settingsForm.constraints}
              onChange={(e) => setSettingsForm((v) => ({ ...v, constraints: e.target.value }))}
            />
          </label>
        </div>
      </section>

      <section className="panel p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-content text-xl">自动更新</div>
            <div className="text-xs text-subtext">
              自动更新配置已迁移至「模型配置 → 自动化任务」Tab。
            </div>
          </div>
          {projectId && (
            <button
              className="btn btn-secondary"
              onClick={() => navigate(`/projects/${projectId}/prompts#automation`)}
              type="button"
            >
              打开模型配置
            </button>
          )}
        </div>
      </section>

      <section className="panel p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-content text-xl">向量检索 & Rerank</div>
            <div className="text-xs text-subtext">
              向量检索配置已迁移至「模型配置 → 向量 &amp; RAG」Tab。
            </div>
          </div>
          {projectId && (
            <button
              className="btn btn-secondary"
              onClick={() => navigate(`/projects/${projectId}/prompts#rag`)}
              type="button"
            >
              打开模型配置
            </button>
          )}
        </div>
      </section>

      <section className="panel p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-content text-xl">Query 预处理</div>
            <div className="text-xs text-subtext">
              Query 预处理配置已迁移至「模型配置 → 向量 &amp; RAG」Tab。
            </div>
          </div>
          {projectId && (
            <button
              className="btn btn-secondary"
              onClick={() => navigate(`/projects/${projectId}/prompts#rag`)}
              type="button"
            >
              打开模型配置
            </button>
          )}
        </div>
      </section>

      <details className="panel" aria-label="上下文优化（Context Optimizer）">
        <summary className="ui-focus-ring ui-transition-fast cursor-pointer select-none p-6">
          <div className="grid gap-1">
            <div className="font-content text-xl text-ink">上下文优化（Context Optimizer）</div>
            <div className="text-xs text-subtext">
              对 StructuredMemory / WORLD_BOOK 注入做去重、排序、表格化合并，用于节省 tokens 并提升可读性（默认关闭）。
            </div>
            <div className="text-xs text-subtext">
              status: {baselineSettings.context_optimizer_enabled ? "enabled" : "disabled"}
            </div>
          </div>
        </summary>

        <div className="px-6 pb-6 pt-0">
          <div className="mt-4 grid gap-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                className="checkbox"
                checked={settingsForm.context_optimizer_enabled}
                onChange={(e) => setSettingsForm((v) => ({ ...v, context_optimizer_enabled: e.target.checked }))}
                type="checkbox"
              />
              启用 ContextOptimizer（影响 Prompt 预览与生成）
            </label>
            <div className="text-[11px] text-subtext">提示：写作页「上下文预览」会显示优化摘要与 diff。</div>
          </div>
        </div>
      </details>

      <details className="panel" aria-label="协作成员（Project Memberships）">
        <summary className="ui-focus-ring ui-transition-fast cursor-pointer select-none p-6">
          <div className="grid gap-1">
            <div className="font-content text-xl text-ink">协作成员（Project Memberships）</div>
            <div className="text-xs text-subtext">
              项目 owner 可邀请/改角色/移除成员；非成员访问将被 404（RBAC fail-closed）。
            </div>
            <div className="text-xs text-subtext">owner: {baselineProject.owner_user_id}</div>
          </div>
        </summary>

        <div className="px-6 pb-6 pt-0">
          {canManageMemberships ? (
            <div className="mt-4 grid gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1">
                  <span className="text-xs text-subtext">邀请 user_id</span>
                  <input
                    className="input"
                    id="invite_user_id"
                    name="invite_user_id"
                    value={inviteUserId}
                    onChange={(e) => setInviteUserId(e.target.value)}
                    placeholder="admin"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-xs text-subtext">角色</span>
                  <select
                    className="select"
                    id="invite_role"
                    name="invite_role"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value === "editor" ? "editor" : "viewer")}
                  >
                    <option value="viewer">{humanizeMemberRole("viewer")}</option>
                    <option value="editor">{humanizeMemberRole("editor")}</option>
                  </select>
                </label>
                <div className="flex gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={membershipSaving || membershipsLoading}
                    onClick={() => void inviteMember()}
                    type="button"
                  >
                    邀请
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={membershipSaving || membershipsLoading}
                    onClick={() => void loadMemberships()}
                    type="button"
                  >
                    {membershipsLoading ? "刷新中…" : "刷新"}
                  </button>
                </div>
              </div>

              <div className="overflow-auto rounded-atelier border border-border bg-canvas">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-xs text-subtext">
                    <tr>
                      <th className="px-3 py-2">user_id</th>
                      <th className="px-3 py-2">display_name</th>
                      <th className="px-3 py-2">role</th>
                      <th className="px-3 py-2">actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberships.map((m) => {
                      const memberUserId = m.user?.id ?? "";
                      const isOwnerRow = memberUserId === baselineProject.owner_user_id || m.role === "owner";
                      return (
                        <tr key={memberUserId} className="border-t border-border">
                          <td className="px-3 py-2 font-mono text-xs">{memberUserId}</td>
                          <td className="px-3 py-2">{m.user?.display_name ?? "-"}</td>
                          <td className="px-3 py-2">
                            {isOwnerRow ? (
                              <span className="text-xs text-subtext">{humanizeMemberRole("owner")}</span>
                            ) : (
                              <select
                                className="select"
                                name="member_role"
                                value={m.role === "editor" ? "editor" : "viewer"}
                                disabled={membershipSaving || membershipsLoading}
                                onChange={(e) =>
                                  void updateMemberRole(memberUserId, e.target.value === "editor" ? "editor" : "viewer")
                                }
                              >
                                <option value="viewer">{humanizeMemberRole("viewer")}</option>
                                <option value="editor">{humanizeMemberRole("editor")}</option>
                              </select>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {isOwnerRow ? (
                              <span className="text-xs text-subtext">-</span>
                            ) : (
                              <button
                                className="btn btn-secondary"
                                disabled={membershipSaving || membershipsLoading}
                                onClick={() => void removeMember(memberUserId)}
                                type="button"
                              >
                                移除
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {memberships.length === 0 ? (
                      <tr>
                        <td className="px-3 py-3 text-xs text-subtext" colSpan={4}>
                          暂无成员数据
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="mt-4 text-xs text-subtext">
              仅项目 owner（{baselineProject.owner_user_id}）可管理成员；当前用户：{auth.user?.id ?? "unknown"}。
            </div>
          )}
        </div>
      </details>

      <div className="text-xs text-subtext">快捷键：Ctrl/Cmd + S 保存</div>

      <WizardNextBar
        projectId={projectId}
        currentStep="settings"
        progress={wizard.progress}
        loading={wizard.loading}
        dirty={dirty}
        saving={saving}
        onSave={save}
      />

      <details className="panel" aria-label={UI_COPY.featureDefaults.ariaLabel}>
        <summary className="ui-focus-ring ui-transition-fast cursor-pointer select-none p-6">
          <div className="grid gap-1">
            <div className="font-content text-xl text-ink">{UI_COPY.featureDefaults.title}</div>
            <div className="text-xs text-subtext">{UI_COPY.featureDefaults.subtitle}</div>
            <div className="text-xs text-subtext">
              status: memory_injection_default={writingMemoryInjectionEnabled ? "enabled" : "disabled"} (localStorage)
            </div>
          </div>
        </summary>

        <div className="px-6 pb-6 pt-0">
          <div className="mt-4 grid gap-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                className="checkbox"
                id="settings_writing_memory_injection_default"
                name="writing_memory_injection_default"
                checked={writingMemoryInjectionEnabled}
                onChange={(e) => saveWritingMemoryInjectionEnabled(e.target.checked)}
                aria-label="settings_writing_memory_injection_default"
                type="checkbox"
              />
              {UI_COPY.featureDefaults.memoryInjectionLabel}
            </label>
            <div className="text-[11px] text-subtext">{UI_COPY.featureDefaults.memoryInjectionHint}</div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button className="btn btn-secondary btn-sm" onClick={resetWritingMemoryInjectionEnabled} type="button">
                {UI_COPY.featureDefaults.reset}
              </button>
              <div className="text-[11px] text-subtext">{UI_COPY.featureDefaults.resetHint}</div>
            </div>

            <div className="mt-3 rounded-atelier border border-border bg-canvas p-3 text-[11px] text-subtext">
              {UI_COPY.featureDefaults.autoUpdateHint}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
