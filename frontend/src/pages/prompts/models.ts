import type { LlmForm } from "../../components/prompts/types";
import type { LLMProfile, LLMPreset, LLMProvider, LLMTaskPreset, ProjectSettings } from "../../types";

export type LlmCapabilities = {
  provider: string;
  model: string;
  max_tokens_limit: number | null;
  max_tokens_recommended: number | null;
  context_window_limit: number | null;
};

export type VectorRagForm = {
  vector_rerank_enabled: boolean;
  vector_rerank_method: string;
  vector_rerank_top_k: number;
  vector_rerank_provider: string;
  vector_rerank_base_url: string;
  vector_rerank_model: string;
  vector_rerank_timeout_seconds: number | null;
  vector_rerank_hybrid_alpha: number | null;
  vector_embedding_provider: string;
  vector_embedding_base_url: string;
  vector_embedding_model: string;
  vector_embedding_azure_deployment: string;
  vector_embedding_azure_api_version: string;
  vector_embedding_sentence_transformers_model: string;
};

export type VectorEmbeddingDryRunResult = {
  enabled: boolean;
  disabled_reason?: string | null;
  provider?: string | null;
  dims?: number | null;
  timings_ms?: { total?: number | null } | null;
  error?: string | null;
  embedding?: {
    provider?: string | null;
    base_url?: string | null;
    model?: string | null;
    has_api_key?: boolean;
    masked_api_key?: string;
  };
};

export type VectorRerankDryRunResult = {
  enabled: boolean;
  documents_count?: number;
  method?: string | null;
  top_k?: number | null;
  hybrid_alpha?: number | null;
  order?: number[];
  timings_ms?: { total?: number | null } | null;
  obs?: unknown;
  rerank?: {
    provider?: string | null;
    base_url?: string | null;
    model?: string | null;
    timeout_seconds?: number | null;
    hybrid_alpha?: number | null;
    has_api_key?: boolean;
    masked_api_key?: string;
  };
};

export const DEFAULT_VECTOR_RAG_FORM: VectorRagForm = {
  vector_rerank_enabled: false,
  vector_rerank_method: "auto",
  vector_rerank_top_k: 20,
  vector_rerank_provider: "",
  vector_rerank_base_url: "",
  vector_rerank_model: "",
  vector_rerank_timeout_seconds: null,
  vector_rerank_hybrid_alpha: null,
  vector_embedding_provider: "",
  vector_embedding_base_url: "",
  vector_embedding_model: "",
  vector_embedding_azure_deployment: "",
  vector_embedding_azure_api_version: "",
  vector_embedding_sentence_transformers_model: "",
};

export const DEFAULT_LLM_FORM: LlmForm = {
  provider: "openai",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: "0.7",
  top_p: "1",
  max_tokens: "12000",
  presence_penalty: "0",
  frequency_penalty: "0",
  top_k: "",
  stop: "",
  timeout_seconds: "180",
  reasoning_effort: "",
  text_verbosity: "",
  anthropic_thinking_enabled: false,
  anthropic_thinking_budget_tokens: "",
  gemini_thinking_budget: "",
  gemini_include_thoughts: false,
  extra: "{}",
};

export type LlmPresetPayload = {
  provider: LLMProvider;
  base_url: string | null;
  model: string;
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  presence_penalty: number | null;
  frequency_penalty: number | null;
  top_k: number | null;
  stop: string[];
  timeout_seconds: number | null;
  extra: Record<string, unknown>;
};

export type TaskOverridePayload = {
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  presence_penalty: number | null;
  frequency_penalty: number | null;
  top_k: number | null;
  stop: string[];
  timeout_seconds: number | null;
  extra: Record<string, unknown>;
};

type BuildPayloadResult = { ok: true; payload: LlmPresetPayload } | { ok: false; message: string };

type LoadedVectorFormState = {
  vectorForm: VectorRagForm;
  vectorRerankTopKDraft: string;
  vectorRerankTimeoutDraft: string;
  vectorRerankHybridAlphaDraft: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function objectHasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function parsePositiveIntDraft(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function parseNumber(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseStopList(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseTimeoutSecondsForTest(value: string): number {
  const n = parseNumber(value);
  const i = Math.trunc(n ?? 180);
  if (i < 1) return 1;
  if (i > 1800) return 1800;
  return i;
}

export function parseTimeoutSecondsForPreset(value: string): number | null {
  const n = parseNumber(value);
  if (n === null) return null;
  const i = Math.trunc(n);
  if (i < 1) return 1;
  if (i > 1800) return 1800;
  return i;
}

function mergeManagedAdvancedExtra(form: LlmForm, extraBase: Record<string, unknown>): BuildPayloadResult {
  const extra = cloneJsonObject(extraBase);
  const provider = form.provider.trim();

  delete extra.reasoning_effort;
  delete extra.reasoningEffort;
  delete extra.verbosity;
  delete extra.text_verbosity;
  delete extra.textVerbosity;

  const responsesProvider = provider === "openai_responses" || provider === "openai_responses_compatible";
  const reasoningEffort = form.reasoning_effort.trim();
  if (responsesProvider) {
    const reasoningRaw = extra.reasoning;
    const reasoning = isRecord(reasoningRaw) ? cloneJsonObject(reasoningRaw) : {};
    delete reasoning.effort;
    if (reasoningEffort) reasoning.effort = reasoningEffort;
    if (objectHasKeys(reasoning)) extra.reasoning = reasoning;
    else delete extra.reasoning;

    const textRaw = extra.text;
    const text = isRecord(textRaw) ? cloneJsonObject(textRaw) : {};
    delete text.verbosity;
    const verbosity = form.text_verbosity.trim();
    if (verbosity) text.verbosity = verbosity;
    if (objectHasKeys(text)) extra.text = text;
    else delete extra.text;
  } else {
    delete extra.reasoning;
    if (reasoningEffort) extra.reasoning_effort = reasoningEffort;
    delete extra.text;
  }

  if (provider === "anthropic") {
    if (form.anthropic_thinking_enabled) {
      const budget = parsePositiveIntDraft(form.anthropic_thinking_budget_tokens);
      if (budget === null) {
        return { ok: false, message: "Anthropic thinking budget_tokens 必须是正整数" };
      }
      extra.thinking = { type: "enabled", budget_tokens: budget };
    } else {
      delete extra.thinking;
    }
  } else {
    delete extra.thinking;
  }

  if (provider === "gemini") {
    const thinkingRaw = extra.thinkingConfig;
    const thinking = isRecord(thinkingRaw) ? cloneJsonObject(thinkingRaw) : {};
    delete thinking.thinkingBudget;
    delete thinking.includeThoughts;
    const budget = parsePositiveIntDraft(form.gemini_thinking_budget);
    if (form.gemini_thinking_budget.trim() && budget === null) {
      return { ok: false, message: "Gemini thinkingBudget 必须是正整数" };
    }
    if (budget !== null) thinking.thinkingBudget = budget;
    if (form.gemini_include_thoughts) thinking.includeThoughts = true;
    if (objectHasKeys(thinking)) extra.thinkingConfig = thinking;
    else delete extra.thinkingConfig;
    delete extra.thinking_config;
  } else {
    delete extra.thinkingConfig;
    delete extra.thinking_config;
  }

  return {
    ok: true,
    payload: {
      provider,
      base_url: form.base_url.trim() || null,
      model: form.model.trim(),
      temperature: parseNumber(form.temperature),
      top_p: parseNumber(form.top_p),
      max_tokens: parseNumber(form.max_tokens),
      presence_penalty: parseNumber(form.presence_penalty),
      frequency_penalty: parseNumber(form.frequency_penalty),
      top_k: parseNumber(form.top_k),
      stop: parseStopList(form.stop),
      timeout_seconds: parseTimeoutSecondsForPreset(form.timeout_seconds),
      extra,
    },
  };
}

export function buildPresetPayload(form: LlmForm): BuildPayloadResult {
  const provider = form.provider.trim();
  if (!provider) return { ok: false, message: "服务商（provider）不能为空" };
  const model = form.model.trim();
  if (!model) return { ok: false, message: "模型（model）不能为空" };

  const parsed = (() => {
    try {
      return JSON.parse(form.extra || "{}") as unknown;
    } catch {
      return null;
    }
  })();
  if (!isRecord(parsed)) return { ok: false, message: "extra 必须是合法 JSON object" };
  return mergeManagedAdvancedExtra(form, parsed);
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pickNumberString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function formFromPreset(preset: LLMPreset | LLMTaskPreset): LlmForm {
  const extra = isRecord(preset.extra) ? preset.extra : {};
  const reasoning = isRecord(extra.reasoning) ? extra.reasoning : {};
  const text = isRecord(extra.text) ? extra.text : {};
  const thinking = isRecord(extra.thinking) ? extra.thinking : {};
  const thinkingConfig = isRecord(extra.thinkingConfig)
    ? extra.thinkingConfig
    : isRecord(extra.thinking_config)
      ? extra.thinking_config
      : {};

  const responsesProvider = preset.provider === "openai_responses" || preset.provider === "openai_responses_compatible";
  const reasoningEffort = responsesProvider
    ? pickString(reasoning.effort)
    : pickString(extra.reasoning_effort) || pickString(extra.reasoningEffort);
  const textVerbosity = responsesProvider ? pickString(text.verbosity) : "";
  const anthropicThinkingBudget = pickNumberString(thinking.budget_tokens);
  const geminiThinkingBudget = pickNumberString(thinkingConfig.thinkingBudget);

  return {
    provider: preset.provider,
    base_url: preset.base_url ?? "",
    model: preset.model ?? "",
    temperature: preset.temperature?.toString() ?? "",
    top_p: preset.top_p?.toString() ?? "",
    max_tokens: preset.max_tokens?.toString() ?? "",
    presence_penalty: preset.presence_penalty?.toString() ?? "",
    frequency_penalty: preset.frequency_penalty?.toString() ?? "",
    top_k: preset.top_k?.toString() ?? "",
    stop: (preset.stop ?? []).join(", "),
    timeout_seconds: preset.timeout_seconds?.toString() ?? "",
    reasoning_effort: reasoningEffort,
    text_verbosity: textVerbosity,
    anthropic_thinking_enabled: pickString(thinking.type) === "enabled" || Boolean(anthropicThinkingBudget),
    anthropic_thinking_budget_tokens: anthropicThinkingBudget,
    gemini_thinking_budget: geminiThinkingBudget,
    gemini_include_thoughts: Boolean(thinkingConfig.includeThoughts),
    extra: JSON.stringify(extra, null, 2),
  };
}

export function formFromProfile(profile: LLMProfile): LlmForm {
  const syntheticPreset: LLMPreset = {
    project_id: "",
    provider: profile.provider,
    base_url: profile.base_url ?? "",
    model: profile.model,
    temperature: profile.temperature ?? null,
    top_p: profile.top_p ?? null,
    max_tokens: profile.max_tokens ?? null,
    presence_penalty: profile.presence_penalty ?? null,
    frequency_penalty: profile.frequency_penalty ?? null,
    top_k: profile.top_k ?? null,
    stop: profile.stop ?? [],
    timeout_seconds: profile.timeout_seconds ?? null,
    extra: profile.extra ?? {},
  };
  return formFromPreset(syntheticPreset);
}

export function payloadFromProfile(profile: LLMProfile): LlmPresetPayload {
  const syntheticPreset: LLMPreset = {
    project_id: "",
    provider: profile.provider,
    base_url: profile.base_url ?? "",
    model: profile.model,
    temperature: profile.temperature ?? null,
    top_p: profile.top_p ?? null,
    max_tokens: profile.max_tokens ?? null,
    presence_penalty: profile.presence_penalty ?? null,
    frequency_penalty: profile.frequency_penalty ?? null,
    top_k: profile.top_k ?? null,
    stop: profile.stop ?? [],
    timeout_seconds: profile.timeout_seconds ?? null,
    extra: profile.extra ?? {},
  };
  return payloadFromPreset(syntheticPreset);
}

export function payloadFromPreset(preset: LLMPreset | LLMTaskPreset): LlmPresetPayload {
  const form = formFromPreset(preset);
  const result = buildPresetPayload(form);
  if (result.ok) return result.payload;
  return {
    provider: preset.provider,
    base_url: preset.base_url ?? null,
    model: preset.model,
    temperature: preset.temperature ?? null,
    top_p: preset.top_p ?? null,
    max_tokens: preset.max_tokens ?? null,
    presence_penalty: preset.presence_penalty ?? null,
    frequency_penalty: preset.frequency_penalty ?? null,
    top_k: preset.top_k ?? null,
    stop: preset.stop ?? [],
    timeout_seconds: preset.timeout_seconds ?? null,
    extra: isRecord(preset.extra) ? preset.extra : {},
  };
}

export function buildTaskOverridePayload(
  form: {
    temperature: string;
    top_p: string;
    max_tokens: string;
    presence_penalty: string;
    frequency_penalty: string;
    top_k: string;
    stop: string;
    timeout_seconds: string;
    extra: string;
  },
): { ok: true; payload: TaskOverridePayload } | { ok: false; message: string } {
  const parsed = (() => {
    try {
      return JSON.parse(form.extra || "{}") as unknown;
    } catch {
      return null;
    }
  })();
  if (!isRecord(parsed)) return { ok: false, message: "extra 必须是合法 JSON object" };

  const stop = parseStopList(form.stop);
  return {
    ok: true,
    payload: {
      temperature: parseNumber(form.temperature),
      top_p: parseNumber(form.top_p),
      max_tokens: parseNumber(form.max_tokens),
      presence_penalty: parseNumber(form.presence_penalty),
      frequency_penalty: parseNumber(form.frequency_penalty),
      top_k: parseNumber(form.top_k),
      stop,
      timeout_seconds: parseTimeoutSecondsForPreset(form.timeout_seconds),
      extra: parsed,
    },
  };
}

export function overrideFormFromPreset(preset: LLMTaskPreset): {
  temperature: string;
  top_p: string;
  max_tokens: string;
  presence_penalty: string;
  frequency_penalty: string;
  top_k: string;
  stop: string;
  timeout_seconds: string;
  extra: string;
} {
  return {
    temperature: preset.temperature?.toString() ?? "",
    top_p: preset.top_p?.toString() ?? "",
    max_tokens: preset.max_tokens?.toString() ?? "",
    presence_penalty: preset.presence_penalty?.toString() ?? "",
    frequency_penalty: preset.frequency_penalty?.toString() ?? "",
    top_k: preset.top_k?.toString() ?? "",
    stop: (preset.stop ?? []).join(", "),
    timeout_seconds: preset.timeout_seconds?.toString() ?? "",
    extra: JSON.stringify(isRecord(preset.extra) ? preset.extra : {}, null, 2),
  };
}

export function overridePayloadFromPreset(preset: LLMTaskPreset): TaskOverridePayload {
  const extra = isRecord(preset.extra) ? preset.extra : {};
  const stop = preset.stop ?? [];
  return {
    temperature: preset.temperature ?? null,
    top_p: preset.top_p ?? null,
    max_tokens: preset.max_tokens ?? null,
    presence_penalty: preset.presence_penalty ?? null,
    frequency_penalty: preset.frequency_penalty ?? null,
    top_k: preset.top_k ?? null,
    stop,
    timeout_seconds: preset.timeout_seconds ?? null,
    extra,
  };
}

export function payloadEquals(left: LlmPresetPayload, right: LlmPresetPayload): boolean {
  return stableJson(left) === stableJson(right);
}

export function overridePayloadEquals(left: TaskOverridePayload, right: TaskOverridePayload): boolean {
  return stableJson(left) === stableJson(right);
}

export function mapVectorFormFromSettings(settings: ProjectSettings): LoadedVectorFormState {
  const rerankTopK = Number(settings.vector_rerank_effective_top_k ?? 20) || 20;
  return {
    vectorForm: {
      vector_rerank_enabled: Boolean(settings.vector_rerank_effective_enabled),
      vector_rerank_method: String(settings.vector_rerank_effective_method ?? "auto") || "auto",
      vector_rerank_top_k: rerankTopK,
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
    },
    vectorRerankTopKDraft: String(rerankTopK),
    vectorRerankTimeoutDraft:
      settings.vector_rerank_timeout_seconds != null ? String(settings.vector_rerank_timeout_seconds) : "",
    vectorRerankHybridAlphaDraft:
      settings.vector_rerank_hybrid_alpha != null ? String(settings.vector_rerank_hybrid_alpha) : "",
  };
}
