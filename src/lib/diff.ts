/** 行级 diff（自实现 LCS，零依赖）。
 *
 * 只服务一个场景：给「模型改了你的文件」这件事一个能看懂的视图——哪些行删了、哪些加了。
 * 不做三方合并、不做词级高亮、不做 patch 应用。
 *
 * 大文件保护：先裁掉公共前后缀，再对中间块做 DP；中间块超过 `maxCells` 就直接
 * 整体按「旧全删 + 新全加」展示——宁可粗，也不要把内存吃爆。
 */

export type DiffType = "eq" | "add" | "del";

export interface DiffLine {
  type: DiffType;
  text: string;
  /** 旧文件里的行号（1 起；新增行为 undefined） */
  a?: number;
  /** 新文件里的行号（1 起；删除行为 undefined） */
  b?: number;
}

export interface DiffStats {
  add: number;
  del: number;
}

/** 行数超过这个量就不再逐行 DP，直接整体替换展示 */
const DEFAULT_MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const norm = text.replace(/\r\n/g, "\n");
  const lines = norm.split("\n");
  // 末尾换行会多出一个空行，去掉它，否则每个文件都会多出一行无意义的差异
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(oldText: string, newText: string, maxCells = DEFAULT_MAX_CELLS): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 公共前缀 / 后缀先剥掉，日常改几行时能省掉 99% 的计算
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ type: "eq", text: a[i], a: i + 1, b: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const cells = (midA.length + 1) * (midB.length + 1);

  if (midA.length === 0 || midB.length === 0 || cells > maxCells) {
    midA.forEach((line, i) => out.push({ type: "del", text: line, a: start + i + 1 }));
    midB.forEach((line, i) => out.push({ type: "add", text: line, b: start + i + 1 }));
  } else {
    out.push(...lcsDiff(midA, midB, start, start));
  }

  for (let k = 0; k < a.length - endA; k += 1) {
    out.push({ type: "eq", text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  }
  return out;
}

/** 对中间块跑标准 LCS，回溯出操作序列 */
function lcsDiff(a: string[], b: string[], aOffset: number, bOffset: number): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "eq", text: a[i], a: aOffset + i + 1, b: bOffset + j + 1 });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ type: "del", text: a[i], a: aOffset + i + 1 });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j], b: bOffset + j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i], a: aOffset + i + 1 });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j], b: bOffset + j + 1 });
    j += 1;
  }
  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === "add") add += 1;
    else if (l.type === "del") del += 1;
  }
  return { add, del };
}

/** 回执上的一行摘要，如 `+12 −3`；没有改动返回空串 */
export function diffBadge(lines: DiffLine[]): string {
  const { add, del } = diffStats(lines);
  if (!add && !del) return "";
  return [add ? `+${add}` : "", del ? `−${del}` : ""].filter(Boolean).join(" ");
}

/** 未改动且连续超过 2*keep 行的段落折起来，只看改动附近 */
export function collapseContext(lines: DiffLine[], keep = 3): (DiffLine | { type: "gap"; count: number })[] {
  const out: (DiffLine | { type: "gap"; count: number })[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type !== "eq") {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === "eq") j += 1;
    const run = j - i;
    if (run > keep * 2 + 1) {
      out.push(...lines.slice(i, i + keep));
      out.push({ type: "gap", count: run - keep * 2 });
      out.push(...lines.slice(j - keep, j));
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out;
}
