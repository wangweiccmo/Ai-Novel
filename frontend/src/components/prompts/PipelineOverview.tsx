import { useMemo } from "react";

type PipelineStep = {
  taskKey: string;
  label: string;
};

const PIPELINE_STEPS: PipelineStep[] = [
  { taskKey: "plan_chapter", label: "章节规划" },
  { taskKey: "chapter_generate", label: "章节生成" },
  { taskKey: "content_optimize", label: "正文优化" },
  { taskKey: "post_edit", label: "章节润色" },
];

const MEMORY_STEPS: PipelineStep[] = [
  { taskKey: "worldbook_auto_update", label: "世界书" },
  { taskKey: "characters_auto_update", label: "角色卡" },
  { taskKey: "plot_auto_update", label: "剧情记忆" },
  { taskKey: "graph_auto_update", label: "图谱" },
  { taskKey: "fractal_v2", label: "分形摘要" },
  { taskKey: "table_ai_update", label: "数值表" },
];

type TaskModuleInfo = {
  task_key: string;
  model: string | null;
  overridden: boolean;
};

type Props = {
  mainModel: string;
  taskModules: TaskModuleInfo[];
  onNodeClick?: (taskKey: string) => void;
};

export function PipelineOverview({ mainModel, taskModules, onNodeClick }: Props) {
  const moduleMap = useMemo(() => {
    const map = new Map<string, TaskModuleInfo>();
    for (const tm of taskModules) map.set(tm.task_key, tm);
    return map;
  }, [taskModules]);

  return (
    <section className="panel p-4" aria-label="生成管线总览">
      {/* Writing pipeline */}
      <div className="mb-2 text-xs font-medium text-subtext">生成管线</div>
      <div className="flex items-center gap-1 overflow-x-auto">
        {PIPELINE_STEPS.map((step, i) => {
          const info = moduleMap.get(step.taskKey);
          const overridden = info?.overridden ?? false;
          const model = overridden ? (info?.model ?? mainModel) : mainModel;
          return (
            <div key={step.taskKey} className="flex items-center gap-1">
              {i > 0 && <span className="text-xs text-subtext select-none">→</span>}
              <button
                type="button"
                className={`rounded-atelier px-3 py-2 text-xs transition-colors ${
                  overridden
                    ? "border-2 border-accent bg-accent/10 text-ink"
                    : "border border-dashed border-border text-subtext"
                }`}
                onClick={() => onNodeClick?.(step.taskKey)}
                title={`${step.label}: ${model}`}
              >
                <div className="font-medium">{step.label}</div>
                <div className="mt-0.5 truncate max-w-[8rem]">
                  {overridden ? model : `← ${mainModel}`}
                </div>
              </button>
            </div>
          );
        })}
      </div>

      {/* Memory/background tasks */}
      <div className="mt-3 mb-1 text-xs font-medium text-subtext">记忆后台</div>
      <div className="flex flex-wrap items-center gap-1">
        {MEMORY_STEPS.map((step) => {
          const info = moduleMap.get(step.taskKey);
          const overridden = info?.overridden ?? false;
          const model = overridden ? (info?.model ?? mainModel) : mainModel;
          return (
            <button
              key={step.taskKey}
              type="button"
              className={`rounded-atelier px-2 py-1 text-[11px] transition-colors ${
                overridden
                  ? "border border-purple-400/60 bg-purple-500/10 text-ink"
                  : "border border-dashed border-border/60 text-subtext"
              }`}
              onClick={() => onNodeClick?.(step.taskKey)}
              title={`${step.label}: ${model}`}
            >
              {step.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
