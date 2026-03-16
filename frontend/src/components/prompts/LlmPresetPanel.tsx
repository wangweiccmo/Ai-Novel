import { useCallback, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import type { LLMProfile, LLMProvider, LLMTaskCatalogItem, ModuleSlot } from "../../types";
import { Badge, type BadgeTone } from "../ui/Badge";
import type { LlmForm, LlmModelListState, TaskOverrideForm } from "./types";

type ModuleCardView = {
  slot_id: string;
  display_name: string;
  is_main: boolean;
  profile: LLMProfile;
  form: LlmForm;
  dirty: boolean;
  saving: boolean;
  testing: boolean;
  modelList: LlmModelListState;
  apiKeyDraft: string;
  apiKeyDirty: boolean;
};

type TaskOverrideView = {
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

type Props = {
  moduleCards: ModuleCardView[];
  moduleOptions: ModuleSlot[];
  mainSlotId: string | null;
  capabilities: {
    max_tokens_limit: number | null;
    max_tokens_recommended: number | null;
    context_window_limit: number | null;
  } | null;
  onModuleNameChange: (slotId: string, value: string) => void;
  onModuleFormChange: (slotId: string, updater: (prev: LlmForm) => LlmForm) => void;
  onSaveModule: (slotId: string) => void;
  onDeleteModule: (slotId: string) => void;
  onReloadModuleModels: (slotId: string) => void;
  onTestModuleConnection: (slotId: string) => void;
  onAddModule: () => void;
  onModuleApiKeyDraftChange: (slotId: string, value: string) => void;
  onClearModuleApiKey: (slotId: string) => void;

  taskModules: TaskOverrideView[];
  taskCatalog: LLMTaskCatalogItem[];
  onAddTaskModule: (taskKey: string) => void;
  onTaskModuleChange: (taskKey: string, moduleSlotId: string | null) => void;
  onTaskFormChange: (taskKey: string, updater: (prev: TaskOverrideForm) => TaskOverrideForm) => void;
  onSaveTask: (taskKey: string) => void;
  onDeleteTask: (taskKey: string) => void;
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
  hideAdvanced?: boolean;
};

function getJsonParseErrorPosition(message: string): number | null {
  const m = message.match(/\\bposition\\s+(\\d+)\\b/i);
  if (!m) return null;
  const pos = Number(m[1]);
  return Number.isFinite(pos) ? pos : null;
}

function getLineAndColumnFromPosition(text: string, position: number): { line: number; column: number } | null {
  if (!Number.isFinite(position) || position < 0 || position > text.length) return null;
  const before = text.slice(0, position);
  const parts = before.split(/\\r?\\n/);
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

const KNOWN_PROVIDERS = [
  "openai",
  "openai_responses",
  "openai_compatible",
  "openai_responses_compatible",
  "OpenAI",
  "anthropic",
  "gemini",
  "deepseek",
] as const;

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI Chat";
  if (provider === "openai_responses") return "OpenAI Responses";
  if (provider === "openai_compatible") return "OpenAI Compatible Chat";
  if (provider === "openai_responses_compatible") return "OpenAI Compatible Responses";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "gemini") return "Gemini";
  if (provider === "deepseek") return "DeepSeek";
  return provider.trim() || "其它";
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
  const provider = task.recommended_provider ? providerLabel(String(task.recommended_provider)) : "";
  const model = String(task.recommended_model || "").trim();
  if (!provider && !model) return null;
  return [provider, model].filter(Boolean).join(" / ");
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
  const providerValue = props.form.provider.trim();
  const responsesProvider = providerValue === "openai_responses" || providerValue === "openai_responses_compatible";
  const isKnownProvider = KNOWN_PROVIDERS.includes(providerValue as (typeof KNOWN_PROVIDERS)[number]);
  const providerSelectValue = isKnownProvider ? providerValue : "other";
  const customProviderValue = isKnownProvider ? "" : providerValue;

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
            value={providerSelectValue}
            disabled={props.saving}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "other") {
                props.setForm((v) => ({
                  ...v,
                  provider: KNOWN_PROVIDERS.includes(v.provider as (typeof KNOWN_PROVIDERS)[number]) ? "" : v.provider,
                  max_tokens: "",
                  text_verbosity: "",
                  reasoning_effort: "",
                  anthropic_thinking_enabled: false,
                  anthropic_thinking_budget_tokens: "",
                  gemini_thinking_budget: "",
                  gemini_include_thoughts: false,
                }));
                return;
              }
              props.setForm((v) => ({
                ...v,
                provider: next as LLMProvider,
                max_tokens: "",
                text_verbosity: "",
                reasoning_effort: "",
                anthropic_thinking_enabled: false,
                anthropic_thinking_budget_tokens: "",
                gemini_thinking_budget: "",
                gemini_include_thoughts: false,
              }));
            }}
          >
            <option value="openai">openai（官方）</option>
            <option value="openai_responses">openai_responses（官方 /v1/responses）</option>
            <option value="openai_compatible">openai_compatible（中转/本地）</option>
            <option value="openai_responses_compatible">openai_responses_compatible（中转 /v1/responses）</option>
            <option value="OpenAI">GGBOOM公益站</option>
            <option value="anthropic">anthropic（Claude）</option>
            <option value="gemini">gemini</option>
            <option value="deepseek">deepseek（DeepSeek）</option>
            <option value="other">其它（手动输入）</option>
          </select>
          <div className="text-[11px] text-subtext">
            当前：{providerLabel(providerValue)}。兼容网关通常需要可访问的 `base_url`。
          </div>
        </label>

        {providerSelectValue === "other" && (
          <label className="grid gap-1 md:col-span-2">
            <span className="text-xs text-subtext">手动输入 provider</span>
            <input
              className="input"
              disabled={props.saving}
              placeholder="例如 openai_compatible / openai-compatible / deepseek"
              value={customProviderValue}
              onChange={(e) => props.setForm((v) => ({ ...v, provider: e.target.value }))}
            />
            <div className="text-[11px] text-subtext">请输入后端支持或可识别的 provider key。</div>
          </label>
        )}

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
            支持“下拉选择 + 手动输入”。{props.modelList.warning ? `提示：${props.modelList.warning}` : ""}
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
              providerValue === "openai_compatible" || providerValue === "openai_responses_compatible"
                ? "https://your-gateway.example.com/v1"
                : undefined
            }
            value={props.form.base_url}
            onChange={(e) => props.setForm((v) => ({ ...v, base_url: e.target.value }))}
          />
          <div className="text-[11px] text-subtext">
            OpenAI / OpenAI-compatible 一般包含 `/v1`，Anthropic/Gemini 一般为 host，DeepSeek 默认 `https://api.deepseek.com`。
          </div>
        </label>
      </div>

      <details className="mt-4 rounded-atelier border border-border/60 bg-canvas px-4 py-3" open={props.dirty} hidden={props.hideAdvanced}>
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

          {providerValue === "openai" || providerValue === "openai_compatible" || providerValue === "deepseek" ? (
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

          {(providerValue === "openai" || providerValue === "openai_compatible" || responsesProvider) && (
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

          {providerValue === "anthropic" && (
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

          {providerValue === "gemini" && (
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

function TaskOverrideEditor(props: {
  form: TaskOverrideForm;
  disabled: boolean;
  onChange: (updater: (prev: TaskOverrideForm) => TaskOverrideForm) => void;
}) {
  const extraValidation = useMemo(() => validateExtraJson(props.form.extra), [props.form.extra]);
  const extraErrorText = extraValidation.ok
    ? ""
    : `extra JSON 无效${extraValidation.line ? `（第 ${extraValidation.line} 行，第 ${extraValidation.column ?? 1} 列）` : ""}：${extraValidation.message}`;
  const onFormatExtra = useCallback(() => {
    const parsed = validateExtraJson(props.form.extra);
    if (!parsed.ok) return;
    props.onChange((v) => ({
      ...v,
      extra: JSON.stringify(parsed.value, null, 2),
    }));
  }, [props]);

  return (
    <details className="rounded-atelier border border-border/50 bg-surface/40 px-4 py-3">
      <summary className="cursor-pointer select-none text-sm font-medium text-ink">微调参数（留空 = 使用模块默认值）</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <label className="grid gap-1">
          <span className="text-xs text-subtext">temperature</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.temperature}
            onChange={(e) => props.onChange((v) => ({ ...v, temperature: e.target.value }))}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-subtext">top_p</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.top_p}
            onChange={(e) => props.onChange((v) => ({ ...v, top_p: e.target.value }))}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-subtext">max_tokens</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.max_tokens}
            onChange={(e) => props.onChange((v) => ({ ...v, max_tokens: e.target.value }))}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-subtext">presence_penalty</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.presence_penalty}
            onChange={(e) => props.onChange((v) => ({ ...v, presence_penalty: e.target.value }))}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-subtext">frequency_penalty</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.frequency_penalty}
            onChange={(e) => props.onChange((v) => ({ ...v, frequency_penalty: e.target.value }))}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-subtext">top_k</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.top_k}
            onChange={(e) => props.onChange((v) => ({ ...v, top_k: e.target.value }))}
          />
        </label>

        <label className="grid gap-1 md:col-span-2">
          <span className="text-xs text-subtext">stop（逗号分隔）</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.stop}
            onChange={(e) => props.onChange((v) => ({ ...v, stop: e.target.value }))}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-subtext">timeout_seconds</span>
          <input
            className="input"
            disabled={props.disabled}
            value={props.form.timeout_seconds}
            onChange={(e) => props.onChange((v) => ({ ...v, timeout_seconds: e.target.value }))}
          />
        </label>

        <label className="grid gap-1 md:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-subtext">extra（JSON，高级扩展）</span>
            <button
              className="btn btn-secondary btn-sm"
              disabled={props.disabled || !extraValidation.ok}
              onClick={onFormatExtra}
              type="button"
            >
              一键格式化
            </button>
          </div>
          <textarea
            className="textarea atelier-mono"
            rows={5}
            disabled={props.disabled}
            value={props.form.extra}
            onChange={(e) => props.onChange((v) => ({ ...v, extra: e.target.value }))}
          />
          {extraErrorText ? <div className="text-xs text-warning">{extraErrorText}</div> : null}
        </label>
      </div>
    </details>
  );
}

export function LlmPresetPanel(props: Props) {
  const [advancedMode, setAdvancedMode] = useState(() => {
    try {
      return localStorage.getItem("llm_panel_advanced") === "1";
    } catch {
      return false;
    }
  });
  const toggleAdvancedMode = useCallback(() => {
    setAdvancedMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("llm_panel_advanced", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const moduleById = useMemo(() => {
    const map = new Map<string, ModuleSlot>();
    for (const slot of props.moduleOptions) {
      map.set(slot.id, slot);
    }
    return map;
  }, [props.moduleOptions]);

  const taskModuleMap = useMemo(() => {
    const map = new Map<string, TaskOverrideView>();
    for (const tm of props.taskModules) map.set(tm.task_key, tm);
    return map;
  }, [props.taskModules]);

  const TASK_GROUP_ORDER = ["writing", "planning", "analysis", "memory"];
  const TASK_GROUP_LABELS: Record<string, string> = {
    writing: "写作流程",
    planning: "规划",
    analysis: "分析",
    memory: "记忆后台",
  };

  const groupedCatalog = useMemo(() => {
    const groups: { key: string; label: string; items: LLMTaskCatalogItem[]; overriddenCount: number }[] = [];
    const byGroup = new Map<string, LLMTaskCatalogItem[]>();
    for (const item of props.taskCatalog) {
      const g = item.group || "other";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(item);
    }
    for (const gKey of TASK_GROUP_ORDER) {
      const items = byGroup.get(gKey);
      if (!items) continue;
      byGroup.delete(gKey);
      const overriddenCount = items.filter((i) => taskModuleMap.has(i.key)).length;
      groups.push({ key: gKey, label: TASK_GROUP_LABELS[gKey] ?? gKey, items, overriddenCount });
    }
    for (const [gKey, items] of byGroup) {
      const overriddenCount = items.filter((i) => taskModuleMap.has(i.key)).length;
      groups.push({ key: gKey, label: TASK_GROUP_LABELS[gKey] ?? gKey, items, overriddenCount });
    }
    return groups;
  }, [props.taskCatalog, taskModuleMap]);

  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-content text-xl text-ink">模型编排配置</div>
          <div className="mt-1 text-xs text-subtext">主模块负责默认调用；可添加多个模块分配给不同任务。</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={toggleAdvancedMode} type="button">
          {advancedMode ? "切换到简单模式" : "切换到高级模式"}
        </button>
      </div>

      <div className="mt-4 grid gap-4">
        {props.moduleCards.map((module) => {
          const moduleTitle = module.is_main ? "主模块（默认）" : module.display_name;
          const moduleSubtitle = module.is_main
            ? "所有未单独覆盖的任务都会使用这里的 provider/model/参数。"
            : "自定义模块可绑定到特定任务。";
          const moduleCaps = module.is_main ? props.capabilities : null;
          const profileHasKey = module.profile.has_api_key;
          const hasDraftKey = Boolean(module.apiKeyDraft.trim());
          const maskedKey = module.profile.masked_api_key ?? "已保存";
          const keyStatus = module.apiKeyDirty ? "已输入（未保存）" : profileHasKey ? `已保存 ${maskedKey}` : "未保存";
          return (
            <section key={module.slot_id} className="rounded-atelier border border-border/70 bg-canvas p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={module.is_main ? "accent" : "neutral"}>{module.is_main ? "主模块" : "自定义"}</Badge>
                  <input
                    className="input h-8 min-w-[220px]"
                    disabled={module.is_main || module.saving}
                    value={module.display_name}
                    onChange={(e) => props.onModuleNameChange(module.slot_id, e.target.value)}
                  />
                  {module.dirty && (
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">未保存</span>
                  )}
                </div>
                {!module.is_main && (
                  <button
                    className="btn btn-ghost btn-sm text-accent hover:bg-accent/10"
                    disabled={module.saving}
                    onClick={() => props.onDeleteModule(module.slot_id)}
                    type="button"
                  >
                    删除
                  </button>
                )}
              </div>

              <ModuleEditor
                moduleId={module.slot_id}
                legacyMainFieldNames={module.is_main}
                title={moduleTitle}
                subtitle={moduleSubtitle}
                form={module.form}
                setForm={(updater) => props.onModuleFormChange(module.slot_id, updater)}
                saving={module.saving}
                dirty={module.dirty}
                capabilities={moduleCaps}
                modelList={module.modelList}
                hideAdvanced={!advancedMode}
                headerActions={
                  <>
                    <button
                      className="btn btn-secondary"
                      disabled={module.modelList.loading || module.saving}
                      onClick={() => props.onReloadModuleModels(module.slot_id)}
                      type="button"
                    >
                      {module.modelList.loading ? "拉取中..." : "拉取模型列表"}
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={module.testing || module.saving || (!profileHasKey && !hasDraftKey)}
                      onClick={() => props.onTestModuleConnection(module.slot_id)}
                      type="button"
                    >
                      {module.testing ? "测试中..." : "测试连接"}
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!module.dirty || module.saving}
                      onClick={() => props.onSaveModule(module.slot_id)}
                      type="button"
                    >
                      保存模块
                    </button>
                  </>
                }
              />

              <div className="mt-4 rounded-atelier border border-border/60 bg-surface/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-ink">API Key（后端加密）</div>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={module.saving || !profileHasKey}
                    onClick={() => props.onClearModuleApiKey(module.slot_id)}
                    type="button"
                  >
                    清除 Key
                  </button>
                </div>
                <div className="mt-2 text-xs text-subtext">{keyStatus}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    className="input flex-1 min-w-[220px]"
                    disabled={module.saving}
                    placeholder="输入 Key（保存模块时一并保存）"
                    type="text"
                    value={module.apiKeyDraft}
                    onChange={(e) => props.onModuleApiKeyDraftChange(module.slot_id, e.target.value)}
                  />
                </div>
                {!profileHasKey && !hasDraftKey && (
                  <div className="mt-2 text-[11px] text-warning">未保存 API Key，无法测试连接。</div>
                )}
              </div>
            </section>
          );
        })}

        <button className="btn btn-secondary" onClick={props.onAddModule} type="button">
          + 添加模块
        </button>
      </div>

      {!advancedMode && (
        <div className="mt-4 rounded-atelier border border-dashed border-border/50 p-3 text-xs text-subtext">
          简单模式：仅显示核心参数。切换到高级模式可管理任务覆盖和推理参数。
        </div>
      )}

      {advancedMode && (
        <div className="mt-6 rounded-atelier border border-border/70 bg-canvas p-4">
          <div className="grid gap-1">
            <div className="text-sm font-semibold text-ink">任务模块覆盖</div>
            <div className="text-xs text-subtext">每个任务可绑定上方已配置的模块，未绑定则使用主模块。</div>
          </div>

          {groupedCatalog.length === 0 ? (
            <div className="mt-4 rounded-atelier border border-dashed border-border p-4 text-xs text-subtext">
              暂无任务目录。
            </div>
          ) : (
            <div className="mt-4 grid gap-3">
              {groupedCatalog.map((group) => {
                const hasOverrides = group.overriddenCount > 0;
                return (
                  <details key={group.key} className="rounded-atelier border border-border/50" open={group.key === "writing" || hasOverrides}>
                    <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-ink hover:bg-surface/50">
                      {group.label}
                      <span className="ml-2 text-xs text-subtext">
                        {group.items.length} 个任务，{group.overriddenCount} 个已覆盖
                      </span>
                    </summary>
                    <div className="grid gap-2 px-3 pb-3">
                      {group.items.map((catalogItem) => {
                        const task = taskModuleMap.get(catalogItem.key);
                        if (!task) {
                          return (
                            <div key={catalogItem.key} className="flex items-center justify-between rounded-atelier border border-dashed border-border/50 px-3 py-2">
                              <div className="grid gap-0.5">
                                <span className="text-sm text-subtext">{catalogItem.label}</span>
                                <span className="text-[11px] text-subtext">→ 使用主模块 · {catalogItem.description}</span>
                              </div>
                              <button className="btn btn-secondary btn-sm" onClick={() => props.onAddTaskModule(catalogItem.key)} type="button">
                                添加覆盖
                              </button>
                            </div>
                          );
                        }

                        const selectedSlot = task.module_slot_id ? moduleById.get(task.module_slot_id) ?? null : null;
                        const displayProvider = selectedSlot?.profile.provider ?? "";
                        const displayModel = selectedSlot?.profile.model ?? "";
                        const displayLine = displayProvider && displayModel ? `${displayProvider} / ${displayModel}` : "";
                        const costMeta = getCostTierMeta(task.cost_tier);
                        const recommendLabel = formatRecommendedLabel(task);
                        const note = String(task.recommended_note || "").trim();
                        const taskBusy = task.saving || task.deleting;
                        return (
                          <div className="rounded-atelier border border-accent/30 bg-accent/5 p-3" key={task.task_key}>
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                              <div className="grid gap-1">
                                <div className="text-sm font-semibold text-ink">{task.label}</div>
                                <div className="text-xs text-subtext">{task.description}</div>
                                {(costMeta || recommendLabel || note) && (
                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-subtext">
                                    {costMeta ? <Badge tone={costMeta.tone}>{costMeta.label}</Badge> : null}
                                    {recommendLabel ? <Badge tone="accent">推荐 {recommendLabel}</Badge> : null}
                                    {note ? <span>{note}</span> : null}
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {task.dirty && (
                                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">未保存</span>
                                )}
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={!task.dirty || taskBusy}
                                  onClick={() => props.onSaveTask(task.task_key)}
                                  type="button"
                                >
                                  {task.saving ? "保存中..." : "保存"}
                                </button>
                                <button
                                  className="btn btn-ghost btn-sm text-accent hover:bg-accent/10"
                                  disabled={taskBusy}
                                  onClick={() => props.onDeleteTask(task.task_key)}
                                  type="button"
                                >
                                  {task.deleting ? "删除中..." : "删除覆盖"}
                                </button>
                              </div>
                            </div>

                            <div className="mb-3 grid gap-2">
                              <label className="grid gap-1">
                                <span className="text-xs text-subtext">使用模块</span>
                                <select
                                  className="select"
                                  value={task.module_slot_id ?? ""}
                                  disabled={taskBusy}
                                  onChange={(e) => props.onTaskModuleChange(task.task_key, e.target.value || null)}
                                >
                                  <option value="">（请选择模块）</option>
                                  {props.moduleOptions.map((slot) => (
                                    <option key={slot.id} value={slot.id}>
                                      {slot.display_name} · {slot.profile.provider}/{slot.profile.model}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {displayLine ? (
                                <div className="text-[11px] text-subtext">当前：{displayLine}</div>
                              ) : (
                                <div className="text-[11px] text-subtext">请选择一个模块以绑定该任务。</div>
                              )}
                            </div>

                            <TaskOverrideEditor
                              form={task.form}
                              disabled={taskBusy}
                              onChange={(updater) => props.onTaskFormChange(task.task_key, updater)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
