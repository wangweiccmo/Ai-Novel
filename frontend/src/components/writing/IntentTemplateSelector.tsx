import { useCallback, useEffect, useState } from "react";

export type IntentCardValues = {
  style: string;
  pov: string;
  pacing: string;
  conflict: string;
  voice: string;
};

export type IntentTemplate = {
  id: string;
  name: string;
  scene_type: string;
  values: IntentCardValues;
};

const STORAGE_KEY = "ainovel:intent_templates";

const BUILTIN_TEMPLATES: IntentTemplate[] = [
  {
    id: "__action",
    name: "动作场景",
    scene_type: "action",
    values: { style: "紧张刺激", pov: "第三人称限定", pacing: "快节奏，短句为主", conflict: "外部危机，生死一线", voice: "画面感强，动词密集" },
  },
  {
    id: "__dialogue",
    name: "对话场景",
    scene_type: "dialogue",
    values: { style: "自然流畅", pov: "", pacing: "中等节奏", conflict: "观点冲突或情感博弈", voice: "口语化，注重潜台词" },
  },
  {
    id: "__introspection",
    name: "内心独白",
    scene_type: "introspection",
    values: { style: "细腻深沉", pov: "第一人称或深度限定", pacing: "慢节奏，意识流", conflict: "内心矛盾", voice: "长句，隐喻丰富" },
  },
  {
    id: "__description",
    name: "景物描写",
    scene_type: "description",
    values: { style: "沉浸感强", pov: "", pacing: "舒缓", conflict: "", voice: "五感描写，细节密集" },
  },
  {
    id: "__transition",
    name: "过渡衔接",
    scene_type: "transition",
    values: { style: "简洁克制", pov: "", pacing: "快速推进", conflict: "", voice: "概括性叙述，承上启下" },
  },
];

function loadUserTemplates(): IntentTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is IntentTemplate =>
        t && typeof t === "object" && typeof t.id === "string" && typeof t.name === "string",
    );
  } catch {
    return [];
  }
}

function saveUserTemplates(templates: IntentTemplate[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // ignore
  }
}

type Props = {
  disabled?: boolean;
  onApplyTemplate: (values: IntentCardValues) => void;
  currentValues: IntentCardValues;
};

export function IntentTemplateSelector({ disabled, onApplyTemplate, currentValues }: Props) {
  const [userTemplates, setUserTemplates] = useState(loadUserTemplates);
  const [saveName, setSaveName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);

  // Reload if localStorage changes externally
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setUserTemplates(loadUserTemplates());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const allTemplates = [...BUILTIN_TEMPLATES, ...userTemplates];

  const handleSave = useCallback(() => {
    const name = saveName.trim();
    if (!name) return;
    const id = `user_${Date.now()}`;
    const template: IntentTemplate = { id, name, scene_type: "custom", values: { ...currentValues } };
    const next = [...userTemplates, template];
    setUserTemplates(next);
    saveUserTemplates(next);
    setSaveName("");
    setSaveOpen(false);
  }, [currentValues, saveName, userTemplates]);

  const handleDelete = useCallback(
    (id: string) => {
      const next = userTemplates.filter((t) => t.id !== id);
      setUserTemplates(next);
      saveUserTemplates(next);
    },
    [userTemplates],
  );

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-subtext">模板</span>
        {allTemplates.map((t) => (
          <button
            key={t.id}
            className="btn btn-secondary"
            disabled={disabled}
            onClick={() => onApplyTemplate(t.values)}
            title={`${t.name}：风格=${t.values.style || "-"} 视角=${t.values.pov || "-"} 节奏=${t.values.pacing || "-"}`}
            type="button"
          >
            {t.name}
            {!t.id.startsWith("__") && (
              <span
                className="ml-1 text-[10px] text-subtext hover:text-accent"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(t.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); handleDelete(t.id); } }}
              >
                x
              </span>
            )}
          </button>
        ))}
        <button
          className="btn btn-secondary text-[11px]"
          disabled={disabled}
          onClick={() => setSaveOpen((v) => !v)}
          type="button"
        >
          {saveOpen ? "取消" : "保存当前为模板"}
        </button>
      </div>
      {saveOpen && (
        <div className="flex items-center gap-2">
          <input
            className="input flex-1"
            placeholder="模板名称"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          />
          <button
            className="btn btn-primary"
            disabled={!saveName.trim()}
            onClick={handleSave}
            type="button"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}
