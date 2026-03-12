import { useMemo } from "react";

import type { ChapterListItem } from "../../types";

type Props = {
  chapters: ChapterListItem[];
  currentContentMd: string;
  currentChapterNumber: number | null;
};

/** CJK character count (approximation for Chinese text). */
function countChars(text: string): number {
  if (!text) return 0;
  return text.replace(/\s/g, "").length;
}

export function WritingStatsBar({ chapters, currentContentMd, currentChapterNumber }: Props) {
  const projectStats = useMemo(() => {
    let totalWords = 0;
    let done = 0;
    let drafting = 0;
    let planned = 0;
    let proofreading = 0;

    for (const ch of chapters) {
      totalWords += ch.word_count ?? 0;
      if (ch.status === "done") done++;
      else if (ch.status === "drafting") drafting++;
      else if (ch.status === "proofreading") proofreading++;
      else planned++;
    }

    return { totalWords, done, drafting, planned, proofreading, total: chapters.length };
  }, [chapters]);

  const currentChars = useMemo(() => countChars(currentContentMd), [currentContentMd]);

  const fmtWords = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-subtext">
      {currentChapterNumber != null && (
        <span>
          本章 <span className="text-ink">{fmtWords(currentChars)}</span> 字
        </span>
      )}
      <span>
        全书 <span className="text-ink">{fmtWords(projectStats.totalWords)}</span> 字
      </span>
      <span>
        共 <span className="text-ink">{projectStats.total}</span> 章
      </span>
      {projectStats.done > 0 && (
        <span>
          定稿 <span className="text-ink">{projectStats.done}</span>
        </span>
      )}
      {projectStats.proofreading > 0 && (
        <span>
          校对 <span className="text-ink">{projectStats.proofreading}</span>
        </span>
      )}
      {projectStats.drafting > 0 && (
        <span>
          草稿 <span className="text-ink">{projectStats.drafting}</span>
        </span>
      )}
      <span className="hidden sm:inline">
        快捷键：Ctrl/Cmd+S 保存 · Ctrl/Cmd+Enter AI 生成 · Alt+Up/Down 切换章节
      </span>
    </div>
  );
}
