"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = void 0;
exports.apiJson = apiJson;
exports.apiForm = apiForm;
exports.apiDownloadMarkdown = apiDownloadMarkdown;
exports.apiDownloadAttachment = apiDownloadAttachment;
exports.sanitizeFilename = sanitizeFilename;
var unauthorizedPolicy_1 = require("./unauthorizedPolicy");
var ApiError = /** @class */ (function (_super) {
    __extends(ApiError, _super);
    function ApiError(args) {
        var _this = _super.call(this, args.message) || this;
        _this.name = "ApiError";
        _this.code = args.code;
        _this.requestId = args.requestId;
        _this.details = args.details;
        _this.status = args.status;
        return _this;
    }
    return ApiError;
}(Error));
exports.ApiError = ApiError;
var DEFAULT_TIMEOUT_MS = 120000;
function parseJsonSafe(res) {
    return __awaiter(this, void 0, void 0, function () {
        var text;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, res.text()];
                case 1:
                    text = _a.sent();
                    if (!text)
                        return [2 /*return*/, null];
                    try {
                        return [2 /*return*/, JSON.parse(text)];
                    }
                    catch (_b) {
                        return [2 /*return*/, { _raw: text }];
                    }
                    return [2 /*return*/];
            }
        });
    });
}
function fetchWithTimeout(path, init) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, _b, timeoutMs, externalSignal, rest, controller, timedOut, onAbort, timeoutEnabled, timeoutId, e_1;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _a = init !== null && init !== void 0 ? init : {}, _b = _a.timeoutMs, timeoutMs = _b === void 0 ? DEFAULT_TIMEOUT_MS : _b, externalSignal = _a.signal, rest = __rest(_a, ["timeoutMs", "signal"]);
                    controller = new AbortController();
                    timedOut = false;
                    onAbort = function () { return controller.abort(); };
                    if (externalSignal) {
                        if (externalSignal.aborted)
                            controller.abort();
                        else
                            externalSignal.addEventListener("abort", onAbort, { once: true });
                    }
                    timeoutEnabled = timeoutMs > 0;
                    timeoutId = timeoutEnabled
                        ? setTimeout(function () {
                            timedOut = true;
                            controller.abort();
                        }, timeoutMs)
                        : null;
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, fetch(path, __assign(__assign({}, rest), { credentials: (_c = rest.credentials) !== null && _c !== void 0 ? _c : "include", signal: controller.signal }))];
                case 2: return [2 /*return*/, _d.sent()];
                case 3:
                    e_1 = _d.sent();
                    if (timedOut) {
                        throw new ApiError({
                            code: "TIMEOUT",
                            message: "请求超时，请稍后重试",
                            requestId: "unknown",
                            status: 0,
                            details: e_1 instanceof Error ? e_1.message : String(e_1),
                        });
                    }
                    if (e_1 instanceof Error && e_1.name === "AbortError") {
                        throw new ApiError({
                            code: "REQUEST_ABORTED",
                            message: "请求已取消",
                            requestId: "unknown",
                            status: 0,
                            details: e_1.message,
                        });
                    }
                    throw new ApiError({
                        code: "NETWORK_ERROR",
                        message: "网络错误，请检查后端是否启动",
                        requestId: "unknown",
                        status: 0,
                        details: e_1 instanceof Error ? e_1.message : String(e_1),
                    });
                case 4:
                    if (timeoutId !== null)
                        clearTimeout(timeoutId);
                    if (externalSignal)
                        externalSignal.removeEventListener("abort", onAbort);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function notifyUnauthorized(requestId) {
    if (typeof window === "undefined")
        return;
    try {
        window.dispatchEvent(new CustomEvent("ainovel:unauthorized", { detail: { requestId: requestId } }));
    }
    catch (_a) {
        // ignore
    }
}
function apiJson(path, init) {
    return __awaiter(this, void 0, void 0, function () {
        var res, requestIdHeader, payload, typed;
        var _a, _b, _c, _d, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0: return [4 /*yield*/, fetchWithTimeout(path, __assign(__assign({}, init), { headers: __assign({ "Content-Type": "application/json" }, ((_a = init === null || init === void 0 ? void 0 : init.headers) !== null && _a !== void 0 ? _a : {})) }))];
                case 1:
                    res = _g.sent();
                    requestIdHeader = (_b = res.headers.get("X-Request-Id")) !== null && _b !== void 0 ? _b : undefined;
                    return [4 /*yield*/, parseJsonSafe(res)];
                case 2:
                    payload = (_g.sent());
                    if (typeof payload === "object" && payload && "ok" in payload) {
                        typed = payload;
                        if (typed.ok)
                            return [2 /*return*/, typed];
                        if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, typed.error.code))
                            notifyUnauthorized((_d = (_c = typed.request_id) !== null && _c !== void 0 ? _c : requestIdHeader) !== null && _d !== void 0 ? _d : "unknown");
                        throw new ApiError({
                            code: typed.error.code,
                            message: typed.error.message,
                            details: typed.error.details,
                            requestId: (_f = (_e = typed.request_id) !== null && _e !== void 0 ? _e : requestIdHeader) !== null && _f !== void 0 ? _f : "unknown",
                            status: res.status,
                        });
                    }
                    if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, null))
                        notifyUnauthorized(requestIdHeader !== null && requestIdHeader !== void 0 ? requestIdHeader : "unknown");
                    throw new ApiError({
                        code: "BAD_RESPONSE",
                        message: "响应格式错误",
                        requestId: requestIdHeader !== null && requestIdHeader !== void 0 ? requestIdHeader : "unknown",
                        status: res.status,
                        details: payload,
                    });
            }
        });
    });
}
function apiForm(path, form, init) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res, requestIdHeader, payload, typed;
        var _a, _b, _c, _d, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    headers = new Headers((_a = init === null || init === void 0 ? void 0 : init.headers) !== null && _a !== void 0 ? _a : {});
                    headers.delete("Content-Type");
                    return [4 /*yield*/, fetchWithTimeout(path, __assign(__assign({}, init), { headers: headers, body: form }))];
                case 1:
                    res = _g.sent();
                    requestIdHeader = (_b = res.headers.get("X-Request-Id")) !== null && _b !== void 0 ? _b : undefined;
                    return [4 /*yield*/, parseJsonSafe(res)];
                case 2:
                    payload = (_g.sent());
                    if (typeof payload === "object" && payload && "ok" in payload) {
                        typed = payload;
                        if (typed.ok)
                            return [2 /*return*/, typed];
                        if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, typed.error.code))
                            notifyUnauthorized((_d = (_c = typed.request_id) !== null && _c !== void 0 ? _c : requestIdHeader) !== null && _d !== void 0 ? _d : "unknown");
                        throw new ApiError({
                            code: typed.error.code,
                            message: typed.error.message,
                            details: typed.error.details,
                            requestId: (_f = (_e = typed.request_id) !== null && _e !== void 0 ? _e : requestIdHeader) !== null && _f !== void 0 ? _f : "unknown",
                            status: res.status,
                        });
                    }
                    if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, null))
                        notifyUnauthorized(requestIdHeader !== null && requestIdHeader !== void 0 ? requestIdHeader : "unknown");
                    throw new ApiError({
                        code: "BAD_RESPONSE",
                        message: "响应格式错误",
                        requestId: requestIdHeader !== null && requestIdHeader !== void 0 ? requestIdHeader : "unknown",
                        status: res.status,
                        details: payload,
                    });
            }
        });
    });
}
function apiDownloadMarkdown(path) {
    return __awaiter(this, void 0, void 0, function () {
        var res, contentType, requestIdHeader, content, cd, filename, payload, typed;
        var _a, _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0: return [4 /*yield*/, fetchWithTimeout(path)];
                case 1:
                    res = _f.sent();
                    contentType = (_a = res.headers.get("Content-Type")) !== null && _a !== void 0 ? _a : "";
                    requestIdHeader = (_b = res.headers.get("X-Request-Id")) !== null && _b !== void 0 ? _b : "unknown";
                    if (!contentType.includes("text/markdown")) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.text()];
                case 2:
                    content = _f.sent();
                    cd = (_c = res.headers.get("Content-Disposition")) !== null && _c !== void 0 ? _c : "";
                    filename = parseContentDispositionFilename(cd) || "ainovel.md";
                    return [2 /*return*/, { filename: filename, content: content }];
                case 3: return [4 /*yield*/, parseJsonSafe(res)];
                case 4:
                    payload = (_f.sent());
                    if (typeof payload === "object" && payload && "ok" in payload && payload.ok === false) {
                        typed = payload;
                        if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, typed.error.code))
                            notifyUnauthorized((_d = typed.request_id) !== null && _d !== void 0 ? _d : requestIdHeader);
                        throw new ApiError({
                            code: typed.error.code,
                            message: typed.error.message,
                            details: typed.error.details,
                            requestId: (_e = typed.request_id) !== null && _e !== void 0 ? _e : requestIdHeader,
                            status: res.status,
                        });
                    }
                    if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, null))
                        notifyUnauthorized(requestIdHeader);
                    throw new ApiError({
                        code: "BAD_RESPONSE",
                        message: "导出失败",
                        requestId: requestIdHeader,
                        status: res.status,
                        details: payload,
                    });
            }
        });
    });
}
function apiDownloadAttachment(path) {
    return __awaiter(this, void 0, void 0, function () {
        var res, requestIdHeader, cd, filename, blob, payload, typed;
        var _a, _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0: return [4 /*yield*/, fetchWithTimeout(path)];
                case 1:
                    res = _e.sent();
                    requestIdHeader = (_a = res.headers.get("X-Request-Id")) !== null && _a !== void 0 ? _a : "unknown";
                    cd = (_b = res.headers.get("Content-Disposition")) !== null && _b !== void 0 ? _b : "";
                    filename = parseContentDispositionFilename(cd);
                    if (!(res.ok && filename)) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.blob()];
                case 2:
                    blob = _e.sent();
                    return [2 /*return*/, { filename: filename, blob: blob, requestId: requestIdHeader }];
                case 3: return [4 /*yield*/, parseJsonSafe(res)];
                case 4:
                    payload = (_e.sent());
                    if (typeof payload === "object" && payload && "ok" in payload && payload.ok === false) {
                        typed = payload;
                        if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, typed.error.code))
                            notifyUnauthorized((_c = typed.request_id) !== null && _c !== void 0 ? _c : requestIdHeader);
                        throw new ApiError({
                            code: typed.error.code,
                            message: typed.error.message,
                            details: typed.error.details,
                            requestId: (_d = typed.request_id) !== null && _d !== void 0 ? _d : requestIdHeader,
                            status: res.status,
                        });
                    }
                    if ((0, unauthorizedPolicy_1.shouldNotifyUnauthorized)(res.status, null))
                        notifyUnauthorized(requestIdHeader);
                    throw new ApiError({
                        code: "BAD_RESPONSE",
                        message: "下载失败",
                        requestId: requestIdHeader,
                        status: res.status,
                        details: payload,
                    });
            }
        });
    });
}
function unquoteHeaderValue(value) {
    var trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
        return trimmed.slice(1, -1);
    return trimmed;
}
function sanitizeFilename(value) {
    var _a;
    var trimmed = value.trim();
    if (!trimmed)
        return "";
    var lastSegment = (_a = trimmed.split(/[/\\]/).pop()) !== null && _a !== void 0 ? _a : trimmed;
    var withoutNull = lastSegment.replaceAll("\0", "");
    var safe = withoutNull.replaceAll(/[\\/:*?"<>|]+/g, "_").trim();
    return safe.slice(0, 80);
}
function parseContentDispositionFilename(header) {
    var _a;
    if (!header)
        return null;
    var filenameStarMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
    if (filenameStarMatch === null || filenameStarMatch === void 0 ? void 0 : filenameStarMatch[1]) {
        var raw = unquoteHeaderValue(filenameStarMatch[1]);
        var parts = /^([^']*)'[^']*'(.*)$/.exec(raw);
        var encoded = (_a = parts === null || parts === void 0 ? void 0 : parts[2]) !== null && _a !== void 0 ? _a : raw;
        try {
            var decoded = decodeURIComponent(encoded);
            return sanitizeFilename(decoded) || null;
        }
        catch (_b) {
            return sanitizeFilename(encoded) || null;
        }
    }
    var filenameQuotedMatch = /filename\s*=\s*"([^"]+)"/i.exec(header);
    if (filenameQuotedMatch === null || filenameQuotedMatch === void 0 ? void 0 : filenameQuotedMatch[1])
        return sanitizeFilename(filenameQuotedMatch[1]) || null;
    var filenameMatch = /filename\s*=\s*([^;]+)/i.exec(header);
    if (filenameMatch === null || filenameMatch === void 0 ? void 0 : filenameMatch[1])
        return sanitizeFilename(unquoteHeaderValue(filenameMatch[1])) || null;
    return null;
}
