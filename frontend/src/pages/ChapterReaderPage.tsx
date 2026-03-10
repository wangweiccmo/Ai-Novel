import clsx from "clsx";
import { BookOpen, ChevronLeft, Edit3, List, StickyNote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";

import { ToolContent } from "../components/layout/AppShell";
import { ChapterVirtualList } from "../components/writing/ChapterVirtualList";
import { Drawer } from "../components/ui/Drawer";
import { useChapterDetail } from "../hooks/useChapterDetail";
import { useChapterMetaList } from "../hooks/useChapterMetaList";
import { ApiError, apiJson } from "../services/apiClient";
import { chapterStore } from "../services/chapterStore";
import type { Chapter, ChapterListItem } from "../types";
import type { MemoryContextPack } from "../components/writing/types";
const EMPTY_PACK: MemoryContextPack = {
  worldbook: {},
  story_memory: {},
  semantic_history: {},
  foreshadow_open_loops: {},
  structured: {},
  tables: {},
  vector_rag: {},
  graph: {},
  fractal: {},
  logs: [],
};

function humanizeChapterStatusZh(status: string): string {
  const s = String(status || "").trim();
  if (s === "planned") return "计划中";
  if (s === "drafting") return "草稿";
  if (s === "proofreading") return "校对";
  if (s === "done") return "定稿";
  return s || "未知";
}

function buildMemoryQueryText(chapter: Chapter): string {
  const parts: string[] = [];
  const title = String(chapter.title || "").trim();
  if (title) parts.push(`title: ${title}`);
  const summary = String(chapter.summary || "").trim();
  if (summary) parts.push(`summary: ${summary}`);
  const plan = String((chapter as { plan?: unknown }).plan || "").trim();
  if (plan) parts.push(`plan: ${plan}`);
  const content = String(chapter.content_md || "").trim();
  if (content) parts.push(content);
  const merged = parts.join("\n\n").trim();
  return merged.slice(0, 5000);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getSectionEnabled(section: Record<string, unknown> | null): boolean {
  return Boolean(section?.enabled);
}

function getSectionDisabledReason(section: Record<string, unknown> | null): string | null {
  const raw = section?.disabled_reason;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

type MemoryItem = {
  id: string;
  chapter_id?: string | null;
  title?: string | null;
  memory_type?: string | null;
  content_preview?: string | null;
};

function normalizeItems(raw: unknown): MemoryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryItem[] = [];
  for (const it of raw) {
    const obj = asObject(it);
    if (!obj) continue;
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!id) continue;
    out.push({
      id,
      chapter_id: typeof obj.chapter_id === "string" ? obj.chapter_id : null,
      title: typeof obj.title === "string" ? obj.title : null,
      memory_type: typeof obj.memory_type === "string" ? obj.memory_type : null,
      content_preview: typeof obj.content_preview === "string" ? obj.content_preview : null,
    });
  }
  return out;
}

function sectionCounts(section: Record<string, unknown> | null): Record<string, number> {
  const raw = asObject(section?.counts);
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const num = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(num)) continue;
    out[k] = num;
  }
  return out;
}

function sectionTextMd(section: Record<string, unknown> | null): string {
  const raw = section?.text_md;
  return typeof raw === "string" ? raw : "";
}

export function ChapterReaderPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedChapterId = searchParams.get("chapterId");

  const [activeId, setActiveId] = useState<string | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [mobileMemoryOpen, setMobileMemoryOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [memoryCollapsed, setMemoryCollapsed] = useState(false);
  const [onlyDone, setOnlyDone] = useState(false);

  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<ApiError | null>(null);
  const [memoryPack, setMemoryPack] = useState<MemoryContextPack>(EMPTY_PACK);
  const memoryCacheRef = useRef(new Map<string, MemoryContextPack>());

  const chapterListQuery = useChapterMetaList(projectId);
  const chapters = chapterListQuery.chapters as ChapterListItem[];
  const sortedChapters = useMemo(() => [...chapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)), [chapters]);
  const doneCount = useMemo(
    () => sortedChapters.reduce((acc, c) => acc + (c.status === "done" ? 1 : 0), 0),
    [sortedChapters],
  );
  const visibleChapters = useMemo(() => {
    if (!onlyDone) return sortedChapters;
    return sortedChapters.filter((c) => c.status === "done");
  }, [onlyDone, sortedChapters]);

  const resolvedActiveId = useMemo(() => {
    if (activeId && visibleChapters.some((c) => c.id === activeId)) return activeId;
    if (!activeId && requestedChapterId && visibleChapters.some((c) => c.id === requestedChapterId)) {
      return requestedChapterId;
    }
    return visibleChapters[0]?.id ?? null;
  }, [activeId, requestedChapterId, visibleChapters]);

  const activeIndex = useMemo(() => {
    if (!resolvedActiveId) return -1;
    return visibleChapters.findIndex((c) => c.id === resolvedActiveId);
  }, [resolvedActiveId, visibleChapters]);

  const activeChapterMeta = useMemo(() => {
    if (activeIndex < 0) return null;
    return visibleChapters[activeIndex] ?? null;
  }, [activeIndex, visibleChapters]);

  const prevChapter = useMemo(() => {
    if (activeIndex <= 0) return null;
    return visibleChapters[activeIndex - 1] ?? null;
  }, [activeIndex, visibleChapters]);

  const nextChapter = useMemo(() => {
    if (activeIndex < 0) return null;
    if (activeIndex >= visibleChapters.length - 1) return null;
    return visibleChapters[activeIndex + 1] ?? null;
  }, [activeIndex, visibleChapters]);

  const openEditor = (chapterId: string) => {
    if (!projectId) return;
    navigate(`/projects/${projectId}/writing?chapterId=${encodeURIComponent(chapterId)}`);
  };

  const openChapter = useCallback((chapterId: string) => {
    setActiveId(chapterId);
    setMobileListOpen(false);
  }, []);

  const { chapter: activeChapter, loading: loadingChapter } = useChapterDetail(resolvedActiveId, {
    enabled: Boolean(resolvedActiveId),
  });
  const activeChapterSummary = activeChapter ?? activeChapterMeta;

  useEffect(() => {
    if (prevChapter) void chapterStore.prefetchChapterDetail(prevChapter.id);
    if (nextChapter) void chapterStore.prefetchChapterDetail(nextChapter.id);
  }, [nextChapter, prevChapter]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

      const activeEl = document.activeElement;
      const isTypingTarget =
        activeEl instanceof HTMLElement &&
        (activeEl.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName));
      if (isTypingTarget) return;

      if (e.key === "ArrowLeft" && prevChapter) {
        e.preventDefault();
        openChapter(prevChapter.id);
        return;
      }
      if (e.key === "ArrowRight" && nextChapter) {
        e.preventDefault();
        openChapter(nextChapter.id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nextChapter, openChapter, prevChapter]);

  useEffect(() => {
    if (!projectId) return;
    if (!activeChapter) return;

    const cacheKey = `${activeChapter.id}:${activeChapter.updated_at}`;
    const cachedPack = memoryCacheRef.current.get(cacheKey);
    if (cachedPack) {
      setMemoryPack(cachedPack);
      setMemoryError(null);
      setMemoryLoading(false);
      return;
    }

    const controller = new AbortController();
    setMemoryLoading(true);
    setMemoryError(null);
    const queryText = buildMemoryQueryText(activeChapter);

    apiJson<MemoryContextPack>(`/api/projects/${projectId}/memory/preview`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        query_text: queryText,
        section_enabled: {
          worldbook: false,
          story_memory: true,
          semantic_history: false,
          foreshadow_open_loops: true,
          structured: true,
          vector_rag: false,
          graph: false,
          fractal: false,
        },
      }),
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        memoryCacheRef.current.set(cacheKey, res.data);
        setMemoryPack(res.data);
        setMemoryError(null);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        if (err.code === "REQUEST_ABORTED") return;
        setMemoryError(err);
        setMemoryPack(EMPTY_PACK);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setMemoryLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [activeChapter, projectId]);

  const effectiveMemoryPack = activeChapter ? memoryPack : EMPTY_PACK;
  const effectiveMemoryLoading = activeChapter ? memoryLoading : false;
  const effectiveMemoryError = activeChapter ? memoryError : null;

  const storySection = useMemo(() => asObject(effectiveMemoryPack.story_memory), [effectiveMemoryPack.story_memory]);
  const foreshadowSection = useMemo(
    () => asObject(effectiveMemoryPack.foreshadow_open_loops),
    [effectiveMemoryPack.foreshadow_open_loops],
  );
  const structuredSection = useMemo(() => asObject(effectiveMemoryPack.structured), [effectiveMemoryPack.structured]);

  const storyItems = useMemo(() => normalizeItems(storySection?.items), [storySection]);
  const foreshadowItems = useMemo(() => normalizeItems(foreshadowSection?.items), [foreshadowSection]);
  const structuredCounts = useMemo(() => sectionCounts(structuredSection), [structuredSection]);
  const structuredText = useMemo(() => sectionTextMd(structuredSection), [structuredSection]);

  const list = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="inline-flex items-center gap-2 text-sm text-ink">
          <BookOpen size={16} />
          {"章节"}
        </div>
        <div className="flex items-center gap-2">
          <button
            className={clsx("btn btn-ghost px-2 py-1 text-xs", onlyDone ? "text-accent" : "text-subtext")}
            onClick={() => setOnlyDone((v) => !v)}
            type="button"
          >
            {onlyDone ? "显示全部" : "只看定稿"}
          </button>
          <span className="text-[11px] text-subtext">
            {doneCount}/{sortedChapters.length} {"已定稿"}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <ChapterVirtualList
          chapters={visibleChapters}
          activeId={resolvedActiveId}
          ariaLabel="章节列表"
          className="h-full"
          emptyState={
            sortedChapters.length === 0 ? (
              <div className="p-3 text-sm text-subtext">{"暂无章节"}</div>
            ) : (
              <div className="p-3 text-sm text-subtext">{"暂无已定稿章节"}</div>
            )
          }
          getStatusLabel={(chapter) => humanizeChapterStatusZh(chapter.status)}
          onSelectChapter={openChapter}
          variant="card"
        />
      </div>
    </div>
  );

  const memoryPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="inline-flex items-center gap-2 text-sm text-ink">
          <StickyNote size={16} />
          记忆标注
        </div>
        <button
          className={clsx("btn btn-secondary", memoryCollapsed ? null : "xl:hidden")}
          onClick={() => setMobileMemoryOpen(false)}
          type="button"
        >
          <ChevronLeft size={16} />
          关闭
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {!activeChapter ? <div className="text-sm text-subtext">请选择章节以查看命中。</div> : null}
        {effectiveMemoryLoading ? <div className="text-sm text-subtext">加载中...</div> : null}
        {effectiveMemoryError ? (
          <div className="rounded-atelier border border-border bg-surface p-3 text-sm text-subtext">
            <div className="text-ink">记忆标注加载失败</div>
            <div className="mt-1 text-xs text-subtext">
              {effectiveMemoryError.message} ({effectiveMemoryError.code})
              {effectiveMemoryError.requestId ? (
                <span className="ml-2">request_id: {effectiveMemoryError.requestId}</span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="mt-3 grid gap-3">
          <div className="panel p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm text-ink">剧情记忆（story_memory）</div>
              <div className="text-xs text-subtext">{storyItems.length} items</div>
            </div>
            <div className="mt-1 text-[11px] text-subtext">
              {getSectionEnabled(storySection) ? (
                <>enabled</>
              ) : (
                <>disabled: {getSectionDisabledReason(storySection) ?? "unknown"}</>
              )}
            </div>
            {storyItems.length ? (
              <div className="mt-2 grid gap-2">
                {storyItems.map((it) => (
                  <button
                    key={it.id}
                    className="ui-focus-ring ui-transition-fast w-full rounded-atelier border border-border bg-canvas px-3 py-2 text-left text-sm text-ink hover:bg-surface"
                    onClick={() => {
                      if (it.chapter_id) openEditor(it.chapter_id);
                      else if (activeChapter) openEditor(activeChapter.id);
                    }}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate">
                        {it.title?.trim() ? it.title : it.memory_type?.trim() ? `[${it.memory_type}]` : "StoryMemory"}
                      </div>
                      <div className="shrink-0 text-[11px] text-subtext">去写作</div>
                    </div>
                    {it.content_preview?.trim() ? (
                      <div className="mt-1 line-clamp-3 text-xs text-subtext">{it.content_preview}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-sm text-subtext">暂无命中</div>
            )}
          </div>

          <div className="panel p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm text-ink">未回收伏笔（foreshadow_open_loops）</div>
              <div className="text-xs text-subtext">{foreshadowItems.length} items</div>
            </div>
            <div className="mt-1 text-[11px] text-subtext">
              {getSectionEnabled(foreshadowSection) ? (
                <>enabled</>
              ) : (
                <>disabled: {getSectionDisabledReason(foreshadowSection) ?? "unknown"}</>
              )}
            </div>
            {foreshadowItems.length ? (
              <div className="mt-2 grid gap-2">
                {foreshadowItems.map((it) => (
                  <button
                    key={it.id}
                    className="ui-focus-ring ui-transition-fast w-full rounded-atelier border border-border bg-canvas px-3 py-2 text-left text-sm text-ink hover:bg-surface"
                    onClick={() => {
                      if (it.chapter_id) openEditor(it.chapter_id);
                      else if (activeChapter) openEditor(activeChapter.id);
                    }}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate">{it.title?.trim() ? it.title : "Foreshadow"}</div>
                      <div className="shrink-0 text-[11px] text-subtext">去写作</div>
                    </div>
                    {it.content_preview?.trim() ? (
                      <div className="mt-1 line-clamp-3 text-xs text-subtext">{it.content_preview}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-sm text-subtext">暂无命中</div>
            )}
          </div>

          <div className="panel p-3">
            <div className="text-sm text-ink">结构化记忆（structured）</div>
            <div className="mt-1 text-[11px] text-subtext">
              {getSectionEnabled(structuredSection) ? (
                <>enabled</>
              ) : (
                <>disabled: {getSectionDisabledReason(structuredSection) ?? "unknown"}</>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-subtext">
              {Object.keys(structuredCounts).length ? (
                Object.entries(structuredCounts).map(([k, v]) => (
                  <span key={k} className="rounded-atelier border border-border bg-canvas px-2 py-1">
                    {k}:{v}
                  </span>
                ))
              ) : (
                <span>暂无结构化命中</span>
              )}
            </div>
            {structuredText ? (
              <details className="mt-2">
                <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                  查看原始 text_md
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-atelier border border-border bg-surface p-2 text-xs text-ink">
                  {structuredText}
                </pre>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );

  if (!chapterListQuery.hasLoaded && chapterListQuery.loading) return <div className="text-subtext">加载中...</div>;

  return (
    <ToolContent className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-secondary lg:hidden" onClick={() => setMobileListOpen(true)} type="button">
            <List size={16} />
            章节列表
          </button>
          <button
            className={clsx("btn btn-secondary", memoryCollapsed ? null : "xl:hidden")}
            onClick={() => setMobileMemoryOpen(true)}
            type="button"
          >
            <StickyNote size={16} />
            记忆标注
          </button>
          <button
            className="btn btn-secondary hidden xl:inline-flex"
            onClick={() => setMemoryCollapsed((v) => !v)}
            type="button"
          >
            <StickyNote size={16} />
            {memoryCollapsed ? "显示记忆栏" : "沉浸阅读"}
          </button>
          <button
            className="btn btn-secondary hidden lg:inline-flex"
            onClick={() => setCollapsed((v) => !v)}
            type="button"
          >
            <List size={16} />
            {collapsed ? "显示章节列表" : "隐藏章节列表"}
          </button>

          <button
            className="btn btn-secondary"
            disabled={!prevChapter}
            onClick={() => (prevChapter ? openChapter(prevChapter.id) : undefined)}
            type="button"
          >
            上一章
          </button>
          <button
            className="btn btn-secondary"
            disabled={!nextChapter}
            onClick={() => (nextChapter ? openChapter(nextChapter.id) : undefined)}
            type="button"
          >
            下一章
          </button>
          <span className="text-[11px] text-subtext">快捷键：← / →</span>
        </div>

        <div className="min-w-0 truncate text-xs text-subtext">
          {activeChapterSummary ? `正在阅读：第 ${activeChapterSummary.number} 章` : "请选择章节"}
        </div>

        {activeChapterSummary ? (
          <button className="btn btn-secondary" onClick={() => openEditor(activeChapterSummary.id)} type="button">
            <Edit3 size={16} />
            去写作
          </button>
        ) : null}
      </div>

      <div className="flex gap-4">
        {!collapsed ? (
          <aside className="hidden w-[280px] shrink-0 lg:block">
            <div className="panel h-[calc(100vh-260px)] min-h-[520px] overflow-hidden">{list}</div>
          </aside>
        ) : null}

        <section className="min-w-0 flex-1">
          <div className="panel p-8">
            {activeChapterSummary ? (
              <>
                <div className="mb-4">
                  <div className="font-content text-2xl text-ink">
                    第 {activeChapterSummary.number} 章
                    {activeChapterSummary.title?.trim() ? ` · ${activeChapterSummary.title}` : ""}
                  </div>
                  {activeChapterSummary.status !== "done" ? (
                    <div className="mt-1 text-xs text-subtext">
                      提示：本章状态为 {humanizeChapterStatusZh(activeChapterSummary.status)}。
                    </div>
                  ) : null}
                </div>
                <div className="atelier-content mx-auto max-w-4xl text-ink">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {loadingChapter ? "_(loading...)_" : activeChapter?.content_md || "_（空）_"}
                  </ReactMarkdown>
                </div>
              </>
            ) : (
              <div className="text-subtext">暂无可阅读内容</div>
            )}
          </div>
        </section>

        {!memoryCollapsed ? (
          <aside className="hidden w-[340px] shrink-0 xl:block">
            <div className="panel h-[calc(100vh-260px)] min-h-[520px] overflow-hidden">{memoryPanel}</div>
          </aside>
        ) : null}
      </div>

      <Drawer
        open={mobileListOpen}
        onClose={() => setMobileListOpen(false)}
        side="bottom"
        overlayClassName="lg:hidden"
        ariaLabel="章节列表"
        panelClassName="h-[85vh] w-full overflow-hidden rounded-atelier border border-border bg-surface shadow-sm"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm text-ink">章节列表</div>
          <button className="btn btn-secondary" onClick={() => setMobileListOpen(false)} type="button">
            <ChevronLeft size={16} />
            关闭
          </button>
        </div>
        {list}
      </Drawer>

      <Drawer
        open={mobileMemoryOpen}
        onClose={() => setMobileMemoryOpen(false)}
        side="bottom"
        overlayClassName={memoryCollapsed ? undefined : "xl:hidden"}
        ariaLabel="记忆标注"
        panelClassName="h-[85vh] w-full overflow-hidden rounded-atelier border border-border bg-surface shadow-sm"
      >
        {memoryPanel}
      </Drawer>
    </ToolContent>
  );
}
