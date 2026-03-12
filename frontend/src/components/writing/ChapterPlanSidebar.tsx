import { useEffect, useState } from "react";
import { ChevronRight, PanelRightClose } from "lucide-react";

type Props = {
  plan: string;
  summary: string;
  chapterNumber: number | null;
  onPlanChange?: (value: string) => void;
  readOnly?: boolean;
};

const STORAGE_KEY = "ainovel:plan_sidebar_open";

export function ChapterPlanSidebar({ plan, summary, chapterNumber, onPlanChange, readOnly }: Props) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(open));
    } catch {
      // ignore
    }
  }, [open]);

  if (!open) {
    return (
      <button
        className="fixed right-0 top-1/3 z-20 hidden rounded-l-atelier border border-r-0 border-border bg-surface px-1 py-3 text-subtext shadow-sm hover:bg-canvas xl:block"
        onClick={() => setOpen(true)}
        title="展开章节计划"
        type="button"
      >
        <ChevronRight size={14} className="rotate-180" />
      </button>
    );
  }

  return (
    <aside className="hidden w-[220px] shrink-0 xl:block">
      <div className="sticky top-4 rounded-atelier border border-border bg-surface p-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-ink">
            {chapterNumber != null ? `第 ${chapterNumber} 章 · 计划` : "章节计划"}
          </div>
          <button
            className="text-subtext hover:text-ink"
            onClick={() => setOpen(false)}
            title="收起"
            type="button"
          >
            <PanelRightClose size={14} />
          </button>
        </div>

        <div className="mt-2">
          <div className="text-[11px] text-subtext">要点</div>
          {onPlanChange && !readOnly ? (
            <textarea
              className="textarea mt-1 text-xs"
              rows={6}
              value={plan}
              onChange={(e) => onPlanChange(e.target.value)}
            />
          ) : (
            <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-ink">
              {plan.trim() || "（空）"}
            </div>
          )}
        </div>

        <div className="mt-3">
          <div className="text-[11px] text-subtext">摘要</div>
          <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-ink">
            {summary.trim() || "（空）"}
          </div>
        </div>
      </div>
    </aside>
  );
}
