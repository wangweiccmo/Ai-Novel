export type CreateChapterForm = {
  number: number;
  title: string;
  plan: string;
};

export type PromptOverrideMessage = {
  role: string;
  content: string;
  name?: string | null;
};

export type PromptOverride = {
  system?: string | null;
  user?: string | null;
  messages?: PromptOverrideMessage[];
};

export type GenerateForm = {
  instruction: string;
  target_word_count: number | null;
  macro_seed?: string;
  prompt_override?: PromptOverride | null;
  stream: boolean;
  plan_first: boolean;
  post_edit: boolean;
  post_edit_sanitize: boolean;
  content_optimize: boolean;
  style_id: string | null;
  memory_injection_enabled: boolean;
  memory_query_text: string;
  memory_modules: {
    worldbook: boolean;
    story_memory: boolean;
    semantic_history: boolean;
    foreshadow_open_loops: boolean;
    structured: boolean;
    tables: boolean;
    vector_rag: boolean;
    graph: boolean;
    fractal: boolean;
  };
  context: {
    include_world_setting: boolean;
    include_style_guide: boolean;
    include_constraints: boolean;
    include_outline: boolean;
    include_smart_context: boolean;
    require_sequential: boolean;
    character_ids: string[];
    previous_chapter: "none" | "summary" | "content" | "tail";
  };
};

export type MemoryContextPack = {
  worldbook: Record<string, unknown>;
  story_memory: Record<string, unknown>;
  semantic_history: Record<string, unknown>;
  foreshadow_open_loops: Record<string, unknown>;
  structured: Record<string, unknown>;
  tables: Record<string, unknown>;
  vector_rag: Record<string, unknown>;
  graph: Record<string, unknown>;
  fractal: Record<string, unknown>;
  logs: unknown[];
};

export type GenerationRun = {
  id: string;
  project_id: string;
  actor_user_id?: string | null;
  chapter_id?: string | null;
  type: string;
  provider?: string | null;
  model?: string | null;
  request_id?: string | null;
  prompt_system?: string | null;
  prompt_user?: string | null;
  params?: unknown;
  output_text?: string | null;
  error?: unknown;
  created_at: string;
};

export type BatchGenerationTaskStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "canceled";
export type BatchGenerationItemStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "skipped";

export type BatchGenerationTask = {
  id: string;
  project_id: string;
  outline_id: string;
  actor_user_id?: string | null;
  project_task_id?: string | null;
  status: BatchGenerationTaskStatus;
  total_count: number;
  completed_count: number;
  failed_count: number;
  skipped_count: number;
  cancel_requested: boolean;
  pause_requested: boolean;
  checkpoint_json?: string | null;
  error_json?: string | null;
  created_at: string;
  updated_at: string;
};

export type BatchGenerationTaskItem = {
  id: string;
  task_id: string;
  chapter_id?: string | null;
  chapter_number: number;
  status: BatchGenerationItemStatus;
  attempt_count: number;
  generation_run_id?: string | null;
  last_request_id?: string | null;
  error_message?: string | null;
  last_error_json?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type ChapterAnalysisNote = { excerpt?: string; note?: string };
export type ChapterAnalysisPlotPoint = { beat?: string; excerpt?: string };
export type ChapterAnalysisSuggestion = {
  title?: string;
  excerpt?: string;
  issue?: string;
  recommendation?: string;
  priority?: string;
};

export type ChapterAnalysis = {
  chapter_summary?: string;
  hooks?: ChapterAnalysisNote[];
  foreshadows?: ChapterAnalysisNote[];
  plot_points?: ChapterAnalysisPlotPoint[];
  suggestions?: ChapterAnalysisSuggestion[];
  overall_notes?: string;
};

export type QualityScores = {
  schema_version?: string;
  method?: string;
  word_count?: number;
  counts?: {
    hooks?: number;
    foreshadows?: number;
    plot_points?: number;
    suggestions?: number;
    summary_present?: number;
  };
  scores?: {
    overall?: number;
    coherence?: number;
    engagement?: number;
    pacing?: number;
  };
  report_md?: string;
};

export type ChapterAnalyzeResult = {
  analysis: ChapterAnalysis;
  quality_scores?: QualityScores;
  raw_output?: string;
  raw_json?: string;
  warnings?: string[];
  parse_error?: { code?: string; message?: string; hint?: string };
  finish_reason?: string;
  dropped_params?: string[];
  generation_run_id: string;
};

export type ChapterRewriteResult = {
  content_md: string;
  raw_output?: string;
  warnings?: string[];
  parse_error?: { code?: string; message?: string; hint?: string };
  finish_reason?: string;
  dropped_params?: string[];
  generation_run_id: string;
};
