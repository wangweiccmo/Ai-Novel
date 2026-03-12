// ---------------------------------------------------------------------------
// LCS-based line diff utility
// ---------------------------------------------------------------------------

export type DiffLine = {
  type: "same" | "add" | "remove";
  content: string;
};

/**
 * Compute a line-level diff between two strings using LCS (Longest Common Subsequence).
 * Returns an array of DiffLine entries suitable for colored rendering.
 */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const normalize = (v: string) => v.replace(/\r\n/g, "\n");
  const bLines = normalize(before).split("\n");
  const aLines = normalize(after).split("\n");

  const m = bLines.length;
  const n = aLines.length;

  // Build LCS length table (DP)
  // Use two rows to save memory: prev and curr
  let prev = new Uint32Array(n + 1);
  let curr = new Uint32Array(n + 1);

  // We need the full table for backtracking, so store directions
  // Direction: 0 = diagonal (match), 1 = up, 2 = left
  const dir = new Uint8Array((m + 1) * (n + 1));

  for (let i = 1; i <= m; i++) {
    curr = new Uint32Array(n + 1);
    for (let j = 1; j <= n; j++) {
      if (bLines[i - 1] === aLines[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        dir[i * (n + 1) + j] = 0; // diagonal
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        dir[i * (n + 1) + j] = 1; // up
      } else {
        curr[j] = curr[j - 1];
        dir[i * (n + 1) + j] = 2; // left
      }
    }
    prev = curr;
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dir[i * (n + 1) + j] === 0) {
      result.push({ type: "same", content: bLines[i - 1] });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || dir[i * (n + 1) + j] === 1)) {
      result.push({ type: "remove", content: bLines[i - 1] });
      i--;
    } else {
      result.push({ type: "add", content: aLines[j - 1] });
      j--;
    }
  }

  result.reverse();
  return result;
}

/**
 * Backward-compatible unified diff as plain text.
 * Uses the new LCS algorithm under the hood.
 */
export function buildNaiveUnifiedLineDiff(before: string, after: string): string {
  const lines = computeLineDiff(before, after);
  return lines
    .map((l) => {
      if (l.type === "add") return `+ ${l.content}`;
      if (l.type === "remove") return `- ${l.content}`;
      return `  ${l.content}`;
    })
    .join("\n");
}
