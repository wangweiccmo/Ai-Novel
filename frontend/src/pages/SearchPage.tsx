import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { DebugDetails, DebugPageShell } from "../components/atelier/DebugPageShell";
import { useToast } from "../components/ui/toast";
import { copyText } from "../lib/copyText";
import { UI_COPY } from "../lib/uiCopy";
import { ApiError, apiJson } from "../services/apiClient";

type SearchItem = {
  source_type: string;
  source_id: string;
  title: string;
  snippet: string;
  jump_url: string | null;
  locator_json?: string | null;
};

type SearchQueryResponse = {
  items: SearchItem[];
  next_offset: number | null;
  mode?: string;
  fts_enabled?: boolean;
};

const SOURCE_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "chapter", label: UI_COPY.search.sourceLabels.chapter },
  { key: "outline", label: UI_COPY.search.sourceLabels.outline },
  { key: "worldbook_entry", label: UI_COPY.search.sourceLabels.worldbookEntry },
  { key: "character", label: UI_COPY.search.sourceLabels.character },
  { key: "story_memory", label: UI_COPY.search.sourceLabels.storyMemory },
  { key: "source_document", label: UI_COPY.search.sourceLabels.sourceDocument },
  { key: "project_table_row", label: UI_COPY.search.sourceLabels.projectTableRow },
  { key: "memory_entity", label: UI_COPY.search.sourceLabels.memoryEntity },
  { key: "memory_relation", label: UI_COPY.search.sourceLabels.memoryRelation },
  { key: "memory_evidence", label: UI_COPY.search.sourceLabels.memoryEvidence },
];

function dedupeItems(items: SearchItem[]): SearchItem[] {
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const key = `${it.source_type}:${it.source_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function SearchPage() {
  const { projectId } = useParams();
  const toast = useToast();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [sourcesState, setSourcesState] = useState<Record<string, boolean>>({});

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [debug, setDebug] = useState<{ mode?: string; fts_enabled?: boolean } | null>(null);

  const selectedSources = useMemo(() => {
    const selected = SOURCE_OPTIONS.filter((s) => sourcesState[s.key]).map((s) => s.key);
    return selected.length ? selected : null;
  }, [sourcesState]);

  const queryTokens = useMemo(() => {
    return query
      .trim()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10);
  }, [query]);

  const highlightText = useCallback((text: string) => {
    if (!text) return text;
    if (queryTokens.length === 0) return text;
    const escaped = queryTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
    const parts = text.split(pattern);
    if (parts.length === 1) return text;
    return parts.map((part, index) => {
      const isMatch = queryTokens.some((t) => part.toLowerCase() === t.toLowerCase());
      return isMatch ? (
        <mark key={`${part}-${index}`} className="rounded-atelier bg-accent/15 px-1 text-ink">
          {part}
        </mark>
      ) : (
        <span key={`${part}-${index}`}>{part}</span>
      );
    });
  }, [queryTokens]);

  const runQuery = useCallback(
    async (opts?: { append?: boolean }) => {
      if (!projectId) return;
      const append = Boolean(opts?.append);
      const q = query.trim();
      if (!q) return;
      if (loading) return;
      setLoading(true);
      try {
        const offset = append ? (nextOffset ?? 0) : 0;
        const res = await apiJson<SearchQueryResponse>(`/api/projects/${projectId}/search/query`, {
          method: "POST",
          body: JSON.stringify({
            q,
            sources: selectedSources ?? [],
            limit: 20,
            offset,
          }),
        });

        const data = res.data;
        const nextItems = Array.isArray(data.items) ? data.items : [];
        setItems((prev) => (append ? dedupeItems([...prev, ...nextItems]) : dedupeItems(nextItems)));
        setNextOffset(typeof data.next_offset === "number" ? data.next_offset : null);
        setDebug({ mode: data.mode, fts_enabled: data.fts_enabled });
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
        toast.toastError(`${err.message} (${err.code})`, err.requestId);
      } finally {
        setLoading(false);
      }
    },
    [loading, nextOffset, projectId, query, selectedSources, toast],
  );

  const clear = useCallback(() => {
    setQuery("");
    setItems([]);
    setNextOffset(null);
    setDebug(null);
  }, []);

  const toggleSource = useCallback((key: string) => {
    setSourcesState((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const sourceLabel = useCallback((sourceType: string) => {
    switch (sourceType) {
      case "chapter":
        return UI_COPY.search.sourceLabels.chapter;
      case "outline":
        return UI_COPY.search.sourceLabels.outline;
      case "worldbook_entry":
        return UI_COPY.search.sourceLabels.worldbookEntry;
      case "character":
        return UI_COPY.search.sourceLabels.character;
      case "story_memory":
        return UI_COPY.search.sourceLabels.storyMemory;
      case "source_document":
        return UI_COPY.search.sourceLabels.sourceDocument;
      case "project_table_row":
        return UI_COPY.search.sourceLabels.projectTableRow;
      case "memory_entity":
        return UI_COPY.search.sourceLabels.memoryEntity;
      case "memory_relation":
        return UI_COPY.search.sourceLabels.memoryRelation;
      case "memory_evidence":
        return UI_COPY.search.sourceLabels.memoryEvidence;
      default:
        return sourceType;
    }
  }, []);

  const canJump = useCallback((it: SearchItem) => {
    if (it.jump_url && it.jump_url.startsWith("/")) return true;
    return (
      it.source_type === "chapter" ||
      it.source_type === "outline" ||
      it.source_type === "worldbook_entry" ||
      it.source_type === "character" ||
      it.source_type === "story_memory" ||
      it.source_type === "source_document" ||
      it.source_type === "project_table_row" ||
      it.source_type === "memory_entity" ||
      it.source_type === "memory_relation" ||
      it.source_type === "memory_evidence"
    );
  }, []);

  const jump = useCallback(
    (it: SearchItem) => {
      if (!projectId) return;
      if (it.source_type !== "worldbook_entry") {
        const raw = String(it.jump_url || "").trim();
        if (raw && raw.startsWith("/")) {
          navigate(raw);
          return;
        }
      }
      if (it.source_type === "chapter") {
        navigate(`/projects/${projectId}/writing?chapterId=${encodeURIComponent(it.source_id)}`);
        return;
      }
      if (it.source_type === "outline") {
        navigate(`/projects/${projectId}/outline`);
        return;
      }
      if (it.source_type === "worldbook_entry") {
        const params = new URLSearchParams();
        const search = String(it.title || query.trim()).trim();
        if (search) params.set("search", search);
        navigate(`/projects/${projectId}/worldbook${params.toString() ? `?${params.toString()}` : ""}`);
        return;
      }
      if (it.source_type === "character") {
        navigate(`/projects/${projectId}/characters`);
        return;
      }
      if (it.source_type === "project_table_row") {
        navigate(`/projects/${projectId}/numeric-tables`);
        return;
      }
      if (it.source_type === "memory_entity" || it.source_type === "memory_evidence") {
        navigate(`/projects/${projectId}/structured-memory`);
        return;
      }
      toast.toastWarning(`该来源暂不支持跳转：${it.source_type}`);
    },
    [navigate, projectId, query, toast],
  );

  const copySourceId = useCallback(
    async (it: SearchItem) => {
      const ok = await copyText(it.source_id, { title: UI_COPY.search.copyIdFailTitle });
      if (ok) toast.toastSuccess(UI_COPY.search.copiedId);
      else toast.toastWarning(UI_COPY.search.copyFailedToast);
    },
    [toast],
  );

  const copyLocator = useCallback(
    async (it: SearchItem) => {
      const raw = String(it.locator_json ?? "").trim();
      if (!raw) {
        toast.toastWarning("该结果没有 locator 信息");
        return;
      }
      const ok = await copyText(raw, { title: UI_COPY.search.copyLocatorFailTitle });
      if (ok) toast.toastSuccess(UI_COPY.search.copiedLocator);
      else toast.toastWarning(UI_COPY.search.copyFailedToast);
    },
    [toast],
  );

  return (
    <DebugPageShell
      title={UI_COPY.search.title}
      description={UI_COPY.search.subtitle}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            aria-label="search_clear"
            disabled={loading && Boolean(query.trim())}
            onClick={clear}
          >
            {UI_COPY.search.clear}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-label="search_submit"
            disabled={!projectId || !query.trim() || loading}
            onClick={() => void runQuery({ append: false })}
          >
            {loading ? UI_COPY.common.loading : UI_COPY.search.search}
          </button>
        </div>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-2">
          <input
            className="input w-full"
            id="search_query"
            name="search_query"
            aria-label="search_query"
            placeholder={UI_COPY.search.queryPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runQuery({ append: false });
            }}
          />

          <div className="flex flex-wrap items-center gap-3">
            <div className="text-xs text-subtext">{UI_COPY.search.sourcesTitle}</div>
            {SOURCE_OPTIONS.map((s) => (
              <label key={s.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`search_source_${s.key}`}
                  name={`search_source_${s.key}`}
                  className="checkbox"
                  checked={Boolean(sourcesState[s.key])}
                  onChange={() => toggleSource(s.key)}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-2" aria-label="search_results">
          {!items.length ? (
            <div className="text-sm text-subtext">{UI_COPY.search.emptyHint}</div>
          ) : (
            items.map((it) => (
              <div key={`${it.source_type}:${it.source_id}`} className="panel p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">
                      {highlightText(it.title || it.source_id)}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtext">
                      <span>{sourceLabel(it.source_type)}</span>
                      <span className="font-mono">{it.source_type}</span>
                      <span className="font-mono break-all">{it.source_id}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-label="search_copy_id"
                      onClick={() => void copySourceId(it)}
                    >
                      {UI_COPY.search.copyId}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-label="search_copy_locator"
                      disabled={!String(it.locator_json ?? "").trim()}
                      onClick={() => void copyLocator(it)}
                    >
                      {UI_COPY.search.copyLocator}
                    </button>
                    {canJump(it) ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        aria-label="search_jump"
                        disabled={false}
                        onClick={() => jump(it)}
                      >
                        {UI_COPY.search.jump}
                      </button>
                    ) : (
                      <span title={UI_COPY.search.jumpDisabledHint}>
                        <button type="button" className="btn btn-primary" aria-label="search_jump" disabled>
                          {UI_COPY.search.jump}
                        </button>
                      </span>
                    )}
                  </div>
                </div>
                {it.snippet ? (
                  <div className="mt-2 whitespace-pre-wrap break-words rounded-atelier border border-border bg-canvas px-3 py-2 text-xs text-ink">
                    {highlightText(it.snippet)}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        {nextOffset !== null ? (
          <div className="flex justify-center">
            <button
              type="button"
              className="btn btn-secondary"
              aria-label="search_load_more"
              disabled={loading}
              onClick={() => void runQuery({ append: true })}
            >
              {UI_COPY.search.loadMore}
            </button>
          </div>
        ) : null}

        <DebugDetails title={UI_COPY.search.debugTitle} defaultOpen={false}>
          <pre className="overflow-auto whitespace-pre-wrap break-words text-xs text-subtext">
            {JSON.stringify({ projectId, selectedSources, nextOffset, debug }, null, 2)}
          </pre>
        </DebugDetails>
      </div>
    </DebugPageShell>
  );
}
