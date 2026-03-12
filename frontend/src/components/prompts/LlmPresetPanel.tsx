import { useCallback, useMemo } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import type { LLMProfile, LLMProvider, LLMTaskCatalogItem } from "../../types";
import { Badge, type BadgeTone } from "../ui/Badge";
import type { LlmForm, LlmModelListState } from "./types";

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

type Props = {
  llmForm: LlmForm;
  setLlmForm: Dispatch<SetStateAction<LlmForm>>;
  presetDirty: boolean;
  saving: boolean;
  testing: boolean;
  capabilities: {
    max_tokens_limit: number | null;
    max_tokens_recommended: number | null;
    context_window_limit: number | null;
  } | null;
  onTestConnection: () => void;
  testConnectionDisabledReason?: string | null;
  onSave: () => void;
  mainModelList: LlmModelListState;
  onReloadMainModels: () => void;

  profiles: LLMProfile[];
  selectedProfileId: string | null;
  onSelectProfile: (profileId: string | null) => void;
  profileName: string;
  onChangeProfileName: (value: string) => void;
  profileBusy: boolean;
  onCreateProfile: () => void;
  onUpdateProfile: () => void;
  onDeleteProfile: () => void;

  apiKey: string;
  onChangeApiKey: (value: string) => void;
  onSaveApiKey: () => void;
  onClearApiKey: () => void;

  taskModules: TaskModuleView[];
  addableTasks: LLMTaskCatalogItem[];
  selectedAddTaskKey: string;
  onSelectAddTaskKey: (taskKey: string) => void;
  onAddTaskModule: () => void;
  onTaskProfileChange: (taskKey: string, profileId: string | null) => void;
  onTaskFormChange: (taskKey: string, updater: (prev: LlmForm) => LlmForm) => void;
  taskTesting: Record<string, boolean>;
  onTestTaskConnection: (taskKey: string) => void;
  taskApiKeyDrafts: Record<string, string>;
  onTaskApiKeyDraftChange: (taskKey: string, value: string) => void;
  taskProfileBusy: Record<string, boolean>;
  onSaveTaskApiKey: (taskKey: string) => void;
  onClearTaskApiKey: (taskKey: string) => void;
  onSaveTask: (taskKey: string) => void;
  onDeleteTask: (taskKey: string) => void;
  onReloadTaskModels: (taskKey: string) => void;
};

type ModuleEditorProps = {
  moduleId: string;
  legacyMainFieldNames?: boolean;
  title: string;
  subtitle: string;
  form: LlmForm;
  setForm: (updater: (prev: LlmForm) => LlmForm) => void;
  saving: boolean;
  dirty: boolean;
  capabilities: {
    max_tokens_limit: number | null;
    max_tokens_recommended: number | null;
    context_window_limit: number | null;
  } | null;
  modelList: LlmModelListState;
  headerActions: ReactNode;
};

function getJsonParseErrorPosition(message: string): number | null {
  const m = message.match(/\bposition\s+(\d+)\b/i);
  if (!m) return null;
  const pos = Number(m[1]);
  return Number.isFinite(pos) ? pos : null;
}

function getLineAndColumnFromPosition(text: string, position: number): { line: number; column: number } | null {
  if (!Number.isFinite(position) || position < 0 || position > text.length) return null;
  const before = text.slice(0, position);
  const parts = before.split(/\r?\n/);
  const line = parts.length;
  const column = parts[parts.length - 1].length + 1;
  return { line, column };
}

function validateExtraJson(
  raw: string,
): { ok: true; value: unknown } | { ok: false; message: string; position?: number; line?: number; column?: number } {
  const trimmed = (raw ?? "").trim();
  const effective = trimmed ? raw : "{}";
  try {
    return { ok: true, value: JSON.parse(effective) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const position = getJsonParseErrorPosition(message);
    const lc = position !== null ? getLineAndColumnFromPosition(effective, position) : null;
    return {
      ok: false,
      message,
      ...(position !== null ? { position } : {}),
      ...(lc ? lc : {}),
    };
  }
}

function providerLabel(provider: LLMProvider): string {
  if (provider === "openai") return "OpenAI Chat";
  if (provider === "openai_responses") return "OpenAI Responses";
  if (provider === "openai_compatible") return "OpenAI Compatible Chat";
  if (provider === "openai_responses_compatible") return "OpenAI Compatible Responses";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "deepseek") return "DeepSeek";
  return "Gemini";
}

const COST_TIER_META: Record<string, { label: string; tone: BadgeTone }> = {
  low: { label: "低成本", tone: "success" },
  medium: { label: "中成本", tone: "warning" },
  high: { label: "高成本", tone: "danger" },
};

function getCostTierMeta(tier: string | null | undefined): { label: string; tone: BadgeTone } | null {
  if (!tier) return null;
  const key = String(tier || "").trim();
  return COST_TIER_META[key] ?? null;
}

function formatRecommendedLabel(task: {
  recommended_provider?: LLMTaskCatalogItem["recommended_provider"];
  recommended_model?: LLMTaskCatalogItem["recommended_model"];
}): string | null {
  const provider = task.recommended_provider ? providerLabel(task.recommended_provider as LLMProvider) : "";
  const model = String(task.recommended_model || "").trim();
  if (!provider && !model) return null;
  return [provider, model].filter(Boolean).join(" / ");
}

function formatRecommendedCompact(task: LLMTaskCatalogItem): string | null {
  const provider = String(task.recommended_provider || "").trim();
  const model = String(task.recommended_model || "").trim();
  if (!provider && !model) return null;
  if (provider && model) return `${provider}/${model}`;
  return provider || model;
}

function maxTokensHint(
  caps: {
    max_tokens_limit: number | null;
    max_tokens_recommended: number | null;
    context_window_limit: number | null;
  } | null,
): string {
  if (!caps) return "";
  const parts: string[] = [];
  if (caps.max_tokens_recommended) parts.push(`推荐 ${caps.max_tokens_recommended}`);
  if (caps.max_tokens_limit) parts.push(`上限 ${caps.max_tokens_limit}`);
  if (caps.context_window_limit) parts.push(`上下文 ${caps.context_window_limit}`);
  return parts.join(" · ");
}

function ModuleEditor(props: ModuleEditorProps) {
  const fieldName = useCallback(
    (key: string) => (props.legacyMainFieldNames ? key : `${props.moduleId}_${key}`),
    [props.legacyMainFieldNames, props.moduleId],
  );
  const extraValidation = useMemo(() => validateExtraJson(props.form.extra), [props.form.extra]);
  const extraErrorText = extraValidation.ok
    ? ""
    : `extra JSON 无效${extraValidation.line ? `（第 ${extraValidation.line} 行，第 ${extraValidation.column ?? 1} 列）` : ""}：${extraValidation.message}`;
  const tokenHint = maxTokensHint(props.capabilities);
  const responsesProvider =
    props.form.provider === "openai_responses" || props.form.provider === "openai_responses_compatible";

  const onFormatExtra = useCallback(() => {
    const parsed = validateExtraJson(props.form.extra);
    if (!parsed.ok) return;
    props.setForm((v) => ({
      ...v,
      extra: JSON.stringify(parsed.value, null, 2),
    }));
  }, [props]);

  return (
    <section className="surface border border-border p-4" aria-label={props.title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="text-base font-semibold text-ink">{props.title}</div>
          <div className="text-xs text-subtext">{props.subtitle}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">{props.headerActions}</div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs text-subtext">服务商（provider）</span>
          <select
            className="select"
            name={fieldName("provider")}
            value={props.form.provider}
            disabled={props.saving}
            onChange={(e) =>
              props.setForm((v) => ({
                ...v,
                provider: e.target.value as LLMProvider,
                max_tokens: "",
                text_verbosity: "",
                reasoning_effort: "",
                anthropic_thinking_enabled: false,
                anthropic_thinking_budget_tokens: "",
                gemini_thinking_budget: "",
                gemini_include_thoughts: false,
              }))
            }
          >
            <option value="openai">openai（官方）</option>
            <option value="openai_responses">openai_responses（官方 /v1/responses）</option>
            <option value="openai_compatible">openai_compatible（中转/本地）</option>
            <option value="openai_responses_compatible">openai_responses_compatible（中转 /v1/responses）</option>
            <option value="anthropic">anthropic（Claude）</option>
            <option value="gemini">gemini</option>
            <option value="deepseek">deepseek（DeepSeek）</option>
          </select>
          <div className="text-[11px] text-subtext">
            当前：{providerLabel(props.form.provider)}。兼容网关通常需要可访问的 `base_url`。
          </div>
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-subtext">模型（model）</span>
          <input
            className="input"
            list={`${props.moduleId}_models`}
            name={fieldName("model")}
            disabled={props.saving}
            value={props.form.model}
            onChange={(e) => props.setForm((v) => ({ ...v, model: e.target.value }))}
          />
          <datalist id={`${props.moduleId}_models`}>
            {props.modelList.options.map((option) => (
              <option key={`${props.moduleId}-${option.id}`} value={option.id}>
                {option.display_name}
              </option>
            ))}
          </datalist>
          <div className="text-[11px] text-subtext">
            支持“下拉候选 + 手动输入”。{props.modelList.warning ? `提示：${props.modelList.warning}` : ""}
            {props.modelList.error ? `错误：${props.modelList.error}` : ""}
          </div>
        </label>

        <label className="grid gap-1 md:col-span-2">
          <span className="text-xs text-subtext">接口地址（base_url）</span>
          <input
            className="input"
            disabled={props.saving}
            name={fieldName("base_url")}
            placeholder={
              props.form.provider === "openai_compatible" || props.form.provider === "openai_responses_compatible"
                ? "https://your-gateway.example.com/v1"
                : undefined
            }
            value={props.form.base_url}
            onChange={(e) => props.setForm((v) => ({ ...v, base_url: e.target.value }))}
          />
          <div className="text-[11px] text-subtext">
            OpenAI / OpenAI-compatible 一般包含 `/v1`；Anthropic/Gemini 一般为 host；DeepSeek 默认 `https://api.deepseek.com`。
          </div>
        </label>
      </div>

      <details className="mt-4 rounded-atelier border border-border/60 bg-canvas px-4 py-3" open={props.dirty}>
        <summary className="cursor-pointer select-none text-sm font-medium text-ink">高级参数与推理配置</summary>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="text-xs text-subtext">temperature</span>
            <input
              className="input"
              value={props.form.temperature}
              onChange={(e) => props.setForm((v) => ({ ...v, temperature: e.target.value }))}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-subtext">top_p</span>
            <input
              className="input"
              value={props.form.top_p}
              onChange={(e) => props.setForm((v) => ({ ...v, top_p: e.target.value }))}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-subtext">max_tokens / max_output_tokens</span>
            <input
              className="input"
              value={props.form.max_tokens}
              onChange={(e) => props.setForm((v) => ({ ...v, max_tokens: e.target.value }))}
            />
            {tokenHint ? <div className="text-[11px] text-subtext">{tokenHint}</div> : null}
          </label>

          {props.form.provider === "openai" || props.form.provider === "openai_compatible" || props.form.provider === "deepseek" ? (
            <>
              <label className="grid gap-1">
                <span className="text-xs text-subtext">presence_penalty</span>
                <input
                  className="input"
                  value={props.form.presence_penalty}
                  onChange={(e) => props.setForm((v) => ({ ...v, presence_penalty: e.target.value }))}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-subtext">frequency_penalty</span>
                <input
                  className="input"
                  value={props.form.frequency_penalty}
                  onChange={(e) => props.setForm((v) => ({ ...v, frequency_penalty: e.target.value }))}
                />
              </label>
            </>
          ) : (
            <label className="grid gap-1">
              <span className="text-xs text-subtext">top_k</span>
              <input
                className="input"
                value={props.form.top_k}
                onChange={(e) => props.setForm((v) => ({ ...v, top_k: e.target.value }))}
              />
            </label>
          )}

          <label className="grid gap-1 md:col-span-2">
            <span className="text-xs text-subtext">stop（逗号分隔）</span>
            <input
              className="input"
              value={props.form.stop}
              onChange={(e) => props.setForm((v) => ({ ...v, stop: e.target.value }))}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-subtext">timeout_seconds</span>
            <input
              className="input"
              value={props.form.timeout_seconds}
              onChange={(e) => props.setForm((v) => ({ ...v, timeout_seconds: e.target.value }))}
            />
          </label>

          {(props.form.provider === "openai" || props.form.provider === "openai_compatible" || responsesProvider) && (
            <label className="grid gap-1">
              <span className="text-xs text-subtext">reasoning effort</span>
              <select
                className="select"
                value={props.form.reasoning_effort}
                onChange={(e) => props.setForm((v) => ({ ...v, reasoning_effort: e.target.value }))}
              >
                <option value="">（默认）</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
          )}

          {responsesProvider && (
            <label className="grid gap-1">
              <span className="text-xs text-subtext">text verbosity</span>
              <select
                className="select"
                value={props.form.text_verbosity}
                onChange={(e) => props.setForm((v) => ({ ...v, text_verbosity: e.target.value }))}
              >
                <option value="">（默认）</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
          )}

          {props.form.provider === "anthropic" && (
            <>
              <label className="flex items-center gap-2 md:col-span-1">
                <input
                  checked={props.form.anthropic_thinking_enabled}
                  onChange={(e) => props.setForm((v) => ({ ...v, anthropic_thinking_enabled: e.target.checked }))}
                  type="checkbox"
                />
                <span className="text-sm text-ink">启用 thinking</span>
              </label>
              <label className="grid gap-1 md:col-span-2">
                <span className="text-xs text-subtext">thinking.budget_tokens</span>
                <input
                  className="input"
                  placeholder="例如 1024"
                  value={props.form.anthropic_thinking_budget_tokens}
                  onChange={(e) => props.setForm((v) => ({ ...v, anthropic_thinking_budget_tokens: e.target.value }))}
                />
              </label>
            </>
          )}

          {props.form.provider === "gemini" && (
            <>
              <label className="grid gap-1 md:col-span-2">
                <span className="text-xs text-subtext">thinkingConfig.thinkingBudget</span>
                <input
                  className="input"
                  placeholder="例如 1024"
                  value={props.form.gemini_thinking_budget}
                  onChange={(e) => props.setForm((v) => ({ ...v, gemini_thinking_budget: e.target.value }))}
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  checked={props.form.gemini_include_thoughts}
                  onChange={(e) => props.setForm((v) => ({ ...v, gemini_include_thoughts: e.target.checked }))}
                  type="checkbox"
                />
                <span className="text-sm text-ink">thinkingConfig.includeThoughts</span>
              </label>
            </>
          )}

          <label className="grid gap-1 md:col-span-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-subtext">extra（JSON，高级扩展）</span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={props.saving || !extraValidation.ok}
                onClick={onFormatExtra}
                type="button"
              >
                一键格式化
              </button>
            </div>
            <textarea
              className="textarea atelier-mono"
              rows={6}
              value={props.form.extra}
              onChange={(e) => props.setForm((v) => ({ ...v, extra: e.target.value }))}
            />
            <div className="text-[11px] text-subtext">
              保留自定义 provider 字段；推理参数建议优先用上面的结构化控件。
            </div>
            {extraErrorText ? <div className="text-xs text-warning">{extraErrorText}</div> : null}
          </label>
        </div>
      </details>
    </section>
  );
}

export function LlmPresetPanel(props: Props) {
  const selectedProfile = props.selectedProfileId
    ? (props.profiles.find((p) => p.id === props.selectedProfileId) ?? null)
    : null;
  const testDisabledReason = (props.testConnectionDisabledReason ?? "").trim();

  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-content text-xl text-ink">模型编排配置</div>
          <div className="mt-1 text-xs text-subtext">
            主模型负责默认调用；任务模块可覆盖特定流程（未覆盖则自动回退主模型）。
          </div>
        </div>
      </div>

      <div className="mt-4">
        <ModuleEditor
          moduleId="main-module"
          legacyMainFieldNames
          title="主模块（默认）"
          subtitle="所有未单独覆盖的任务都会使用这里的 provider/model/参数。"
          form={props.llmForm}
          setForm={props.setLlmForm}
          saving={props.saving || props.profileBusy}
          dirty={props.presetDirty}
          capabilities={props.capabilities}
          modelList={props.mainModelList}
          headerActions={
            <>
              <button
                className="btn btn-secondary"
                disabled={props.mainModelList.loading || props.saving}
                onClick={props.onReloadMainModels}
                type="button"
              >
                {props.mainModelList.loading ? "拉取中..." : "拉取模型列表"}
              </button>
              <button
                className="btn btn-secondary"
                disabled={props.testing || props.profileBusy || Boolean(testDisabledReason)}
                onClick={props.onTestConnection}
                type="button"
              >
                {props.testing ? "测试中..." : "测试连接"}
              </button>
              <button
                className="btn btn-primary"
                disabled={!props.presetDirty || props.saving}
                onClick={props.onSave}
                type="button"
              >
                保存主模块
              </button>
            </>
          }
        />
        {testDisabledReason ? <div className="mt-2 text-[11px] text-warning">{testDisabledReason}</div> : null}
      </div>

      <div className="mt-6 rounded-atelier border border-border/70 bg-canvas p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <div className="text-sm font-semibold text-ink">任务模块覆盖</div>
            <div className="text-xs text-subtext">
              按流程拆分模型。每个模块都可绑定独立 API 配置库，未绑定则回退项目主配置。
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="select min-w-[240px]"
              value={props.selectedAddTaskKey}
              onChange={(e) => props.onSelectAddTaskKey(e.target.value)}
              disabled={props.addableTasks.length === 0 || props.profileBusy}
            >
              <option value="">选择要新增的任务模块</option>
              {props.addableTasks.map((task) => (
                <option key={task.key} value={task.key}>
                  {(() => {
                    const parts = [`[${task.group}] ${task.label}`];
                    const recommend = formatRecommendedCompact(task);
                    if (recommend) parts.push(`推荐 ${recommend}`);
                    const costLabel = getCostTierMeta(task.cost_tier)?.label;
                    if (costLabel) parts.push(costLabel);
                    return parts.join(" · ");
                  })()}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={!props.selectedAddTaskKey || props.profileBusy}
              onClick={props.onAddTaskModule}
              type="button"
            >
              新增模块
            </button>
          </div>
        </div>

        {props.taskModules.length === 0 ? (
          <div className="mt-4 rounded-atelier border border-dashed border-border p-4 text-xs text-subtext">
            暂无任务级覆盖。当前所有流程都使用主模块。
          </div>
        ) : (
          <div className="mt-4 grid gap-4">
            {props.taskModules.map((task) => {
              const boundProfile = task.llm_profile_id
                ? (props.profiles.find((p) => p.id === task.llm_profile_id) ?? null)
                : null;
              const effectiveProfile = boundProfile ?? (!task.llm_profile_id ? selectedProfile : null);
              const profileMismatch = Boolean(boundProfile && boundProfile.provider !== task.form.provider);
              const fallbackProfileMismatch = Boolean(
                !boundProfile && selectedProfile && selectedProfile.provider !== task.form.provider,
              );
              const testing = Boolean(props.taskTesting[task.task_key]);
              const profileBusy = Boolean(props.taskProfileBusy[task.task_key]);
              const taskBusy = task.saving || task.deleting || profileBusy;
              const taskUiLocked = taskBusy || testing;
              return (
                <div className="rounded-atelier border border-border/70 bg-canvas p-3" key={task.task_key}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="grid gap-1">
                      <div className="text-sm font-semibold text-ink">
                        [{task.group}] {task.label}
                      </div>
                      <div className="text-xs text-subtext">{task.description}</div>
                      {(() => {
                        const costMeta = getCostTierMeta(task.cost_tier);
                        const recommendLabel = formatRecommendedLabel(task);
                        const note = String(task.recommended_note || "").trim();
                        if (!costMeta && !recommendLabel && !note) return null;
                        return (
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-subtext">
                            {costMeta ? <Badge tone={costMeta.tone}>{costMeta.label}</Badge> : null}
                            {recommendLabel ? <Badge tone="accent">推荐 {recommendLabel}</Badge> : null}
                            {note ? <span>{note}</span> : null}
                          </div>
                        );
                      })()}
                      <div className="text-[11px] text-subtext">任务键：{task.task_key}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {task.dirty ? (
                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">未保存</span>
                      ) : null}
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={task.modelList.loading || taskUiLocked}
                        onClick={() => props.onReloadTaskModels(task.task_key)}
                        type="button"
                      >
                        {task.modelList.loading ? "拉取中..." : "模型列表"}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={taskUiLocked || props.profileBusy}
                        onClick={() => props.onTestTaskConnection(task.task_key)}
                        type="button"
                      >
                        {testing ? "测试中..." : "测试连接"}
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!task.dirty || taskUiLocked}
                        onClick={() => props.onSaveTask(task.task_key)}
                        type="button"
                      >
                        {task.saving ? "保存中..." : "保存模块"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm text-accent hover:bg-accent/10"
                        disabled={taskUiLocked}
                        onClick={() => props.onDeleteTask(task.task_key)}
                        type="button"
                      >
                        {task.deleting ? "删除中..." : "删除模块"}
                      </button>
                    </div>
                  </div>

                  <div className="mb-3 grid gap-1">
                    <span className="text-xs text-subtext">任务模块绑定的 API 配置库</span>
                    <select
                      className="select"
                      value={task.llm_profile_id ?? ""}
                      onChange={(e) => props.onTaskProfileChange(task.task_key, e.target.value || null)}
                      disabled={taskUiLocked}
                    >
                      <option value="">使用默认主配置</option>
                      {props.profiles.map((profile) => (
                        <option key={`${task.task_key}-${profile.id}`} value={profile.id}>
                          {profile.name} · {profile.provider}/{profile.model}
                        </option>
                      ))}
                    </select>
                    <div className="text-[11px] text-subtext">
                      选择后该任务优先使用该配置库的 API Key。留空表示继承项目主配置绑定的 API Key。
                    </div>
                    {profileMismatch ? (
                      <div className="text-[11px] text-warning">
                        所选配置库 provider 与当前模块 provider 不一致，保存会失败。
                      </div>
                    ) : null}
                    {fallbackProfileMismatch ? (
                      <div className="text-[11px] text-warning">
                        当前未绑定任务配置，回退主配置 provider 与模块 provider 不一致，测试连接会失败。
                      </div>
                    ) : null}
                    {effectiveProfile ? (
                      <>
                        <div className="text-[11px] text-subtext">
                          当前生效配置：{effectiveProfile.name}（{effectiveProfile.provider}/{effectiveProfile.model}）
                          {!boundProfile ? "，来源：主配置回退" : "，来源：任务绑定配置"}
                          {effectiveProfile.has_api_key
                            ? `，已保存 Key：${effectiveProfile.masked_api_key ?? "（已保存）"}`
                            : "，尚未保存 Key"}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2">
                          <input
                            className="input flex-1 min-w-[220px]"
                            disabled={taskUiLocked}
                            placeholder={
                              boundProfile
                                ? "输入该任务绑定配置库的新 Key（共享给复用该配置库的模块）"
                                : "输入主配置的新 Key（将影响回退到主配置的任务）"
                            }
                            type="password"
                            value={props.taskApiKeyDrafts[task.task_key] ?? ""}
                            onChange={(e) => props.onTaskApiKeyDraftChange(task.task_key, e.target.value)}
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={taskUiLocked || !(props.taskApiKeyDrafts[task.task_key] ?? "").trim()}
                            onClick={() => props.onSaveTaskApiKey(task.task_key)}
                            type="button"
                          >
                            保存 Key
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={taskUiLocked || !effectiveProfile.has_api_key}
                            onClick={() => props.onClearTaskApiKey(task.task_key)}
                            type="button"
                          >
                            清除 Key
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="text-[11px] text-subtext">
                        当前未绑定任务配置且项目主配置为空，请先绑定配置库或设置主配置。
                      </div>
                    )}
                  </div>

                  <ModuleEditor
                    moduleId={`task-${task.task_key}`}
                    title="模块参数"
                    subtitle="该任务专属模型参数。"
                    form={task.form}
                    setForm={(updater) => props.onTaskFormChange(task.task_key, updater)}
                    saving={taskUiLocked}
                    dirty={task.dirty}
                    capabilities={null}
                    modelList={task.modelList}
                    headerActions={<></>}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="surface mt-6 p-4">
        <div className="text-sm text-ink">API 配置库（后端持久化）</div>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 sm:col-span-2">
            <span className="text-xs text-subtext">选择主配置</span>
            <select
              className="select"
              name="profile_select"
              value={props.selectedProfileId ?? ""}
              disabled={props.profileBusy}
              onChange={(e) => props.onSelectProfile(e.target.value ? e.target.value : null)}
            >
              <option value="">（未绑定后端配置）</option>
              {props.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.provider}/{p.model}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 sm:col-span-1">
            <span className="text-xs text-subtext">新建配置名</span>
            <input
              className="input"
              disabled={props.profileBusy}
              name="profile_name"
              value={props.profileName}
              onChange={(e) => props.onChangeProfileName(e.target.value)}
              placeholder="例如：主网关"
            />
          </label>
        </div>

        {selectedProfile ? (
          <div className="mt-3 text-xs text-subtext">
            当前主配置：{selectedProfile.name}（{selectedProfile.provider}/{selectedProfile.model}）
          </div>
        ) : (
          <div className="mt-3 text-xs text-subtext">
            当前主配置：未绑定。任务模块若也未绑定配置库，将无法调用模型。
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn btn-secondary px-3 py-2 text-xs"
            disabled={props.profileBusy}
            onClick={props.onCreateProfile}
            type="button"
          >
            保存为新配置
          </button>
          <button
            className="btn btn-secondary px-3 py-2 text-xs"
            disabled={props.profileBusy || !props.selectedProfileId}
            onClick={props.onUpdateProfile}
            type="button"
          >
            更新当前配置
          </button>
          <button
            className="btn btn-ghost px-3 py-2 text-xs text-accent hover:bg-accent/10"
            disabled={props.profileBusy || !props.selectedProfileId}
            onClick={props.onDeleteProfile}
            type="button"
          >
            删除当前配置
          </button>
        </div>
      </div>

      <div className="surface mt-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink">API Key（后端加密）</div>
          <button
            className="btn btn-secondary px-3 py-2 text-xs"
            disabled={!props.selectedProfileId || props.profileBusy || !selectedProfile?.has_api_key}
            onClick={props.onClearApiKey}
            type="button"
          >
            清除 Key
          </button>
        </div>
        <div className="mt-2 text-xs text-subtext">
          {selectedProfile
            ? selectedProfile.has_api_key
              ? `已保存：${selectedProfile.masked_api_key ?? "（已保存）"}`
              : "未保存：请在下方输入并保存"
            : "请先选择/新建一个后端配置再保存 Key"}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className="input flex-1"
            placeholder="输入新 Key（不会回显已保存 Key）"
            name="api_key"
            type="password"
            value={props.apiKey}
            onChange={(e) => props.onChangeApiKey(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={!props.selectedProfileId || props.profileBusy || !props.apiKey.trim()}
            onClick={props.onSaveApiKey}
            type="button"
          >
            保存 Key
          </button>
        </div>
      </div>
    </section>
  );
}
