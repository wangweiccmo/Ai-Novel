"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiGenerateDrawer = AiGenerateDrawer;
var react_1 = require("react");
var Drawer_1 = require("../ui/Drawer");
var ProgressBar_1 = require("../ui/ProgressBar");
var uiCopy_1 = require("../../lib/uiCopy");
var toast_1 = require("../ui/toast");
var apiClient_1 = require("../../services/apiClient");
var IntentTemplateSelector_1 = require("./IntentTemplateSelector");
var StylePreviewDrawer_1 = require("./StylePreviewDrawer");
function AiGenerateDrawer(props) {
    var _this = this;
    var _a, _b, _c, _d, _e, _f, _g, _h;
    var onClose = props.onClose, open = props.open;
    var toast = (0, toast_1.useToast)();
    var streamProviderSupported = !!props.preset && props.preset.provider.startsWith("openai");
    var titleId = (0, react_1.useId)();
    var advancedPanelId = (0, react_1.useId)();
    var hasPromptOverride = props.genForm.prompt_override != null;
    var _j = (0, react_1.useState)(false), stylesLoading = _j[0], setStylesLoading = _j[1];
    var _k = (0, react_1.useState)([]), presets = _k[0], setPresets = _k[1];
    var _l = (0, react_1.useState)([]), userStyles = _l[0], setUserStyles = _l[1];
    var _m = (0, react_1.useState)(null), projectDefaultStyleId = _m[0], setProjectDefaultStyleId = _m[1];
    var _o = (0, react_1.useState)(null), stylesError = _o[0], setStylesError = _o[1];
    var _p = (0, react_1.useState)(false), advancedOpen = _p[0], setAdvancedOpen = _p[1];
    var _q = (0, react_1.useState)(false), stylePreviewOpen = _q[0], setStylePreviewOpen = _q[1];
    var _r = (0, react_1.useState)({
        style: "",
        pov: "",
        pacing: "",
        conflict: "",
        voice: "",
    }), intentCard = _r[0], setIntentCard = _r[1];
    var allStyles = (0, react_1.useMemo)(function () { return __spreadArray(__spreadArray([], presets, true), userStyles, true); }, [presets, userStyles]);
    var projectDefaultStyle = (0, react_1.useMemo)(function () { var _a; return (_a = allStyles.find(function (s) { return s.id === projectDefaultStyleId; })) !== null && _a !== void 0 ? _a : null; }, [allStyles, projectDefaultStyleId]);
    var closeDrawer = (0, react_1.useCallback)(function () {
        setAdvancedOpen(false);
        onClose();
    }, [onClose]);
    var intentHasContent = (0, react_1.useMemo)(function () { return Object.values(intentCard).some(function (v) { return v.trim(); }); }, [intentCard]);
    var applyIntentCard = (0, react_1.useCallback)(function () {
        if (!intentHasContent) {
            toast.toastWarning("意图卡片为空，先填写再应用。");
            return;
        }
        var block = [
            "【意图卡片】",
            intentCard.style ? "- \u98CE\u683C\uFF1A".concat(intentCard.style.trim()) : "",
            intentCard.pov ? "- \u89C6\u89D2\uFF1A".concat(intentCard.pov.trim()) : "",
            intentCard.pacing ? "- \u8282\u594F\uFF1A".concat(intentCard.pacing.trim()) : "",
            intentCard.conflict ? "- \u51B2\u7A81\uFF1A".concat(intentCard.conflict.trim()) : "",
            intentCard.voice ? "- \u6587\u98CE\uFF1A".concat(intentCard.voice.trim()) : "",
            "【/意图卡片】",
        ]
            .filter(Boolean)
            .join("\n");
        props.setGenForm(function (v) {
            var _a;
            var cleaned = ((_a = v.instruction) !== null && _a !== void 0 ? _a : "").replace(/【意图卡片】[\s\S]*?【\/意图卡片】\n*/g, "").trim();
            var nextInstruction = "".concat(block, "\n\n").concat(cleaned).trim();
            return __assign(__assign({}, v), { instruction: nextInstruction });
        });
        toast.toastSuccess("已将意图卡片应用到指令");
    }, [intentCard, intentHasContent, props, toast]);
    (0, react_1.useEffect)(function () {
        if (!open)
            return;
        var onKeyDown = function (e) {
            if (e.key !== "Escape")
                return;
            e.preventDefault();
            closeDrawer();
        };
        window.addEventListener("keydown", onKeyDown);
        return function () { return window.removeEventListener("keydown", onKeyDown); };
    }, [closeDrawer, open]);
    (0, react_1.useEffect)(function () {
        if (!open)
            return;
        if (!props.projectId)
            return;
        var cancelled = false;
        Promise.resolve()
            .then(function () { return __awaiter(_this, void 0, void 0, function () {
            var _a, presetRes, userRes, defRes;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (cancelled)
                            return [2 /*return*/, null];
                        setStylesLoading(true);
                        setStylesError(null);
                        return [4 /*yield*/, Promise.all([
                                (0, apiClient_1.apiJson)("/api/writing_styles/presets"),
                                (0, apiClient_1.apiJson)("/api/writing_styles"),
                                (0, apiClient_1.apiJson)("/api/projects/".concat(props.projectId, "/writing_style_default")),
                            ])];
                    case 1:
                        _a = _b.sent(), presetRes = _a[0], userRes = _a[1], defRes = _a[2];
                        return [2 /*return*/, { presetRes: presetRes, userRes: userRes, defRes: defRes }];
                }
            });
        }); })
            .then(function (res) {
            var _a, _b, _c, _d;
            if (cancelled || !res)
                return;
            setPresets((_a = res.presetRes.data.styles) !== null && _a !== void 0 ? _a : []);
            setUserStyles((_b = res.userRes.data.styles) !== null && _b !== void 0 ? _b : []);
            setProjectDefaultStyleId((_d = (_c = res.defRes.data.default) === null || _c === void 0 ? void 0 : _c.style_id) !== null && _d !== void 0 ? _d : null);
        })
            .catch(function (e) {
            if (cancelled)
                return;
            var err = e instanceof apiClient_1.ApiError
                ? e
                : new apiClient_1.ApiError({ code: "UNKNOWN", message: String(e), requestId: "unknown", status: 0 });
            setStylesError(err);
        })
            .finally(function () {
            if (cancelled)
                return;
            setStylesLoading(false);
        });
        return function () {
            cancelled = true;
        };
    }, [open, props.projectId]);
    return (<Drawer_1.Drawer open={open} onClose={closeDrawer} side="bottom" ariaLabelledBy={titleId} panelClassName="h-[85vh] w-full overflow-y-auto rounded-atelier border-t border-border bg-canvas p-6 shadow-sm sm:h-full sm:max-w-md sm:rounded-none sm:border-l sm:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-content text-2xl text-ink" id={titleId}>
            AI 生成
          </div>
          <div className="mt-1 text-xs text-subtext">
            {props.preset ? "".concat(props.preset.provider, " / ").concat(props.preset.model) : "未加载 LLM 配置"}
          </div>
          {hasPromptOverride ? (<div className="mt-2 callout-warning">
              已启用 Prompt 覆盖：生成将使用覆盖文本（可在 Prompt Inspector 回退默认）。
            </div>) : null}
        </div>
        <button className="btn btn-secondary" aria-label="关闭" onClick={closeDrawer} type="button">
          关闭
        </button>
      </div>

      <div className="mt-5 grid gap-4">
        <div className="panel p-3">
          <div className="text-sm font-medium text-ink">基础生成</div>
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1">
              <span className="text-xs text-subtext">用户指令</span>
              <textarea className="textarea atelier-content" disabled={props.generating} name="instruction" rows={5} value={props.genForm.instruction} onChange={function (e) {
            var value = e.target.value;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { instruction: value })); });
        }}/>
            </label>

            <div className="rounded-atelier border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink">意图卡片（可选）</div>
                <div className="flex items-center gap-2">
                  <button className="btn btn-secondary" disabled={props.generating} onClick={function () {
            return setIntentCard({ style: "", pov: "", pacing: "", conflict: "", voice: "" });
        }} type="button">
                    清空
                  </button>
                  <button className="btn btn-primary" disabled={props.generating} onClick={applyIntentCard} type="button">
                    应用到指令
                  </button>
                </div>
              </div>
              <IntentTemplateSelector_1.IntentTemplateSelector disabled={props.generating} currentValues={intentCard} onApplyTemplate={function (values) { return setIntentCard(values); }}/>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-[11px] text-subtext">风格</span>
                  <input className="input" value={intentCard.style} onChange={function (e) { return setIntentCard(function (v) { return (__assign(__assign({}, v), { style: e.target.value })); }); }} placeholder="如：冷峻克制 / 轻快幽默"/>
                </label>
                <label className="grid gap-1">
                  <span className="text-[11px] text-subtext">视角</span>
                  <input className="input" value={intentCard.pov} onChange={function (e) { return setIntentCard(function (v) { return (__assign(__assign({}, v), { pov: e.target.value })); }); }} placeholder="如：第一人称 / 第三人称限定"/>
                </label>
                <label className="grid gap-1">
                  <span className="text-[11px] text-subtext">节奏</span>
                  <input className="input" value={intentCard.pacing} onChange={function (e) { return setIntentCard(function (v) { return (__assign(__assign({}, v), { pacing: e.target.value })); }); }} placeholder="如：快节奏 / 稳步推进"/>
                </label>
                <label className="grid gap-1">
                  <span className="text-[11px] text-subtext">冲突</span>
                  <input className="input" value={intentCard.conflict} onChange={function (e) { return setIntentCard(function (v) { return (__assign(__assign({}, v), { conflict: e.target.value })); }); }} placeholder="如：角色目标冲突 / 外部危机"/>
                </label>
                <label className="grid gap-1 sm:col-span-2">
                  <span className="text-[11px] text-subtext">文风</span>
                  <input className="input" value={intentCard.voice} onChange={function (e) { return setIntentCard(function (v) { return (__assign(__assign({}, v), { voice: e.target.value })); }); }} placeholder="如：细腻写实 / 画面感强"/>
                </label>
              </div>
              <div className="mt-2 text-[11px] text-subtext">
                应用后会在“用户指令”前插入意图卡片块，可随时修改或删除。
              </div>
            </div>

            <label className="grid gap-1">
              <span className="text-xs text-subtext">目标字数（中文按字数=字符数）</span>
              <input className="input" disabled={props.generating} min={100} name="target_word_count" type="number" value={(_a = props.genForm.target_word_count) !== null && _a !== void 0 ? _a : ""} onChange={function (e) {
            var next = e.currentTarget.valueAsNumber;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { target_word_count: Number.isNaN(next) ? null : next })); });
        }}/>
            </label>

            <label className="grid gap-1">
              <span className="text-xs text-subtext">风格</span>
              <select className="select" disabled={props.generating || stylesLoading} name="style_id" value={(_b = props.genForm.style_id) !== null && _b !== void 0 ? _b : ""} onChange={function (e) {
            var value = e.target.value;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { style_id: value ? value : null })); });
        }} aria-label="gen_style_id">
                <option value="">自动（使用项目默认）</option>
                <optgroup label="系统预设">
                  {presets.map(function (s) { return (<option key={s.id} value={s.id}>
                      {s.name}
                    </option>); })}
                </optgroup>
                <optgroup label="我的风格">
                  {userStyles.map(function (s) { return (<option key={s.id} value={s.id}>
                      {s.name}
                    </option>); })}
                </optgroup>
              </select>
              <div className="text-[11px] text-subtext">
                项目默认：{projectDefaultStyle ? projectDefaultStyle.name : "（未设置）"}
                {stylesError ? " | \u52A0\u8F7D\u5931\u8D25\uFF1A".concat(stylesError.code) : ""}
              </div>
              <button className="btn btn-secondary mt-1 text-[11px]" disabled={props.generating || stylesLoading} onClick={function () { return setStylePreviewOpen(true); }} type="button">
                预览风格
              </button>
            </label>
          </div>
        </div>

        <div className="panel p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-ink">生成前/后检查</div>
            <div className="flex items-center gap-2">
              <button className="btn btn-secondary" disabled={props.generating || !props.activeChapter} onClick={props.onOpenPromptInspector} type="button">
                前置检查
              </button>
              <button className="btn btn-secondary" disabled={props.generating || !props.activeChapter || !props.onOpenSelfCheck} onClick={function () { var _a; return (_a = props.onOpenSelfCheck) === null || _a === void 0 ? void 0 : _a.call(props); }} type="button">
                生成后自检
              </button>
            </div>
          </div>
          <div className="mt-2 text-[11px] text-subtext">
            前置检查用于确认提示词与上下文注入；自检会对生成内容做一致性与逻辑检查。
          </div>
        </div>

        <div className="panel p-3">
          <div className="text-sm font-medium text-ink">记忆注入</div>

          <div className="mt-3">
            <label className="flex items-center justify-between gap-3 text-sm text-ink">
              <span>{uiCopy_1.UI_COPY.writing.memoryInjectionToggle}</span>
              <input className="checkbox" checked={props.genForm.memory_injection_enabled} disabled={props.generating} name="memory_injection_enabled" onChange={function (e) {
            var checked = e.target.checked;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_injection_enabled: checked })); });
        }} type="checkbox"/>
            </label>
            <div className="mt-1 text-[11px] text-subtext">{uiCopy_1.UI_COPY.writing.memoryInjectionHint}</div>

            {props.genForm.memory_injection_enabled ? (<div className="mt-2 rounded-atelier border border-border bg-surface p-3">
                <label className="grid gap-1">
                  <span className="text-xs text-subtext">记忆查询关键词（可选）</span>
                  <input className="input" disabled={props.generating} aria-label="memory_query_text" value={props.genForm.memory_query_text} onChange={function (e) {
                var value = e.currentTarget.value;
                props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_query_text: value })); });
            }}/>
                </label>
                <div className/>”mt-1 text-[11px] text-subtext”>
                  {}“留空将自动使用「用户指令 + 章节计划」。查询预处理（标签提取、排除规则）在项目设置中配置，可在上下文预览中查看效果。”}
                </div>
            ,
                <div className="mt-3 grid gap-2">
                  <div className="text-xs text-subtext">注入模块</div>
                  <div className="text-[11px] text-subtext">会影响本次生成提示词，并同步到「上下文预览」。</div>

                  <label className="flex items-center justify-between gap-3 text-sm text-ink">
                    <span>世界书（worldbook）</span>
                    <input className="checkbox" checked={props.genForm.memory_modules.worldbook} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { worldbook: checked }) })); });
                    }} type="checkbox"/>
                  </label>

                  <label className="flex items-center justify-between gap-3 text-sm text-ink">
                    <span>表格系统（tables）</span>
                    <input className="checkbox" checked={props.genForm.memory_modules.tables} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { tables: checked }) })); });
                    }} type="checkbox"/>
                  </label>

                  <details className="rounded-atelier border border-border bg-surface p-2">
                    <summary className="cursor-pointer text-sm text-ink">更多模块（高级）</summary>
                    <div className="mt-2 grid gap-2">
                      <label className="flex items-center justify-between gap-3 text-sm text-ink">
                        <span>剧情记忆（story_memory）</span>
                        <input className="checkbox" checked={props.genForm.memory_modules.story_memory} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { story_memory: checked }) })); });
                    }} type="checkbox"/>
                      </label>
                      <label className="flex items-center justify-between gap-3 text-sm text-ink">
                        <span>语义历史（semantic_history）</span>
                        <input className="checkbox" checked={props.genForm.memory_modules.semantic_history} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { semantic_history: checked }) })); });
                    }} type="checkbox"/>
                      </label>
                      <label className="flex items-center justify-between gap-3 text-sm text-ink">
                        <span>未回收伏笔（foreshadow_open_loops）</span>
                        <input className="checkbox" checked={props.genForm.memory_modules.foreshadow_open_loops} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { foreshadow_open_loops: checked }) })); });
                    }} type="checkbox"/>
                      </label>
                      <label className="flex items-center justify-between gap-3 text-sm text-ink">
                        <span>结构化记忆（structured）</span>
                        <input className="checkbox" checked={props.genForm.memory_modules.structured} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { structured: checked }) })); });
                    }} type="checkbox"/>
                      </label>
                      <label className="flex items-center justify-between gap-3 text-sm text-ink">
                        <span>向量 RAG（vector_rag）</span>
                        <input className="checkbox" checked={props.genForm.memory_modules.vector_rag} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { vector_rag: checked }) })); });
                    }} type="checkbox"/>
                      </label>
                      <label className="flex items-center justify-between gap-3 text-sm text-ink">
                        <span>关系图（graph）</span>
                        <input className="checkbox" checked={props.genForm.memory_modules.graph} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { graph: checked }) })); });
                    }} type="checkbox"/>
                      </label>
                      <label className="flex items-center justify-between gap-3 text-sm text-ink">
                        <span>Fractal（fractal）</span>
                        <input className="checkbox" checked={props.genForm.memory_modules.fractal} disabled={props.generating} onChange={function (e) {
                        var checked = e.target.checked;
                        props.setGenForm(function (v) { return (__assign(__assign({}, v), { memory_modules: __assign(__assign({}, v.memory_modules), { fractal: checked }) })); });
                    }} type="checkbox"/>
                      </label>
                    </div>
                  </details>
                </div>)
            :
        }
              </div>
            ) : null}
          </div>
        </div>

        {props.genForm.stream && props.generating ? (<div className="panel p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-subtext">
              <span className="truncate">{(_d = (_c = props.streamProgress) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "连接中..."}</span>
              <span className="shrink-0">{(_f = (_e = props.streamProgress) === null || _e === void 0 ? void 0 : _e.progress) !== null && _f !== void 0 ? _f : 0}%</span>
            </div>
            <ProgressBar_1.ProgressBar ariaLabel="章节流式生成进度" value={(_h = (_g = props.streamProgress) === null || _g === void 0 ? void 0 : _g.progress) !== null && _h !== void 0 ? _h : 0}/>
            {props.onCancelGenerate ? (<div className="flex justify-end">
                <button className="btn btn-secondary" onClick={props.onCancelGenerate} type="button">
                  取消生成
                </button>
              </div>) : null}
          </div>) : null}

        <div className="panel p-3">
          <div className="text-sm font-medium text-ink">上下文</div>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-2">
              <div className="text-xs text-subtext">上下文注入</div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input className="checkbox" checked={props.genForm.context.include_world_setting} disabled={props.generating} name="context_include_world_setting" onChange={function (e) {
            var checked = e.target.checked;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { context: __assign(__assign({}, v.context), { include_world_setting: checked }) })); });
        }} type="checkbox"/>
                世界观
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input className="checkbox" checked={props.genForm.context.include_style_guide} disabled={props.generating} name="context_include_style_guide" onChange={function (e) {
            var checked = e.target.checked;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { context: __assign(__assign({}, v.context), { include_style_guide: checked }) })); });
        }} type="checkbox"/>
                风格
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input className="checkbox" checked={props.genForm.context.include_constraints} disabled={props.generating} name="context_include_constraints" onChange={function (e) {
            var checked = e.target.checked;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { context: __assign(__assign({}, v.context), { include_constraints: checked }) })); });
        }} type="checkbox"/>
                约束
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input className="checkbox" checked={props.genForm.context.include_outline} disabled={props.generating} name="context_include_outline" onChange={function (e) {
            var checked = e.target.checked;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { context: __assign(__assign({}, v.context), { include_outline: checked }) })); });
        }} type="checkbox"/>
                大纲
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input className="checkbox" checked={props.genForm.context.include_smart_context} disabled={props.generating} name="context_include_smart_context" onChange={function (e) {
            var checked = e.target.checked;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { context: __assign(__assign({}, v.context), { include_smart_context: checked }) })); });
        }} type="checkbox"/>
                智能上下文
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input className="checkbox" checked={props.genForm.context.require_sequential} disabled={props.generating} name="context_require_sequential" onChange={function (e) {
            var checked = e.target.checked;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { context: __assign(__assign({}, v.context), { require_sequential: checked }) })); });
        }} type="checkbox"/>
                严格顺序
              </label>
            </div>

            <label className="grid gap-1">
              <span className="text-xs text-subtext">上一章注入</span>
              <select className="select" disabled={props.generating} name="previous_chapter" value={props.genForm.context.previous_chapter} onChange={function (e) {
            var value = e.target.value;
            props.setGenForm(function (v) { return (__assign(__assign({}, v), { context: __assign(__assign({}, v.context), { previous_chapter: value }) })); });
        }}>
                <option value="none">不注入</option>
                <option value="tail">结尾（推荐）</option>
                <option value="summary">摘要</option>
                <option value="content">正文</option>
              </select>
              <div className="text-[11px] text-subtext">结尾更利于强衔接，减少开头复述。</div>
            </label>

            <div className="grid gap-2">
              <div className="text-xs text-subtext">注入角色（可选）</div>
              {props.characters.length === 0 ? <div className="text-sm text-subtext">暂无角色</div> : null}
              <div className="max-h-40 overflow-auto rounded-atelier border border-border bg-surface p-2">
                {props.characters.map(function (c) { return (<label key={c.id} className="flex items-center gap-2 px-2 py-1 text-sm text-ink">
                    <input className="checkbox" checked={props.genForm.context.character_ids.includes(c.id)} disabled={props.generating} name={"character_".concat(c.id)} onChange={function (e) {
                var checked = e.target.checked;
                props.setGenForm(function (v) {
                    var next = new Set(v.context.character_ids);
                    if (checked)
                        next.add(c.id);
                    else
                        next.delete(c.id);
                    return __assign(__assign({}, v), { context: __assign(__assign({}, v.context), { character_ids: Array.from(next) }) });
                });
            }} type="checkbox"/>
                    <span className="truncate">{c.name}</span>
                  </label>); })}
              </div>
            </div>
          </div>
        </div>

        <div className="panel p-3">
          <button className="ui-focus-ring ui-pressable flex w-full items-center justify-between gap-3 rounded-atelier px-2 py-2 text-left hover:bg-canvas" aria-controls={advancedPanelId} aria-expanded={advancedOpen} onClick={function () { return setAdvancedOpen(function (v) { return !v; }); }} type="button">
            <span className="text-sm font-medium text-ink">高级参数</span>
            <span aria-hidden="true" className="text-xs text-subtext">
              {advancedOpen ? "收起" : "展开"}
            </span>
          </button>

          {!advancedOpen ? (<div className="mt-2 text-[11px] text-subtext">默认折叠：流式生成、规划、润色等。</div>) : null}

          {props.preset && props.genForm.stream && !streamProviderSupported ? (<div className="mt-2 text-xs text-warning">不支持流式，生成时会自动回退非流式生成</div>) : null}

          {advancedOpen ? (<div className="mt-3 grid gap-2" id={advancedPanelId}>
              <label className="flex items-center justify-between gap-3 text-sm text-ink">
                <span>流式生成（beta）</span>
                <input className="checkbox" checked={props.genForm.stream} disabled={props.generating} name="stream" onChange={function (e) {
                var checked = e.target.checked;
                props.setGenForm(function (v) { return (__assign(__assign({}, v), { stream: checked })); });
            }} type="checkbox"/>
              </label>

              <label className="flex items-center justify-between gap-3 text-sm text-ink">
                <span>先生成规划</span>
                <input className="checkbox" checked={props.genForm.plan_first} disabled={props.generating} name="plan_first" onChange={function (e) {
                var checked = e.target.checked;
                props.setGenForm(function (v) { return (__assign(__assign({}, v), { plan_first: checked })); });
            }} type="checkbox"/>
              </label>

              <label className="flex items-center justify-between gap-3 text-sm text-ink">
                <span>润色</span>
                <input className="checkbox" checked={props.genForm.post_edit} disabled={props.generating} name="post_edit" onChange={function (e) {
                var checked = e.target.checked;
                props.setGenForm(function (v) { return (__assign(__assign({}, v), { post_edit: checked, post_edit_sanitize: checked ? v.post_edit_sanitize : false })); });
            }} type="checkbox"/>
              </label>

              <label className="flex items-center justify-between gap-3 text-sm text-ink">
                <span>去味/一致性修复</span>
                <input className="checkbox" checked={props.genForm.post_edit_sanitize} disabled={props.generating || !props.genForm.post_edit} name="post_edit_sanitize" onChange={function (e) {
                var checked = e.target.checked;
                props.setGenForm(function (v) { return (__assign(__assign({}, v), { post_edit_sanitize: checked })); });
            }} type="checkbox"/>
              </label>
              <label className="flex items-center justify-between gap-3 text-sm text-ink">
                <span>正文优化</span>
                <input className="checkbox" checked={props.genForm.content_optimize} disabled={props.generating} name="content_optimize" onChange={function (e) {
                var checked = e.target.checked;
                props.setGenForm(function (v) { return (__assign(__assign({}, v), { content_optimize: checked })); });
            }} type="checkbox"/>
              </label>
              <div className="text-[11px] text-subtext">失败会降级保留原文，并记录原因。</div>
            </div>) : (<div id={advancedPanelId} hidden/>)}
        </div>

        <div className="panel p-3 text-xs text-subtext">
          生成与编辑内容会自动保存（有短暂延迟），也可随时点击“保存”或 Ctrl/Cmd+S 立即保存。
        </div>
      </div>
        ,
            <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className="btn btn-secondary" disabled={props.generating || !props.activeChapter} onClick={props.onOpenPromptInspector} type="button">
          预检/审查{hasPromptOverride ? "（覆盖中）" : ""}
        </button>
        {props.postEditCompareAvailable ? (<button className="btn btn-secondary" disabled={props.generating || !props.onOpenPostEditCompare} onClick={function () { var _a; return (_a = props.onOpenPostEditCompare) === null || _a === void 0 ? void 0 : _a.call(props); }} type="button">
            润色对比/回退
          </button>) : null}
        {props.contentOptimizeCompareAvailable ? (<button className="btn btn-secondary" disabled={props.generating || !props.onOpenContentOptimizeCompare} onClick={function () { var _a; return (_a = props.onOpenContentOptimizeCompare) === null || _a === void 0 ? void 0 : _a.call(props); }} type="button">
            正文优化对比/回退
          </button>) : null}
        {hasPromptOverride ? (<button className="btn btn-secondary" disabled={props.generating} onClick={function () { return props.setGenForm(function (v) { return (__assign(__assign({}, v), { prompt_override: null })); }); }} type="button">
            回退默认
          </button>) : null}
        {props.contextEstimate && props.contextEstimate.estimated_context_tokens > 0 ? (<div className="flex items-center gap-2 rounded-atelier border border-border bg-surface px-3 py-1.5 text-xs">
            <span className="text-subtext">上下文</span>
            <span className={props.contextEstimate.estimated_context_tokens > 100000
                        ? "font-medium text-red-500"
                        : props.contextEstimate.estimated_context_tokens > 50000
                            ? "font-medium text-yellow-600"
                            : "text-ink"}>
              ~{(props.contextEstimate.estimated_context_tokens / 1000).toFixed(1)}k tokens
            </span>
          </div>) : null}
        <button className="btn btn-primary" disabled={props.generating || !props.activeChapter} onClick={props.onGenerateReplace} type="button">
          {props.generating ? "生成中..." : "生成"}
        </button>
        {props.onSaveAndGenerateNext ? (<button className="btn btn-primary" disabled={props.generating || props.saving || !props.activeChapter} onClick={function () { var _a; return void ((_a = props.onSaveAndGenerateNext) === null || _a === void 0 ? void 0 : _a.call(props)); }} type="button">
            {props.saving ? "保存中..." : "保存并继续"}
          </button>) : null}
        <button className="btn btn-secondary" disabled={props.generating || !props.activeChapter} onClick={props.onGenerateAppend} type="button">
          {props.generating ? "生成中..." : "追加生成"}
        </button>
        <button className="btn btn-secondary" disabled={props.generating || props.saving || !props.activeChapter || !props.dirty} onClick={function () { return void props.onSave(); }} type="button">
          {props.saving ? "保存中..." : "保存"}
        </button>
      </div>);
    {
        props.projectId && (<StylePreviewDrawer_1.StylePreviewDrawer open={stylePreviewOpen} onClose={function () { return setStylePreviewOpen(false); }} projectId={props.projectId} presets={presets} userStyles={userStyles} currentStyleId={props.genForm.style_id}/>);
    }
    Drawer_1.Drawer >
    ;
    ;
}
