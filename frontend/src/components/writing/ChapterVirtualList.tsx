import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { humanizeChapterStatus } from "../../lib/humanize";
import type { ChapterListItem } from "../../types";

import {
  DEFAULT_ROW_HEIGHT,
  DEFAULT_VIEWPORT_HEIGHT,
  getChapterScrollTopForIndex,
  getChapterVirtualWindow,
} from "./chapterVirtualWindow";

type ChapterVirtualListVariant = "panel" | "card";

function renderTitle(variant: ChapterVirtualListVariant, chapter: ChapterListItem): ReactNode {
  const wordCount = chapter.word_count ?? 0;
  const genCount = chapter.generation_count ?? 0;

  if (variant === "panel") {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="mr-1 text-xs text-subtext">#{chapter.number}</span>
        <span className="min-w-0 truncate">{chapter.title?.trim() ? chapter.title : "（未命名章节）"}</span>
        {wordCount > 0 && (
          <span className="shrink-0 rounded bg-surface px-1 text-[10px] text-subtext" title="字数">
            {wordCount >= 1000 ? `${(wordCount / 1000).toFixed(1)}k` : wordCount}
          </span>
        )}
        {genCount > 0 && (
          <span className="shrink-0 rounded bg-accent/10 px-1 text-[10px] text-accent" title="生成次数">
            G{genCount}
          </span>
        )}
      </div>
    );
  }

  return (
    <span className="min-w-0 truncate">
      {chapter.number}. {chapter.title?.trim() ? chapter.title : "（未命名）"}
      {wordCount > 0 && (
        <span className="ml-1 text-[10px] text-subtext">
          {wordCount >= 1000 ? `${(wordCount / 1000).toFixed(1)}k` : wordCount}字
        </span>
      )}
    </span>
  );
}

function itemClassName(variant: ChapterVirtualListVariant, isActive: boolean): string {
  if (variant === "panel") {
    return clsx(
      "ui-focus-ring ui-transition-fast flex h-11 w-full items-center justify-between gap-2 rounded-atelier px-3 text-left text-sm",
      isActive ? "bg-canvas text-ink" : "text-subtext hover:bg-canvas hover:text-ink",
    );
  }

  return clsx(
    "ui-focus-ring ui-transition-fast flex h-11 w-full items-center justify-between gap-2 rounded-atelier border px-3 text-left text-sm motion-safe:active:scale-[0.99]",
    isActive ? "border-accent/40 bg-accent/10 text-ink" : "border-border bg-canvas text-subtext hover:bg-surface",
  );
}

export function ChapterVirtualList(props: {
  chapters: ChapterListItem[];
  activeId: string | null;
  onSelectChapter: (chapterId: string) => void;
  ariaLabel?: string;
  className?: string;
  emptyState?: ReactNode;
  variant?: ChapterVirtualListVariant;
  getStatusLabel?: (chapter: ChapterListItem) => string;
}) {
  const {
    chapters,
    activeId,
    onSelectChapter,
    ariaLabel = "章节列表",
    className,
    emptyState,
    variant = "panel",
    getStatusLabel = (chapter) => humanizeChapterStatus(chapter.status),
  } = props;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);

  const activeIndex = useMemo(() => {
    if (!activeId) return -1;
    return chapters.findIndex((chapter) => chapter.id === activeId);
  }, [activeId, chapters]);

  const windowState = useMemo(
    () =>
      getChapterVirtualWindow({
        itemCount: chapters.length,
        itemHeight: DEFAULT_ROW_HEIGHT,
        viewportHeight,
        scrollTop,
      }),
    [chapters.length, scrollTop, viewportHeight],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      setViewportHeight(Math.max(viewport.clientHeight, DEFAULT_VIEWPORT_HEIGHT));
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || activeIndex < 0) return;

    const nextScrollTop = getChapterScrollTopForIndex({
      currentScrollTop: viewport.scrollTop,
      itemIndex: activeIndex,
      itemHeight: DEFAULT_ROW_HEIGHT,
      viewportHeight,
    });

    if (nextScrollTop === null) return;
    viewport.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, [activeIndex, viewportHeight]);

  if (chapters.length === 0) {
    return (
      <div className={clsx("flex h-full min-h-[160px] items-center justify-center", className)}>
        {emptyState ?? <div className="p-3 text-sm text-subtext">暂无章节</div>}
      </div>
    );
  }

  const visibleItems = chapters.slice(windowState.startIndex, windowState.endIndex);

  return (
    <div
      ref={viewportRef}
      aria-label={ariaLabel}
      className={clsx("h-full overflow-auto", className)}
      role="list"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: `${windowState.totalHeight}px` }}>
        {visibleItems.map((chapter, index) => {
          const absoluteIndex = windowState.startIndex + index;
          const isActive = chapter.id === activeId;
          return (
            <div
              key={chapter.id}
              className="absolute left-0 right-0"
              role="listitem"
              style={{ top: `${absoluteIndex * DEFAULT_ROW_HEIGHT}px`, height: `${DEFAULT_ROW_HEIGHT}px` }}
            >
              <button
                aria-current={isActive ? "true" : undefined}
                className={itemClassName(variant, isActive)}
                onClick={() => onSelectChapter(chapter.id)}
                type="button"
              >
                {renderTitle(variant, chapter)}
                <span
                  className={clsx(
                    "shrink-0 text-[11px]",
                    variant === "card" && chapter.status === "done" ? "text-accent" : "text-subtext",
                  )}
                >
                  {getStatusLabel(chapter)}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
