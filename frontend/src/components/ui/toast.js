"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToastContext = void 0;
exports.useToast = useToast;
var react_1 = require("react");
exports.ToastContext = (0, react_1.createContext)(null);
function useToast() {
    var ctx = (0, react_1.useContext)(exports.ToastContext);
    if (!ctx)
        throw new Error("useToast must be used within ToastProvider");
    return ctx;
}
