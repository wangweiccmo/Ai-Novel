export type LLMProvider =
  | "openai"
  | "openai_responses"
  | "openai_compatible"
  | "openai_responses_compatible"
  | "anthropic"
  | "gemini"
  | "deepseek";

export type ChapterStatus = "planned" | "drafting" | "proofreading" | "done";

export interface Project {
  id: string;
  owner_user_id: string;
  active_outline_id?: string | null;
  llm_profile_id?: string | null;
  name: string;
  genre?: string | null;
  logline?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectSettings {
  project_id: string;
  world_setting: string;
  style_guide: string;
  constraints: string;
  context_optimizer_enabled: boolean;

  auto_update_worldbook_enabled: boolean;
  auto_update_characters_enabled: boolean;
  auto_update_story_memory_enabled: boolean;
  auto_update_graph_enabled: boolean;
  auto_update_vector_enabled: boolean;
  auto_update_search_enabled: boolean;
  auto_update_fractal_enabled: boolean;
  auto_update_tables_enabled: boolean;

  query_preprocessing?: QueryPreprocessingConfig | null;
  query_preprocessing_default?: QueryPreprocessingConfig;
  query_preprocessing_effective?: QueryPreprocessingConfig;
  query_preprocessing_effective_source?: string;

  vector_rerank_enabled: boolean | null;
  vector_rerank_method: string | null;
  vector_rerank_top_k: number | null;
  vector_rerank_provider: string;
  vector_rerank_base_url: string;
  vector_rerank_model: string;
  vector_rerank_timeout_seconds: number | null;
  vector_rerank_hybrid_alpha: number | null;
  vector_rerank_has_api_key: boolean;
  vector_rerank_masked_api_key: string;
  vector_rerank_effective_enabled: boolean;
  vector_rerank_effective_method: string;
  vector_rerank_effective_top_k: number;
  vector_rerank_effective_source: string;
  vector_rerank_effective_provider: string;
  vector_rerank_effective_base_url: string;
  vector_rerank_effective_model: string;
  vector_rerank_effective_timeout_seconds: number;
  vector_rerank_effective_hybrid_alpha: number;
  vector_rerank_effective_has_api_key: boolean;
  vector_rerank_effective_masked_api_key: string;
  vector_rerank_effective_config_source: string;

  vector_embedding_provider: string;
  vector_embedding_base_url: string;
  vector_embedding_model: string;
  vector_embedding_azure_deployment: string;
  vector_embedding_azure_api_version: string;
  vector_embedding_sentence_transformers_model: string;
  vector_embedding_has_api_key: boolean;
  vector_embedding_masked_api_key: string;
  vector_embedding_effective_provider: string;
  vector_embedding_effective_base_url: string;
  vector_embedding_effective_model: string;
  vector_embedding_effective_azure_deployment: string;
  vector_embedding_effective_azure_api_version: string;
  vector_embedding_effective_sentence_transformers_model: string;
  vector_embedding_effective_has_api_key: boolean;
  vector_embedding_effective_masked_api_key: string;
  vector_embedding_effective_disabled_reason?: string | null;
  vector_embedding_effective_source: string;
}

export interface QueryPreprocessingConfig {
  enabled: boolean;
  tags: string[];
  exclusion_rules: string[];
  index_ref_enhance: boolean;
}

export interface Character {
  id: string;
  project_id: string;
  name: string;
  role?: string | null;
  profile?: string | null;
  notes?: string | null;
  updated_at: string;
}

export interface Outline {
  id: string;
  project_id: string;
  title: string;
  content_md: string;
  structure?: unknown | null;
  created_at: string;
  updated_at: string;
}

export interface OutlineListItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  has_chapters: boolean;
}

export interface ChapterBase {
  id: string;
  project_id: string;
  outline_id: string;
  number: number;
  title?: string | null;
  status: ChapterStatus;
  updated_at: string;
}

export interface ChapterDetail extends ChapterBase {
  plan?: string | null;
  content_md?: string | null;
  summary?: string | null;
}

export type Chapter = ChapterDetail;

export interface ChapterListItem extends ChapterBase {
  has_plan: boolean;
  has_summary: boolean;
  has_content: boolean;
  word_count?: number;
  generation_count?: number;
}

export interface ChapterMetaPage {
  chapters: ChapterListItem[];
  next_cursor: number | null;
  has_more: boolean;
  returned: number;
  total: number;
}

export interface CreateChapterInput {
  number: number;
  title?: string | null;
  plan?: string | null;
  status?: ChapterStatus;
}

export interface UpdateChapterInput {
  title?: string | null;
  plan?: string | null;
  content_md?: string | null;
  summary?: string | null;
  status?: ChapterStatus;
}

export interface BulkCreateChapterInput {
  chapters: Array<{
    number: number;
    title?: string | null;
    plan?: string | null;
  }>;
}

export interface PromptPreset {
  id: string;
  project_id: string;
  name: string;
  category?: string | null;
  scope: string;
  version: number;
  active_for: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PromptPresetVersion {
  id: string;
  project_id: string;
  preset_id: string;
  actor_user_id?: string | null;
  version: number;
  preset_version: number;
  note?: string | null;
  created_at?: string | null;
}

export interface PromptBlock {
  id: string;
  preset_id: string;
  identifier: string;
  name: string;
  role: string;
  enabled: boolean;
  template?: string | null;
  marker_key?: string | null;
  injection_position: string;
  injection_depth?: number | null;
  injection_order: number;
  triggers: string[];
  forbid_overrides: boolean;
  budget: Record<string, unknown>;
  cache: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PromptPreviewBlock {
  id: string;
  identifier: string;
  role: string;
  enabled: boolean;
  text: string;
  missing: string[];
  token_estimate?: number;
}

export interface PromptPreview {
  preset_id: string;
  task: string;
  system: string;
  user: string;
  prompt_tokens_estimate?: number;
  prompt_budget_tokens?: number | null;
  missing: string[];
  blocks: PromptPreviewBlock[];
}

export interface LLMPreset {
  project_id: string;
  provider: LLMProvider;
  base_url?: string | null;
  model: string;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  max_tokens_limit?: number | null;
  max_tokens_recommended?: number | null;
  context_window_limit?: number | null;
  pricing?: {
    input_per_million?: number | null;
    output_per_million?: number | null;
    currency?: string;
    source?: string;
  };
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  top_k?: number | null;
  stop: string[];
  timeout_seconds?: number | null;
  extra: Record<string, unknown>;
}

export interface LLMProfile {
  id: string;
  owner_user_id: string;
  name: string;
  provider: LLMProvider;
  base_url?: string | null;
  model: string;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  top_k?: number | null;
  stop?: string[];
  timeout_seconds?: number | null;
  extra?: Record<string, unknown>;
  has_api_key: boolean;
  masked_api_key?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LLMTaskCatalogItem {
  key: string;
  label: string;
  group: string;
  description: string;
  recommended_provider?: LLMProvider | null;
  recommended_model?: string | null;
  recommended_note?: string | null;
  cost_tier?: string | null;
}

export interface LLMTaskPreset extends LLMPreset {
  task_key: string;
  llm_profile_id?: string | null;
  source?: string;
  pricing?: {
    input_per_million?: number | null;
    output_per_million?: number | null;
    currency?: string;
    source?: string;
  };
}

export interface LLMModelItem {
  id: string;
  display_name?: string;
  provider: LLMProvider;
  name?: string;
}

export interface LLMModelsWarning {
  code: string;
  message: string;
}

export interface LLMModelsResponse {
  provider: LLMProvider;
  base_url: string;
  models: LLMModelItem[];
  warning?: LLMModelsWarning | null;
}

export interface ProjectSummaryItem {
  project: Project;
  settings: ProjectSettings | null;
  characters_count: number;
  outline_content_md: string;
  outline_content_len?: number;
  outline_content_truncated?: boolean;
  chapters_total: number;
  chapters_done: number;
  llm_preset: { provider: LLMProvider; model: string } | null;
  llm_profile_has_api_key: boolean;
}
