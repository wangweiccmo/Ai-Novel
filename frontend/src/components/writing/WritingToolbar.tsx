import { useEffect, useRef, useState } from "react";
import { ChevronDown, List } from "lucide-react";

import { UI_COPY } from "../../lib/uiCopy";
import type { OutlineListItem } from "../../types";

export function WritingToolbar(props: {
  outlines: OutlineListItem[];
  activeOutlineId: string;
  chaptersCount: number;
  batchProgressText: string;
  aiGenerateDisabled: boolean;
  onSwitchOutline: (outlineId: string) => void;
  onOpenChapterList: () => void;
  onOpenBatch: () => void;
  onOpenHistory: () => void;
  onOpenAiGenerate: () => void;
  onOpenContextPreview: () => void;
  onOpenMemoryUpdate: () => void;
  onOpenTaskCenter: () => void;
  onOpenForeshadow: () => void;
  onOpenTables: () => void;
  onCreateChapter: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen]);

  const toolItems = [
    { label: "伏笔面板", action: props.onOpenForeshadow },
    { label: "表格面板", action: props.onOpenTables },
    { label: UI_COPY.writing.contextPreview, action: props.onOpenContextPreview },
    { label: "记忆更新", action: props.onOpenMemoryUpdate },
    { label: "任务中心", action: props.onOpenTaskCenter },
  ];

  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtext">当前大纲</span>
          <select
            className="select w-auto"
            name="active_outline_id"
            value={props.activeOutlineId}
            onChange={(e) => props.onSwitchOutline(e.target.value)}
          >
            {props.outlines.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
                {o.has_chapters ? "（已有章节）" : ""}
              </option>
            ))}
          </select>
          <span className="text-xs text-subtext">共 {props.chaptersCount} 章</span>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn btn-secondary lg:hidden" onClick={props.onOpenChapterList} type="button">
            <List size={16} />
            章节列表
          </button>
          <button className="btn btn-primary" onClick={props.onCreateChapter} type="button">
            新增章节
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-subtext">生成</span>
        <button
          className="btn btn-secondary"
          disabled={props.aiGenerateDisabled}
          onClick={props.onOpenAiGenerate}
          type="button"
        >
          AI 生成
        </button>
        <button
          className="btn btn-secondary"
          aria-label="Open batch generation (writing_open_batch_generation)"
          onClick={props.onOpenBatch}
          type="button"
        >
          批量生成{props.batchProgressText}
        </button>
        <button
          className="btn btn-secondary"
          aria-label="Open generation history (writing_open_generation_history)"
          onClick={props.onOpenHistory}
          type="button"
        >
          生成记录
        </button>

        <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />

        {/* Full tool buttons — visible on large screens */}
        <span className="hidden text-[11px] text-subtext lg:inline">工具</span>
        {toolItems.map((item) => (
          <button
            key={item.label}
            className="btn btn-secondary hidden lg:inline-flex"
            onClick={item.action}
            type="button"
          >
            {item.label}
          </button>
        ))}

        {/* "More" dropdown — visible on small/medium screens */}
        <div className="relative lg:hidden" ref={moreRef}>
          <button
            className="btn btn-secondary inline-flex items-center gap-1"
            onClick={() => setMoreOpen((v) => !v)}
            type="button"
          >
            更多工具
            <ChevronDown size={14} className={`transition-transform ${moreOpen ? "rotate-180" : ""}`} />
          </button>
          {moreOpen && (
            <div className="absolute left-0 top-full z-30 mt-1 min-w-[140px] rounded-atelier border border-border bg-surface py-1 shadow-sm">
              {toolItems.map((item) => (
                <button
                  key={item.label}
                  className="w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-accent/10"
                  onClick={() => {
                    setMoreOpen(false);
                    item.action();
                  }}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 text-xs text-subtext">
        提示：生成默认不会自动保存；若章节有未保存修改，会在生成前提示"保存并生成 / 直接生成"。
      </div>
    </div>
  );
}
