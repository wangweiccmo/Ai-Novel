import type { LLMProvider } from "../../types";

export type LlmForm = {
  provider: LLMProvider;
  base_url: string;
  model: string;
  temperature: string;
  top_p: string;
  max_tokens: string;
  presence_penalty: string;
  frequency_penalty: string;
  top_k: string;
  stop: string;
  timeout_seconds: string;
  reasoning_effort: string;
  text_verbosity: string;
  anthropic_thinking_enabled: boolean;
  anthropic_thinking_budget_tokens: string;
  gemini_thinking_budget: string;
  gemini_include_thoughts: boolean;
  extra: string;
};

export type TaskOverrideForm = {
  temperature: string;
  top_p: string;
  max_tokens: string;
  presence_penalty: string;
  frequency_penalty: string;
  top_k: string;
  stop: string;
  timeout_seconds: string;
  extra: string;
};

export type LlmTaskFormDraft = {
  task_key: string;
  module_slot_id: string | null;
  form: TaskOverrideForm;
  isNew: boolean;
};

export type LlmModelListState = {
  loading: boolean;
  options: Array<{ id: string; display_name: string }>;
  warning: string | null;
  error: string | null;
  requestId: string | null;
};
