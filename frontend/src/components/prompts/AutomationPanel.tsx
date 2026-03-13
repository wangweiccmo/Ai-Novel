import { useCallback, useMemo, useRef } from "react";

export type AutoUpdateForm = {
  auto_update_worldbook_enabled: boolean;
  auto_update_characters_enabled: boolean;
  auto_update_story_memory_enabled: boolean;
  auto_update_graph_enabled: boolean;
  auto_update_vector_enabled: boolean;
  auto_update_search_enabled: boolean;
  auto_update_fractal_enabled: boolean;
  auto_update_tables_enabled: boolean;
};

type TaskMeta = {
  formKey: keyof AutoUpdateForm;
  taskKey: string | null;
  label: string;
  description: string;
};

const AUTO_UPDATE_TASKS: TaskMeta[] = [
  { formKey: "auto_update_worldbook_enabled", taskKey: "worldbook_auto_update", label: "世界书自动更新", description: "章节定稿后自动更新世界书条目" },
  { formKey: "auto_update_characters_enabled", taskKey: "characters_auto_update", label: "角色卡自动更新", description: "章节定稿后自动更新角色卡" },
  { formKey: "auto_update_story_memory_enabled", taskKey: "plot_auto_update", label: "剧情记忆自动更新", description: "章节定稿后自动分析并写入剧情记忆" },
  { formKey: "auto_update_graph_enabled", taskKey: "graph_auto_update", label: "图谱自动更新", description: "章节定稿后自动更新知识图谱" },
  { formKey: "auto_update_vector_enabled", taskKey: null, label: "向量索引自动更新", description: "章节定稿后自动重建向量索引（使用「向量 & RAG」配置）" },
  { formKey: "auto_update_search_enabled", taskKey: null, label: "搜索索引自动更新", description: "章节定稿后自动重建搜索索引" },
  { formKey: "auto_update_fractal_enabled", taskKey: "fractal_v2", label: "分形摘要自动更新", description: "章节定稿后自动重建分形摘要" },
  { formKey: "auto_update_tables_enabled", taskKey: "table_ai_update", label: "数值表自动更新", description: "章节定稿后自动更新数值表格" },
];

type TaskModuleInfo = { task_key: string; model: string | null };

type Props = {
  form: AutoUpdateForm;
  onChange: (form: AutoUpdateForm) => void;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  mainModel: string;
  taskModules: TaskModuleInfo[];
};

export function AutomationPanel({ form, onChange, saving, dirty, onSave, mainModel, taskModules }: Props) {
  const masterRef = useRef<HTMLInputElement>(null);

  const taskModelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const tm of taskModules) {
      if (tm.model) map.set(tm.task_key, tm.model);
    }
    return map;
  }, [taskModules]);

  const allEnabled = useMemo(
    () => AUTO_UPDATE_TASKS.every((t) => form[t.formKey]),
    [form],
  );
  const someEnabled = useMemo(
    () => AUTO_UPDATE_TASKS.some((t) => form[t.formKey]),
    [form],
  );

  const setAll = useCallback(
    (enabled: boolean) => {
      const next = { ...form };
      for (const t of AUTO_UPDATE_TASKS) next[t.formKey] = enabled;
      onChange(next);
    },
    [form, onChange],
  );

  // indeterminate state for master checkbox
  if (masterRef.current) {
    masterRef.current.indeterminate = someEnabled && !allEnabled;
  }

  const toggle = useCallback(
    (key: keyof AutoUpdateForm) => {
      onChange({ ...form, [key]: !form[key] });
    },
    [form, onChange],
  );

  return (
    <section className="panel p-6" aria-label="自动化任务">
      <div className="grid gap-1">
        <div className="font-content text-xl text-ink">自动化任务</div>
        <div className="text-xs text-subtext">
          章节定稿后自动触发的后台 AI 任务。关闭后仍可在对应页面或任务中心手动触发。
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-ink">
          <input
            ref={masterRef}
            className="checkbox"
            type="checkbox"
            checked={allEnabled}
            onChange={(e) => setAll(e.target.checked)}
          />
          一键开关
        </label>
        {dirty && (
          <button className="btn btn-primary btn-sm" disabled={saving} onClick={onSave} type="button">
            {saving ? "保存中…" : "保存"}
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {AUTO_UPDATE_TASKS.map((task) => {
          const enabled = form[task.formKey];
          const model = task.taskKey ? taskModelMap.get(task.taskKey) ?? mainModel : null;
          return (
            <div
              key={task.formKey}
              className={`flex items-start gap-3 rounded-atelier border p-3 ${enabled ? "border-accent/30 bg-accent/5" : "border-border"}`}
            >
              <input
                className="checkbox mt-0.5"
                type="checkbox"
                checked={enabled}
                onChange={() => toggle(task.formKey)}
              />
              <div className="grid gap-0.5 text-sm">
                <span className="font-medium text-ink">{task.label}</span>
                <span className="text-xs text-subtext">{task.description}</span>
                {enabled && model && (
                  <span className="text-xs text-subtext">
                    模型：{model === mainModel ? `${model}（主模型）` : model}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
