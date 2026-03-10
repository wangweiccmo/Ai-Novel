import { useEffect, useId, useMemo, useState } from "react";

import { Drawer } from "../ui/Drawer";
import { buildNaiveUnifiedLineDiff } from "../../lib/textDiff";

type Props = {
  open: boolean;
  onClose: () => void;
  rawContentMd: string;
  optimizedContentMd: string;
  requestId: string | null;
  appliedChoice: "raw" | "content_optimize";
  onApplyRaw: () => void;
  onApplyOptimized: () => void;
};

type ViewMode = "diff" | "raw" | "content_optimize";

export function ContentOptimizeCompareDrawer(props: Props) {
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

  const raw = String(props.rawContentMd ?? "");
  const optimized = String(props.optimizedContentMd ?? "");
  const diffText = useMemo(() => buildNaiveUnifiedLineDiff(raw, optimized), [optimized, raw]);

  const applyRaw = () => {
    props.onApplyRaw();
    onClose();
  };

  const applyOptimized = () => {
    props.onApplyOptimized();
    onClose();
  };

  const hasDiff = raw.trim() !== optimized.trim();

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
            正文优化对比
          </div>
          <div className="mt-1 text-xs text-subtext">
            {props.requestId ? (
              <>
                request_id: <span className="font-mono">{props.requestId}</span>
              </>
            ) : (
              "request_id: （未知）"
            )}
          </div>
        </div>
        <button className="btn btn-secondary" onClick={onClose} type="button">
          关闭
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtext">视图</span>
          {(["diff", "raw", "content_optimize"] as const).map((v) => (
            <button
              key={v}
              className={mode === v ? "btn btn-primary" : "btn btn-secondary"}
              onClick={() => setMode(v)}
              type="button"
            >
              {v === "diff" ? "差异" : v === "raw" ? "原稿" : "优化稿"}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className={props.appliedChoice === "raw" ? "btn btn-primary" : "btn btn-secondary"}
            onClick={applyRaw}
            type="button"
          >
            采用原稿
          </button>
          <button
            className={props.appliedChoice === "content_optimize" ? "btn btn-primary" : "btn btn-secondary"}
            onClick={applyOptimized}
            type="button"
          >
            采用优化稿
          </button>
        </div>
      </div>

      <div className="mt-3 text-[11px] text-subtext">
        {hasDiff ? "提示：- 为原稿行，+ 为优化稿行。" : "提示：原稿与优化稿内容一致，无差异。"}
      </div>

      <div className="mt-4">
        {mode === "raw" ? (
          <pre className="max-h-[60vh] overflow-auto rounded-atelier border border-border bg-surface p-4 text-xs text-ink">
            {raw || "（空）"}
          </pre>
        ) : mode === "content_optimize" ? (
          <pre className="max-h-[60vh] overflow-auto rounded-atelier border border-border bg-surface p-4 text-xs text-ink">
            {optimized || "（空）"}
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
