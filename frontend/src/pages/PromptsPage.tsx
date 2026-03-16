import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { WizardNextBar } from "../components/atelier/WizardNextBar";
import { AutomationPanel, type AutoUpdateForm } from "../components/prompts/AutomationPanel";
import { LlmPresetPanel } from "../components/prompts/LlmPresetPanel";
import { PipelineOverview } from "../components/prompts/PipelineOverview";
import type { LlmForm, LlmModelListState, LlmTaskFormDraft, TaskOverrideForm } from "../components/prompts/types";
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
  LLMModelsResponse,
  LLMProfile,
  LLMTaskCatalogItem,
  LLMTaskPreset,
  ModuleSlot,
  Project,
  ProjectSettings,
} from "../types";
import {
  buildPresetPayload,
  buildTaskOverridePayload,
  DEFAULT_LLM_FORM,
  DEFAULT_VECTOR_RAG_FORM,
  formFromProfile,
  mapVectorFormFromSettings,
  overrideFormFromPreset,
  overridePayloadEquals,
  overridePayloadFromPreset,
  payloadEquals,
  payloadFromProfile,
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
  module_slot_id: string | null;
  form: TaskOverrideForm;
  dirty: boolean;
  saving: boolean;
  deleting: boolean;
};

const EMPTY_MODEL_LIST_STATE: LlmModelListState = {
  loading: false,
  options: [],
  warning: null,
  error: null,
  requestId: null,
};

const EMPTY_TASK_OVERRIDE: TaskOverrideForm = {
  temperature: "",
  top_p: "",
  max_tokens: "",
  presence_penalty: "",
  frequency_penalty: "",
  top_k: "",
  stop: "",
  timeout_seconds: "",
  extra: "{}",
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
  const wizardRefreshTimerRef = useRef<number | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [moduleSlots, setModuleSlots] = useState<ModuleSlot[]>([]);
  const [moduleDrafts, setModuleDrafts] = useState<Record<string, { display_name: string; form: LlmForm }>>({});
  const [moduleSaving, setModuleSaving] = useState<Record<string, boolean>>({});
  const [moduleTesting, setModuleTesting] = useState<Record<string, boolean>>({});
  const [moduleModelLists, setModuleModelLists] = useState<Record<string, LlmModelListState>>({});
  const [moduleApiKeyDrafts, setModuleApiKeyDrafts] = useState<Record<string, string>>({});
  const [moduleApiKeySnapshots, setModuleApiKeySnapshots] = useState<Record<string, string>>({});

  const [capabilities, setCapabilities] = useState<LlmCapabilities | null>(null);
  const capsGuardRef = useRef(createRequestSeqGuard());
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

  const [taskCatalog, setTaskCatalog] = useState<LLMTaskCatalogItem[]>([]);
  const [taskBaseline, setTaskBaseline] = useState<Record<string, LLMTaskPreset>>({});
  const [taskDrafts, setTaskDrafts] = useState<Record<string, LlmTaskFormDraft>>({});
  const [taskSaving, setTaskSaving] = useState<Record<string, boolean>>({});
  const [taskDeleting, setTaskDeleting] = useState<Record<string, boolean>>({});

  const mainSlot = useMemo(() => moduleSlots.find((slot) => slot.is_main) ?? null, [moduleSlots]);
  const mainSlotId = mainSlot?.id ?? null;
  const mainDraft = mainSlot ? moduleDrafts[mainSlot.id] ?? null : null;
  const mainForm = useMemo(
    () => mainDraft?.form ?? (mainSlot ? formFromProfile(mainSlot.profile) : { ...DEFAULT_LLM_FORM }),
    [mainDraft, mainSlot],
  );

  const reloadAll = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [modulesRes, pRes, settingsRes, taskRes] = await Promise.all([
        apiJson<{ modules: ModuleSlot[] }>(`/api/projects/${projectId}/modules`),
        apiJson<{ project: Project }>(`/api/projects/${projectId}`),
        apiJson<{ settings: ProjectSettings }>(`/api/projects/${projectId}/settings`),
        apiJson<{ catalog: LLMTaskCatalogItem[]; task_presets: LLMTaskPreset[] }>(
          `/api/projects/${projectId}/llm_task_presets`,
        ),
      ]);

      setProject(pRes.data.project);
      const modules = modulesRes.data.modules ?? [];
      setModuleSlots(modules);
      setModuleDrafts(() => {
        const next: Record<string, { display_name: string; form: LlmForm }> = {};
        for (const slot of modules) {
          next[slot.id] = {
            display_name: slot.display_name,
            form: formFromProfile(slot.profile),
          };
        }
        return next;
      });
      setModuleSaving({});
      setModuleTesting({});
      setModuleModelLists({});
      setModuleApiKeyDrafts({});
      setModuleApiKeySnapshots({});

      const nextTaskCatalog = taskRes.data.catalog ?? [];
      const nextTaskBaseline: Record<string, LLMTaskPreset> = {};
      const nextTaskDrafts: Record<string, LlmTaskFormDraft> = {};
      for (const row of taskRes.data.task_presets ?? []) {
        const key = String(row.task_key || "").trim();
        if (!key) continue;
        nextTaskBaseline[key] = row;
        nextTaskDrafts[key] = {
          task_key: key,
          module_slot_id: row.module_slot_id ?? null,
          form: overrideFormFromPreset(row),
          isNew: false,
        };
      }
      setTaskCatalog(nextTaskCatalog);
      setTaskBaseline(nextTaskBaseline);
      setTaskDrafts(nextTaskDrafts);
      setTaskSaving({});
      setTaskDeleting({});

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
    const provider = mainForm.provider;
    const model = mainForm.model.trim();
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
  }, [mainForm.model, mainForm.provider]);

  const currentMainPayload = useMemo(() => buildPresetPayload(mainForm), [mainForm]);
  const baselineMainPayload = useMemo(
    () => (mainSlot ? payloadFromProfile(mainSlot.profile) : null),
    [mainSlot],
  );
  const mainPresetDirty = useMemo(() => {
    if (!baselineMainPayload) return false;
    if (!currentMainPayload.ok) return true;
    return !payloadEquals(currentMainPayload.payload, baselineMainPayload);
  }, [baselineMainPayload, currentMainPayload]);

  const taskCatalogByKey = useMemo(() => {
    const map = new Map<string, LLMTaskCatalogItem>();
    for (const item of taskCatalog) map.set(item.key, item);
    return map;
  }, [taskCatalog]);

  const taskModules = useMemo<TaskModuleView[]>(() => {
    return Object.values(taskDrafts)
      .map((draft) => {
        const baseline = taskBaseline[draft.task_key] ?? null;
        const baselinePayload = baseline ? overridePayloadFromPreset(baseline) : null;
        const payload = buildTaskOverridePayload(draft.form);
        const payloadDirty =
          baselinePayload === null || !payload.ok ? true : !overridePayloadEquals(payload.payload, baselinePayload);
        const bindingDirty = (draft.module_slot_id ?? null) !== (baseline?.module_slot_id ?? null);
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
          module_slot_id: draft.module_slot_id,
          form: draft.form,
          dirty: draft.isNew || payloadDirty || bindingDirty,
          saving: Boolean(taskSaving[draft.task_key]),
          deleting: Boolean(taskDeleting[draft.task_key]),
        };
      })
      .sort((a, b) => a.group.localeCompare(b.group, "zh-Hans-CN") || a.label.localeCompare(b.label, "zh-Hans-CN"));
  }, [taskBaseline, taskCatalogByKey, taskDeleting, taskDrafts, taskSaving]);

  const vectorRagDirty = useMemo(() => {
    if (!baselineSettings) return false;
    const baseline = mapVectorFormFromSettings(baselineSettings);
    return JSON.stringify(vectorForm) !== JSON.stringify(baseline.vectorForm);
  }, [baselineSettings, vectorForm]);

  const vectorApiKeyDirty = useMemo(() => vectorApiKeyDraft.trim().length > 0 || vectorApiKeyClearRequested, [vectorApiKeyDraft, vectorApiKeyClearRequested]);
  const rerankApiKeyDirty = useMemo(() => rerankApiKeyDraft.trim().length > 0 || rerankApiKeyClearRequested, [rerankApiKeyDraft, rerankApiKeyClearRequested]);

  const qpDirty = useMemo(() => {
    if (!baselineSettings) return false;
    const baseline = baselineSettings.query_preprocessing;
    return qpEnabled !== (baseline?.enabled ?? false) ||
           qpTags !== (baseline?.tags?.join(", ") ?? "") ||
           qpExclusionRules !== (baseline?.exclusion_rules?.join("\n") ?? "") ||
           qpIndexRefEnhance !== (baseline?.index_ref_enhance ?? false);
  }, [baselineSettings, qpEnabled, qpTags, qpExclusionRules, qpIndexRefEnhance]);

  const autoUpdateDirty = useMemo(() => {
    if (!baselineSettings) return false;
    return autoUpdateForm.auto_update_worldbook_enabled !== baselineSettings.auto_update_worldbook_enabled ||
           autoUpdateForm.auto_update_characters_enabled !== baselineSettings.auto_update_characters_enabled ||
           autoUpdateForm.auto_update_story_memory_enabled !== baselineSettings.auto_update_story_memory_enabled ||
           autoUpdateForm.auto_update_graph_enabled !== baselineSettings.auto_update_graph_enabled ||
           autoUpdateForm.auto_update_vector_enabled !== baselineSettings.auto_update_vector_enabled ||
           autoUpdateForm.auto_update_search_enabled !== baselineSettings.auto_update_search_enabled ||
           autoUpdateForm.auto_update_fractal_enabled !== baselineSettings.auto_update_fractal_enabled ||
           autoUpdateForm.auto_update_tables_enabled !== baselineSettings.auto_update_tables_enabled;
  }, [baselineSettings, autoUpdateForm]);

  const llmCtaBlockedReason = useMemo(() => {
    if (!mainSlot) return "请先创建主模块";
    const draftKey = (moduleApiKeyDrafts[mainSlot.id] ?? "").trim();
    if (!mainSlot.profile.has_api_key && !draftKey) return "请先保存 API Key";
    return null;
  }, [mainSlot, moduleApiKeyDrafts]);

  const getModuleDraft = useCallback(
    (slot: ModuleSlot) => moduleDrafts[slot.id] ?? { display_name: slot.display_name, form: formFromProfile(slot.profile) },
    [moduleDrafts],
  );

  const isModuleFormDirty = useCallback(
    (slot: ModuleSlot) => {
      const draft = getModuleDraft(slot);
      const payload = buildPresetPayload(draft.form);
      if (!payload.ok) return true;
      return !payloadEquals(payload.payload, payloadFromProfile(slot.profile));
    },
    [getModuleDraft],
  );

  const isModuleApiKeyDirty = useCallback(
    (slotId: string) => {
      const draft = (moduleApiKeyDrafts[slotId] ?? "").trim();
      if (!draft) return false;
      const snapshot = moduleApiKeySnapshots[slotId];
      if (snapshot === undefined) return true;
      return draft !== snapshot;
    },
    [moduleApiKeyDrafts, moduleApiKeySnapshots],
  );

  const isModuleDirty = useCallback(
    (slot: ModuleSlot) => {
      const draft = getModuleDraft(slot);
      if (draft.display_name !== slot.display_name) return true;
      if (isModuleApiKeyDirty(slot.id)) return true;
      if (isModuleFormDirty(slot)) return true;
      return false;
    },
    [getModuleDraft, isModuleApiKeyDirty, isModuleFormDirty],
  );

  const moduleCards = useMemo(
    () =>
      moduleSlots.map((slot) => {
        const draft = getModuleDraft(slot);
        return {
          slot_id: slot.id,
          display_name: draft.display_name,
          is_main: slot.is_main,
          profile: slot.profile,
          form: draft.form,
          formDirty: isModuleFormDirty(slot),
          dirty: isModuleDirty(slot),
          saving: Boolean(moduleSaving[slot.id]),
          testing: Boolean(moduleTesting[slot.id]),
          modelList: moduleModelLists[slot.id] ?? EMPTY_MODEL_LIST_STATE,
          apiKeyDraft: moduleApiKeyDrafts[slot.id] ?? "",
          apiKeyDirty: isModuleApiKeyDirty(slot.id),
        };
      }),
    [getModuleDraft, isModuleDirty, isModuleApiKeyDirty, isModuleFormDirty, moduleApiKeyDrafts, moduleModelLists, moduleSaving, moduleSlots, moduleTesting],
  );

  const taskDirty = useMemo(() => taskModules.some((item) => item.dirty), [taskModules]);
  const moduleDirty = useMemo(() => moduleSlots.some((slot) => isModuleDirty(slot)), [isModuleDirty, moduleSlots]);
  const dirty = mainPresetDirty || taskDirty || moduleDirty;
  const llmSaving = useMemo(
    () =>
      Object.values(moduleSaving).some(Boolean) ||
      Object.values(taskSaving).some(Boolean) ||
      Object.values(taskDeleting).some(Boolean),
    [moduleSaving, taskDeleting, taskSaving],
  );
  const llmTesting = useMemo(() => Object.values(moduleTesting).some(Boolean), [moduleTesting]);
  const llmBusy = llmSaving || llmTesting;

  const updateModuleName = useCallback((slotId: string, value: string) => {
    setModuleDrafts((prev) => {
      const current = prev[slotId];
      return {
        ...prev,
        [slotId]: {
          display_name: value,
          form: current?.form ?? { ...DEFAULT_LLM_FORM },
        },
      };
    });
  }, []);

  const updateModuleForm = useCallback((slotId: string, updater: (prev: LlmForm) => LlmForm) => {
    setModuleDrafts((prev) => {
      const current = prev[slotId];
      if (!current) return prev;
      return {
        ...prev,
        [slotId]: {
          ...current,
          form: updater(current.form),
        },
      };
    });
  }, []);

  const updateModuleApiKeyDraft = useCallback((slotId: string, value: string) => {
    setModuleApiKeyDrafts((prev) => ({ ...prev, [slotId]: value }));
  }, []);

  const saveModule = useCallback(
    async (slotId: string, opts?: { silent?: boolean; snapshot?: LlmForm; displayName?: string }): Promise<boolean> => {
      if (!projectId) return false;
      const slot = moduleSlots.find((item) => item.id === slotId);
      if (!slot) return false;

      const silent = Boolean(opts?.silent);
      const draft = moduleDrafts[slotId];
      const snapshot = opts?.snapshot ?? draft?.form ?? formFromProfile(slot.profile);
      const displayName = opts?.displayName ?? draft?.display_name ?? slot.display_name;
      const apiKeyDraft = (moduleApiKeyDrafts[slotId] ?? "").trim();

      const payload = buildPresetPayload(snapshot);
      if (!payload.ok) {
        if (!silent) toast.toastError(payload.message);
        return false;
      }

      const scheduleWizardRefresh = () => {
        if (wizardRefreshTimerRef.current !== null) window.clearTimeout(wizardRefreshTimerRef.current);
        wizardRefreshTimerRef.current = window.setTimeout(() => void refreshWizard(), 1200);
      };

      setModuleSaving((prev) => ({ ...prev, [slotId]: true }));
      try {
        const profileUpdate = {
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
          ...(apiKeyDraft ? { api_key: apiKeyDraft } : {}),
        };
        const res = await apiJson<{ module: ModuleSlot }>(`/api/projects/${projectId}/modules/${slotId}`, {
          method: "PUT",
          body: JSON.stringify({
            display_name: displayName,
            profile_update: profileUpdate,
          }),
        });
        const updated = res.data.module;
        setModuleSlots((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setModuleDrafts((prev) => ({
          ...prev,
          [updated.id]: { display_name: updated.display_name, form: formFromProfile(updated.profile) },
        }));
        if (apiKeyDraft) {
          setModuleApiKeySnapshots((prev) => ({ ...prev, [updated.id]: apiKeyDraft }));
        }

        if (silent) scheduleWizardRefresh();
        else {
          toast.toastSuccess("已保存", res.request_id);
          await refreshWizard();
        }
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (!silent) toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setModuleSaving((prev) => ({ ...prev, [slotId]: false }));
      }
    },
    [moduleApiKeyDrafts, moduleDrafts, moduleSlots, projectId, refreshWizard, toast],
  );

  const deleteModule = useCallback(
    async (slotId: string): Promise<boolean> => {
      if (!projectId) return false;
      const slot = moduleSlots.find((item) => item.id === slotId);
      if (!slot || slot.is_main) return false;

      const yes = await confirm.confirm({
        title: "删除模块",
        description: `确认删除模块“${slot.display_name}”？已绑定该模块的任务将回退到主模块。`,
        confirmText: "删除",
        cancelText: "取消",
        danger: true,
      });
      if (!yes) return false;

      setModuleSaving((prev) => ({ ...prev, [slotId]: true }));
      try {
        await apiJson<Record<string, never>>(`/api/projects/${projectId}/modules/${slotId}`, { method: "DELETE" });
        setModuleSlots((prev) => prev.filter((item) => item.id !== slotId));
        setModuleDrafts((prev) => {
          const next = { ...prev };
          delete next[slotId];
          return next;
        });
        setModuleModelLists((prev) => {
          const next = { ...prev };
          delete next[slotId];
          return next;
        });
        setModuleTesting((prev) => {
          const next = { ...prev };
          delete next[slotId];
          return next;
        });
        setModuleApiKeyDrafts((prev) => {
          const next = { ...prev };
          delete next[slotId];
          return next;
        });
        setModuleApiKeySnapshots((prev) => {
          const next = { ...prev };
          delete next[slotId];
          return next;
        });
        toast.toastSuccess("模块已删除");
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setModuleSaving((prev) => ({ ...prev, [slotId]: false }));
      }
    },
    [confirm, moduleSlots, projectId, toast],
  );

  const addModule = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;
    const payload = buildPresetPayload(mainForm);
    if (!payload.ok) {
      toast.toastError(payload.message);
      return false;
    }
    const displayName = "新模块";
    try {
      const res = await apiJson<{ module: ModuleSlot }>(`/api/projects/${projectId}/modules`, {
        method: "POST",
        body: JSON.stringify({
          display_name: displayName,
          new_profile: {
            name: displayName,
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
          },
        }),
      });
      const created = res.data.module;
      setModuleSlots((prev) => [...prev, created]);
      setModuleDrafts((prev) => ({
        ...prev,
        [created.id]: { display_name: created.display_name, form: formFromProfile(created.profile) },
      }));
      toast.toastSuccess("模块已添加", res.request_id);
      return true;
    } catch (e) {
      const err = e as ApiError;
      toast.toastError(`${err.message} (${err.code})`, err.requestId);
      return false;
    }
  }, [mainForm, projectId, toast]);

  const clearModuleApiKey = useCallback(
    async (slotId: string): Promise<boolean> => {
      if (!projectId) return false;
      try {
        const res = await apiJson<{ module: ModuleSlot }>(`/api/projects/${projectId}/modules/${slotId}`, {
          method: "PUT",
          body: JSON.stringify({ profile_update: { api_key: "" } }),
        });
        const updated = res.data.module;
        setModuleSlots((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setModuleApiKeyDrafts((prev) => ({ ...prev, [slotId]: "" }));
        setModuleApiKeySnapshots((prev) => ({ ...prev, [slotId]: "" }));
        toast.toastSuccess("API Key 已清除", res.request_id);
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      }
    },
    [projectId, toast],
  );

  const loadModuleModels = useCallback(
    async (slotId: string) => {
      if (!projectId) return;
      const slot = moduleSlots.find((item) => item.id === slotId);
      if (!slot) return;
      const draft = moduleDrafts[slotId]?.form ?? formFromProfile(slot.profile);

      setModuleModelLists((prev) => ({
        ...prev,
        [slotId]: {
          ...(prev[slotId] ?? { ...EMPTY_MODEL_LIST_STATE }),
          loading: true,
        },
      }));

      const params = new URLSearchParams();
      params.set("provider", draft.provider);
      if (draft.base_url.trim()) params.set("base_url", draft.base_url.trim());
      params.set("profile_id", slot.profile.id);

      try {
        const res = await apiJson<LLMModelsResponse>(`/api/llm_models?${params.toString()}`);
        const options = (res.data.models ?? [])
          .map((item) => ({
            id: String(item.id || "").trim(),
            display_name: String(item.display_name || item.id || "").trim(),
          }))
          .filter((item) => item.id);
        setModuleModelLists((prev) => ({
          ...prev,
          [slotId]: {
            loading: false,
            options,
            warning: res.data.warning?.message ?? null,
            error: null,
            requestId: res.request_id,
          },
        }));
      } catch (e) {
        const err = e as ApiError;
        setModuleModelLists((prev) => ({
          ...prev,
          [slotId]: {
            loading: false,
            options: [],
            warning: null,
            error: `${err.message} (${err.code})`,
            requestId: err.requestId ?? null,
          },
        }));
      }
    },
    [moduleDrafts, moduleSlots, projectId],
  );

  const testModuleConnection = useCallback(
    async (slotId: string): Promise<boolean> => {
      if (!projectId) return false;
      const slot = moduleSlots.find((item) => item.id === slotId);
      if (!slot) return false;
      const draftEntry = moduleDrafts[slotId];
      const draft = draftEntry?.form ?? formFromProfile(slot.profile);
      const apiKeyDraft = (moduleApiKeyDrafts[slotId] ?? "").trim();
      const payload = buildPresetPayload(draft);
      if (!payload.ok) {
        toast.toastError(payload.message);
        return false;
      }

      const needsSave = isModuleDirty(slot);
      if (needsSave) {
        const saved = await saveModule(slotId, {
          silent: true,
          snapshot: draft,
          displayName: draftEntry?.display_name ?? slot.display_name,
        });
        if (!saved) {
          toast.toastError("保存失败，请检查参数");
          return false;
        }
      }

      const hasKey = slot.profile.has_api_key || apiKeyDraft.length > 0;
      if (!hasKey) {
        toast.toastError("请先保存 API Key");
        return false;
      }

      setModuleTesting((prev) => ({ ...prev, [slotId]: true }));
      try {
        const res = await apiJson<{ latency_ms: number; text?: string }>("/api/llm/test", {
          method: "POST",
          headers: {
            "X-LLM-Provider": payload.payload.provider,
          },
          body: JSON.stringify({
            project_id: projectId,
            profile_id: slot.profile.id,
            provider: payload.payload.provider,
            base_url: payload.payload.base_url,
            model: payload.payload.model,
            timeout_seconds: parseTimeoutSecondsForTest(draft.timeout_seconds),
            extra: payload.payload.extra,
            params: {
              temperature: payload.payload.temperature ?? 0,
              max_tokens: 64,
            },
          }),
        });
        const preview = (res.data.text ?? "").trim();
        toast.toastSuccess(
          `连接成功（延迟 ${res.data.latency_ms}ms${preview ? `，输出：${preview}` : ""}）`,
          res.request_id,
        );
        if (slot.is_main && projectId) {
          markWizardLlmTestOk(projectId, payload.payload.provider, payload.payload.model);
          bumpWizardLocal();
        }
        return true;
      } catch (e) {
        const err = e as ApiError;
        toast.toastError(formatLlmTestApiError(err), err.requestId);
        return false;
      } finally {
        setModuleTesting((prev) => ({ ...prev, [slotId]: false }));
      }
    },
    [bumpWizardLocal, isModuleDirty, moduleApiKeyDrafts, moduleDrafts, moduleSlots, projectId, saveModule, toast],
  );

  const updateTaskForm = useCallback((taskKey: string, updater: (prev: TaskOverrideForm) => TaskOverrideForm) => {
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

  const updateTaskModule = useCallback((taskKey: string, moduleSlotId: string | null) => {
    setTaskDrafts((prev) => {
      const current = prev[taskKey];
      if (!current) return prev;
      return {
        ...prev,
        [taskKey]: {
          ...current,
          module_slot_id: moduleSlotId,
        },
      };
    });
  }, []);

  const addTaskModule = useCallback(
    (taskKey: string) => {
      const key = taskKey.trim();
      if (!key) return;
      setTaskDrafts((prev) => {
        if (prev[key]) return prev;
        return {
          ...prev,
          [key]: {
            task_key: key,
            module_slot_id: mainSlotId,
            form: { ...EMPTY_TASK_OVERRIDE },
            isNew: true,
          },
        };
      });
    },
    [mainSlotId],
  );

  const saveTaskModule = useCallback(
    async (taskKey: string, opts?: { silent?: boolean }): Promise<boolean> => {
      if (!projectId) return false;
      const draft = taskDrafts[taskKey];
      if (!draft) return false;
      if (!draft.module_slot_id) {
        if (!opts?.silent) toast.toastError("请选择要绑定的模块");
        return false;
      }
      const payload = buildTaskOverridePayload(draft.form);
      if (!payload.ok) {
        if (!opts?.silent) toast.toastError(payload.message);
        return false;
      }

      setTaskSaving((prev) => ({ ...prev, [taskKey]: true }));
      try {
        const res = await apiJson<{ task_preset: LLMTaskPreset }>(
          `/api/projects/${projectId}/llm_task_presets/${encodeURIComponent(taskKey)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              module_slot_id: draft.module_slot_id,
              ...payload.payload,
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
              module_slot_id: row.module_slot_id ?? null,
              form: overrideFormFromPreset(row),
              isNew: false,
            },
          };
        });
        if (!opts?.silent) toast.toastSuccess("任务覆盖已保存", res.request_id);
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (!opts?.silent) toast.toastError(`${err.message} (${err.code})`, err.requestId);
        return false;
      } finally {
        setTaskSaving((prev) => ({ ...prev, [taskKey]: false }));
      }
    },
    [projectId, taskDrafts, toast],
  );

  const deleteTaskModule = useCallback(
    async (taskKey: string): Promise<boolean> => {
      if (!projectId) return false;
      const draft = taskDrafts[taskKey];
      if (!draft) return false;
      const yes = await confirm.confirm({
        title: "删除任务覆盖",
        description: `确认删除任务“${taskCatalogByKey.get(taskKey)?.label ?? taskKey}”的覆盖配置？`,
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
        toast.toastSuccess("已移除未保存覆盖");
        return true;
      }

      setTaskDeleting((prev) => ({ ...prev, [taskKey]: true }));
      try {
        await apiJson<Record<string, never>>(
          `/api/projects/${projectId}/llm_task_presets/${encodeURIComponent(taskKey)}`,
          { method: "DELETE" },
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
        toast.toastSuccess("任务覆盖已删除");
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

  const saveAllDirtyModules = useCallback(async (): Promise<boolean> => {
    let ok = true;
    let savedAny = false;
    for (const slot of moduleSlots) {
      if (!isModuleDirty(slot)) continue;
      savedAny = true;
      const draft = getModuleDraft(slot);
      ok = (await saveModule(slot.id, { silent: true, snapshot: draft.form, displayName: draft.display_name })) && ok;
    }
    for (const item of taskModules) {
      if (!item.dirty) continue;
      savedAny = true;
      ok = (await saveTaskModule(item.task_key, { silent: true })) && ok;
    }
    if (savedAny && !ok) {
      toast.toastError("存在未保存模块，请检查参数");
    }
    if (savedAny && ok) {
      toast.toastSuccess("已保存全部模块");
      await refreshWizard();
    }
    return ok;
  }, [getModuleDraft, isModuleDirty, moduleSlots, refreshWizard, saveModule, saveTaskModule, taskModules, toast]);
  useSaveHotkey(() => void saveAllDirtyModules(), dirty);

  const testMainConnection = useCallback(async (): Promise<boolean> => {
    if (!projectId || !mainSlotId) return false;
    return testModuleConnection(mainSlotId);
  }, [mainSlotId, projectId, testModuleConnection]);
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

    const ok = await testMainConnection();
    if (!ok) return false;

    if (nextAfterLlm?.href) navigate(nextAfterLlm.href);
    else navigate(`/projects/${projectId}/outline`);
    return true;
  }, [navigate, nextAfterLlm?.href, projectId, saveAllDirtyModules, testMainConnection]);

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

  if (loadError && !project && !baselineSettings) {
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
      {dirty && outletActive ? <UnsavedChangesGuard when={dirty} /> : null}

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
            mainModel={mainForm.model.trim() || "（未设置）"}
            taskModules={taskModules.map((tm) => ({
              task_key: tm.task_key,
              model: tm.form.model.trim() || null,
              overridden: true,
            }))}
          />
          <LlmPresetPanel
            moduleCards={moduleCards}
            moduleOptions={moduleSlots}
            mainSlotId={mainSlotId}
            capabilities={capabilities}
            onModuleNameChange={updateModuleName}
            onModuleFormChange={updateModuleForm}
            onSaveModule={(slotId) => void saveModule(slotId)}
            onDeleteModule={(slotId) => void deleteModule(slotId)}
            onReloadModuleModels={(slotId) => void loadModuleModels(slotId)}
            onTestModuleConnection={(slotId) => void testModuleConnection(slotId)}
            onAddModule={() => void addModule()}
            onModuleApiKeyDraftChange={updateModuleApiKeyDraft}
            onClearModuleApiKey={(slotId) => void clearModuleApiKey(slotId)}
            taskModules={taskModules}
            taskCatalog={taskCatalog}
            onAddTaskModule={addTaskModule}
            onTaskModuleChange={updateTaskModule}
            onTaskFormChange={updateTaskForm}
            onSaveTask={(taskKey) => void saveTaskModule(taskKey)}
            onDeleteTask={(taskKey) => void deleteTaskModule(taskKey)}
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
          mainModel={mainForm.model.trim() || "（未设置）"}
          taskModules={taskModules.map((tm) => ({ task_key: tm.task_key, model: tm.form.model.trim() || null }))}
        />
      )}

      <WizardNextBar
        projectId={projectId}
        currentStep="llm"
        progress={wizard.progress}
        loading={wizard.loading}
        dirty={dirty}
        saving={llmBusy}
        onSave={saveAllDirtyModules}
        primaryAction={
          wizard.progress.nextStep?.key === "llm"
            ? {
                label: llmCtaBlockedReason ?? `测试连接并下一步：${nextAfterLlm ? nextAfterLlm.title : "继续"}`,
                disabled: Boolean(llmBusy || llmCtaBlockedReason),
                onClick: testAndGoNext,
              }
            : undefined
        }
      />
    </div>
  );
}
