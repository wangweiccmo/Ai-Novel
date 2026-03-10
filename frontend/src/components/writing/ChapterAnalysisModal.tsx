import { useId } from "react";

import { Modal } from "../ui/Modal";
import { ProgressBar } from "../ui/ProgressBar";

import type { ChapterAnalyzeResult } from "./types";

export function ChapterAnalysisModal(props: {
  open: boolean;
  analysisLoading: boolean;
  rewriteLoading: boolean;
  applyLoading: boolean;
  analysisFocus: string;
  setAnalysisFocus: (value: string) => void;
  analysisResult: ChapterAnalyzeResult | null;
  rewriteInstruction: string;
  setRewriteInstruction: (value: string) => void;
  onClose: () => void;
  onAnalyze: () => void;
  onApplyAnalysisToMemory: () => void;
  onLocateInEditor: (excerpt: string) => void;
  onRewriteFromAnalysis: () => void;
}) {
  const busy = props.analysisLoading || props.rewriteLoading || props.applyLoading;
  const titleId = useId();
  const quality = props.analysisResult?.quality_scores;
  const scoreItems = [
    { key: "overall", label: "整体", value: quality?.scores?.overall },
    { key: "coherence", label: "连贯", value: quality?.scores?.coherence },
    { key: "engagement", label: "张力", value: quality?.scores?.engagement },
    { key: "pacing", label: "节奏", value: quality?.scores?.pacing },
  ];
  const wordCount = quality?.word_count;
  const counts = quality?.counts;
  return (
    <Modal
      open={props.open}
      onClose={busy ? undefined : props.onClose}
      panelClassName="surface max-w-3xl p-5"
      ariaLabelledBy={titleId}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-content text-xl text-ink" id={titleId}>
            章节分析
          </div>
          <div className="mt-1 text-xs text-subtext">
            分析与重写只会写入“生成记录”；保存到记忆库会写入长期记忆（不影响章节正文）。
          </div>
        </div>
        <button className="btn btn-secondary" aria-label="关闭" onClick={props.onClose} disabled={busy} type="button">
          关闭
        </button>
      </div>

      <div className="mt-4 grid gap-3">
        <label className="grid gap-1">
          <span className="text-xs text-subtext">分析重点（可选）</span>
          <input
            className="input"
            value={props.analysisFocus}
            onChange={(e) => props.setAnalysisFocus(e.target.value)}
            disabled={busy}
            placeholder="例如：钩子/伏笔回收、节奏、人物动机、逻辑矛盾…"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={props.onAnalyze} type="button">
            {props.analysisLoading ? "分析中..." : props.analysisResult ? "重新分析" : "开始分析"}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!props.analysisResult || busy}
            onClick={props.onApplyAnalysisToMemory}
            type="button"
          >
            {props.applyLoading ? "保存中..." : "保存到记忆库"}
          </button>
          {props.analysisResult?.generation_run_id ? (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void navigator.clipboard.writeText(props.analysisResult?.generation_run_id ?? "")}
              type="button"
            >
              复制 run_id
            </button>
          ) : null}
        </div>

        {props.analysisResult ? (
          <div className="grid gap-4">
            {props.analysisResult.parse_error?.message ? (
              <div className="rounded-atelier border border-border bg-surface p-3 text-sm text-accent">
                解析失败：{props.analysisResult.parse_error.message}
                {props.analysisResult.parse_error.hint ? (
                  <div className="mt-1 text-xs text-subtext">hint: {props.analysisResult.parse_error.hint}</div>
                ) : null}
              </div>
            ) : null}

            {props.analysisResult.warnings && props.analysisResult.warnings.length > 0 ? (
              <div className="rounded-atelier border border-border bg-surface p-3 text-xs text-subtext">
                warnings: {props.analysisResult.warnings.join(", ")}
              </div>
            ) : null}

            {quality?.scores ? (
              <div className="grid gap-3 rounded-atelier border border-border bg-surface p-3">
                <div className="text-sm text-ink">质量评估（启发式）</div>
                <div className="text-xs text-subtext">
                  口径：结构要素密度 + 章节长度（仅供趋势参考）
                  {quality?.schema_version ? ` | ${quality.schema_version}` : ""}
                </div>
                <div className="mt-1 grid gap-2">
                  {scoreItems.map((item) => {
                    const value = typeof item.value === "number" ? item.value : null;
                    const percent = value == null ? 0 : Math.round(value * 100);
                    return (
                      <div key={item.key} className="grid gap-1">
                        <div className="flex items-center justify-between text-[11px] text-subtext">
                          <span>{item.label}</span>
                          <span className="text-ink">{value == null ? "-" : `${percent}%`}</span>
                        </div>
                        <ProgressBar
                          value={value == null ? 0 : percent}
                          ariaLabel={`quality_${item.key}`}
                          ariaValueText={value == null ? "-" : `${percent}%`}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 text-[11px] text-subtext">
                  字数：{wordCount ?? "-"} | Hooks：{counts?.hooks ?? 0} | Foreshadows：{counts?.foreshadows ?? 0} | Plot
                  Points：{counts?.plot_points ?? 0} | Suggestions：{counts?.suggestions ?? 0}
                </div>
                {quality?.report_md ? (
                  <details className="mt-1">
                    <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                      评分说明
                    </summary>
                    <pre className="mt-2 max-h-56 overflow-auto rounded-atelier border border-border bg-canvas p-3 text-[11px] text-ink">
                      {quality.report_md}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-3 rounded-atelier border border-border bg-surface p-3">
              <div className="text-sm text-ink">本章摘要</div>
              <div className="text-sm text-ink">
                {(props.analysisResult.analysis?.chapter_summary ?? "").trim() || "（空）"}
              </div>
            </div>

            <div className="grid gap-2 rounded-atelier border border-border bg-surface p-3">
              <div className="text-sm text-ink">Hooks / 钩子</div>
              {(props.analysisResult.analysis?.hooks ?? []).length === 0 ? (
                <div className="text-sm text-subtext">（无）</div>
              ) : (
                <div className="grid gap-2">
                  {(props.analysisResult.analysis?.hooks ?? []).map((it, idx) => (
                    <div key={idx} className="rounded-atelier border border-border bg-canvas p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-subtext">{(it.excerpt ?? "").trim() || "（无 excerpt）"}</div>
                        {it.excerpt ? (
                          <button
                            className="btn btn-ghost px-2 py-1 text-xs"
                            onClick={() => props.onLocateInEditor(it.excerpt ?? "")}
                            type="button"
                          >
                            定位
                          </button>
                        ) : null}
                      </div>
                      {it.note ? <div className="mt-2 text-sm text-ink">{it.note}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-2 rounded-atelier border border-border bg-surface p-3">
              <div className="text-sm text-ink">Foreshadows / 伏笔</div>
              {(props.analysisResult.analysis?.foreshadows ?? []).length === 0 ? (
                <div className="text-sm text-subtext">（无）</div>
              ) : (
                <div className="grid gap-2">
                  {(props.analysisResult.analysis?.foreshadows ?? []).map((it, idx) => (
                    <div key={idx} className="rounded-atelier border border-border bg-canvas p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-subtext">{(it.excerpt ?? "").trim() || "（无 excerpt）"}</div>
                        {it.excerpt ? (
                          <button
                            className="btn btn-ghost px-2 py-1 text-xs"
                            onClick={() => props.onLocateInEditor(it.excerpt ?? "")}
                            type="button"
                          >
                            定位
                          </button>
                        ) : null}
                      </div>
                      {it.note ? <div className="mt-2 text-sm text-ink">{it.note}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-2 rounded-atelier border border-border bg-surface p-3">
              <div className="text-sm text-ink">Plot Points / 情节点</div>
              {(props.analysisResult.analysis?.plot_points ?? []).length === 0 ? (
                <div className="text-sm text-subtext">（无）</div>
              ) : (
                <div className="grid gap-2">
                  {(props.analysisResult.analysis?.plot_points ?? []).map((it, idx) => (
                    <div key={idx} className="rounded-atelier border border-border bg-canvas p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-ink">{(it.beat ?? "").trim() || "（无 beat）"}</div>
                        {it.excerpt ? (
                          <button
                            className="btn btn-ghost px-2 py-1 text-xs"
                            onClick={() => props.onLocateInEditor(it.excerpt ?? "")}
                            type="button"
                          >
                            定位
                          </button>
                        ) : null}
                      </div>
                      {it.excerpt ? <div className="mt-2 text-xs text-subtext">{it.excerpt}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-2 rounded-atelier border border-border bg-surface p-3">
              <div className="text-sm text-ink">Suggestions / 修改建议</div>
              {(props.analysisResult.analysis?.suggestions ?? []).length === 0 ? (
                <div className="text-sm text-subtext">（无）</div>
              ) : (
                <div className="grid gap-2">
                  {(props.analysisResult.analysis?.suggestions ?? []).map((it, idx) => (
                    <div key={idx} className="rounded-atelier border border-border bg-canvas p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-ink">
                          {(it.title ?? "").trim() || "建议"}{" "}
                          {(it.priority ?? "").trim() ? (
                            <span className="text-xs text-subtext">({it.priority})</span>
                          ) : null}
                        </div>
                        {it.excerpt ? (
                          <button
                            className="btn btn-ghost px-2 py-1 text-xs"
                            onClick={() => props.onLocateInEditor(it.excerpt ?? "")}
                            type="button"
                          >
                            定位
                          </button>
                        ) : null}
                      </div>
                      {it.excerpt ? <div className="mt-2 text-xs text-subtext">{it.excerpt}</div> : null}
                      {it.issue ? <div className="mt-2 text-sm text-ink">问题：{it.issue}</div> : null}
                      {it.recommendation ? (
                        <div className="mt-2 text-sm text-ink">建议：{it.recommendation}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {props.analysisResult.analysis?.overall_notes ? (
              <div className="grid gap-2 rounded-atelier border border-border bg-surface p-3">
                <div className="text-sm text-ink">总体备注</div>
                <div className="text-sm text-ink">{props.analysisResult.analysis.overall_notes}</div>
              </div>
            ) : null}

            <details>
              <summary className="ui-transition-fast cursor-pointer text-xs text-subtext hover:text-ink">
                raw_output
              </summary>
              <pre className="mt-2 max-h-56 overflow-auto rounded-atelier border border-border bg-canvas p-3 text-xs text-ink">
                {props.analysisResult.raw_output ?? ""}
              </pre>
            </details>
          </div>
        ) : (
          <div className="text-sm text-subtext">暂无分析结果。</div>
        )}

        <div className="grid gap-3 rounded-atelier border border-border bg-surface p-3">
          <div className="text-sm text-ink">按建议重写（覆盖编辑器正文）</div>
          <label className="grid gap-1">
            <span className="text-xs text-subtext">重写指令（可选）</span>
            <input
              className="input"
              value={props.rewriteInstruction}
              onChange={(e) => props.setRewriteInstruction(e.target.value)}
              disabled={busy}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-subtext">重写结果不会自动保存，记得 Ctrl/Cmd+S 保存。</div>
            <button
              className="btn btn-primary"
              disabled={!props.analysisResult || busy}
              onClick={props.onRewriteFromAnalysis}
              type="button"
            >
              {props.rewriteLoading ? "重写中..." : "按建议重写并应用"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
