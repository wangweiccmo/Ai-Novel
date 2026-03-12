import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";

import type { ChapterListItem } from "../../types";
import { apiJson } from "../../services/apiClient";

import { ChapterVirtualList } from "./ChapterVirtualList";

type SearchHit = {
  source_id: string;
  title: string;
  snippet: string;
};

export function ChapterListPanel(props: {
  chapters: ChapterListItem[];
  activeId: string | null;
  projectId?: string;
  onSelectChapter: (chapterId: string) => void;
  containerClassName?: string;
  emptyState?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [ftsHits, setFtsHits] = useState<SearchHit[]>([]);
  const [ftsLoading, setFtsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const containerClassName =
    props.containerClassName ?? "panel flex h-[calc(100vh-220px)] min-h-[480px] flex-col overflow-hidden p-2";

  // Local title/number filter
  const filteredChapters = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.chapters;
    return props.chapters.filter((ch) => {
      const title = (ch.title ?? "").toLowerCase();
      const num = String(ch.number);
      return title.includes(q) || num.includes(q);
    });
  }, [props.chapters, query]);

  // FTS backend search (debounced, only for queries >= 2 chars)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !props.projectId) {
      setFtsHits([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFtsLoading(true);
      apiJson<{ results: SearchHit[] }>(`/api/projects/${props.projectId}/search/query`, {
        method: "POST",
        body: JSON.stringify({ q, sources: ["chapter"], limit: 20 }),
      })
        .then((res) => setFtsHits(res.data.results ?? []))
        .catch(() => setFtsHits([]))
        .finally(() => setFtsLoading(false));
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [query, props.projectId]);

  // Ctrl+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleFtsClick = useCallback(
    (hit: SearchHit) => {
      props.onSelectChapter(hit.source_id);
      setQuery("");
    },
    [props.onSelectChapter],
  );

  const showFts = query.trim().length >= 2 && ftsHits.length > 0;

  return (
    <div className={containerClassName}>
      <div className="relative mb-1.5 flex items-center">
        <Search size={13} className="pointer-events-none absolute left-2 text-subtext" />
        <input
          ref={inputRef}
          className="input w-full py-1 pl-7 pr-7 text-xs"
          placeholder="搜索章节 (Ctrl+K)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            className="absolute right-1.5 text-subtext hover:text-ink"
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            type="button"
            aria-label="清除搜索"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {showFts && (
        <div className="mb-1.5 max-h-48 overflow-auto rounded-atelier border border-border bg-surface">
          <div className="px-2 py-1 text-[10px] text-subtext">
            全文匹配 ({ftsHits.length})
            {ftsLoading && " ..."}
          </div>
          {ftsHits.map((hit) => (
            <button
              key={hit.source_id}
              className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-canvas"
              onClick={() => handleFtsClick(hit)}
              type="button"
            >
              <div className="text-xs font-medium text-ink">{hit.title}</div>
              <div
                className="line-clamp-2 text-[11px] text-subtext"
                dangerouslySetInnerHTML={{ __html: hit.snippet }}
              />
            </button>
          ))}
        </div>
      )}

      <ChapterVirtualList
        chapters={filteredChapters}
        activeId={props.activeId}
        onSelectChapter={props.onSelectChapter}
        emptyState={
          query.trim()
            ? <div className="p-3 text-sm text-subtext">未找到匹配章节</div>
            : props.emptyState
        }
        variant="panel"
      />
    </div>
  );
}
