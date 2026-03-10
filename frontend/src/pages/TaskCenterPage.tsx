import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { DebugDetails, DebugPageShell } from "../components/atelier/DebugPageShell";
import { Drawer } from "../components/ui/Drawer";
import { useToast } from "../components/ui/toast";
import { useProjectData } from "../hooks/useProjectData";
import { useProjectTaskEvents } from "../hooks/useProjectTaskEvents";
import { copyText } from "../lib/copyText";
import { createRequestSeqGuard } from "../lib/requestSeqGuard";
import { humanizeChangeSetStatus, humanizeTaskStatus } from "../lib/humanize";
import { ApiError, apiJson } from "../services/apiClient";
import {
  cancelBatchGenerationTask,
  getProjectTaskRuntime,
  pauseBatchGenerationTask,
  resumeBatchGenerationTask,
  retryFailedBatchGenerationTask,
  skipFailedBatchGenerationTask,
  type ProjectTaskRuntime,
} from "../services/projectTaskRuntime";
import { UI_COPY } from "../lib/uiCopy";
import { ProjectTaskRuntimePanel } from "./taskCenter/ProjectTaskRuntimePanel";
import { StatusBadge } from "./taskCenter/StatusBadge";
import {
  extractChangeSetIdFromProjectTaskResult,
  extractChangeSetStatusFromProjectTaskResult,
  extractHowToFix,
  extractRunIdFromProjectTaskError,
  extractRunIdFromProjectTaskResult,
  safeJsonStringify,
} from "./taskCenter/helpers";

type MemoryChangeSetSummary = {
  id: string;
  chapter_id?: string | null;
  request_id?: string | null;
  idempotency_key?: string | null;
  title?: string | null;
  summary_md?: string | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
};

type MemoryTaskSummary = {
  id: string;
  project_id: string;
  change_set_id: string;
  request_id?: string | null;
  actor_user_id?: string | null;
  kind: string;
  status: string;
  error_type?: string | null;
  error_message?: string | null;
  error?: unknown;
  timings?: Record<string, unknown>;
};

type ProjectTaskSummary = {
  id: string;
  project_id: string;
  actor_user_id?: string | null;
  kind: string;
  status: string;
  idempotency_key?: string | null;
  error_type?: string | null;
  error_message?: string | null;
  timings?: Record<string, unknown>;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type PagedResult<T> = { items: T[]; next_before?: string | null };

type ChangeSetApplyResult = {
  idempotent: boolean;
  change_set?: { id?: string | null; status?: string | null } | null;
  warnings?: unknown;
};

type HealthData = {
  status: string;
  version?: string;
  queue_backend?: string | null;
  effective_backend?: string | null;
  redis_ok?: boolean | null;
  rq_queue_name?: string | null;
  redis_error_type?: string | null;
  worker_hint?: string | null;
};

export function TaskCenterPage() {
  const { projectId } = useParams();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [health, setHealth] = useState<{ data: HealthData; requestId: string } | null>(null);

  const [changeSetStatus, setChangeSetStatus] = useState<string>("all");
  const [taskStatus, setTaskStatus] = useState<string>("all");
  const [projectTaskStatus, setProjectTaskStatus] = useState<string>("all");
  const [autoOpenedProjectTask, setAutoOpenedProjectTask] = useState<boolean>(false);
  const projectTaskRefreshTimerRef = useRef<number | null>(null);
  const projectTaskDetailGuardRef = useRef(createRequestSeqGuard());
  const projectTaskRuntimeGuardRef = useRef(createRequestSeqGuard());
  const [selectedProjectTaskRuntime, setSelectedProjectTaskRuntime] = useState<ProjectTaskRuntime | null>(null);
  const [projectTaskRuntimeLoading, setProjectTaskRuntimeLoading] = useState<boolean>(false);
  const [projectTaskBatchActionLoading, setProjectTaskBatchActionLoading] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    apiJson<HealthData>("/api/health")
      .then((res) => {
        if (cancelled) return;
        setHealth({ data: res.data, requestId: res.request_id });
      })
      .catch(() => {
        if (cancelled) return;
        setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadChangeSets = useCallback(
    async (id: string): Promise<PagedResult<MemoryChangeSetSummary>> => {
      const params = new URLSearchParams();
      if (changeSetStatus !== "all") params.set("status", changeSetStatus);
      params.set("limit", "50");
      const qs = params.toString();
      const res = await apiJson<PagedResult<MemoryChangeSetSummary>>(
        `/api/projects/${id}/memory_change_sets${qs ? `?${qs}` : ""}`,
      );
      return res.data;
    },
    [changeSetStatus],
  );

  const loadTasks = useCallback(
    async (id: string): Promise<PagedResult<MemoryTaskSummary>> => {
      const params = new URLSearchParams();
      if (taskStatus !== "all") params.set("status", taskStatus);
      params.set("limit", "50");
      const qs = params.toString();
      const res = await apiJson<PagedResult<MemoryTaskSummary>>(
        `/api/projects/${id}/memory_tasks${qs ? `?${qs}` : ""}`,
      );
      return res.data;
    },
    [taskStatus],
  );

  const loadProjectTasks = useCallback(
    async (id: string): Promise<PagedResult<ProjectTaskSummary>> => {
      const params = new URLSearchParams();
      if (projectTaskStatus !== "all") params.set("status", projectTaskStatus);
      params.set("limit", "50");
      const qs = params.toString();
      const res = await apiJson<PagedResult<ProjectTaskSummary>>(`/api/projects/${id}/tasks${qs ? `?${qs}` : ""}`);
      return res.data;
    },
    [projectTaskStatus],
  );

  const changeSetsQuery = useProjectData(projectId, loadChangeSets);
  const tasksQuery = useProjectData(projectId, loadTasks);
  const projectTasksQuery = useProjectData(projectId, loadProjectTasks);

  const refreshChangeSets = changeSetsQuery.refresh;
  const refreshTasks = tasksQuery.refresh;
  const refreshProjectTasks = projectTasksQuery.refresh;

  useEffect(() => {
    if (!projectId) return;
    void refreshChangeSets();
  }, [changeSetStatus, projectId, refreshChangeSets]);

  useEffect(() => {
    if (!projectId) return;
    void refreshTasks();
  }, [projectId, refreshTasks, taskStatus]);

  useEffect(() => {
    if (!projectId) return;
    void refreshProjectTasks();
  }, [projectId, projectTaskStatus, refreshProjectTasks]);

  const changeSets = useMemo(() => changeSetsQuery.data?.items ?? [], [changeSetsQuery.data?.items]);
  const tasks = useMemo(() => tasksQuery.data?.items ?? [], [tasksQuery.data?.items]);
  const projectTasks = useMemo(() => projectTasksQuery.data?.items ?? [], [projectTasksQuery.data?.items]);

  const changeSetSummary = useMemo(() => {
    const out = { all: changeSets.length, proposed: 0, applied: 0, rolled_back: 0, failed: 0, other: 0 };
    for (const it of changeSets) {
      const s = String(it.status || "").trim();
      if (s === "proposed") out.proposed += 1;
      else if (s === "applied") out.applied += 1;
      else if (s === "rolled_back") out.rolled_back += 1;
      else if (s === "failed") out.failed += 1;
      else out.other += 1;
    }
    return out;
  }, [changeSets]);

  const taskSummary = useMemo(() => {
    const out = { all: tasks.length, queued: 0, running: 0, done: 0, failed: 0, other: 0 };
    for (const it of tasks) {
      const s = String(it.status || "").trim();
      if (s === "queued") out.queued += 1;
      else if (s === "running") out.running += 1;
      else if (s === "done") out.done += 1;
      else if (s === "failed") out.failed += 1;
      else out.other += 1;
    }
    return out;
  }, [tasks]);

  const projectTaskSummary = useMemo(() => {
    const out = { all: projectTasks.length, queued: 0, running: 0, done: 0, failed: 0, other: 0 };
    for (const it of projectTasks) {
      const s = String(it.status || "").trim();
      if (s === "queued") out.queued += 1;
      else if (s === "running") out.running += 1;
      else if (s === "done" || s === "succeeded") out.done += 1;
      else if (s === "failed") out.failed += 1;
      else out.other += 1;
    }
    return out;
  }, [projectTasks]);

  const [selected, setSelected] = useState<
    | { kind: "change_set"; item: MemoryChangeSetSummary }
    | { kind: "task"; item: MemoryTaskSummary }
    | { kind: "project_task"; item: ProjectTaskSummary }
    | null
  >(null);
  const [projectTaskDetailLoading, setProjectTaskDetailLoading] = useState<boolean>(false);
  const [changeSetActionLoading, setChangeSetActionLoading] = useState<boolean>(false);

  const detailTitle = useMemo(() => {
    if (!selected) return "";
    if (selected.kind === "change_set") return "ChangeSet 详情";
    if (selected.kind === "task") return "Task 详情";
    return "ProjectTask 详情";
  }, [selected]);

  const detailHeading = useMemo(() => {
    if (!selected) return "";
    if (selected.kind === "change_set") return "变更集详情";
    if (selected.kind === "task") return "任务详情";
    return "项目任务详情";
  }, [selected]);

  const refreshAll = useCallback(() => {
    void refreshChangeSets();
    void refreshTasks();
    void refreshProjectTasks();
  }, [refreshChangeSets, refreshProjectTasks, refreshTasks]);

  const refreshSelectedProjectTask = useCallback(
    async (taskId: string, options?: { silent?: boolean; loading?: boolean }) => {
      const targetId = String(taskId || "").trim();
      if (!targetId) return;
      const seq = projectTaskDetailGuardRef.current.next();
      if (options?.loading) {
        setProjectTaskDetailLoading(true);
      }
      try {
        const res = await apiJson<ProjectTaskSummary>(`/api/tasks/${encodeURIComponent(targetId)}`);
        if (!projectTaskDetailGuardRef.current.isLatest(seq)) return;
        setSelected((prev) =>
          prev?.kind === "project_task" && prev.item.id === targetId ? { kind: "project_task", item: res.data } : prev,
        );
      } catch (e) {
        if (!projectTaskDetailGuardRef.current.isLatest(seq)) return;
        if (!options?.silent) {
          const err =
            e instanceof ApiError
              ? e
              : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
          toast.toastError(`${err.message} (${err.code})`, err.requestId);
        }
      } finally {
        if (options?.loading && projectTaskDetailGuardRef.current.isLatest(seq)) {
          setProjectTaskDetailLoading(false);
        }
      }
    },
    [toast],
  );

  const refreshSelectedProjectTaskRuntime = useCallback(
    async (taskId: string, options?: { silent?: boolean; loading?: boolean }) => {
      const targetId = String(taskId || "").trim();
      if (!targetId) return;
      const seq = projectTaskRuntimeGuardRef.current.next();
      if (options?.loading) {
        setProjectTaskRuntimeLoading(true);
      }
      try {
        const runtime = await getProjectTaskRuntime(targetId);
        if (!projectTaskRuntimeGuardRef.current.isLatest(seq)) return;
        setSelectedProjectTaskRuntime(runtime);
      } catch (e) {
        if (!projectTaskRuntimeGuardRef.current.isLatest(seq)) return;
        if (!options?.silent) {
          const err =
            e instanceof ApiError
              ? e
              : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
          toast.toastError(`${err.message} (${err.code})`, err.requestId);
        }
      } finally {
        if (options?.loading && projectTaskRuntimeGuardRef.current.isLatest(seq)) {
          setProjectTaskRuntimeLoading(false);
        }
      }
    },
    [toast],
  );

  const scheduleProjectTaskRefresh = useCallback(
    (taskId?: string | null) => {
      if (projectTaskRefreshTimerRef.current !== null) {
        window.clearTimeout(projectTaskRefreshTimerRef.current);
      }
      projectTaskRefreshTimerRef.current = window.setTimeout(() => {
        projectTaskRefreshTimerRef.current = null;
        void refreshProjectTasks();
        if (taskId && selected?.kind === "project_task" && selected.item.id === taskId) {
          void refreshSelectedProjectTask(taskId, { silent: true });
          void refreshSelectedProjectTaskRuntime(taskId, { silent: true });
        }
      }, 120);
    },
    [refreshProjectTasks, refreshSelectedProjectTask, refreshSelectedProjectTaskRuntime, selected],
  );

  useEffect(() => {
    const projectTaskDetailGuard = projectTaskDetailGuardRef.current;
    const projectTaskRuntimeGuard = projectTaskRuntimeGuardRef.current;
    return () => {
      projectTaskDetailGuard.invalidate();
      projectTaskRuntimeGuard.invalidate();
      if (projectTaskRefreshTimerRef.current !== null) {
        window.clearTimeout(projectTaskRefreshTimerRef.current);
      }
    };
  }, []);

  const projectTaskEvents = useProjectTaskEvents({
    projectId,
    enabled: Boolean(projectId),
    onSnapshot: (snapshot) => {
      if ((snapshot.active_tasks || []).length > 0) {
        scheduleProjectTaskRefresh(snapshot.active_tasks[0]?.id);
      }
    },
    onEvent: (event) => {
      scheduleProjectTaskRefresh(event.task_id);
    },
  });

  useEffect(() => {
    if (!projectId) return;
    if (projectTaskEvents.status === "open") return;
    const id = window.setInterval(() => {
      void refreshProjectTasks();
      if (selected?.kind === "project_task") {
        void refreshSelectedProjectTask(selected.item.id, { silent: true });
        void refreshSelectedProjectTaskRuntime(selected.item.id, { silent: true });
      }
    }, 8000);
    return () => window.clearInterval(id);
  }, [
    projectId,
    projectTaskEvents.status,
    refreshProjectTasks,
    refreshSelectedProjectTask,
    refreshSelectedProjectTaskRuntime,
    selected,
  ]);

  const projectTaskLiveStatusLabel = useMemo(() => {
    if (projectTaskEvents.status === "open") return "connected";
    if (projectTaskEvents.status === "connecting") return "reconnecting";
    if (projectTaskEvents.status === "error") return "fallback polling";
    return "idle";
  }, [projectTaskEvents.status]);

  const copyDebugInfo = useCallback(async () => {
    if (!selected) return;
    if (selected.kind === "change_set") {
      const it = selected.item;
      const lines = [
        "[TaskCenter][ChangeSet]",
        `id=${it.id}`,
        `status=${String(it.status || "-")} (${humanizeChangeSetStatus(String(it.status || ""))})`,
        `chapter_id=${it.chapter_id || "-"}`,
        `request_id=${it.request_id || "-"}`,
        `idempotency_key=${it.idempotency_key || "-"}`,
        `created_at=${it.created_at || "-"}`,
        `updated_at=${it.updated_at || "-"}`,
      ];
      await copyText(lines.join("\n"), { title: "Copy debug info manually" });
      return;
    }

    if (selected.kind === "task") {
      const t = selected.item;
      const lines = [
        "[TaskCenter][Task]",
        `id=${t.id}`,
        `kind=${t.kind}`,
        `status=${String(t.status || "-")} (${humanizeTaskStatus(String(t.status || ""))})`,
        `change_set_id=${t.change_set_id}`,
        `request_id=${t.request_id || "-"}`,
        `error_type=${t.error_type || "-"}`,
        `error_message=${t.error_message || "-"}`,
        `error=${safeJsonStringify(t.error ?? null)}`,
      ];
      await copyText(lines.join("\n"), { title: "Copy debug info manually" });
      return;
    }

    const pt = selected.item;
    const lines = [
      "[TaskCenter][ProjectTask]",
      `id=${pt.id}`,
      `kind=${pt.kind}`,
      `status=${String(pt.status || "-")} (${humanizeTaskStatus(String(pt.status || ""))})`,
      `idempotency_key=${pt.idempotency_key || "-"}`,
      `error_type=${pt.error_type || "-"}`,
      `error_message=${pt.error_message || "-"}`,
      `error=${safeJsonStringify(pt.error ?? null)}`,
    ];
    await copyText(lines.join("\n"), { title: "Copy debug info manually" });
  }, [selected]);

  const copyRawJson = useCallback(async () => {
    if (!selected) return;
    await copyText(safeJsonStringify(selected.item), { title: "Copy debug info manually" });
  }, [selected]);

  const selectProjectTask = useCallback(
    async (t: ProjectTaskSummary) => {
      setSelected({ kind: "project_task", item: t });
      setSelectedProjectTaskRuntime(null);
      void refreshSelectedProjectTask(t.id, { loading: true });
      void refreshSelectedProjectTaskRuntime(t.id, { loading: true });
    },
    [refreshSelectedProjectTask, refreshSelectedProjectTaskRuntime],
  );

  const retryProjectTask = useCallback(
    async (id: string) => {
      const taskId = String(id || "").trim();
      if (!taskId) return;
      try {
        const res = await apiJson<ProjectTaskSummary>(`/api/tasks/${encodeURIComponent(taskId)}/retry`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        toast.toastSuccess("已重试任务", res.request_id);
        await refreshProjectTasks();
        setSelected((prev) =>
          prev?.kind === "project_task" && prev.item.id === taskId ? { kind: "project_task", item: res.data } : prev,
        );
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      }
    },
    [refreshProjectTasks, toast],
  );

  const cancelProjectTask = useCallback(
    async (id: string) => {
      const taskId = String(id || "").trim();
      if (!taskId) return;
      if (!window.confirm("确认取消该排队中的任务？取消后将不会执行。")) return;
      try {
        const res = await apiJson<ProjectTaskSummary>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        toast.toastSuccess("已取消任务", res.request_id);
        await refreshProjectTasks();
        setSelected((prev) =>
          prev?.kind === "project_task" && prev.item.id === taskId ? { kind: "project_task", item: res.data } : prev,
        );
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      }
    },
    [refreshProjectTasks, toast],
  );

  const runSelectedBatchAction = useCallback(
    async (action: "pause" | "resume" | "retry_failed" | "skip_failed" | "cancel") => {
      if (selected?.kind !== "project_task") return;
      const batchTaskId = String(selectedProjectTaskRuntime?.batch?.task.id || "").trim();
      if (!batchTaskId) return;
      const projectTaskId = selected.item.id;
      setProjectTaskBatchActionLoading(true);
        try {
          if (action === "pause") {
            await pauseBatchGenerationTask(batchTaskId);
            toast.toastSuccess("批量已暂停。");
          } else if (action === "resume") {
            await resumeBatchGenerationTask(batchTaskId);
            toast.toastSuccess("批量已继续。");
          } else if (action === "retry_failed") {
            await retryFailedBatchGenerationTask(batchTaskId);
            toast.toastSuccess("失败章节已加入重试队列。");
          } else if (action === "skip_failed") {
            await skipFailedBatchGenerationTask(batchTaskId);
            toast.toastSuccess("失败章节已跳过。");
          } else {
            if (!window.confirm("确定取消该批量任务吗？")) return;
            await cancelBatchGenerationTask(batchTaskId);
            toast.toastSuccess("批量已取消。");
          }
        await refreshProjectTasks();
        await Promise.all([
          refreshSelectedProjectTask(projectTaskId, { silent: true }),
          refreshSelectedProjectTaskRuntime(projectTaskId, { silent: true }),
        ]);
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setProjectTaskBatchActionLoading(false);
      }
    },
    [
      refreshProjectTasks,
      refreshSelectedProjectTask,
      refreshSelectedProjectTaskRuntime,
      selected,
      selectedProjectTaskRuntime,
      toast,
    ],
  );

  const applyChangeSet = useCallback(
    async (id: string) => {
      const changeSetId = String(id || "").trim();
      if (!changeSetId) return;
      setChangeSetActionLoading(true);
      try {
        const res = await apiJson<ChangeSetApplyResult>(
          `/api/memory_change_sets/${encodeURIComponent(changeSetId)}/apply`,
          {
            method: "POST",
            body: JSON.stringify({}),
          },
        );
        toast.toastSuccess("已应用 ChangeSet", res.request_id);
        await refreshChangeSets();
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setChangeSetActionLoading(false);
      }
    },
    [refreshChangeSets, toast],
  );

  const rollbackChangeSet = useCallback(
    async (id: string) => {
      const changeSetId = String(id || "").trim();
      if (!changeSetId) return;
      setChangeSetActionLoading(true);
      try {
        const res = await apiJson<ChangeSetApplyResult>(
          `/api/memory_change_sets/${encodeURIComponent(changeSetId)}/rollback`,
          {
            method: "POST",
            body: JSON.stringify({}),
          },
        );
        toast.toastSuccess("已回滚 ChangeSet", res.request_id);
        await refreshChangeSets();
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setChangeSetActionLoading(false);
      }
    },
    [refreshChangeSets, toast],
  );

  useEffect(() => {
    if (!projectId) return;
    const targetId = String(searchParams.get("project_task_id") || "").trim();
    if (!targetId) return;
    if (autoOpenedProjectTask) return;
    setAutoOpenedProjectTask(true);
    setSelectedProjectTaskRuntime(null);
    void refreshSelectedProjectTask(targetId, { loading: true });
    void refreshSelectedProjectTaskRuntime(targetId, { loading: true });
  }, [autoOpenedProjectTask, projectId, refreshSelectedProjectTask, refreshSelectedProjectTaskRuntime, searchParams]);

  useEffect(() => {
    if (selected?.kind === "project_task") return;
    projectTaskRuntimeGuardRef.current.invalidate();
    setSelectedProjectTaskRuntime(null);
    setProjectTaskRuntimeLoading(false);
    setProjectTaskBatchActionLoading(false);
  }, [selected]);

  const selectedProjectTaskChangeSetId = useMemo(() => {
    if (selected?.kind !== "project_task") return null;
    return extractChangeSetIdFromProjectTaskResult(selected.item.result);
  }, [selected]);

  const selectedProjectTaskChangeSetStatus = useMemo(() => {
    if (selected?.kind !== "project_task") return null;
    return extractChangeSetStatusFromProjectTaskResult(selected.item.result);
  }, [selected]);

  const selectedProjectTaskRunId = useMemo(() => {
    if (selected?.kind !== "project_task") return null;
    return (
      extractRunIdFromProjectTaskError(selected.item.error) || extractRunIdFromProjectTaskResult(selected.item.result)
    );
  }, [selected]);

  const liveChangeSetStatus = useMemo(() => {
    const id = selectedProjectTaskChangeSetId;
    if (!id) return selectedProjectTaskChangeSetStatus;
    const live = changeSets.find((it) => it.id === id);
    return (live?.status ? String(live.status) : null) ?? selectedProjectTaskChangeSetStatus;
  }, [changeSets, selectedProjectTaskChangeSetId, selectedProjectTaskChangeSetStatus]);

  if (!projectId) return <div className="text-subtext">缺少 projectId</div>;

  return (
    <DebugPageShell
      title={UI_COPY.taskCenter.title}
      description={UI_COPY.taskCenter.subtitle}
      actions={
        <button className="btn btn-secondary" onClick={refreshAll} aria-label="刷新 (taskcenter_refresh)" type="button">
          刷新
        </button>
      }
    >
      {health?.data.queue_backend ? (
        <section
          className="rounded-atelier border border-border bg-surface p-3 text-[11px] text-subtext"
          aria-label="队列状态 (taskcenter_queue_status)"
        >
          <div>
            配置后端（queue_backend）：<span className="font-mono text-ink">{health.data.queue_backend}</span>
            {health.data.effective_backend ? (
              <>
                {" "}
                | 实际后端（effective_backend）：{" "}
                <span className="font-mono text-ink">{health.data.effective_backend}</span>
              </>
            ) : null}
            {health.data.queue_backend === "rq" ? (
              <>
                {" "}
                | redis_ok：<span className="font-mono text-ink">{String(health.data.redis_ok ?? "-")}</span>
                {health.data.rq_queue_name ? (
                  <>
                    {" "}
                    | queue：<span className="font-mono text-ink">{health.data.rq_queue_name}</span>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
          {health.data.effective_backend === "inline" ? (
            <div className="mt-1 text-warning">
              提示：inline 为进程内单线程 worker，任务会排队串行执行；如需并发请启动 rq+worker。
            </div>
          ) : null}
          {health.data.worker_hint ? <div className="mt-1">{health.data.worker_hint}</div> : null}
          {health.requestId ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="truncate">
                health {UI_COPY.common.requestIdLabel}: <span className="font-mono">{health.requestId}</span>
              </span>
              <button
                className="btn btn-ghost px-2 py-1 text-[11px]"
                onClick={async () => {
                  await copyText(health.requestId, { title: "复制失败：请手动复制请求 ID（request_id）" });
                }}
                type="button"
              >
                复制 health 请求 ID（request_id）
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <DebugDetails title={UI_COPY.help.title}>
        <div className="grid gap-2 text-xs text-subtext">
          <div>{UI_COPY.taskCenter.usageHint}</div>
          {projectId ? (
            <div>
              常用入口：{" "}
              <Link className="underline" to={`/projects/${projectId}/structured-memory`}>
                结构化记忆
              </Link>{" "}
              与{" "}
              <Link className="underline" to={`/projects/${projectId}/writing`}>
                写作页
              </Link>{" "}
              之间来回跳转，查看“提议→应用→回滚”的全链路。
            </div>
          ) : null}
          <div className="text-warning">{UI_COPY.taskCenter.riskHint}</div>
        </div>
      </DebugDetails>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-4" aria-label="变更集 (taskcenter_changesets_section)">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm text-ink">变更集（Change Set）</div>
              <div className="mt-1 text-xs text-subtext">按状态筛选；点击条目查看摘要与原始数据（默认折叠）</div>
              <div className="mt-1 text-[11px] text-subtext">
                状态说明：未应用=仅提议 | 已应用=已落库 | 已回滚=已撤销 | 失败=执行异常
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-subtext">
                <span>总计 {changeSetSummary.all}</span>
                <span>未应用 {changeSetSummary.proposed}</span>
                <span>已应用 {changeSetSummary.applied}</span>
                <span>已回滚 {changeSetSummary.rolled_back}</span>
                <span>失败 {changeSetSummary.failed}</span>
              </div>
            </div>
            <label className="grid gap-1">
              <span className="text-[11px] text-subtext">状态</span>
              <select
                className="select"
                aria-label="taskcenter_changeset_status"
                value={changeSetStatus}
                onChange={(e) => setChangeSetStatus(e.target.value)}
              >
                <option value="all">全部</option>
                <option value="proposed">{humanizeChangeSetStatus("proposed")}</option>
                <option value="applied">{humanizeChangeSetStatus("applied")}</option>
                <option value="rolled_back">{humanizeChangeSetStatus("rolled_back")}</option>
                <option value="failed">{humanizeChangeSetStatus("failed")}</option>
              </select>
            </label>
          </div>

          {changeSetsQuery.loading ? <div className="mt-3 text-sm text-subtext">加载中...</div> : null}
          {!changeSetsQuery.loading && changeSets.length === 0 ? (
            <div className="mt-3 text-sm text-subtext">暂无变更集</div>
          ) : null}

          <div className="mt-3 grid gap-2">
            {changeSets.map((it) => (
              <button
                key={it.id}
                className="surface surface-interactive w-full p-3 text-left"
                onClick={() => setSelected({ kind: "change_set", item: it })}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">{it.title || it.summary_md || it.id}</div>
                    <div className="mt-1 truncate text-xs text-subtext">
                      章节 ID：{it.chapter_id || "-"} | 更新时间：{it.updated_at || it.created_at || "-"}
                    </div>
                    {it.request_id ? (
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-subtext">
                        <span className="truncate">
                          {UI_COPY.common.requestIdLabel}: <span className="font-mono">{it.request_id}</span>
                        </span>
                        <button
                          className="btn btn-ghost px-2 py-1 text-[11px]"
                          onClick={async () => {
                            await copyText(it.request_id ?? "", {
                              title: "复制失败：请手动复制请求 ID（request_id）",
                            });
                          }}
                          type="button"
                        >
                          复制请求 ID（request_id）
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <StatusBadge status={it.status} kind="change_set" />
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel p-4" aria-label="任务列表 (taskcenter_tasks_section)">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm text-ink">任务（Task）</div>
              <div className="mt-1 text-xs text-subtext">失败任务会显示错误摘要与 {UI_COPY.common.requestIdLabel}</div>
              <div className="mt-1 text-[11px] text-subtext">
                状态说明：排队中→运行中→完成/失败（如失败可用 request_id 查后端日志）
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-subtext">
                <span>总计 {taskSummary.all}</span>
                <span>排队中 {taskSummary.queued}</span>
                <span>运行中 {taskSummary.running}</span>
                <span>完成 {taskSummary.done}</span>
                <span>失败 {taskSummary.failed}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <button
                className="btn btn-secondary"
                aria-label="失败任务筛选 (taskcenter_failed_only)"
                onClick={() => setTaskStatus((prev) => (prev === "failed" ? "all" : "failed"))}
                type="button"
              >
                仅看失败
              </button>
              <label className="grid gap-1">
                <span className="text-[11px] text-subtext">状态</span>
                <select
                  className="select"
                  aria-label="taskcenter_task_status"
                  value={taskStatus}
                  onChange={(e) => setTaskStatus(e.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="queued">{humanizeTaskStatus("queued")}</option>
                  <option value="running">{humanizeTaskStatus("running")}</option>
                  <option value="done">{humanizeTaskStatus("done")}</option>
                  <option value="failed">{humanizeTaskStatus("failed")}</option>
                </select>
              </label>
            </div>
          </div>

          {tasksQuery.loading ? <div className="mt-3 text-sm text-subtext">加载中...</div> : null}
          {!tasksQuery.loading && tasks.length === 0 ? <div className="mt-3 text-sm text-subtext">暂无任务</div> : null}

          <div className="mt-3 grid gap-2">
            {tasks.map((t) => (
              <button
                key={t.id}
                className="surface surface-interactive w-full p-3 text-left"
                onClick={() => setSelected({ kind: "task", item: t })}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">
                      {t.kind} <span className="text-subtext">({t.id})</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-subtext">变更集 ID：{t.change_set_id}</div>
                    {t.request_id ? (
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-subtext">
                        <span className="truncate">
                          {UI_COPY.common.requestIdLabel}: <span className="font-mono">{t.request_id}</span>
                        </span>
                        <button
                          className="btn btn-ghost px-2 py-1 text-[11px]"
                          onClick={async () => {
                            await copyText(t.request_id ?? "", {
                              title: "复制失败：请手动复制请求 ID（request_id）",
                            });
                          }}
                          type="button"
                        >
                          复制请求 ID（request_id）
                        </button>
                      </div>
                    ) : null}
                    {t.status === "failed" ? (
                      <div className="mt-1 truncate text-xs text-danger">
                        {t.error_type || "ERROR"}: {t.error_message || "未知错误"}
                      </div>
                    ) : null}
                  </div>
                  <StatusBadge status={t.status} kind="task" />
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel p-4 lg:col-span-2" aria-label="项目任务 (taskcenter_projecttasks_section)">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm text-ink">项目任务（Project Task）</div>
              <div className="mt-1 text-xs text-subtext">
                用于 worldbook/search/vector/graph 等自动化后台更新；点击条目查看详情（params/result/error 已脱敏）
              </div>
              <div className="mt-1 text-[11px] text-subtext">状态说明：排队中→运行中→完成/失败</div>
              <div className="mt-1 text-[11px] text-subtext" aria-label="taskcenter_projecttask_live_status">
                Project SSE: {projectTaskLiveStatusLabel}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-subtext">
                <span>总计 {projectTaskSummary.all}</span>
                <span>排队中 {projectTaskSummary.queued}</span>
                <span>运行中 {projectTaskSummary.running}</span>
                <span>完成 {projectTaskSummary.done}</span>
                <span>失败 {projectTaskSummary.failed}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <button
                className="btn btn-secondary"
                aria-label="项目任务仅看失败 (taskcenter_projecttask_failed_only)"
                onClick={() => setProjectTaskStatus((prev) => (prev === "failed" ? "all" : "failed"))}
                type="button"
              >
                仅看失败
              </button>
              <label className="grid gap-1">
                <span className="text-[11px] text-subtext">状态</span>
                <select
                  className="select"
                  aria-label="taskcenter_projecttask_status"
                  value={projectTaskStatus}
                  onChange={(e) => setProjectTaskStatus(e.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="queued">{humanizeTaskStatus("queued")}</option>
                  <option value="running">{humanizeTaskStatus("running")}</option>
                  <option value="done">{humanizeTaskStatus("done")}</option>
                  <option value="failed">{humanizeTaskStatus("failed")}</option>
                </select>
              </label>
            </div>
          </div>

          {projectTasksQuery.loading ? <div className="mt-3 text-sm text-subtext">加载中...</div> : null}
          {!projectTasksQuery.loading && projectTasks.length === 0 ? (
            <div className="mt-3 text-sm text-subtext">暂无项目任务</div>
          ) : null}

          <div className="mt-3 grid gap-2">
            {projectTasks.map((t) => (
              <button
                key={t.id}
                className="surface surface-interactive w-full p-3 text-left"
                onClick={() => void selectProjectTask(t)}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">
                      {t.kind} <span className="text-subtext">({t.id})</span>
                    </div>
                    {t.idempotency_key ? (
                      <div className="mt-1 truncate text-xs text-subtext">幂等键：{t.idempotency_key}</div>
                    ) : null}
                    {t.status === "failed" ? (
                      <div className="mt-1 truncate text-xs text-danger">
                        {t.error_type || "ERROR"}: {t.error_message || "未知错误"}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    {t.status === "failed" ? (
                      <button
                        className="btn btn-secondary btn-sm"
                        aria-label="项目任务重试 (taskcenter_projecttask_retry)"
                        onClick={(e) => {
                          e.stopPropagation();
                          void retryProjectTask(t.id);
                        }}
                        type="button"
                      >
                        重试
                      </button>
                    ) : null}
                    {t.status === "queued" ? (
                      <button
                        className="btn btn-secondary btn-sm"
                        aria-label="取消项目任务 (taskcenter_projecttask_cancel)"
                        onClick={(e) => {
                          e.stopPropagation();
                          void cancelProjectTask(t.id);
                        }}
                        type="button"
                      >
                        取消
                      </button>
                    ) : null}
                    <StatusBadge status={t.status} kind="task" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        ariaLabel={detailTitle}
        panelClassName="h-full w-full max-w-2xl border-l border-border bg-canvas p-6 shadow-sm"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-content text-2xl text-ink">{detailHeading || detailTitle}</div>
            {selected ? (
              <div className="mt-1 text-xs text-subtext">
                ID：{selected.item.id}{" "}
                {selected.kind === "task"
                  ? `| ${UI_COPY.common.requestIdLabel}: ${selected.item.request_id ?? "-"}`
                  : selected.kind === "project_task"
                    ? `| 幂等键：${selected.item.idempotency_key ?? "-"}`
                    : ""}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn btn-secondary"
              onClick={() => void copyDebugInfo()}
              aria-label="复制排障信息"
              type="button"
            >
              复制 Debug 信息
            </button>
            <button className="btn btn-secondary" onClick={() => setSelected(null)} type="button">
              关闭
            </button>
          </div>
        </div>

        {selected?.kind === "project_task" ? (
          <div className="mt-5 grid gap-3">
            <section className="rounded-atelier border border-border bg-surface p-3" aria-label="projecttask_overview">
              <div className="text-sm text-ink">Overview</div>
              <div className="mt-2 grid gap-1 text-xs text-subtext">
                <div>
                  Kind：<span className="font-mono text-ink">{selected.item.kind}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span>状态：</span>
                  <StatusBadge status={selected.item.status} kind="task" />
                </div>
                <div>
                  幂等键：<span className="font-mono text-ink">{selected.item.idempotency_key || "-"}</span>
                </div>
                <div>
                  created_at：
                  <span className="font-mono text-ink">
                    {String((selected.item.timings as Record<string, unknown> | null | undefined)?.created_at ?? "-")}
                  </span>
                </div>
                <div>
                  started_at：
                  <span className="font-mono text-ink">
                    {String((selected.item.timings as Record<string, unknown> | null | undefined)?.started_at ?? "-")}
                  </span>
                </div>
                <div>
                  finished_at：
                  <span className="font-mono text-ink">
                    {String((selected.item.timings as Record<string, unknown> | null | undefined)?.finished_at ?? "-")}
                  </span>
                </div>
              </div>
            </section>

            <section className="rounded-atelier border border-border bg-surface p-3" aria-label="projecttask_actions">
              <div className="text-sm text-ink">Actions</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-secondary btn-sm"
                  aria-label="刷新项目任务详情 (taskcenter_projecttask_refresh_detail)"
                  onClick={() => void selectProjectTask(selected.item)}
                  type="button"
                >
                  刷新详情
                </button>
                {selected.item.status === "failed" && !selectedProjectTaskRuntime?.batch ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    aria-label="重试项目任务 (taskcenter_projecttask_retry_detail)"
                    onClick={() => void retryProjectTask(selected.item.id)}
                    type="button"
                  >
                    重试
                  </button>
                ) : null}
                {selected.item.status === "queued" && !selectedProjectTaskRuntime?.batch ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    aria-label="取消项目任务 (taskcenter_projecttask_cancel_detail)"
                    onClick={() => void cancelProjectTask(selected.item.id)}
                    type="button"
                  >
                    取消
                  </button>
                ) : null}
              </div>
              {projectTaskDetailLoading ? <div className="mt-2 text-xs text-subtext">加载中...</div> : null}
            </section>

            <ProjectTaskRuntimePanel
              runtime={selectedProjectTaskRuntime}
              loading={projectTaskRuntimeLoading}
              actionLoading={projectTaskBatchActionLoading}
              onRefresh={() => void refreshSelectedProjectTaskRuntime(selected.item.id, { loading: true })}
              onPauseBatch={() => void runSelectedBatchAction("pause")}
              onResumeBatch={() => void runSelectedBatchAction("resume")}
              onRetryFailedBatch={() => void runSelectedBatchAction("retry_failed")}
              onSkipFailedBatch={() => void runSelectedBatchAction("skip_failed")}
              onCancelBatch={() => void runSelectedBatchAction("cancel")}
            />
            {selectedProjectTaskRunId ? (
              <section
                className="rounded-atelier border border-border bg-surface p-3"
                aria-label="projecttask_generation_run"
              >
                <div className="text-sm text-ink">GenerationRun</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtext">
                  <span>
                    run_id：<span className="font-mono text-ink">{selectedProjectTaskRunId}</span>
                  </span>
                  <button
                    className="btn btn-secondary btn-sm"
                    aria-label="复制 run_id (taskcenter_projecttask_copy_run_id)"
                    onClick={() => void copyText(selectedProjectTaskRunId, { title: "复制失败：请手动复制 run_id" })}
                    type="button"
                  >
                    复制 run_id
                  </button>
                  <a
                    className="btn btn-secondary btn-sm"
                    href={`/api/generation_runs/${encodeURIComponent(selectedProjectTaskRunId)}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="打开运行记录 (taskcenter_projecttask_open_generation_run)"
                  >
                    打开运行记录
                  </a>
                </div>
              </section>
            ) : null}

            <section className="rounded-atelier border border-border bg-surface p-3" aria-label="projecttask_error">
              <div className="text-sm text-ink">Error</div>
              {selected.item.status === "failed" ? (
                <div className="mt-2 grid gap-2 text-xs text-subtext">
                  <div className="text-danger">
                    {selected.item.error_type || "ERROR"}: {selected.item.error_message || "未知错误"}
                  </div>
                  {extractHowToFix(selected.item.error).length > 0 ? (
                    <ul className="list-disc pl-5 text-[11px] text-subtext">
                      {extractHowToFix(selected.item.error).map((it, idx) => (
                        <li key={idx}>{it}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <div className="mt-2 text-xs text-subtext">无错误信息</div>
              )}
            </section>

            {selected.item.kind === "table_ai_update" ? (
              <section
                className="rounded-atelier border border-border bg-surface p-3"
                aria-label="projecttask_changeset"
              >
                <div className="text-sm text-ink">ChangeSet</div>
                {selectedProjectTaskChangeSetId ? (
                  <div className="mt-2 grid gap-2 text-xs text-subtext">
                    <div>
                      change_set_id：<span className="font-mono text-ink">{selectedProjectTaskChangeSetId}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>状态：</span>
                      <StatusBadge status={String(liveChangeSetStatus || "unknown")} kind="change_set" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={changeSetActionLoading || liveChangeSetStatus === "applied"}
                        onClick={() => void applyChangeSet(selectedProjectTaskChangeSetId)}
                        aria-label="应用变更集 (taskcenter_changeset_apply)"
                        type="button"
                      >
                        {changeSetActionLoading ? "处理中..." : "Apply"}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={changeSetActionLoading || liveChangeSetStatus !== "applied"}
                        onClick={() => void rollbackChangeSet(selectedProjectTaskChangeSetId)}
                        aria-label="回滚变更集 (taskcenter_changeset_rollback)"
                        type="button"
                      >
                        {changeSetActionLoading ? "处理中..." : "Rollback"}
                      </button>
                    </div>
                    <div className="text-[11px] text-subtext">
                      提示：Apply/Rollback 需要 editor 权限；失败时可复制 request_id 排障。
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-subtext">
                    该任务 result 未包含 change_set（可能仍在运行或已失败）。
                  </div>
                )}
              </section>
            ) : null}

            <section className="rounded-atelier border border-border bg-surface p-3" aria-label="projecttask_results">
              <div className="text-sm text-ink">Results</div>
              <div className="mt-2 grid gap-2">
                <details className="rounded-atelier border border-border bg-canvas p-2">
                  <summary className="cursor-pointer select-none text-xs text-subtext">params（脱敏）</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-ink">
                    {safeJsonStringify(selected.item.params ?? null)}
                  </pre>
                </details>
                <details className="rounded-atelier border border-border bg-canvas p-2">
                  <summary className="cursor-pointer select-none text-xs text-subtext">result</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-ink">
                    {safeJsonStringify(selected.item.result ?? null)}
                  </pre>
                </details>
                <details className="rounded-atelier border border-border bg-canvas p-2">
                  <summary className="cursor-pointer select-none text-xs text-subtext">error（脱敏）</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-ink">
                    {safeJsonStringify(selected.item.error ?? null)}
                  </pre>
                </details>
              </div>
            </section>
          </div>
        ) : null}

        {selected?.kind === "task" ? (
          <div className="mt-5 grid gap-3">
            <section className="rounded-atelier border border-border bg-surface p-3" aria-label="memorytask_overview">
              <div className="text-sm text-ink">Overview</div>
              <div className="mt-2 grid gap-1 text-xs text-subtext">
                <div>
                  Kind：<span className="font-mono text-ink">{selected.item.kind}</span>
                </div>
                <div>
                  change_set_id：<span className="font-mono text-ink">{selected.item.change_set_id}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span>状态：</span>
                  <StatusBadge status={selected.item.status} kind="task" />
                </div>
                <div>
                  created_at：
                  <span className="font-mono text-ink">
                    {String((selected.item.timings as Record<string, unknown> | null | undefined)?.created_at ?? "-")}
                  </span>
                </div>
                <div>
                  started_at：
                  <span className="font-mono text-ink">
                    {String((selected.item.timings as Record<string, unknown> | null | undefined)?.started_at ?? "-")}
                  </span>
                </div>
                <div>
                  finished_at：
                  <span className="font-mono text-ink">
                    {String((selected.item.timings as Record<string, unknown> | null | undefined)?.finished_at ?? "-")}
                  </span>
                </div>
              </div>
            </section>

            <section className="rounded-atelier border border-border bg-surface p-3" aria-label="memorytask_error">
              <div className="text-sm text-ink">Error</div>
              {selected.item.status === "failed" ? (
                <div className="mt-2 grid gap-2 text-xs text-subtext">
                  <div className="text-danger">
                    {selected.item.error_type || "ERROR"}: {selected.item.error_message || "未知错误"}
                  </div>
                  {extractHowToFix(selected.item.error).length > 0 ? (
                    <ul className="list-disc pl-5 text-[11px] text-subtext">
                      {extractHowToFix(selected.item.error).map((it, idx) => (
                        <li key={idx}>{it}</li>
                      ))}
                    </ul>
                  ) : null}
                  <details className="rounded-atelier border border-border bg-canvas p-2">
                    <summary className="cursor-pointer select-none text-xs text-subtext">error（脱敏）</summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-ink">
                      {safeJsonStringify(selected.item.error ?? null)}
                    </pre>
                  </details>
                </div>
              ) : (
                <div className="mt-2 text-xs text-subtext">无错误信息</div>
              )}
            </section>
          </div>
        ) : null}

        {selected ? (
          <details className="mt-5 rounded-atelier border border-border bg-surface p-3">
            <summary className="cursor-pointer select-none text-sm text-ink">原始数据（JSON）</summary>
            <div className="mt-3 flex items-center justify-end">
              <button className="btn btn-secondary btn-sm" onClick={() => void copyRawJson()} type="button">
                复制 Debug 信息
              </button>
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-atelier border border-border bg-canvas p-3 text-xs text-ink">
              {safeJsonStringify(selected.item)}
            </pre>
          </details>
        ) : null}
      </Drawer>
    </DebugPageShell>
  );
}
