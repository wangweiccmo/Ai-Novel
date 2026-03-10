function formatWithKey(label: string, key: string): string {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) return label || "未知";
  return `${label || "未知"}（${normalizedKey}）`;
}

export function humanizeYesNo(value: boolean): string {
  return value ? "是（yes）" : "否（no）";
}

export function humanizeChapterStatus(status: string): string {
  const s = String(status || "").trim();
  if (s === "planned") return formatWithKey("计划中", s);
  if (s === "drafting") return formatWithKey("草稿", s);
  if (s === "proofreading") return formatWithKey("校对", s);
  if (s === "done") return formatWithKey("定稿", s);
  return s || "未知";
}

export function humanizeTaskStatus(status: string): string {
  const s = String(status || "").trim();
  if (s === "queued") return formatWithKey("排队中", s);
  if (s === "running") return formatWithKey("运行中", s);
  if (s === "done") return formatWithKey("完成", s);
  if (s === "succeeded") return formatWithKey("完成", s);
  if (s === "failed") return formatWithKey("失败", s);
  return s || "未知";
}

export function humanizeChangeSetStatus(status: string): string {
  const s = String(status || "").trim();
  if (s === "proposed") return formatWithKey("未应用", s);
  if (s === "applied") return formatWithKey("已应用", s);
  if (s === "rolled_back") return formatWithKey("已回滚", s);
  if (s === "failed") return formatWithKey("失败", s);
  return s || "未知";
}

export function humanizeMemberRole(role: string): string {
  const s = String(role || "").trim();
  if (s === "viewer") return formatWithKey("查看者", s);
  if (s === "editor") return formatWithKey("编辑者", s);
  if (s === "owner") return formatWithKey("拥有者", s);
  return s || "未知";
}
