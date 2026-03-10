import { getLatestRuntimeCheckpoint, type ProjectTaskRuntime } from "../../services/projectTaskRuntime";
import { StatusBadge } from "./StatusBadge";

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback = "-"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function ProjectTaskRuntimePanel(props: {
  runtime: ProjectTaskRuntime | null;
  loading: boolean;
  actionLoading: boolean;
  onRefresh: () => void;
  onPauseBatch: () => void;
  onResumeBatch: () => void;
  onRetryFailedBatch: () => void;
  onSkipFailedBatch: () => void;
  onCancelBatch: () => void;
}) {
  const batch = props.runtime?.batch ?? null;
  const batchItems = batch?.items ?? [];
  const failedItems = batchItems.filter((item) => item.status === "failed");
  const latestCheckpoint = getLatestRuntimeCheckpoint(props.runtime);
  const canPause = Boolean(batch && (batch.task.status === "queued" || batch.task.status === "running"));
  const canResume = Boolean(batch && batch.task.status === "paused" && failedItems.length === 0);
  const canRetryFailed = Boolean(batch && batch.task.status === "paused" && failedItems.length > 0);
  const canSkipFailed = Boolean(batch && batch.task.status === "paused" && failedItems.length > 0);
  const canCancel = Boolean(
    batch && (batch.task.status === "queued" || batch.task.status === "running" || batch.task.status === "paused"),
  );

  return (
    <>
      <section
        className="rounded-atelier border border-border bg-surface p-3"
        aria-label="projecttask_runtime_overview"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-ink">运行态</div>
          <button
            className="btn btn-secondary btn-sm"
            aria-label="Refresh runtime detail (taskcenter_projecttask_runtime_refresh)"
            onClick={props.onRefresh}
            type="button"
          >
            刷新运行态
          </button>
        </div>
        {props.loading ? <div className="mt-2 text-xs text-subtext">加载中...</div> : null}
        {!props.loading && !props.runtime ? (
          <div className="mt-2 text-xs text-subtext">暂无运行态数据。</div>
        ) : null}
        {props.runtime ? (
          <div className="mt-2 grid gap-1 text-xs text-subtext">
            <div>时间线：{props.runtime.timeline.length}</div>
            <div>检查点：{props.runtime.checkpoints.length}</div>
            <div>步骤：{props.runtime.steps.length}</div>
            <div>产物：{props.runtime.artifacts.length}</div>
            {latestCheckpoint ? (
              <div>
                最近检查点：{readString(latestCheckpoint.status)} · 完成{" "}
                {readNumber(latestCheckpoint.completed_count)} · 失败 {readNumber(latestCheckpoint.failed_count)} ·
                跳过 {readNumber(latestCheckpoint.skipped_count)}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {batch ? (
        <section className="rounded-atelier border border-border bg-surface p-3" aria-label="projecttask_runtime_batch">
          <div className="text-sm text-ink">批量</div>
          <div className="mt-2 grid gap-1 text-xs text-subtext">
            <div className="flex flex-wrap items-center gap-2">
              <span>状态：</span>
              <StatusBadge status={batch.task.status} kind="task" />
            </div>
            <div>
              完成 {batch.task.completed_count}/{batch.task.total_count} · 失败 {batch.task.failed_count} · 跳过{" "}
              {batch.task.skipped_count}
            </div>
            <div>
              暂停请求：{String(batch.task.pause_requested)} · 取消请求：{String(batch.task.cancel_requested)}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canPause ? (
              <button
                className="btn btn-secondary btn-sm"
                aria-label="Pause batch (taskcenter_batch_pause)"
                disabled={props.actionLoading}
                onClick={props.onPauseBatch}
                type="button"
              >
                {props.actionLoading ? "处理中..." : "暂停"}
              </button>
            ) : null}
            {canResume ? (
              <button
                className="btn btn-secondary btn-sm"
                aria-label="Resume batch (taskcenter_batch_resume)"
                disabled={props.actionLoading}
                onClick={props.onResumeBatch}
                type="button"
              >
                {props.actionLoading ? "处理中..." : "继续"}
              </button>
            ) : null}
            {canRetryFailed ? (
              <button
                className="btn btn-secondary btn-sm"
                aria-label="Retry failed chapters (taskcenter_batch_retry_failed)"
                disabled={props.actionLoading}
                onClick={props.onRetryFailedBatch}
                type="button"
              >
                {props.actionLoading ? "处理中..." : "重试失败章节"}
              </button>
            ) : null}
            {canSkipFailed ? (
              <button
                className="btn btn-secondary btn-sm"
                aria-label="Skip failed chapters (taskcenter_batch_skip_failed)"
                disabled={props.actionLoading}
                onClick={props.onSkipFailedBatch}
                type="button"
              >
                {props.actionLoading ? "处理中..." : "跳过失败章节"}
              </button>
            ) : null}
            {canCancel ? (
              <button
                className="btn btn-secondary btn-sm"
                aria-label="Cancel batch (taskcenter_batch_cancel)"
                disabled={props.actionLoading}
                onClick={props.onCancelBatch}
                type="button"
              >
                {props.actionLoading ? "处理中..." : "取消批量"}
              </button>
            ) : null}
          </div>
          <div
            className="mt-3 max-h-64 overflow-auto rounded-atelier border border-border bg-canvas"
            aria-label="projecttask_runtime_batch_items"
          >
            {batchItems.length === 0 ? (
              <div className="p-3 text-xs text-subtext">暂无批量步骤。</div>
            ) : (
              <div className="divide-y divide-border">
                {batchItems.map((item) => (
                  <div key={item.id} className="grid gap-1 px-3 py-2 text-xs text-subtext">
                    <div className="text-ink">第 {item.chapter_number} 章</div>
                    <div>
                      {item.status} · 尝试 {item.attempt_count} 次
                      {item.last_request_id ? ` · 请求 ${item.last_request_id}` : ""}
                    </div>
                    {item.error_message ? <div className="text-danger">{item.error_message}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : null}

      {props.runtime?.artifacts.length ? (
        <section
          className="rounded-atelier border border-border bg-surface p-3"
          aria-label="projecttask_runtime_artifacts"
        >
          <div className="text-sm text-ink">产物</div>
          <div className="mt-2 grid gap-2 text-xs text-subtext">
            {props.runtime.artifacts.map((artifact) => (
              <div key={`${artifact.kind}-${artifact.id}`} className="flex flex-wrap items-center gap-2">
                <span>
                  {artifact.kind}: <span className="font-mono text-ink">{artifact.id}</span>
                </span>
                {artifact.kind === "generation_run" ? (
                  <a
                    className="btn btn-secondary btn-sm"
                    href={`/api/generation_runs/${encodeURIComponent(artifact.id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开生成记录
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {props.runtime ? (
        <section
          className="rounded-atelier border border-border bg-surface p-3"
          aria-label="projecttask_runtime_timeline"
        >
          <div className="text-sm text-ink">时间线</div>
          {props.runtime.timeline.length === 0 ? (
            <div className="mt-2 text-xs text-subtext">暂无时间线事件。</div>
          ) : (
            <div className="mt-3 max-h-72 space-y-2 overflow-auto">
              {props.runtime.timeline.map((entry) => (
                <div
                  key={`${entry.seq}-${entry.event_type}`}
                  className="rounded-atelier border border-border bg-canvas px-3 py-2 text-xs text-subtext"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-ink">
                    <span>
                      #{entry.seq} · {entry.event_type}
                    </span>
                    <span>{entry.created_at || "-"}</span>
                  </div>
                  <div className="mt-1">
                    {entry.reason ? `原因：${entry.reason}` : "原因：-"}
                    {entry.source ? ` · 来源：${entry.source}` : ""}
                  </div>
                  {entry.step && typeof entry.step === "object" ? (
                    <div className="mt-1">
                      章节 {readNumber((entry.step as Record<string, unknown>).chapter_number)} · 状态{" "}
                      {readString((entry.step as Record<string, unknown>).status)}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
