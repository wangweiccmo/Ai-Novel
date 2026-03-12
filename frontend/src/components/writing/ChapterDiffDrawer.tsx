import { useEffect, useId, useMemo, useState } from "react";

import { type DiffLine, computeLineDiff } from "../../lib/textDiff";
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

const LINE_STYLES: Record<DiffLine["type"], string> = {
  remove: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  add: "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300",
  same: "",
};

const LINE_PREFIX: Record<DiffLine["type"], string> = {
  remove: "-",
  add: "+",
  same: " ",
};

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
  const diffLines = useMemo(() => computeLineDiff(baseline, current), [baseline, current]);

  const hasDiff = baseline.trim() !== current.trim();
  const baselineLabel = props.baselineLabel ?? "已保存版本";
  const currentLabel = props.currentLabel ?? "当前草稿";

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const l of diffLines) {
      if (l.type === "add") added++;
      else if (l.type === "remove") removed++;
    }
    return { added, removed };
  }, [diffLines]);

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
        {mode === "diff" && hasDiff && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-green-600 dark:text-green-400">+{stats.added} 行</span>
            <span className="text-red-600 dark:text-red-400">-{stats.removed} 行</span>
          </div>
        )}
      </div>

      <div className="mt-3 text-[11px] text-subtext">
        {hasDiff
          ? "提示：红色背景为删除行，绿色背景为新增行。"
          : "提示：已保存版本与当前草稿内容一致，无差异。"}
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
          <div className="max-h-[60vh] overflow-auto rounded-atelier border border-border bg-surface text-xs">
            {hasDiff ? (
              <table className="w-full border-collapse font-mono">
                <tbody>
                  {diffLines.map((line, idx) => (
                    <tr key={idx} className={LINE_STYLES[line.type]}>
                      <td className="w-6 select-none px-2 py-px text-right text-[10px] opacity-40">
                        {LINE_PREFIX[line.type]}
                      </td>
                      <td className="whitespace-pre-wrap break-all px-2 py-px">
                        {line.content || "\u00A0"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-4 text-subtext">（无差异）</div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
