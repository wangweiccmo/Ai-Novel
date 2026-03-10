import { useEffect, useId, useMemo, useState } from "react";

import { buildNaiveUnifiedLineDiff } from "../../lib/textDiff";
import { Drawer } from "../ui/Drawer";

type Props = {
  open: boolean;
  onClose: () => void;
  baselineContentMd: string;
  currentContentMd: string;
  baselineLabel?: string;
  currentLabel?: string;
};

type ViewMode = "diff" | "baseline" | "current";

export function ChapterDiffDrawer(props: Props) {
  const { onClose, open } = props;
  const titleId = useId();
  const [mode, setMode] = useState<ViewMode>("diff");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const baseline = String(props.baselineContentMd ?? "");
  const current = String(props.currentContentMd ?? "");
  const diffText = useMemo(() => buildNaiveUnifiedLineDiff(baseline, current), [baseline, current]);

  const hasDiff = baseline.trim() !== current.trim();
  const baselineLabel = props.baselineLabel ?? "已保存版本";
  const currentLabel = props.currentLabel ?? "当前草稿";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      ariaLabelledBy={titleId}
      panelClassName="h-[85vh] w-full overflow-y-auto rounded-atelier border-t border-border bg-canvas p-6 shadow-sm sm:h-full sm:max-w-3xl sm:rounded-none sm:border-l sm:border-t-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-content text-2xl text-ink" id={titleId}>
            章节对比
          </div>
          <div className="mt-1 text-xs text-subtext">
            对比对象：正文（Markdown） · {baselineLabel} vs {currentLabel}
          </div>
        </div>
        <button className="btn btn-secondary" onClick={onClose} type="button">
          关闭
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtext">视图</span>
          {(["diff", "baseline", "current"] as const).map((v) => (
            <button
              key={v}
              className={mode === v ? "btn btn-primary" : "btn btn-secondary"}
              onClick={() => setMode(v)}
              type="button"
            >
              {v === "diff" ? "差异" : v === "baseline" ? baselineLabel : currentLabel}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 text-[11px] text-subtext">
        {hasDiff ? "提示：- 表示删除行，+ 表示新增行。" : "提示：已保存版本与当前草稿内容一致，无差异。"}
      </div>

      <div className="mt-4">
        {mode === "baseline" ? (
          <pre className="max-h-[60vh] overflow-auto rounded-atelier border border-border bg-surface p-4 text-xs text-ink">
            {baseline || "（空）"}
          </pre>
        ) : mode === "current" ? (
          <pre className="max-h-[60vh] overflow-auto rounded-atelier border border-border bg-surface p-4 text-xs text-ink">
            {current || "（空）"}
          </pre>
        ) : (
          <pre className="max-h-[60vh] overflow-auto rounded-atelier border border-border bg-surface p-4 text-xs text-ink">
            {hasDiff ? diffText : "（无差异）"}
          </pre>
        )}
      </div>
    </Drawer>
  );
}
