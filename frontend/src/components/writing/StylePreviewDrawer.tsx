import { useCallback, useEffect, useId, useState } from "react";

import { Drawer } from "../ui/Drawer";
import { apiJson } from "../../services/apiClient";

type WritingStyle = {
  id: string;
  name: string;
  is_preset: boolean;
};

type PreviewResult = {
  text: string;
  meta: {
    style_id: string | null;
    source: string;
    scene_type?: string | null;
    layers?: string[];
  };
};

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: string;
  presets: WritingStyle[];
  userStyles: WritingStyle[];
  currentStyleId: string | null;
};

const SCENE_TYPES = [
  { value: "", label: "无" },
  { value: "action", label: "动作" },
  { value: "dialogue", label: "对话" },
  { value: "introspection", label: "内心独白" },
  { value: "description", label: "景物描写" },
  { value: "transition", label: "过渡衔接" },
];

export function StylePreviewDrawer({ open, onClose, projectId, presets, userStyles, currentStyleId }: Props) {
  const titleId = useId();
  const [styleIdA, setStyleIdA] = useState<string | null>(currentStyleId);
  const [styleIdB, setStyleIdB] = useState<string | null>(null);
  const [sceneType, setSceneType] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewA, setPreviewA] = useState<PreviewResult | null>(null);
  const [previewB, setPreviewB] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setStyleIdA(currentStyleId);
  }, [open, currentStyleId]);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiJson<{
        preview: { a: PreviewResult; b?: PreviewResult };
      }>(`/api/projects/${projectId}/writing_styles/preview`, {
        method: "POST",
        body: JSON.stringify({
          style_id_a: styleIdA || null,
          style_id_b: styleIdB || null,
          scene_type: sceneType || null,
        }),
      });
      setPreviewA(res.data.preview.a);
      setPreviewB(res.data.preview.b ?? null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [projectId, styleIdA, styleIdB, sceneType]);

  useEffect(() => {
    if (!open) return;
    void fetchPreview();
  }, [open, fetchPreview]);

  const allStyles = [...presets, ...userStyles];

  const styleName = (id: string | null) => {
    if (!id) return "项目默认";
    return allStyles.find((s) => s.id === id)?.name ?? id;
  };

  const sourceLabel = (source: string) => {
    switch (source) {
      case "request": return "指定风格";
      case "project_default": return "项目默认";
      case "settings_fallback": return "设置回退";
      case "disabled": return "已禁用";
      default: return "无";
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      ariaLabelledBy={titleId}
      panelClassName="h-full w-full overflow-y-auto rounded-none border-l border-border bg-canvas p-5 shadow-sm sm:max-w-2xl"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-content text-xl text-ink" id={titleId}>
          风格预览对比
        </div>
        <button className="btn btn-secondary" onClick={onClose} type="button">
          关闭
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1">
          <span className="text-xs text-subtext">风格 A</span>
          <select
            className="select"
            value={styleIdA ?? ""}
            onChange={(e) => setStyleIdA(e.target.value || null)}
          >
            <option value="">项目默认</option>
            <optgroup label="系统预设">
              {presets.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </optgroup>
            <optgroup label="我的风格">
              {userStyles.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-subtext">风格 B（对比）</span>
          <select
            className="select"
            value={styleIdB ?? ""}
            onChange={(e) => setStyleIdB(e.target.value || null)}
          >
            <option value="">不对比</option>
            <optgroup label="系统预设">
              {presets.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </optgroup>
            <optgroup label="我的风格">
              {userStyles.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-subtext">场景类型</span>
          <select
            className="select"
            value={sceneType}
            onChange={(e) => setSceneType(e.target.value)}
          >
            {SCENE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mt-3 callout-warning text-sm">{error}</div>
      )}

      {loading ? (
        <div className="mt-6 text-center text-sm text-subtext">加载中...</div>
      ) : (
        <div className={`mt-4 grid gap-4 ${previewB ? "sm:grid-cols-2" : ""}`}>
          {previewA && (
            <PreviewPanel
              label={`A：${styleName(styleIdA)}`}
              result={previewA}
              sourceLabel={sourceLabel}
            />
          )}
          {previewB && (
            <PreviewPanel
              label={`B：${styleName(styleIdB)}`}
              result={previewB}
              sourceLabel={sourceLabel}
            />
          )}
        </div>
      )}

      <div className="mt-3 text-[11px] text-subtext">
        预览显示的是最终合成后的风格文本（含场景补充 + 角色语气），即 AI 生成时实际注入的风格指令。
      </div>
    </Drawer>
  );
}

function PreviewPanel({
  label,
  result,
  sourceLabel,
}: {
  label: string;
  result: PreviewResult;
  sourceLabel: (s: string) => string;
}) {
  return (
    <div className="rounded-atelier border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-ink">{label}</div>
        <div className="flex items-center gap-2 text-[11px] text-subtext">
          <span>{sourceLabel(result.meta.source)}</span>
          {result.meta.layers && result.meta.layers.length > 0 && (
            <span>层：{result.meta.layers.join(" + ")}</span>
          )}
        </div>
      </div>
      <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs text-ink">
        {result.text.trim() || "（空 — 未配置风格）"}
      </pre>
    </div>
  );
}
