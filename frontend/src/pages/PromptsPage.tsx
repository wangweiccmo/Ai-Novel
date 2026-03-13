import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { WizardNextBar } from "../components/atelier/WizardNextBar";
import { AutomationPanel, type AutoUpdateForm } from "../components/prompts/AutomationPanel";
import { LlmPresetPanel } from "../components/prompts/LlmPresetPanel";
import { PipelineOverview } from "../components/prompts/PipelineOverview";
import type { LlmForm, LlmModelListState, LlmTaskFormDraft } from "../components/prompts/types";
import { useConfirm } from "../components/ui/confirm";
import { RequestIdBadge } from "../components/ui/RequestIdBadge";
import { useToast } from "../components/ui/toast";
import { useAutoSave } from "../hooks/useAutoSave";
import { usePersistentOutletIsActive } from "../hooks/usePersistentOutlet";
import { useSaveHotkey } from "../hooks/useSaveHotkey";
import { UnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { useWizardProgress } from "../hooks/useWizardProgress";
import { copyText } from "../lib/copyText";
import { createRequestSeqGuard } from "../lib/requestSeqGuard";
import { UI_COPY } from "../lib/uiCopy";
import { ApiError, apiJson } from "../services/apiClient";
import { markWizardLlmTestOk } from "../services/wizard";
import type {
  LLMPreset,
  LLMModelsResponse,
  LLMProfile,
  LLMTaskCatalogItem,
  LLMTaskPreset,
  Project,
  ProjectSettings,
} from "../types";
import {
  buildPresetPayload,
  DEFAULT_LLM_FORM,
  DEFAULT_VECTOR_RAG_FORM,
  formFromProfile,
  formFromPreset,
  mapVectorFormFromSettings,
  payloadEquals,
  payloadFromPreset,
  parseTimeoutSecondsForTest,
  type LlmCapabilities,
  type VectorEmbeddingDryRunResult,
  type VectorRagForm,
  type VectorRerankDryRunResult,
} from "./prompts/models";

type TaskModuleView = {
  task_key: string;
  label: string;
  group: string;
  description: string;
  recommended_provider?: LLMTaskCatalogItem["recommended_provider"];
  recommended_model?: LLMTaskCatalogItem["recommended_model"];
  recommended_note?: LLMTaskCatalogItem["recommended_note"];
  cost_tier?: LLMTaskCatalogItem["cost_tier"];
  llm_profile_id: string | null;
  form: LlmForm;
  dirty: boolean;
  saving: boolean;
  deleting: boolean;
  modelList: LlmModelListState;
};

const EMPTY_MODEL_LIST_STATE: LlmModelListState = {
  loading: false,
  options: [],
  warning: null,
  error: null,
  requestId: null,
};

function formatLlmTestApiError(err: ApiError): string {
  const details =
    err.details && typeof err.details === "object" && err.details !== null
      ? (err.details as Record<string, unknown>)
      : null;
  const upstreamStatusCode = details && "status_code" in details ? details.status_code : undefined;
  const upstreamErrorRaw = details && "upstream_error" in details ? details.upstream_error : undefined;
  const upstreamError = (() => {
    if (!upstreamErrorRaw) return null;
    if (typeof upstreamErrorRaw === "string") {
      const s = upstreamErrorRaw.trim();
      if (!s) return null;
      try {
        const parsed = JSON.parse(s) as unknown;
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.detail === "string" && obj.detail.trim()) return obj.detail.trim();
          if (obj.error && typeof obj.error === "object") {
            const errObj = obj.error as Record<string, unknown>;
            if (typeof errObj.message === "string" && errObj.message.trim()) return errObj.message.trim();
          }
        }
      } catch {
        // ignore
      }
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    }
    return String(upstreamErrorRaw);
  })();
  const compatAdjustments =
    details && "compat_adjustments" in details && Array.isArray(details.compat_adjustments)
      ? (details.compat_adjustments as unknown[])
          .filter((x) => typeof x === "string" && x)
          .slice(0, 6)
          .join("、")
      : null;
  return err.code === "LLM_KEY_MISSING"
    ? "请先保存 API Key"
    : err.code === "LLM_AUTH_ERROR"
      ? "API Key 无效或已过期，请检查后重试"
      : err.code === "LLM_TIMEOUT"
        ? "连接超时，请检查网络或 base_url 是否正确"
        : err.code === "LLM_BAD_REQUEST"
          ? `请求参数有误，可能是模型名称或参数不支持${upstreamError ? `（上游：${upstreamError}）` : ""}${
              compatAdjustments ? `（兼容：${compatAdjustments}）` : ""
            }`
          : err.code === "LLM_UPSTREAM_ERROR"
            ? `服务暂时不可用，请稍后重试（${
                typeof upstreamStatusCode === "number" ? upstreamStatusCode : err.status
              }）`
            : err.message;
}

type PromptsTab = "models" | "rag" | "automation";

function resolveInitialTab(): PromptsTab {
  const hash = window.location.hash.replace("#", "").trim();
  if (hash === "rag" || hash === "rag-config") return "rag";
  if (hash === "automation") return "automation";
  return "models";
}

export function PromptsPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const outletActive = usePersistentOutletIsActive();
  const [activeTab, setActiveTab] = useState<PromptsTab>(resolveInitialTab);
  const wizard = useWizardProgress(projectId);
  const refreshWizard = wizard.refresh;
  const bumpWizardLocal = wizard.bumpLocal;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<null | { message: string; code: string; requestId?: string }>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [testing, setTesting] = useState(false);
  const savingPresetRef = useRef(false);
  const queuedPresetSaveRef = useRef<null | { silent: boolean; snapshot?: LlmForm }>(null);
  const wizardRefreshTimerRef = useRef<number | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  const [baselinePreset, setBaselinePreset] = useState<LLMPreset | null>(null);
  const [capabilities, setCapabilities] = useState<LlmCapabilities | null>(null);
  const capsGuardRef = useRef(createRequestSeqGuard());

  const [apiKey, setApiKey] = useState("");
  const [baselineSettings, setBaselineSettings] = useState<ProjectSettings | null>(null);
  const [vectorForm, setVectorForm] = useState<VectorRagForm>(DEFAULT_VECTOR_RAG_FORM);
  const [vectorRerankTopKDraft, setVectorRerankTopKDraft] = useState(
    String(DEFAULT_VECTOR_RAG_FORM.vector_rerank_top_k),
  );
  const [vectorRerankTimeoutDraft, setVectorRerankTimeoutDraft] = useState("");
  const [vectorRerankHybridAlphaDraft, setVectorRerankHybridAlphaDraft] = useState("");
  const [vectorApiKeyDraft, setVectorApiKeyDraft] = useState("");
  const [vectorApiKeyClearRequested, setVectorApiKeyClearRequested] = useState(false);
  const [rerankApiKeyDraft, setRerankApiKeyDraft] = useState("");
  const [rerankApiKeyClearRequested, setRerankApiKeyClearRequested] = useState(false);
  const [savingVector, setSavingVector] = useState(false);
  const savingVectorRef = useRef(false);

  const [autoUpdateForm, setAutoUpdateForm] = useState<AutoUpdateForm>({
    auto_update_worldbook_enabled: true,
    auto_update_characters_enabled: true,
    auto_update_story_memory_enabled: true,
    auto_update_graph_enabled: true,
    auto_update_vector_enabled: true,
    auto_update_search_enabled: true,
    auto_update_fractal_enabled: true,
    auto_update_tables_enabled: true,
  });
  const [savingAutoUpdate, setSavingAutoUpdate] = useState(false);

  const [qpEnabled, setQpEnabled] = useState(false);
  const [qpTags, setQpTags] = useState("");
  const [qpExclusionRules, setQpExclusionRules] = useState("");
  const [qpIndexRefEnhance, setQpIndexRefEnhance] = useState(false);

  const [embeddingDryRunLoading, setEmbeddingDryRunLoading] = useState(false);
  const [embeddingDryRun, setEmbeddingDryRun] = useState<null | {
    requestId: string;
    result: VectorEmbeddingDryRunResult;
  }>(null);
  const [embeddingDryRunError, setEmbeddingDryRunError] = useState<null | {
    message: string;
    code: string;
    requestId?: string;
  }>(null);
  const [rerankDryRunLoading, setRerankDryRunLoading] = useState(false);
  const [rerankDryRun, setRerankDryRun] = useState<null | { requestId: string; result: VectorRerankDryRunResult }>(
    null,
  );
  const [rerankDryRunError, setRerankDryRunError] = useState<null | {
    message: string;
    code: string;
    requestId?: string;
  }>(null);

  const [llmForm, setLlmForm] = useState<LlmForm>({ ...DEFAULT_LLM_FORM });
  const [mainModelList, setMainModelList] = useState<LlmModelListState>({ ...EMPTY_MODEL_LIST_STATE });

  const [taskCatalog, setTaskCatalog] = useState<LLMTaskCatalogItem[]>([]);
  const [taskBaseline, setTaskBaseline] = useState<Record<string, LLMTaskPreset>>({});
  const [taskDrafts, setTaskDrafts] = useState<Record<string, LlmTaskFormDraft>>({});
  const [taskModelLists, setTaskModelLists] = useState<Record<string, LlmModelListState>>({});
  const [taskSaving, setTaskSaving] = useState<Record<string, boolean>>({});
  const [taskDeleting, setTaskDeleting] = useState<Record<string, boolean>>({});
  const [taskTesting, setTaskTesting] = useState<Record<string, boolean>>({});
  const [taskProfileBusy, setTaskProfileBusy] = useState<Record<string, boolean>>({});
  const [taskApiKeyDrafts, setTaskApiKeyDrafts] = useState<Record<string, string>>({});
  const [selectedAddTaskKey, setSelectedAddTaskKey] = useState("");

  const reloadAll = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [presetRes, pRes, profilesRes, settingsRes, taskRes] = await Promise.all([
        apiJson<{ llm_preset: LLMPreset }>(`/api/projects/${projectId}/llm_preset`),
        apiJson<{ project: Project }>(`/api/projects/${projectId}`),
        apiJson<{ profiles: LLMProfile[] }>(`/api/llm_profiles`),
        apiJson<{ settings: ProjectSettings }>(`/api/projects/${projectId}/settings`),
        apiJson<{ catalog: LLMTaskCatalogItem[]; task_presets: LLMTaskPreset[] }>(
          `/api/projects/${projectId}/llm_task_presets`,
        ),
      ]);

      setProject(pRes.data.project);
      setProfiles(profilesRes.data.profiles ?? []);
      setProfileName("");

      setBaselinePreset(presetRes.data.llm_preset);
      setCapabilities({
        provider: presetRes.data.llm_preset.provider,
        model: presetRes.data.llm_preset.model,
        max_tokens_limit: presetRes.data.llm_preset.max_tokens_limit ?? null,
        max_tokens_recommended: presetRes.data.llm_preset.max_tokens_recommended ?? null,
        context_window_limit: presetRes.data.llm_preset.context_window_limit ?? null,
      });
      setLlmForm(formFromPreset(presetRes.data.llm_preset));

      const nextTaskCatalog = taskRes.data.catalog ?? [];
      const nextTaskBaseline: Record<string, LLMTaskPreset> = {};
      const nextTaskDrafts: Record<string, LlmTaskFormDraft> = {};
      for (const row of taskRes.data.task_presets ?? []) {
        const key = String(row.task_key || "").trim();
        if (!key) continue;
        nextTaskBaseline[key] = row;
        nextTaskDrafts[key] = {
          task_key: key,
          llm_profile_id: row.llm_profile_id ?? null,
          form: formFromPreset(row),
          isNew: false,
        };
      }
      setTaskCatalog(nextTaskCatalog);
      setTaskBaseline(nextTaskBaseline);
      setTaskDrafts(nextTaskDrafts);
      setTaskModelLists({});
      setTaskSaving({});
      setTaskDeleting({});
      setTaskTesting({});
      setTaskProfileBusy({});
      setTaskApiKeyDrafts({});
      const firstAddable = nextTaskCatalog.find((item) => !nextTaskDrafts[item.key])?.key ?? "";
      setSelectedAddTaskKey(firstAddable);

      const settings = settingsRes.data.settings;
      const mappedVector = mapVectorFormFromSettings(settings);
      setBaselineSettings(settings);
      setVectorForm(mappedVector.vectorForm);
      setVectorRerankTopKDraft(mappedVector.vectorRerankTopKDraft);
      setVectorRerankTimeoutDraft(mappedVector.vectorRerankTimeoutDraft);
      setVectorRerankHybridAlphaDraft(mappedVector.vectorRerankHybridAlphaDraft);
      setVectorApiKeyDraft("");
      setVectorApiKeyClearRequested(false);
      setRerankApiKeyDraft("");
      setRerankApiKeyClearRequested(false);

      setAutoUpdateForm({
        auto_update_worldbook_enabled: Boolean(settings.auto_update_worldbook_enabled ?? true),
        auto_update_characters_enabled: Boolean(settings.auto_update_characters_enabled ?? true),
        auto_update_story_memory_enabled: Boolean(settings.auto_update_story_memory_enabled ?? true),
        auto_update_graph_enabled: Boolean(settings.auto_update_graph_enabled ?? true),
        auto_update_vector_enabled: Boolean(settings.auto_update_vector_enabled ?? true),
        auto_update_search_enabled: Boolean(settings.auto_update_search_enabled ?? true),
        auto_update_fractal_enabled: Boolean(settings.auto_update_fractal_enabled ?? true),
        auto_update_tables_enabled: Boolean(settings.auto_update_tables_enabled ?? true),
      });

      setQpEnabled(Boolean(settings.query_preprocessing_effective?.enabled));
      setQpTags(
        Array.isArray(settings.query_preprocessing_effective?.tags)
          ? settings.query_preprocessing_effective.tags.join("\n")
          : "",
      );
      setQpExclusionRules(
        Array.isArray(settings.query_preprocessing_effective?.exclusion_rules)
          ? settings.query_preprocessing_effective.exclusion_rules.join("\n")
          : "",
      );
      setQpIndexRefEnhance(Boolean(settings.query_preprocessing_effective?.index_ref_enhance));

      setApiKey("");
      setMainModelList({ ...EMPTY_MODEL_LIST_STATE });
      setLoadError(null);
    } catch (e) {
      if (e instanceof ApiError) {
        setLoadError({ message: e.message, code: e.code, requestId: e.requestId });
        toast.toastError(`${e.message} (${e.code})`, e.requestId);
      } else {
        setLoadError({ message: "请求失败", code: "UNKNOWN_ERROR" });
        toast.toastError("请求失败 (UNKNOWN_ERROR)");
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    return () => {
      if (wizardRefreshTimerRef.current !== null) window.clearTimeout(wizardRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const guard = capsGuardRef.current;
    return () => {
      guard.invalidate();
    };
  }, []);

  useEffect(() => {
    const provider = llmForm.provider;
    const model = llmForm.model.trim();
    const guard = capsGuardRef.current;
    if (!model) {
      guard.invalidate();
      setCapabilities(null);
      return;
    }
    const seq = guard.next();
    void (async () => {
      try {
        const res = await apiJson<{ capabilities: LlmCapabilities }>(
          `/api/llm_capabilities?provider=${provider}&model=${encodeURIComponent(model)}`,
        );
        if (!guard.isLatest(seq)) return;
        setCapabilities(res.data.capabilities);
      } catch {
        if (!guard.isLatest(seq)) return;
        setCapabilities(null);
      }
    })();
  }, [llmForm.model, llmForm.provider]);

  useEffect(() => {
    setApiKey("");
  }, [llmForm.provider, project?.llm_profile_id]);

  const currentMainPayload = useMemo(() => buildPresetPayload(llmForm), [llmForm]);
  const baselineMainPayload = useMemo(
    () => (baselinePreset ? payloadFromPreset(baselinePreset) : null),
    [baselinePreset],
  );
  const presetDirty = useMemo(() => {
    if (!baselineMainPayload) return false;
    if (!currentMainPayload.ok) return true;
    return !payloadEquals(currentMainPayload.payload, baselineMainPayload);
  }, [baselineMainPayload, currentMainPayload]);

  const selectedProfileId = project?.llm_profile_id ?? null;
  const selectedProfile = selectedProfileId ? (profiles.find((p) => p.id === selectedProfileId) ?? null) : null;
  const upsertProfile = useCallback((profile: LLMProfile) => {
    setProfiles((prev) => [profile, ...prev.filter((item) => item.id !== profile.id)]);
  }, []);

  const taskCatalogByKey = useMemo(() => {
    const map = new Map<string, LLMTaskCatalogItem>();
    for (const item of taskCatalog) map.set(item.key, item);
    return map;
  }, [taskCatalog]);

  const taskModules = useMemo<TaskModuleView[]>(() => {
    return Object.values(taskDrafts)
      .map((draft) => {
        const baseline = taskBaseline[draft.task_key] ?? null;
        const baselinePayload = baseline ? payloadFromPreset(baseline) : null;
        const payload = buildPresetPayload(draft.form);
        const payloadDirty =
          baselinePayload === null || !payload.ok ? true : !payloadEquals(payload.payload, baselinePayload);
        const bindingDirty = (draft.llm_profile_id ?? null) !== (baseline?.llm_profile_id ?? null);
        const item = taskCatalogByKey.get(draft.task_key);
        return {
          task_key: draft.task_key,
          label: item?.label ?? draft.task_key,
          group: item?.group ?? "custom",
          description: item?.description ?? "任务级模型覆盖",
          recommended_provider: item?.recommended_provider ?? null,
          recommended_model: item?.recommended_model ?? null,
          recommended_note: item?.recommended_note ?? null,
          cost_tier: item?.cost_tier ?? null,
          llm_profile_id: draft.llm_profile_id,
          form: draft.form,
          dirty: draft.isNew || payloadDirty || bindingDirty,
          saving: Boolean(taskSaving[draft.task_key]),
          deleting: Boolean(taskDeleting[draft.task_key]),
          modelList: taskModelLists[draft.task_key] ?? { ...EMPTY_MODEL_LIST_STATE },
        };
      })
      .sort((a, b) => a.group.localeCompare(b.group, "zh-Hans-CN") || a.label.localeCompare(b.label, "zh-Hans-CN"));
  }, [taskBaseline, taskCatalogByKey, taskDeleting, taskDrafts, taskModelLists, taskSaving]);

  const taskDirty = useMemo(() => taskModules.some((item) => item.dirty), [taskModules]);
  const addableTasks = useMemo(() => taskCatalog.filter((item) => !taskDrafts[item.key]), [taskCatalog, taskDrafts]);

  const dirty = presetDirty || taskDirty;
  const llmCtaBlockedReason = useMemo(() => {
    if (!selectedProfileId) return "请先选择或新建一个后端配置";
    if (!selectedProfile?.has_api_key) return "请先保存 API Key";
    return null;
  }, [selectedProfile?.has_api_key, selectedProfileId]);

  useEffect(() => {
    if (!addableTasks.length) {
      if (selectedAddTaskKey) setSelectedAddTaskKey("");
      return;
    }
    if (selectedAddTaskKey && addableTasks.some((item) => item.key === selectedAddTaskKey)) return;
    setSelectedAddTaskKey(addableTasks[0].key);
  }, [addableTasks, selectedAddTaskKey]);

  const saveAll = useCallback(
    async (opts?: { silent?: boolean; snapshot?: LlmForm }): Promise<boolean> => {
      if (!projectId) return false;
      const silent = Boolean(opts?.silent);
      const snapshot = opts?.snapshot ?? llmForm;
      if (!presetDirty && !opts?.snapshot) return true;
      if (savingPresetRef.current) {
        queuedPresetSaveRef.current = { silent, snapshot };
        return false;
      }

      const payload = buildPresetPayload(snapshot);
      if (!payload.ok) {
        if (!silent) toast.toastError(payload.message);
        return false;
      }

      const scheduleWizardRefresh = () => {
        if (wizardRefreshTimerRef.current !== null) window.clearTimeout(wizardRefreshTimerRef.current);
        wizardRefreshTimerRef.current = window.setTimeout(() => void refreshWizard(), 1200);
      };

      savingPresetRef.current = true;
      setSavingPreset(true);
      try {
        if (selectedProfileId) {
          const currentProvider = selectedProfile?.provider ?? null;
          const currentModel = selectedProfile?.model ?? null;
          const currentBaseUrl = (selectedProfile?.base_url ?? "").trim();
          const needsProfileSync =
            currentProvider !== payload.payload.provider ||
            currentModel !== payload.payload.model ||
            currentBaseUrl !== (payload.payload.base_url ?? "");
          if (needsProfileSync) {
            const res = await apiJson<{ profile: LLMProfile }>(`/api/llm_profiles/${selectedProfileId}`, {
              method: "PUT",
              body: JSON.stringify({
                provider: payload.payload.provider,
                base_url: payload.payload.base_url,
                model: payload.payload.model,
              }),
            });
            setProfiles((prev) => prev.map((p) => (p.id === res.data.profile.id ? res.data.profile : p)));
          }
        }

        if (presetDirty) {
          const res = await apiJson<{ llm_preset: LLMPreset }>(`/api/projects/${projectId}/llm_preset`, {
            method: "PUT",
            body: JSON.stringify(payload.payload),
          });
          setBaselinePreset(res.data.llm_preset);

          setLlmForm((current) => {
            if (current.provider !== snapshot.provider) return current;
            if (current.base_url !== snapshot.base_url) return current;
            if (current.model !== snapshot.model) return current;
            if (current.temperature !== snapshot.temperature) return current;
            if (current.top_p !== snapshot.top_p) return current;
            if (current.max_tokens !== snapshot.max_tokens) return current;
            if (current.presence_penalty !== snapshot.presence_penalty) return current;
            if (current.frequency_penalty !== snapshot.frequency_penalty) return current;
            if (current.top_k !== snapshot.top_k) return current;
            if (current.stop !== snapshot.stop) return current;
            if (current.timeout_seconds !== snapshot.timeout_seconds) return current;
            if (current.reasoning_effort !== snapshot.reasoning_effort) return current;
            if (current.text_verbosity !== snapshot.text_verbosity) return current;
            if (current.anthropic_thinking_enabled !== snapshot.anthropic_thinking_enabled) return current;
            if (current.anthropic_thinking_budget_tokens !== snapshot.anthropic_thinking_budget_tokens) return current;
            if (current.gemini_thinking_budget !== snapshot.gemini_thinking_budget) return current;
            if (current.gemini_include_thoughts !== snapshot.gemini_include_thoughts) return current;
            if (current.extra !== snapshot.extra) return current;
            return formFromPreset(res.data.llm_preset);
          });
        }

        bumpWizardLocal();
        if (silent) scheduleWizardRefresh();
        else {
          toast.toastSuccess("已保存");
          await refreshWizard();
        }
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setSavingPreset(false);
        savingPresetRef.current = false;
        if (queuedPresetSaveRef.current) {
          const queued = queuedPresetSaveRef.current;
          queuedPresetSaveRef.current = null;
          void saveAll({ silent: queued.silent, snapshot: queued.snapshot });
        }
      }
    },
    [bumpWizardLocal, llmForm, presetDirty, projectId, refreshWizard, selectedProfile, selectedProfileId, toast],
  );

  const updateTaskForm = useCallback((taskKey: string, updater: (prev: LlmForm) => LlmForm) => {
    setTaskDrafts((prev) => {
      const current = prev[taskKey];
      if (!current) return prev;
      return {
        ...prev,
        [taskKey]: {
          ...current,
          form: updater(current.form),
        },
      };
    });
  }, []);

  const updateTaskProfile = useCallback(
    (taskKey: string, profileId: string | null) => {
      const targetProfile = profileId ? (profiles.find((item) => item.id === profileId) ?? null) : null;
      const nextForm = targetProfile ? formFromProfile(targetProfile) : { ...llmForm };
      setTaskDrafts((prev) => {
        const current = prev[taskKey];
        if (!current) return prev;
        return {
          ...prev,
          [taskKey]: {
            ...current,
            llm_profile_id: profileId,
            form: nextForm,
          },
        };
      });
      setTaskApiKeyDrafts((prev) => ({ ...prev, [taskKey]: "" }));
    },
    [llmForm, profiles],
  );

  const updateTaskApiKeyDraft = useCallback((taskKey: string, value: string) => {
    setTaskApiKeyDrafts((prev) => ({ ...prev, [taskKey]: value }));
  }, []);

  const addTaskModule = useCallback(() => {
    const taskKey = selectedAddTaskKey.trim();
    if (!taskKey) return;
    setTaskDrafts((prev) => {
      if (prev[taskKey]) return prev;
      return {
        ...prev,
        [taskKey]: {
          task_key: taskKey,
          llm_profile_id: null,
          form: { ...llmForm },
          isNew: true,
        },
      };
    });
    setTaskModelLists((prev) => ({ ...prev, [taskKey]: { ...EMPTY_MODEL_LIST_STATE } }));
    setTaskApiKeyDrafts((prev) => ({ ...prev, [taskKey]: "" }));
  }, [llmForm, selectedAddTaskKey]);

  const saveTaskModule = useCallback(
    async (taskKey: string, opts?: { silent?: boolean }): Promise<boolean> => {
      if (!projectId) return false;
      const draft = taskDrafts[taskKey];
      if (!draft) return false;
      if (taskProfileBusy[taskKey]) {
        if (!opts?.silent) toast.toastError("该任务正在更新 API Key，请稍后再试");
        return false;
      }
      const payload = buildPresetPayload(draft.form);
      if (!payload.ok) {
        if (!opts?.silent) toast.toastError(payload.message);
        return false;
      }
      if (draft.llm_profile_id) {
        const boundProfile = profiles.find((item) => item.id === draft.llm_profile_id) ?? null;
        if (!boundProfile) {
          if (!opts?.silent) toast.toastError("任务模块绑定的配置库不存在，请重新选择");
          return false;
        }
        if (boundProfile.provider !== payload.payload.provider) {
          if (!opts?.silent) toast.toastError("任务模块 provider 必须与所选 API 配置库 provider 一致");
          return false;
        }
      }

      setTaskSaving((prev) => ({ ...prev, [taskKey]: true }));
      try {
        const res = await apiJson<{ task_preset: LLMTaskPreset }>(
          `/api/projects/${projectId}/llm_task_presets/${encodeURIComponent(taskKey)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              ...payload.payload,
              llm_profile_id: draft.llm_profile_id,
            }),
          },
        );
        const row = res.data.task_preset;
        setTaskBaseline((prev) => ({ ...prev, [taskKey]: row }));
        setTaskDrafts((prev) => {
          const current = prev[taskKey];
          if (!current) return prev;
          return {
            ...prev,
            [taskKey]: {
              ...current,
              llm_profile_id: row.llm_profile_id ?? null,
              form: formFromPreset(row),
              isNew: false,
            },
          };
        });
        if (!opts?.silent) toast.toastSuccess("任务模块已保存", res.request_id);
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (!opts?.silent) toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setTaskSaving((prev) => ({ ...prev, [taskKey]: false }));
      }
    },
    [profiles, projectId, taskDrafts, taskProfileBusy, toast],
  );

  const deleteTaskModule = useCallback(
    async (taskKey: string): Promise<boolean> => {
      if (!projectId) return false;
      const draft = taskDrafts[taskKey];
      if (!draft) return false;
      const yes = await confirm.confirm({
        title: "删除任务模块",
        description: `确认删除任务模块「${taskCatalogByKey.get(taskKey)?.label ?? taskKey}」？删除后将回退到主模块。`,
        confirmText: "删除",
        cancelText: "取消",
        danger: true,
      });
      if (!yes) return false;

      if (draft.isNew && !taskBaseline[taskKey]) {
        setTaskDrafts((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskModelLists((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskTesting((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskProfileBusy((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskApiKeyDrafts((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        toast.toastSuccess("已移除未保存模块");
        return true;
      }

      setTaskDeleting((prev) => ({ ...prev, [taskKey]: true }));
      try {
        await apiJson<Record<string, never>>(
          `/api/projects/${projectId}/llm_task_presets/${encodeURIComponent(taskKey)}`,
          {
            method: "DELETE",
          },
        );
        setTaskBaseline((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskDrafts((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskModelLists((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskTesting((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskProfileBusy((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        setTaskApiKeyDrafts((prev) => {
          const next = { ...prev };
          delete next[taskKey];
          return next;
        });
        toast.toastSuccess("任务模块已删除");
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setTaskDeleting((prev) => ({ ...prev, [taskKey]: false }));
      }
    },
    [confirm, projectId, taskBaseline, taskCatalogByKey, taskDrafts, toast],
  );

  const loadModels = useCallback(
    async (opts: { scope: "main" | "task"; taskKey?: string; form: LlmForm; profileId: string | null }) => {
      if (!projectId) return;
      const setLoading = (loading: boolean) => {
        if (opts.scope === "main") {
          setMainModelList((prev) => ({ ...prev, loading }));
          return;
        }
        const key = opts.taskKey ?? "";
        setTaskModelLists((prev) => ({
          ...prev,
          [key]: {
            ...(prev[key] ?? { ...EMPTY_MODEL_LIST_STATE }),
            loading,
          },
        }));
      };
      const setResult = (state: LlmModelListState) => {
        if (opts.scope === "main") {
          setMainModelList(state);
          return;
        }
        const key = opts.taskKey ?? "";
        setTaskModelLists((prev) => ({ ...prev, [key]: state }));
      };

      const params = new URLSearchParams();
      params.set("provider", opts.form.provider);
      if (opts.form.base_url.trim()) params.set("base_url", opts.form.base_url.trim());
      if (opts.profileId) params.set("profile_id", opts.profileId);
      else params.set("project_id", projectId);

      setLoading(true);
      try {
        const res = await apiJson<LLMModelsResponse>(`/api/llm_models?${params.toString()}`);
        const options = (res.data.models ?? [])
          .map((item) => ({
            id: String(item.id || "").trim(),
            display_name: String(item.display_name || item.id || "").trim(),
          }))
          .filter((item) => item.id);
        setResult({
          loading: false,
          options,
          warning: res.data.warning?.message ?? null,
          error: null,
          requestId: res.request_id,
        });
      } catch (e) {
        const err = e as ApiError;
        setResult({
          loading: false,
          options: [],
          warning: null,
          error: `${err.message} (${err.code})`,
          requestId: err.requestId ?? null,
        });
      }
    },
    [projectId],
  );

  const reloadMainModels = useCallback(() => {
    void loadModels({
      scope: "main",
      form: llmForm,
      profileId: selectedProfileId,
    });
  }, [llmForm, loadModels, selectedProfileId]);

  const reloadTaskModels = useCallback(
    (taskKey: string) => {
      const draft = taskDrafts[taskKey];
      if (!draft) return;
      void loadModels({
        scope: "task",
        taskKey,
        form: draft.form,
        profileId: draft.llm_profile_id,
      });
    },
    [loadModels, taskDrafts],
  );

  const saveAllDirtyModules = useCallback(async (): Promise<boolean> => {
    let ok = true;
    let savedAny = false;
    if (presetDirty) {
      savedAny = true;
      ok = (await saveAll({ silent: true })) && ok;
    }
    for (const item of taskModules) {
      if (!item.dirty) continue;
      savedAny = true;
      ok = (await saveTaskModule(item.task_key, { silent: true })) && ok;
    }
    if (savedAny && !ok) {
      toast.toastError("存在未保存模块，请先检查参数与配置绑定");
    }
    if (savedAny && ok) {
      toast.toastSuccess("已保存全部模块");
      await refreshWizard();
    }
    return ok;
  }, [presetDirty, refreshWizard, saveAll, saveTaskModule, taskModules, toast]);

  useSaveHotkey(() => void saveAllDirtyModules(), dirty);

  useAutoSave({
    enabled: Boolean(projectId),
    dirty: presetDirty,
    delayMs: 1200,
    getSnapshot: () => ({ ...llmForm }),
    onSave: async (snapshot) => {
      await saveAll({ silent: true, snapshot });
    },
    deps: [
      llmForm.provider,
      llmForm.base_url,
      llmForm.model,
      llmForm.temperature,
      llmForm.top_p,
      llmForm.max_tokens,
      llmForm.presence_penalty,
      llmForm.frequency_penalty,
      llmForm.top_k,
      llmForm.stop,
      llmForm.timeout_seconds,
      llmForm.reasoning_effort,
      llmForm.text_verbosity,
      llmForm.anthropic_thinking_enabled ? "1" : "0",
      llmForm.anthropic_thinking_budget_tokens,
      llmForm.gemini_thinking_budget,
      llmForm.gemini_include_thoughts ? "1" : "0",
      llmForm.extra,
      projectId ?? "",
    ],
  });

  const vectorApiKeyDirty = vectorApiKeyClearRequested || vectorApiKeyDraft.trim().length > 0;
  const rerankApiKeyDirty = rerankApiKeyClearRequested || rerankApiKeyDraft.trim().length > 0;
  const vectorRagDirty = useMemo(() => {
    if (!baselineSettings) return false;
    return (
      vectorForm.vector_rerank_enabled !== baselineSettings.vector_rerank_effective_enabled ||
      vectorForm.vector_rerank_method.trim() !== baselineSettings.vector_rerank_effective_method ||
      Math.max(1, Math.min(1000, Math.floor(vectorForm.vector_rerank_top_k))) !==
        baselineSettings.vector_rerank_effective_top_k ||
      vectorForm.vector_rerank_provider !== baselineSettings.vector_rerank_provider ||
      vectorForm.vector_rerank_base_url !== baselineSettings.vector_rerank_base_url ||
      vectorForm.vector_rerank_model !== baselineSettings.vector_rerank_model ||
      (vectorForm.vector_rerank_timeout_seconds ?? null) !== (baselineSettings.vector_rerank_timeout_seconds ?? null) ||
      (vectorForm.vector_rerank_hybrid_alpha ?? null) !== (baselineSettings.vector_rerank_hybrid_alpha ?? null) ||
      vectorForm.vector_embedding_provider !== baselineSettings.vector_embedding_provider ||
      vectorForm.vector_embedding_base_url !== baselineSettings.vector_embedding_base_url ||
      vectorForm.vector_embedding_model !== baselineSettings.vector_embedding_model ||
      vectorForm.vector_embedding_azure_deployment !== baselineSettings.vector_embedding_azure_deployment ||
      vectorForm.vector_embedding_azure_api_version !== baselineSettings.vector_embedding_azure_api_version ||
      vectorForm.vector_embedding_sentence_transformers_model !==
        baselineSettings.vector_embedding_sentence_transformers_model
    );
  }, [baselineSettings, vectorForm]);

  const autoUpdateDirty = useMemo(() => {
    if (!baselineSettings) return false;
    return (
      autoUpdateForm.auto_update_worldbook_enabled !== Boolean(baselineSettings.auto_update_worldbook_enabled ?? true) ||
      autoUpdateForm.auto_update_characters_enabled !== Boolean(baselineSettings.auto_update_characters_enabled ?? true) ||
      autoUpdateForm.auto_update_story_memory_enabled !== Boolean(baselineSettings.auto_update_story_memory_enabled ?? true) ||
      autoUpdateForm.auto_update_graph_enabled !== Boolean(baselineSettings.auto_update_graph_enabled ?? true) ||
      autoUpdateForm.auto_update_vector_enabled !== Boolean(baselineSettings.auto_update_vector_enabled ?? true) ||
      autoUpdateForm.auto_update_search_enabled !== Boolean(baselineSettings.auto_update_search_enabled ?? true) ||
      autoUpdateForm.auto_update_fractal_enabled !== Boolean(baselineSettings.auto_update_fractal_enabled ?? true) ||
      autoUpdateForm.auto_update_tables_enabled !== Boolean(baselineSettings.auto_update_tables_enabled ?? true)
    );
  }, [baselineSettings, autoUpdateForm]);

  const qpDirty = useMemo(() => {
    if (!baselineSettings) return false;
    const baseline = baselineSettings.query_preprocessing_effective;
    const baseEnabled = Boolean(baseline?.enabled);
    const baseTags = Array.isArray(baseline?.tags) ? baseline.tags.join("\n") : "";
    const baseExclusion = Array.isArray(baseline?.exclusion_rules) ? baseline.exclusion_rules.join("\n") : "";
    const baseIndexRef = Boolean(baseline?.index_ref_enhance);
    return (
      qpEnabled !== baseEnabled ||
      qpTags !== baseTags ||
      qpExclusionRules !== baseExclusion ||
      qpIndexRefEnhance !== baseIndexRef
    );
  }, [baselineSettings, qpEnabled, qpTags, qpExclusionRules, qpIndexRefEnhance]);

  const anyDirty = dirty || vectorRagDirty || vectorApiKeyDirty || rerankApiKeyDirty || autoUpdateDirty || qpDirty;

  const saveVectorRagConfig = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;
    if (!baselineSettings) return false;
    if (!vectorRagDirty && !vectorApiKeyDirty && !rerankApiKeyDirty) return true;
    if (savingVectorRef.current) return false;

    const rerankMethod = vectorForm.vector_rerank_method.trim() || "auto";
    const rawTopK = vectorRerankTopKDraft.trim();
    const parsedTopK = Math.floor(Number(rawTopK || String(vectorForm.vector_rerank_top_k)));
    if (!Number.isFinite(parsedTopK) || parsedTopK < 1 || parsedTopK > 1000) {
      toast.toastError("rerank top_k 必须为 1-1000 的整数");
      return false;
    }

    const timeoutRaw = vectorRerankTimeoutDraft.trim();
    const parsedTimeoutSeconds = timeoutRaw ? Math.floor(Number(timeoutRaw)) : null;
    if (
      parsedTimeoutSeconds !== null &&
      (!Number.isFinite(parsedTimeoutSeconds) || parsedTimeoutSeconds < 1 || parsedTimeoutSeconds > 120)
    ) {
      toast.toastError("rerank timeout_seconds 必须为 1-120 的整数（或留空）");
      return false;
    }

    const alphaRaw = vectorRerankHybridAlphaDraft.trim();
    const parsedHybridAlpha = alphaRaw ? Number(alphaRaw) : null;
    if (
      parsedHybridAlpha !== null &&
      (!Number.isFinite(parsedHybridAlpha) || parsedHybridAlpha < 0 || parsedHybridAlpha > 1)
    ) {
      toast.toastError("rerank hybrid_alpha 必须为 0-1 的数字（或留空）");
      return false;
    }

    savingVectorRef.current = true;
    setSavingVector(true);
    try {
      const res = await apiJson<{ settings: ProjectSettings }>(`/api/projects/${projectId}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          vector_rerank_enabled: Boolean(vectorForm.vector_rerank_enabled),
          vector_rerank_method: rerankMethod,
          vector_rerank_top_k: parsedTopK,
          vector_rerank_provider: vectorForm.vector_rerank_provider,
          vector_rerank_base_url: vectorForm.vector_rerank_base_url,
          vector_rerank_model: vectorForm.vector_rerank_model,
          vector_rerank_timeout_seconds: parsedTimeoutSeconds,
          vector_rerank_hybrid_alpha: parsedHybridAlpha,
          vector_embedding_provider: vectorForm.vector_embedding_provider,
          vector_embedding_base_url: vectorForm.vector_embedding_base_url,
          vector_embedding_model: vectorForm.vector_embedding_model,
          vector_embedding_azure_deployment: vectorForm.vector_embedding_azure_deployment,
          vector_embedding_azure_api_version: vectorForm.vector_embedding_azure_api_version,
          vector_embedding_sentence_transformers_model: vectorForm.vector_embedding_sentence_transformers_model,
          ...(rerankApiKeyDirty ? { vector_rerank_api_key: rerankApiKeyClearRequested ? "" : rerankApiKeyDraft } : {}),
          ...(vectorApiKeyDirty
            ? { vector_embedding_api_key: vectorApiKeyClearRequested ? "" : vectorApiKeyDraft }
            : {}),
        }),
      });

      const settings = res.data.settings;
      const nextTopK = Number(settings.vector_rerank_effective_top_k ?? 20) || 20;
      setBaselineSettings(settings);
      setVectorForm({
        vector_rerank_enabled: Boolean(settings.vector_rerank_effective_enabled),
        vector_rerank_method: String(settings.vector_rerank_effective_method ?? "auto") || "auto",
        vector_rerank_top_k: nextTopK,
        vector_rerank_provider: settings.vector_rerank_provider ?? "",
        vector_rerank_base_url: settings.vector_rerank_base_url ?? "",
        vector_rerank_model: settings.vector_rerank_model ?? "",
        vector_rerank_timeout_seconds: settings.vector_rerank_timeout_seconds ?? null,
        vector_rerank_hybrid_alpha: settings.vector_rerank_hybrid_alpha ?? null,
        vector_embedding_provider: settings.vector_embedding_provider ?? "",
        vector_embedding_base_url: settings.vector_embedding_base_url ?? "",
        vector_embedding_model: settings.vector_embedding_model ?? "",
        vector_embedding_azure_deployment: settings.vector_embedding_azure_deployment ?? "",
        vector_embedding_azure_api_version: settings.vector_embedding_azure_api_version ?? "",
        vector_embedding_sentence_transformers_model: settings.vector_embedding_sentence_transformers_model ?? "",
      });
      setVectorRerankTopKDraft(String(nextTopK));
      setVectorRerankTimeoutDraft(
        settings.vector_rerank_timeout_seconds != null ? String(settings.vector_rerank_timeout_seconds) : "",
      );
      setVectorRerankHybridAlphaDraft(
        settings.vector_rerank_hybrid_alpha != null ? String(settings.vector_rerank_hybrid_alpha) : "",
      );
      setVectorApiKeyDraft("");
      setVectorApiKeyClearRequested(false);
      setRerankApiKeyDraft("");
      setRerankApiKeyClearRequested(false);

      toast.toastSuccess("已保存");
      return true;
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
      return false;
    } finally {
      setSavingVector(false);
      savingVectorRef.current = false;
    }
  }, [
    baselineSettings,
    projectId,
    rerankApiKeyClearRequested,
    rerankApiKeyDirty,
    rerankApiKeyDraft,
    toast,
    vectorApiKeyClearRequested,
    vectorApiKeyDirty,
    vectorApiKeyDraft,
    vectorForm,
    vectorRagDirty,
    vectorRerankHybridAlphaDraft,
    vectorRerankTopKDraft,
    vectorRerankTimeoutDraft,
  ]);

  const saveAutoUpdate = useCallback(async () => {
    if (!projectId || !baselineSettings || !autoUpdateDirty) return;
    setSavingAutoUpdate(true);
    try {
      const res = await apiJson<{ settings: ProjectSettings }>(`/api/projects/${projectId}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          auto_update_worldbook_enabled: Boolean(autoUpdateForm.auto_update_worldbook_enabled),
          auto_update_characters_enabled: Boolean(autoUpdateForm.auto_update_characters_enabled),
          auto_update_story_memory_enabled: Boolean(autoUpdateForm.auto_update_story_memory_enabled),
          auto_update_graph_enabled: Boolean(autoUpdateForm.auto_update_graph_enabled),
          auto_update_vector_enabled: Boolean(autoUpdateForm.auto_update_vector_enabled),
          auto_update_search_enabled: Boolean(autoUpdateForm.auto_update_search_enabled),
          auto_update_fractal_enabled: Boolean(autoUpdateForm.auto_update_fractal_enabled),
          auto_update_tables_enabled: Boolean(autoUpdateForm.auto_update_tables_enabled),
        }),
      });
      const settings = res.data.settings;
      setBaselineSettings(settings);
      setAutoUpdateForm({
        auto_update_worldbook_enabled: Boolean(settings.auto_update_worldbook_enabled ?? true),
        auto_update_characters_enabled: Boolean(settings.auto_update_characters_enabled ?? true),
        auto_update_story_memory_enabled: Boolean(settings.auto_update_story_memory_enabled ?? true),
        auto_update_graph_enabled: Boolean(settings.auto_update_graph_enabled ?? true),
        auto_update_vector_enabled: Boolean(settings.auto_update_vector_enabled ?? true),
        auto_update_search_enabled: Boolean(settings.auto_update_search_enabled ?? true),
        auto_update_fractal_enabled: Boolean(settings.auto_update_fractal_enabled ?? true),
        auto_update_tables_enabled: Boolean(settings.auto_update_tables_enabled ?? true),
      });
      toast.toastSuccess("自动化任务配置已保存");
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setSavingAutoUpdate(false);
    }
  }, [autoUpdateDirty, autoUpdateForm, baselineSettings, projectId, toast]);

  const saveQueryPreprocessing = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;
    if (!baselineSettings) return false;
    if (!qpDirty) return true;

    const tags = qpTags
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    const exclusionRules = qpExclusionRules
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);

    if (tags.length > 50) {
      toast.toastError("tags 最多 50 条");
      return false;
    }
    if (exclusionRules.length > 50) {
      toast.toastError("exclusion_rules 最多 50 条");
      return false;
    }

    setSavingVector(true);
    try {
      const res = await apiJson<{ settings: ProjectSettings }>(`/api/projects/${projectId}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          query_preprocessing: {
            enabled: qpEnabled,
            tags,
            exclusion_rules: exclusionRules,
            index_ref_enhance: qpIndexRefEnhance,
          },
        }),
      });
      setBaselineSettings(res.data.settings);
      toast.toastSuccess("查询预处理配置已保存");
      return true;
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
      return false;
    } finally {
      setSavingVector(false);
    }
  }, [projectId, baselineSettings, qpDirty, qpEnabled, qpTags, qpExclusionRules, qpIndexRefEnhance, toast]);

  const runEmbeddingDryRun = useCallback(async () => {
    if (!projectId) return;
    if (savingVector || embeddingDryRunLoading || rerankDryRunLoading) return;

    if (vectorRagDirty || vectorApiKeyDirty || rerankApiKeyDirty) {
      toast.toastError("请先保存 RAG 配置后再测试（测试使用已保存配置）");
      return;
    }

    setEmbeddingDryRunLoading(true);
    setEmbeddingDryRunError(null);
    try {
      const res = await apiJson<{ result: VectorEmbeddingDryRunResult }>(
        `/api/projects/${projectId}/vector/embeddings/dry-run`,
        {
          method: "POST",
          body: JSON.stringify({ text: "hello world" }),
        },
      );
      setEmbeddingDryRun({ requestId: res.request_id, result: res.data.result });
      toast.toastSuccess("Embedding 测试已完成", res.request_id);
    } catch (e) {
      const err = e as ApiError;
      setEmbeddingDryRunError({ message: err.message, code: err.code, requestId: err.requestId });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setEmbeddingDryRunLoading(false);
    }
  }, [
    embeddingDryRunLoading,
    projectId,
    rerankApiKeyDirty,
    rerankDryRunLoading,
    savingVector,
    toast,
    vectorApiKeyDirty,
    vectorRagDirty,
  ]);

  const runRerankDryRun = useCallback(async () => {
    if (!projectId) return;
    if (savingVector || embeddingDryRunLoading || rerankDryRunLoading) return;

    if (vectorRagDirty || vectorApiKeyDirty || rerankApiKeyDirty) {
      toast.toastError("请先保存 RAG 配置后再测试（测试使用已保存配置）");
      return;
    }

    setRerankDryRunLoading(true);
    setRerankDryRunError(null);
    try {
      const res = await apiJson<{ result: VectorRerankDryRunResult }>(
        `/api/projects/${projectId}/vector/rerank/dry-run`,
        {
          method: "POST",
          body: JSON.stringify({
            query_text: "dragon castle",
            documents: ["apple banana", "dragon castle"],
          }),
        },
      );
      setRerankDryRun({ requestId: res.request_id, result: res.data.result });
      toast.toastSuccess("Rerank 测试已完成", res.request_id);
    } catch (e) {
      const err = e as ApiError;
      setRerankDryRunError({ message: err.message, code: err.code, requestId: err.requestId });
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setRerankDryRunLoading(false);
    }
  }, [
    embeddingDryRunLoading,
    projectId,
    rerankApiKeyDirty,
    rerankDryRunLoading,
    savingVector,
    toast,
    vectorApiKeyDirty,
    vectorRagDirty,
  ]);

  const selectProfile = useCallback(
    async (profileId: string | null) => {
      if (!projectId) return;
      if (profileBusy) return;
      if (profileId === selectedProfileId) return;

      if (dirty) {
        const choice = await confirm.choose({
          title: "当前有未保存修改，是否切换配置？",
          description: "切换后会刷新表单；建议先保存。",
          confirmText: "保存并切换",
          secondaryText: "不保存切换",
          cancelText: "取消",
        });
        if (choice === "cancel") return;
        if (choice === "confirm") {
          const ok = await saveAllDirtyModules();
          if (!ok) return;
        }
      }

      setProfileBusy(true);
      try {
        await apiJson<{ project: Project }>(`/api/projects/${projectId}`, {
          method: "PUT",
          body: JSON.stringify({ llm_profile_id: profileId }),
        });
        await reloadAll();
        await refreshWizard();
        toast.toastSuccess("已切换配置");
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setProfileBusy(false);
      }
    },
    [confirm, dirty, profileBusy, projectId, reloadAll, refreshWizard, saveAllDirtyModules, selectedProfileId, toast],
  );

  const createProfile = useCallback(async () => {
    if (!projectId) return;
    if (profileBusy) return;
    const name = profileName.trim();
    if (!name) {
      toast.toastError("请先填写“新建配置名”");
      return;
    }
    const payload = buildPresetPayload(llmForm);
    if (!payload.ok) {
      toast.toastError(payload.message);
      return;
    }

    setProfileBusy(true);
    try {
      const apiKeyInput = apiKey.trim();
      const res = await apiJson<{ profile: LLMProfile }>(`/api/llm_profiles`, {
        method: "POST",
        body: JSON.stringify({
          name,
          provider: payload.payload.provider,
          base_url: payload.payload.base_url,
          model: payload.payload.model,
          temperature: payload.payload.temperature,
          top_p: payload.payload.top_p,
          max_tokens: payload.payload.max_tokens,
          presence_penalty: payload.payload.presence_penalty,
          frequency_penalty: payload.payload.frequency_penalty,
          top_k: payload.payload.top_k,
          stop: payload.payload.stop,
          timeout_seconds: payload.payload.timeout_seconds,
          extra: payload.payload.extra,
          api_key: apiKeyInput ? apiKeyInput : undefined,
        }),
      });
      await apiJson<{ project: Project }>(`/api/projects/${projectId}`, {
        method: "PUT",
        body: JSON.stringify({ llm_profile_id: res.data.profile.id }),
      });
      setApiKey("");
      await reloadAll();
      await refreshWizard();
      toast.toastSuccess("已保存为新配置并应用到项目");
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setProfileBusy(false);
    }
  }, [apiKey, llmForm, profileBusy, profileName, projectId, reloadAll, refreshWizard, toast]);

  const updateProfile = useCallback(async () => {
    if (!projectId) return;
    if (profileBusy) return;
    if (!selectedProfileId) {
      toast.toastError("请先选择一个后端配置");
      return;
    }
    if (dirty) {
      const ok = await saveAllDirtyModules();
      if (!ok) return;
    }
    const payload = buildPresetPayload(llmForm);
    if (!payload.ok) {
      toast.toastError(payload.message);
      return;
    }
    const name = profileName.trim();
    setProfileBusy(true);
    try {
      await apiJson<{ profile: LLMProfile }>(`/api/llm_profiles/${selectedProfileId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: name ? name : undefined,
          provider: payload.payload.provider,
          base_url: payload.payload.base_url,
          model: payload.payload.model,
          temperature: payload.payload.temperature,
          top_p: payload.payload.top_p,
          max_tokens: payload.payload.max_tokens,
          presence_penalty: payload.payload.presence_penalty,
          frequency_penalty: payload.payload.frequency_penalty,
          top_k: payload.payload.top_k,
          stop: payload.payload.stop,
          timeout_seconds: payload.payload.timeout_seconds,
          extra: payload.payload.extra,
        }),
      });
      await reloadAll();
      toast.toastSuccess("已更新配置");
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setProfileBusy(false);
    }
  }, [dirty, llmForm, profileBusy, profileName, projectId, reloadAll, saveAllDirtyModules, selectedProfileId, toast]);

  const deleteProfile = useCallback(async () => {
    if (!selectedProfileId) {
      toast.toastError("请先选择一个后端配置");
      return;
    }
    if (profileBusy) return;

    const ok = await confirm.confirm({
      title: "删除当前后端配置？",
      description: "删除后不可恢复。项目将解除绑定，需要重新选择/新建配置并保存 Key。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;

    setProfileBusy(true);
    try {
      await apiJson<Record<string, never>>(`/api/llm_profiles/${selectedProfileId}`, { method: "DELETE" });
      setApiKey("");
      await reloadAll();
      await refreshWizard();
      toast.toastSuccess("已删除配置");
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setProfileBusy(false);
    }
  }, [confirm, profileBusy, reloadAll, refreshWizard, selectedProfileId, toast]);

  const saveApiKeyToProfile = useCallback(async (): Promise<boolean> => {
    if (!selectedProfileId) {
      toast.toastError("请先选择或新建一个后端配置");
      return false;
    }
    const key = apiKey.trim();
    if (!key) {
      toast.toastError("请先填写 API Key");
      return false;
    }
    if (profileBusy) return false;

    setProfileBusy(true);
    try {
      await apiJson<{ profile: LLMProfile }>(`/api/llm_profiles/${selectedProfileId}`, {
        method: "PUT",
        body: JSON.stringify({ api_key: key }),
      });
      setApiKey("");
      await reloadAll();
      await refreshWizard();
      bumpWizardLocal();
      toast.toastSuccess("已保存 Key");
      return true;
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
      return false;
    } finally {
      setProfileBusy(false);
    }
  }, [apiKey, bumpWizardLocal, profileBusy, refreshWizard, reloadAll, selectedProfileId, toast]);

  const clearApiKeyInProfile = useCallback(async () => {
    if (!selectedProfileId) {
      toast.toastError("请先选择一个后端配置");
      return;
    }
    if (profileBusy) return;

    const ok = await confirm.confirm({
      title: "清除 API Key？",
      description: "清除后将无法生成/测试连接，直到重新保存 Key。",
      confirmText: "清除",
      danger: true,
    });
    if (!ok) return;

    setProfileBusy(true);
    try {
      await apiJson<{ profile: LLMProfile }>(`/api/llm_profiles/${selectedProfileId}`, {
        method: "PUT",
        body: JSON.stringify({ api_key: null }),
      });
      setApiKey("");
      await reloadAll();
      await refreshWizard();
      bumpWizardLocal();
      toast.toastSuccess("已清除 Key");
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
    } finally {
      setProfileBusy(false);
    }
  }, [bumpWizardLocal, confirm, profileBusy, refreshWizard, reloadAll, selectedProfileId, toast]);

  const saveTaskApiKey = useCallback(
    async (taskKey: string): Promise<boolean> => {
      const draft = taskDrafts[taskKey];
      if (!draft) return false;
      const profileId = (draft.llm_profile_id ?? selectedProfileId ?? "").trim();
      if (!profileId) {
        toast.toastError("请先为该任务绑定配置库，或先设置主配置");
        return false;
      }
      const profile = profiles.find((item) => item.id === profileId) ?? null;
      if (!profile) {
        toast.toastError("生效配置库不存在，请刷新后重试");
        return false;
      }

      const key = (taskApiKeyDrafts[taskKey] ?? "").trim();
      if (!key) {
        toast.toastError("请先填写 API Key");
        return false;
      }
      if (taskProfileBusy[taskKey]) return false;

      setTaskProfileBusy((prev) => ({ ...prev, [taskKey]: true }));
      try {
        const res = await apiJson<{ profile: LLMProfile }>(`/api/llm_profiles/${profileId}`, {
          method: "PUT",
          body: JSON.stringify({ api_key: key }),
        });
        upsertProfile(res.data.profile);
        setTaskApiKeyDrafts((prev) => ({ ...prev, [taskKey]: "" }));
        await refreshWizard();
        bumpWizardLocal();
        toast.toastSuccess(`配置库「${profile.name}」Key 已保存`, res.request_id);
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setTaskProfileBusy((prev) => ({ ...prev, [taskKey]: false }));
      }
    },
    [
      bumpWizardLocal,
      profiles,
      refreshWizard,
      selectedProfileId,
      taskApiKeyDrafts,
      taskDrafts,
      taskProfileBusy,
      toast,
      upsertProfile,
    ],
  );

  const clearTaskApiKey = useCallback(
    async (taskKey: string): Promise<boolean> => {
      const draft = taskDrafts[taskKey];
      if (!draft) return false;
      const profileId = (draft.llm_profile_id ?? selectedProfileId ?? "").trim();
      if (!profileId) {
        toast.toastError("请先为该任务绑定配置库，或先设置主配置");
        return false;
      }
      const profile = profiles.find((item) => item.id === profileId) ?? null;
      if (!profile) {
        toast.toastError("生效配置库不存在，请刷新后重试");
        return false;
      }
      if (!profile?.has_api_key) return true;
      if (taskProfileBusy[taskKey]) return false;

      const taskLabel = taskCatalogByKey.get(taskKey)?.label ?? taskKey;
      const ok = await confirm.confirm({
        title: "清除任务模块绑定配置的 API Key？",
        description: `将清除配置库「${profile.name}」的 Key。该配置库被其他模块复用时也会立即失效。`,
        confirmText: "清除",
        cancelText: "取消",
        danger: true,
      });
      if (!ok) return false;

      setTaskProfileBusy((prev) => ({ ...prev, [taskKey]: true }));
      try {
        const res = await apiJson<{ profile: LLMProfile }>(`/api/llm_profiles/${profileId}`, {
          method: "PUT",
          body: JSON.stringify({ api_key: null }),
        });
        upsertProfile(res.data.profile);
        setTaskApiKeyDrafts((prev) => ({ ...prev, [taskKey]: "" }));
        await refreshWizard();
        bumpWizardLocal();
        toast.toastSuccess(`模块「${taskLabel}」绑定配置的 Key 已清除`, res.request_id);
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setTaskProfileBusy((prev) => ({ ...prev, [taskKey]: false }));
      }
    },
    [
      bumpWizardLocal,
      confirm,
      profiles,
      refreshWizard,
      selectedProfileId,
      taskCatalogByKey,
      taskDrafts,
      taskProfileBusy,
      toast,
      upsertProfile,
    ],
  );

  const testTaskConnection = useCallback(
    async (taskKey: string): Promise<boolean> => {
      if (!projectId) return false;
      const draft = taskDrafts[taskKey];
      if (!draft) return false;

      const payload = buildPresetPayload(draft.form);
      if (!payload.ok) {
        toast.toastError(payload.message);
        return false;
      }

      const boundProfileId = (draft.llm_profile_id ?? "").trim() || null;
      const boundProfile = boundProfileId ? (profiles.find((item) => item.id === boundProfileId) ?? null) : null;
      if (boundProfileId && !boundProfile) {
        toast.toastError("任务模块绑定的配置库不存在，请重新选择");
        return false;
      }
      const effectiveProfile = boundProfile ?? selectedProfile;
      if (!effectiveProfile) {
        toast.toastError("请先为任务模块绑定配置库，或先设置主配置并保存 Key");
        return false;
      }
      if (effectiveProfile.provider !== payload.payload.provider) {
        if (boundProfile) {
          toast.toastError("任务模块 provider 必须与所选 API 配置库 provider 一致");
        } else {
          toast.toastError("当前任务未绑定配置库，将回退主配置。请保持 provider 一致，或为任务绑定独立配置库");
        }
        return false;
      }
      if (!effectiveProfile.has_api_key) {
        toast.toastError("请先保存该任务生效配置的 API Key");
        return false;
      }

      const model = payload.payload.model.trim();
      const baseUrl = payload.payload.base_url;
      const taskLabel = taskCatalogByKey.get(taskKey)?.label ?? taskKey;

      setTaskTesting((prev) => ({ ...prev, [taskKey]: true }));
      try {
        const res = await apiJson<{ latency_ms: number; text?: string }>("/api/llm/test", {
          method: "POST",
          headers: {
            "X-LLM-Provider": payload.payload.provider,
          },
          body: JSON.stringify({
            project_id: projectId,
            profile_id: boundProfileId,
            provider: payload.payload.provider,
            base_url: baseUrl,
            model,
            timeout_seconds: parseTimeoutSecondsForTest(draft.form.timeout_seconds),
            extra: payload.payload.extra,
            params: {
              temperature: payload.payload.temperature ?? 0,
              // Some models may emit "thinking" blocks before final text; keep this > tiny to ensure we get a text preview.
              max_tokens: 64,
            },
          }),
        });
        const preview = (res.data.text ?? "").trim();
        toast.toastSuccess(
          `模块「${taskLabel}」连接成功（延迟 ${res.data.latency_ms}ms${preview ? `，输出：${preview}` : ""}）`,
          res.request_id,
        );
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(formatLlmTestApiError(err), err.requestId);
        return false;
      } finally {
        setTaskTesting((prev) => ({ ...prev, [taskKey]: false }));
      }
    },
    [profiles, projectId, selectedProfile, taskCatalogByKey, taskDrafts, toast],
  );

  const testConnection = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;
    if (!selectedProfileId) {
      toast.toastError("请先选择或新建一个后端配置");
      return false;
    }
    const payload = buildPresetPayload(llmForm);
    if (!payload.ok) {
      toast.toastError(payload.message);
      return false;
    }

    const model = payload.payload.model.trim();
    const baseUrl = payload.payload.base_url;
    if (!selectedProfile?.has_api_key) {
      toast.toastError("请先保存 API Key");
      return false;
    }

    setTesting(true);
    try {
      const res = await apiJson<{ latency_ms: number; text?: string }>("/api/llm/test", {
        method: "POST",
        headers: {
          "X-LLM-Provider": payload.payload.provider,
        },
        body: JSON.stringify({
          project_id: projectId,
          provider: payload.payload.provider,
          base_url: baseUrl,
          model,
          timeout_seconds: parseTimeoutSecondsForTest(llmForm.timeout_seconds),
          extra: payload.payload.extra,
          params: {
            temperature: payload.payload.temperature ?? 0,
            // Some models may emit "thinking" blocks before final text; keep this > tiny to ensure we get a text preview.
            max_tokens: 64,
          },
        }),
      });
      const preview = (res.data.text ?? "").trim();
      toast.toastSuccess(
        `连接成功（延迟 ${res.data.latency_ms}ms${preview ? `，输出：${preview}` : ""}）`,
        res.request_id,
      );
      if (projectId) {
        markWizardLlmTestOk(projectId, payload.payload.provider, model);
        bumpWizardLocal();
      }
      return true;
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(formatLlmTestApiError(err), err.requestId);
      return false;
    } finally {
      setTesting(false);
    }
  }, [bumpWizardLocal, llmForm, projectId, selectedProfile?.has_api_key, selectedProfileId, toast]);

  const nextAfterLlm = useMemo(() => {
    const idx = wizard.progress.steps.findIndex((s) => s.key === "llm");
    if (idx < 0) return wizard.progress.nextStep;
    for (let i = idx + 1; i < wizard.progress.steps.length; i++) {
      const s = wizard.progress.steps[i];
      if (s.state === "todo") return s;
    }
    return null;
  }, [wizard.progress]);

  const testAndGoNext = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;

    const saved = await saveAllDirtyModules();
    if (!saved) return false;

    const ok = await testConnection();
    if (!ok) return false;

    if (nextAfterLlm?.href) navigate(nextAfterLlm.href);
    else navigate(`/projects/${projectId}/outline`);
    return true;
  }, [navigate, nextAfterLlm?.href, projectId, saveAllDirtyModules, testConnection]);

  if (loading) {
    return (
      <div className="grid gap-6 pb-24" aria-busy="true" aria-live="polite">
        <span className="sr-only">正在加载模型配置…</span>
        <div className="panel p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid gap-2">
              <div className="skeleton h-6 w-44" />
              <div className="skeleton h-4 w-72" />
            </div>
            <div className="skeleton h-9 w-40" />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-28 w-full sm:col-span-2" />
          </div>
        </div>
        <div className="panel p-6">
          <div className="skeleton h-5 w-40" />
          <div className="mt-3 grid gap-2">
            <div className="skeleton h-4 w-80" />
            <div className="skeleton h-4 w-72" />
          </div>
        </div>
      </div>
    );
  }

  if (loadError && !project && !baselinePreset) {
    return (
      <div className="grid gap-6 pb-24">
        <div className="error-card">
          <div className="state-title">加载失败</div>
          <div className="state-desc">{`${loadError.message} (${loadError.code})`}</div>
          {loadError.requestId ? (
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
            <button className="btn btn-primary" onClick={() => void reloadAll()} type="button">
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  const embeddingProviderPreview = (
    vectorForm.vector_embedding_provider.trim() ||
    baselineSettings?.vector_embedding_effective_provider ||
    "openai_compatible"
  ).trim();

  return (
    <div className="grid gap-6 pb-24">
      {anyDirty && outletActive ? <UnsavedChangesGuard when={anyDirty} /> : null}

      <nav className="flex gap-2" aria-label="模型配置 Tab">
        <button
          className={`btn ${activeTab === "models" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("models")}
          type="button"
        >
          模型编排{dirty ? " *" : ""}
        </button>
        <button
          className={`btn ${activeTab === "rag" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("rag")}
          type="button"
        >
          向量 &amp; RAG{vectorRagDirty || vectorApiKeyDirty || rerankApiKeyDirty || qpDirty ? " *" : ""}
        </button>
        <button
          className={`btn ${activeTab === "automation" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("automation")}
          type="button"
        >
          自动化任务{autoUpdateDirty ? " *" : ""}
        </button>
      </nav>

      {activeTab === "models" && (
        <>
      <PipelineOverview
        mainModel={llmForm.model.trim() || "（未设置）"}
        taskModules={taskModules.map((tm) => ({
          task_key: tm.task_key,
          model: tm.form.model.trim() || null,
          overridden: true,
        }))}
      />
      <LlmPresetPanel
        llmForm={llmForm}
        setLlmForm={setLlmForm}
        presetDirty={presetDirty}
        saving={savingPreset}
        testing={testing}
        capabilities={capabilities}
        onTestConnection={() => void testConnection()}
        testConnectionDisabledReason={llmCtaBlockedReason}
        onSave={() => void saveAll()}
        mainModelList={mainModelList}
        onReloadMainModels={reloadMainModels}
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={(id) => void selectProfile(id)}
        profileName={profileName}
        onChangeProfileName={setProfileName}
        profileBusy={profileBusy || testing || savingPreset}
        onCreateProfile={() => void createProfile()}
        onUpdateProfile={() => void updateProfile()}
        onDeleteProfile={() => void deleteProfile()}
        apiKey={apiKey}
        onChangeApiKey={setApiKey}
        onSaveApiKey={() => void saveApiKeyToProfile()}
        onClearApiKey={() => void clearApiKeyInProfile()}
        taskModules={taskModules}
        taskCatalog={taskCatalog}
        addableTasks={addableTasks}
        selectedAddTaskKey={selectedAddTaskKey}
        onSelectAddTaskKey={setSelectedAddTaskKey}
        onAddTaskModule={addTaskModule}
        onTaskProfileChange={updateTaskProfile}
        onTaskFormChange={updateTaskForm}
        onSaveTask={(taskKey) => void saveTaskModule(taskKey)}
        onDeleteTask={(taskKey) => void deleteTaskModule(taskKey)}
        taskTesting={taskTesting}
        onTestTaskConnection={(taskKey) => void testTaskConnection(taskKey)}
        taskApiKeyDrafts={taskApiKeyDrafts}
        onTaskApiKeyDraftChange={updateTaskApiKeyDraft}
        taskProfileBusy={taskProfileBusy}
        onSaveTaskApiKey={(taskKey) => void saveTaskApiKey(taskKey)}
        onClearTaskApiKey={(taskKey) => void clearTaskApiKey(taskKey)}
        onReloadTaskModels={reloadTaskModels}
      />

      <div className="surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">提示词工作室（beta）</div>
            <div className="text-xs text-subtext">提示词仅在「提示词工作室」中编辑/预览（与实际发送一致）。</div>
          </div>
          <button
            className="btn btn-secondary"
            onClick={() => navigate(`/projects/${projectId}/prompt-studio`)}
            type="button"
          >
            打开提示词工作室
          </button>
        </div>
      </div>

      <div className="text-xs text-subtext">快捷键：Ctrl/Cmd + S 保存（仅保存 LLM 配置）</div>
        </>
      )}

      {activeTab === "rag" && (
      <>
      <section className="panel p-6" id="rag-config" aria-label={UI_COPY.vectorRag.title} role="region">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <div className="font-content text-xl text-ink">{UI_COPY.vectorRag.title}</div>
            <div className="text-xs text-subtext">{UI_COPY.vectorRag.subtitle}</div>
            <div className="text-xs text-subtext">{UI_COPY.vectorRag.apiKeyHint}</div>
          </div>
          <button
            className="btn btn-primary"
            disabled={savingVector || (!vectorRagDirty && !vectorApiKeyDirty && !rerankApiKeyDirty)}
            onClick={() => void saveVectorRagConfig()}
            type="button"
          >
            {UI_COPY.vectorRag.save}
          </button>
        </div>

        {baselineSettings ? (
          <div className="mt-4 grid gap-4">
            <div className="rounded-atelier border border-border bg-canvas p-4 text-xs text-subtext">
              <div>
                当前生效：Embedding 提供方（provider）=
                {baselineSettings.vector_embedding_effective_provider || "openai_compatible"}
                （状态: {baselineSettings.vector_embedding_effective_disabled_reason ?? "enabled"}；来源:{" "}
                {baselineSettings.vector_embedding_effective_source}）
              </div>
              <div className="mt-1">
                Rerank：{baselineSettings.vector_rerank_effective_enabled ? "enabled" : "disabled"}（method:{" "}
                {baselineSettings.vector_rerank_effective_method}；provider:{" "}
                {baselineSettings.vector_rerank_effective_provider || "（空）"}；model:{" "}
                {baselineSettings.vector_rerank_effective_model || "（空）"}；top_k:{" "}
                {baselineSettings.vector_rerank_effective_top_k}；alpha:{" "}
                {baselineSettings.vector_rerank_effective_hybrid_alpha ?? 0}；来源:{" "}
                {baselineSettings.vector_rerank_effective_source}；配置:{" "}
                {baselineSettings.vector_rerank_effective_config_source}）
              </div>
            </div>

            <div className="rounded-atelier border border-border bg-canvas p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-ink">测试配置（dry-run）</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={
                      savingVector ||
                      embeddingDryRunLoading ||
                      rerankDryRunLoading ||
                      vectorRagDirty ||
                      vectorApiKeyDirty ||
                      rerankApiKeyDirty
                    }
                    onClick={() => void runEmbeddingDryRun()}
                    type="button"
                  >
                    {embeddingDryRunLoading ? "测试 embedding…" : "测试 embedding"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={
                      savingVector ||
                      embeddingDryRunLoading ||
                      rerankDryRunLoading ||
                      vectorRagDirty ||
                      vectorApiKeyDirty ||
                      rerankApiKeyDirty
                    }
                    onClick={() => void runRerankDryRun()}
                    type="button"
                  >
                    {rerankDryRunLoading ? "测试 rerank…" : "测试 rerank"}
                  </button>
                </div>
              </div>
              {vectorRagDirty || vectorApiKeyDirty || rerankApiKeyDirty ? (
                <div className="mt-1 text-[11px] text-subtext">提示：测试使用已保存配置；请先点“保存 RAG 配置”。</div>
              ) : null}

              {embeddingDryRunError ? (
                <div className="mt-3 rounded-atelier border border-border bg-surface p-3">
                  <div className="text-xs text-danger">
                    Embedding 测试失败：{embeddingDryRunError.message} ({embeddingDryRunError.code})
                  </div>
                  <RequestIdBadge requestId={embeddingDryRunError.requestId} className="mt-2" />
                  <div className="mt-1 text-[11px] text-subtext">
                    排障：检查 embedding base_url/model/api_key；打开后端日志并搜索 request_id。
                  </div>
                </div>
              ) : null}

              {embeddingDryRun ? (
                <div className="mt-3 rounded-atelier border border-border bg-surface p-3">
                  <div className="text-xs text-subtext">
                    Embedding：{embeddingDryRun.result.enabled ? "enabled" : "disabled"}；dims:
                    {embeddingDryRun.result.dims ?? "（未知）"}；耗时:
                    {embeddingDryRun.result.timings_ms?.total ?? "（未知）"}ms
                    {embeddingDryRun.result.error ? `；error: ${embeddingDryRun.result.error}` : ""}
                  </div>
                  <RequestIdBadge requestId={embeddingDryRun.requestId} className="mt-2" />
                </div>
              ) : null}

              {rerankDryRunError ? (
                <div className="mt-3 rounded-atelier border border-border bg-surface p-3">
                  <div className="text-xs text-danger">
                    Rerank 测试失败：{rerankDryRunError.message} ({rerankDryRunError.code})
                  </div>
                  <RequestIdBadge requestId={rerankDryRunError.requestId} className="mt-2" />
                  <div className="mt-1 text-[11px] text-subtext">
                    排障：检查 rerank base_url/model/api_key；若使用 external_rerank_api，确认 /v1/rerank 可访问。
                  </div>
                </div>
              ) : null}

              {rerankDryRun ? (
                <div className="mt-3 rounded-atelier border border-border bg-surface p-3">
                  <div className="text-xs text-subtext">
                    Rerank：{rerankDryRun.result.enabled ? "enabled" : "disabled"}；method:
                    {rerankDryRun.result.method ?? "（未知）"}
                    ；provider:
                    {(rerankDryRun.result.rerank as { provider?: string } | undefined)?.provider ?? "（未知）"}
                    ；耗时:{rerankDryRun.result.timings_ms?.total ?? "（未知）"}ms；order:
                    {(rerankDryRun.result.order ?? []).join(" → ") || "（空）"}
                  </div>
                  <RequestIdBadge requestId={rerankDryRun.requestId} className="mt-2" />
                </div>
              ) : null}
            </div>

            <div className="grid gap-2">
              <div className="text-sm text-ink">{UI_COPY.vectorRag.rerankTitle}</div>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="flex items-center gap-2 text-sm text-ink sm:col-span-3">
                  <input
                    className="checkbox"
                    checked={vectorForm.vector_rerank_enabled}
                    onChange={(e) => setVectorForm((v) => ({ ...v, vector_rerank_enabled: e.target.checked }))}
                    type="checkbox"
                    name="vector_rerank_enabled"
                  />
                  启用 rerank（对候选片段做相关性重排）
                </label>
                <label className="grid gap-1 sm:col-span-2">
                  <span className="text-xs text-subtext">重排算法（rerank method）</span>
                  <select
                    className="select"
                    value={vectorForm.vector_rerank_method}
                    onChange={(e) => setVectorForm((v) => ({ ...v, vector_rerank_method: e.target.value }))}
                    name="vector_rerank_method"
                  >
                    <option value="auto">auto</option>
                    <option value="rapidfuzz_token_set_ratio">rapidfuzz_token_set_ratio</option>
                    <option value="token_overlap">token_overlap</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-xs text-subtext">候选数量（top_k）</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1000}
                    value={vectorRerankTopKDraft}
                    onBlur={() => {
                      const raw = vectorRerankTopKDraft.trim();
                      if (!raw) {
                        setVectorRerankTopKDraft(String(vectorForm.vector_rerank_top_k));
                        return;
                      }
                      const next = Math.floor(Number(raw));
                      if (!Number.isFinite(next)) {
                        setVectorRerankTopKDraft(String(vectorForm.vector_rerank_top_k));
                        return;
                      }
                      const clamped = Math.max(1, Math.min(1000, next));
                      setVectorForm((v) => ({ ...v, vector_rerank_top_k: clamped }));
                      setVectorRerankTopKDraft(String(clamped));
                    }}
                    onChange={(e) => setVectorRerankTopKDraft(e.target.value)}
                    name="vector_rerank_top_k"
                  />
                </label>
              </div>
              <div className="text-[11px] text-subtext">
                提示：启用后会对候选结果做二次排序，通常命中更好，但可能增加耗时/成本。
              </div>
            </div>

            <details className="rounded-atelier border border-border bg-canvas p-4" aria-label="Rerank 提供方配置">
              <summary className="ui-transition-fast cursor-pointer select-none text-sm text-ink hover:text-ink">
                {UI_COPY.vectorRag.rerankConfigDetailsTitle}
              </summary>
              <div className="mt-4 grid gap-4">
                <div className="text-xs text-subtext">不确定怎么配时，可保持留空让后端从环境变量读取。</div>
                <div className="text-xs text-subtext">
                  启用 external_rerank_api：method 建议保持 auto；provider 选 external_rerank_api，并填写
                  base_url/model（可选 api_key）。
                </div>

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">{UI_COPY.vectorRag.rerankProviderLabel}</span>
                  <select
                    className="select"
                    value={vectorForm.vector_rerank_provider}
                    onChange={(e) => setVectorForm((v) => ({ ...v, vector_rerank_provider: e.target.value }))}
                    name="vector_rerank_provider"
                  >
                    <option value="">（使用后端环境变量）</option>
                    <option value="external_rerank_api">external_rerank_api</option>
                  </select>
                  <div className="text-[11px] text-subtext">
                    当前有效：{baselineSettings.vector_rerank_effective_provider || "（空）"}
                  </div>
                </label>

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">{UI_COPY.vectorRag.rerankBaseUrlLabel}</span>
                  <input
                    className="input"
                    value={vectorForm.vector_rerank_base_url}
                    onChange={(e) => {
                      const next = e.target.value;
                      setVectorForm((v) => {
                        const shouldAutoSetProvider = !v.vector_rerank_provider.trim() && next.trim().length > 0;
                        return {
                          ...v,
                          vector_rerank_base_url: next,
                          ...(shouldAutoSetProvider ? { vector_rerank_provider: "external_rerank_api" } : {}),
                        };
                      });
                    }}
                    name="vector_rerank_base_url"
                  />
                  <div className="text-[11px] text-subtext">
                    当前有效：{baselineSettings.vector_rerank_effective_base_url || "（空）"}
                  </div>
                </label>

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">{UI_COPY.vectorRag.rerankModelLabel}</span>
                  <input
                    className="input"
                    value={vectorForm.vector_rerank_model}
                    onChange={(e) => setVectorForm((v) => ({ ...v, vector_rerank_model: e.target.value }))}
                    name="vector_rerank_model"
                  />
                  <div className="text-[11px] text-subtext">
                    当前有效：{baselineSettings.vector_rerank_effective_model || "（空）"}
                  </div>
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-xs text-subtext">{UI_COPY.vectorRag.rerankTimeoutLabel}</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={120}
                      value={vectorRerankTimeoutDraft}
                      onBlur={() => {
                        const raw = vectorRerankTimeoutDraft.trim();
                        if (!raw) {
                          setVectorForm((v) => ({ ...v, vector_rerank_timeout_seconds: null }));
                          setVectorRerankTimeoutDraft("");
                          return;
                        }
                        const next = Math.floor(Number(raw));
                        if (!Number.isFinite(next)) {
                          setVectorRerankTimeoutDraft(
                            vectorForm.vector_rerank_timeout_seconds != null
                              ? String(vectorForm.vector_rerank_timeout_seconds)
                              : "",
                          );
                          return;
                        }
                        const clamped = Math.max(1, Math.min(120, next));
                        setVectorForm((v) => ({ ...v, vector_rerank_timeout_seconds: clamped }));
                        setVectorRerankTimeoutDraft(String(clamped));
                      }}
                      onChange={(e) => setVectorRerankTimeoutDraft(e.target.value)}
                      name="vector_rerank_timeout_seconds"
                    />
                    <div className="text-[11px] text-subtext">
                      当前有效：{baselineSettings.vector_rerank_effective_timeout_seconds ?? 15}
                    </div>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-xs text-subtext">{UI_COPY.vectorRag.rerankHybridAlphaLabel}</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={vectorRerankHybridAlphaDraft}
                      onBlur={() => {
                        const raw = vectorRerankHybridAlphaDraft.trim();
                        if (!raw) {
                          setVectorForm((v) => ({ ...v, vector_rerank_hybrid_alpha: null }));
                          setVectorRerankHybridAlphaDraft("");
                          return;
                        }
                        const next = Number(raw);
                        if (!Number.isFinite(next)) {
                          setVectorRerankHybridAlphaDraft(
                            vectorForm.vector_rerank_hybrid_alpha != null
                              ? String(vectorForm.vector_rerank_hybrid_alpha)
                              : "",
                          );
                          return;
                        }
                        const clamped = Math.max(0, Math.min(1, next));
                        setVectorForm((v) => ({ ...v, vector_rerank_hybrid_alpha: clamped }));
                        setVectorRerankHybridAlphaDraft(String(clamped));
                      }}
                      onChange={(e) => setVectorRerankHybridAlphaDraft(e.target.value)}
                      name="vector_rerank_hybrid_alpha"
                    />
                    <div className="text-[11px] text-subtext">
                      当前有效：{baselineSettings.vector_rerank_effective_hybrid_alpha ?? 0}
                    </div>
                  </label>
                </div>

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">{UI_COPY.vectorRag.rerankApiKeyLabel}</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={rerankApiKeyDraft}
                    onChange={(e) => {
                      setRerankApiKeyDraft(e.target.value);
                      setRerankApiKeyClearRequested(false);
                    }}
                    name="vector_rerank_api_key"
                  />
                  <div className="text-[11px] text-subtext">
                    已保存（项目覆盖）：
                    {baselineSettings.vector_rerank_has_api_key
                      ? baselineSettings.vector_rerank_masked_api_key
                      : "（无）"}
                    {baselineSettings.vector_rerank_effective_has_api_key
                      ? ` | 当前有效：${baselineSettings.vector_rerank_effective_masked_api_key}`
                      : " | 当前有效：（无）"}
                    {rerankApiKeyClearRequested ? " | 将在保存时清除" : ""}
                  </div>
                </label>

                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={savingVector || !baselineSettings.vector_rerank_has_api_key}
                    onClick={() => {
                      setRerankApiKeyDraft("");
                      setRerankApiKeyClearRequested(true);
                    }}
                    type="button"
                  >
                    {UI_COPY.vectorRag.rerankClearApiKey}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={savingVector}
                    onClick={() => {
                      setVectorForm((v) => ({
                        ...v,
                        vector_rerank_provider: "",
                        vector_rerank_base_url: "",
                        vector_rerank_model: "",
                        vector_rerank_timeout_seconds: null,
                        vector_rerank_hybrid_alpha: null,
                      }));
                      setVectorRerankTimeoutDraft("");
                      setVectorRerankHybridAlphaDraft("");
                      setRerankApiKeyDraft("");
                      setRerankApiKeyClearRequested(true);
                    }}
                    type="button"
                  >
                    {UI_COPY.vectorRag.rerankResetOverrides}
                  </button>
                </div>
              </div>
            </details>

            <details className="rounded-atelier border border-border bg-canvas p-4">
              <summary className="ui-transition-fast cursor-pointer select-none text-sm text-ink hover:text-ink">
                {UI_COPY.vectorRag.embeddingTitle}
              </summary>
              <div className="mt-4 grid gap-4">
                <div className="text-xs text-subtext">不确定怎么配时，可保持留空让后端从环境变量读取。</div>

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">
                    Embedding 提供方（provider；项目覆盖；留空=使用后端环境变量）
                  </span>
                  <select
                    className="select"
                    value={vectorForm.vector_embedding_provider}
                    onChange={(e) => setVectorForm((v) => ({ ...v, vector_embedding_provider: e.target.value }))}
                    name="vector_embedding_provider"
                  >
                    <option value="">（使用后端环境变量）</option>
                    <option value="openai_compatible">openai_compatible</option>
                    <option value="azure_openai">azure_openai</option>
                    <option value="google">google</option>
                    <option value="custom">custom</option>
                    <option value="local_proxy">local_proxy</option>
                    <option value="sentence_transformers">sentence_transformers</option>
                  </select>
                  <div className="text-[11px] text-subtext">
                    当前有效：{baselineSettings.vector_embedding_effective_provider || "openai_compatible"}
                  </div>
                </label>

                {embeddingProviderPreview === "azure_openai" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="text-xs text-subtext">
                        Azure 部署名（deployment；项目覆盖；留空=使用后端环境变量）
                      </span>
                      <input
                        className="input"
                        value={vectorForm.vector_embedding_azure_deployment}
                        onChange={(e) =>
                          setVectorForm((v) => ({ ...v, vector_embedding_azure_deployment: e.target.value }))
                        }
                        name="vector_embedding_azure_deployment"
                      />
                      <div className="text-[11px] text-subtext">
                        当前有效：{baselineSettings.vector_embedding_effective_azure_deployment || "（空）"}
                      </div>
                    </label>
                    <label className="grid gap-1">
                      <span className="text-xs text-subtext">
                        Azure API 版本（api_version；项目覆盖；留空=使用后端环境变量）
                      </span>
                      <input
                        className="input"
                        value={vectorForm.vector_embedding_azure_api_version}
                        onChange={(e) =>
                          setVectorForm((v) => ({ ...v, vector_embedding_azure_api_version: e.target.value }))
                        }
                        name="vector_embedding_azure_api_version"
                      />
                      <div className="text-[11px] text-subtext">
                        当前有效：{baselineSettings.vector_embedding_effective_azure_api_version || "（空）"}
                      </div>
                    </label>
                  </div>
                ) : null}

                {embeddingProviderPreview === "sentence_transformers" ? (
                  <label className="grid gap-1">
                    <span className="text-xs text-subtext">
                      SentenceTransformers 模型（项目覆盖；留空=使用后端环境变量）
                    </span>
                    <input
                      className="input"
                      value={vectorForm.vector_embedding_sentence_transformers_model}
                      onChange={(e) =>
                        setVectorForm((v) => ({
                          ...v,
                          vector_embedding_sentence_transformers_model: e.target.value,
                        }))
                      }
                      name="vector_embedding_sentence_transformers_model"
                    />
                    <div className="text-[11px] text-subtext">
                      当前有效：{baselineSettings.vector_embedding_effective_sentence_transformers_model || "（空）"}
                    </div>
                  </label>
                ) : null}

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">
                    Embedding 基础地址（base_url；项目覆盖；留空=使用后端环境变量）
                  </span>
                  <input
                    className="input"
                    id="vector_embedding_base_url"
                    name="vector_embedding_base_url"
                    value={vectorForm.vector_embedding_base_url}
                    onChange={(e) => setVectorForm((v) => ({ ...v, vector_embedding_base_url: e.target.value }))}
                  />
                  <div className="text-[11px] text-subtext">
                    当前有效：{baselineSettings.vector_embedding_effective_base_url || "（空）"}
                  </div>
                </label>

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">Embedding 模型（model；项目覆盖；留空=使用后端环境变量）</span>
                  <input
                    className="input"
                    id="vector_embedding_model"
                    name="vector_embedding_model"
                    value={vectorForm.vector_embedding_model}
                    onChange={(e) => setVectorForm((v) => ({ ...v, vector_embedding_model: e.target.value }))}
                  />
                  <div className="text-[11px] text-subtext">
                    当前有效：{baselineSettings.vector_embedding_effective_model || "（空）"}
                  </div>
                </label>

                <label className="grid gap-1">
                  <span className="text-xs text-subtext">API Key（api_key；项目覆盖；留空不修改）</span>
                  <input
                    className="input"
                    id="vector_embedding_api_key"
                    name="vector_embedding_api_key"
                    type="password"
                    autoComplete="off"
                    value={vectorApiKeyDraft}
                    onChange={(e) => {
                      setVectorApiKeyDraft(e.target.value);
                      setVectorApiKeyClearRequested(false);
                    }}
                  />
                  <div className="text-[11px] text-subtext">
                    已保存（项目覆盖）：
                    {baselineSettings.vector_embedding_has_api_key
                      ? baselineSettings.vector_embedding_masked_api_key
                      : "（无）"}
                    {baselineSettings.vector_embedding_effective_has_api_key
                      ? ` | 当前有效：${baselineSettings.vector_embedding_effective_masked_api_key}`
                      : " | 当前有效：（无）"}
                    {vectorApiKeyClearRequested ? " | 将在保存时清除" : ""}
                  </div>
                </label>

                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={savingVector || !baselineSettings.vector_embedding_has_api_key}
                    onClick={() => {
                      setVectorApiKeyDraft("");
                      setVectorApiKeyClearRequested(true);
                    }}
                    type="button"
                  >
                    清除项目级 API Key
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={savingVector}
                    onClick={() => {
                      setVectorForm((v) => ({
                        ...v,
                        vector_embedding_provider: "",
                        vector_embedding_base_url: "",
                        vector_embedding_model: "",
                        vector_embedding_azure_deployment: "",
                        vector_embedding_azure_api_version: "",
                        vector_embedding_sentence_transformers_model: "",
                      }));
                      setVectorApiKeyDraft("");
                      setVectorApiKeyClearRequested(true);
                    }}
                    type="button"
                  >
                    恢复使用后端环境变量（清除项目覆盖）
                  </button>
                </div>
              </div>
            </details>
          </div>
        ) : (
          <div className="mt-4 text-xs text-subtext">正在加载向量检索配置…</div>
        )}
      </section>

        <section className="panel p-6">
          <div className="grid gap-1">
            <div className="font-content text-xl text-ink">Query 预处理（Query Preprocessing）</div>
            <div className="text-xs text-subtext">
              用于把 query_text 先"标准化/去噪"，让 WorldBook / Vector RAG / Graph 的检索更稳定（默认关闭）。
            </div>
          </div>

          <div className="mt-4 grid gap-4">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                className="checkbox"
                checked={qpEnabled}
                onChange={(e) => setQpEnabled(e.target.checked)}
                type="checkbox"
              />
              启用 query_preprocessing（默认关闭）
            </label>

            {qpEnabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-xs text-subtext">tags（每行一条；匹配 #tag；留空=提取所有 tag）</span>
                    <textarea
                      className="textarea"
                      rows={5}
                      value={qpTags}
                      onChange={(e) => setQpTags(e.target.value)}
                      placeholder={"例如：\nfoo\nbar"}
                    />
                    <div className="text-[11px] text-subtext">最大 50 条；每条最多 64 字符。</div>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-xs text-subtext">exclusion_rules（每行一条；出现则移除）</span>
                    <textarea
                      className="textarea"
                      rows={5}
                      value={qpExclusionRules}
                      onChange={(e) => setQpExclusionRules(e.target.value)}
                      placeholder={"例如：\n忽略这段\nREMOVE"}
                    />
                    <div className="text-[11px] text-subtext">最大 50 条；每条最多 256 字符。</div>
                  </label>
                </div>

                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    className="checkbox"
                    checked={qpIndexRefEnhance}
                    onChange={(e) => setQpIndexRefEnhance(e.target.checked)}
                    type="checkbox"
                  />
                  index_ref_enhance（识别"第N章 / chapter N"并追加引用 token）
                </label>
              </>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                className="btn btn-primary"
                disabled={!qpDirty || savingVector}
                onClick={() => void saveQueryPreprocessing()}
                type="button"
              >
                {savingVector ? "保存中…" : "保存查询预处理"}
              </button>
              {qpDirty && <span className="text-xs text-warning">有未保存的更改</span>}
            </div>
          </div>
        </section>
      </>
      )}

      {activeTab === "automation" && (
        <AutomationPanel
          form={autoUpdateForm}
          onChange={setAutoUpdateForm}
          saving={savingAutoUpdate}
          dirty={autoUpdateDirty}
          onSave={() => void saveAutoUpdate()}
          mainModel={llmForm.model.trim() || "（未设置）"}
          taskModules={taskModules.map((tm) => ({ task_key: tm.task_key, model: tm.form.model.trim() || null }))}
        />
      )}

      <WizardNextBar
        projectId={projectId}
        currentStep="llm"
        progress={wizard.progress}
        loading={wizard.loading}
        dirty={anyDirty}        saving={savingPreset || testing}
        onSave={saveAll}
        primaryAction={
          wizard.progress.nextStep?.key === "llm"
            ? {
                label: llmCtaBlockedReason ?? `测试连接并下一步：${nextAfterLlm ? nextAfterLlm.title : "继续"}`,
                disabled: Boolean(savingPreset || testing || llmCtaBlockedReason),
                onClick: testAndGoNext,
              }
            : undefined
        }
      />
    </div>
  );
}
