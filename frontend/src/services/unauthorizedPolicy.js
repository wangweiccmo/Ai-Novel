"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldNotifyUnauthorized = shouldNotifyUnauthorized;
function shouldNotifyUnauthorized(status, errorCode) {
    if (status !== 401)
        return false;
    var code = String(errorCode !== null && errorCode !== void 0 ? errorCode : "")
        .trim()
        .toUpperCase();
    if (!code)
        return true;
    return code === "UNAUTHORIZED";
}
