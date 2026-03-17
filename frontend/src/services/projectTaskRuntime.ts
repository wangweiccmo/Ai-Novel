import type { BatchGenerationTask, BatchGenerationTaskItem } from "../components/writing/types";
import { apiJson } from "./apiClient";
import type { ProjectTask } from "./worldbookApi";

export type RuntimePayloadRecord = Record<string, unknown>;

export type ProjectTaskRuntimeEvent = {
  seq: number;
  event_type: string;
  created_at?: string | null;
  source?: string | null;
  reason?: string | null;
  checkpoint?: RuntimePayloadRecord | null;
  step?: RuntimePayloadRecord | null;
  error?: RuntimePayloadRecord | null;
  result?: unknown;
};

export type ProjectTaskRuntimeCheckpoint = {
  seq: number;
  created_at?: string | null;
  reason?: string | null;
  checkpoint: RuntimePayloadRecord;
};

export type ProjectTaskRuntimeStep = {
  item_id?: string | null;
  chapter_id?: string | null;
  chapter_number?: number | null;
  status?: string | null;
  attempt_count?: number | null;
  generation_run_id?: string | null;
  request_id?: string | null;
  error_message?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  last_event_type?: string | null;
  last_event_seq?: number | null;
  timeline?: ProjectTaskRuntimeEvent[];
  error?: RuntimePayloadRecord | null;
};

export type ProjectTaskRuntimeArtifact = {
  kind: string;
  id: string;
  chapter_id?: string | null;
  chapter_number?: number | null;
  request_id?: string | null;
  event_seq?: number | null;
};

export type ProjectTaskRuntimeBatch = {
  task: BatchGenerationTask;
  items: BatchGenerationTaskItem[];
};

export type ProjectTaskRuntime = {
  run: ProjectTask;
  timeline: ProjectTaskRuntimeEvent[];
  checkpoints: ProjectTaskRuntimeCheckpoint[];
  steps: ProjectTaskRuntimeStep[];
  artifacts: ProjectTaskRuntimeArtifact[];
  batch: ProjectTaskRuntimeBatch | null;
};

export type ActiveBatchGenerationPayload = {
  task: BatchGenerationTask | null;
  items: BatchGenerationTaskItem[];
};

export async function getProjectTaskRuntime(taskId: string): Promise<ProjectTaskRuntime> {
  const res = await apiJson<ProjectTaskRuntime>(`/api/tasks/${encodeURIComponent(taskId)}/runtime`);
  return res.data;
}

export async function getActiveBatchGenerationTask(projectId: string): Promise<ActiveBatchGenerationPayload> {
  const res = await apiJson<ActiveBatchGenerationPayload>(
    `/api/projects/${encodeURIComponent(projectId)}/batch_generation_tasks/active`,
  );
  return res.data;
}

export async function getBatchGenerationTask(taskId: string): Promise<ActiveBatchGenerationPayload> {
  const res = await apiJson<ActiveBatchGenerationPayload>(`/api/batch_generation_tasks/${encodeURIComponent(taskId)}`);
  return res.data;
}

export async function markBatchGenerationItemApplied(generationRunId: string): Promise<BatchGenerationTaskItem> {
  const res = await apiJson<{ item: BatchGenerationTaskItem }>(`/api/batch_generation_task_items/mark_applied`, {
    method: "POST",
    body: JSON.stringify({ generation_run_id: generationRunId }),
  });
  return res.data.item;
}

async function postBatchGenerationControl(taskId: string, action: string): Promise<void> {
  await apiJson(`/api/batch_generation_tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function pauseBatchGenerationTask(taskId: string): Promise<void> {
  await postBatchGenerationControl(taskId, "pause");
}

export async function resumeBatchGenerationTask(taskId: string): Promise<void> {
  await postBatchGenerationControl(taskId, "resume");
}

export async function retryFailedBatchGenerationTask(taskId: string): Promise<void> {
  await postBatchGenerationControl(taskId, "retry_failed");
}

export async function skipFailedBatchGenerationTask(taskId: string): Promise<void> {
  await postBatchGenerationControl(taskId, "skip_failed");
}

export async function cancelBatchGenerationTask(taskId: string): Promise<void> {
  await postBatchGenerationControl(taskId, "cancel");
}

export function isBatchGenerationProjectTaskKind(kind: string | null | undefined): boolean {
  return String(kind || "").trim() === "batch_generation_orchestrator";
}

export function isBatchGenerationTaskStatusActive(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

export function isBatchGenerationTaskStatusRecoverable(status: string | null | undefined): boolean {
  return status === "queued" || status === "running" || status === "paused";
}

export function hasFailedBatchGenerationItems(items: BatchGenerationTaskItem[] | null | undefined): boolean {
  return Boolean(items?.some((item) => item.status === "failed"));
}

export function getLatestRuntimeCheckpoint(
  runtime: ProjectTaskRuntime | null | undefined,
): RuntimePayloadRecord | null {
  return (runtime?.checkpoints.at(-1)?.checkpoint as RuntimePayloadRecord | undefined) ?? null;
}
