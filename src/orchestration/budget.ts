/** 一批工具调用的成本 / 并发规划（D-22）。
 *
 * `isParallelSafeTool` 只按 `access === "read"` 判并发，把 `explore` 子代理也算成
 * 「无副作用、随便并发」。但一个 explore 会拉起最多 4 轮模型请求，一批 N 个就是
 * 成本 ×N；MCP / exec 类还要弹授权框。规划层把调用分成三类：
 *   - `cheap`：工程内只读，按 `MAX_CONCURRENT_READS` 分波并发；
 *   - `expensive`：会派生模型请求 / 外部调用，串行，且**每批有硬上限**；
 *   - `gated`：写 / 执行 / 未知 / 需审批，串行（保持原始相对顺序）。
 *
 * 超限的 expensive 调用不执行，直接产出一条可读 error 记录——这是真正的成本闸门，
 * 不是「限流之后慢慢跑完」。纯函数，不依赖 React / Tauri，便于单测。
 */

export const MAX_CONCURRENT_READS = 4;
export const MAX_EXPENSIVE_PER_BATCH = 1;

export type BatchClass = "cheap" | "expensive" | "gated";

export interface BatchPlan {
  /** 每层内并发、层与层之间串行；元素是 calls 的下标 */
  waves: number[][];
  /** 串行层：expensive + gated，按原始下标升序 */
  serial: number[];
  /** 因成本闸门被跳过的调用，调用方据此生成 error 记录 */
  skipped: { idx: number; reason: string }[];
}

export function planToolBatch(
  calls: readonly { name: string }[],
  classify: (name: string) => BatchClass,
  opts: { maxConcurrentReads?: number; maxExpensivePerBatch?: number } = {},
): BatchPlan {
  const maxConcurrent = Math.max(1, opts.maxConcurrentReads ?? MAX_CONCURRENT_READS);
  const maxExpensive = Math.max(0, opts.maxExpensivePerBatch ?? MAX_EXPENSIVE_PER_BATCH);
  const cheap: number[] = [];
  const serial: number[] = [];
  const skipped: { idx: number; reason: string }[] = [];
  let expensiveSeen = 0;

  calls.forEach((call, idx) => {
    const cls = classify(call.name);
    if (cls === "cheap") {
      cheap.push(idx);
      return;
    }
    if (cls === "expensive") {
      expensiveSeen += 1;
      if (expensiveSeen > maxExpensive) {
        skipped.push({
          idx,
          reason: `本批高成本工具超过上限 ${maxExpensive}，已跳过以避免成本失控`,
        });
        return;
      }
    }
    serial.push(idx);
  });

  // 串行层按原始相对顺序执行：写/执行工具弹模态、授权框时不能乱序
  serial.sort((a, b) => a - b);
  const waves: number[][] = [];
  for (let i = 0; i < cheap.length; i += maxConcurrent) {
    waves.push(cheap.slice(i, i + maxConcurrent));
  }
  return { waves, serial, skipped };
}
