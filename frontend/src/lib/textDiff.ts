export function buildNaiveUnifiedLineDiff(before: string, after: string): string {
  const normalize = (value: string) => value.replace(/\r\n/g, "\n");
  const beforeLines = normalize(before).split("\n");
  const afterLines = normalize(after).split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);

  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      out.push(`  ${b ?? ""}`);
      continue;
    }
    if (typeof b === "string") out.push(`- ${b}`);
    if (typeof a === "string") out.push(`+ ${a}`);
  }
  return out.join("\n");
}
