/** 用户正则的安全边界（D-21）。
 *
 * `search_files` 会把模型给的 query 编译成 `RegExp` 并对**每个文件的每一行**
 * 调 `test()`。JS 正则没有超时或中断机制：`(a+)+$` 这种 20 字符的模式在长行上
 * 就能灾难性回溯，把渲染进程卡死。防护只能放在**执行前**：
 *   1. 静态拒绝已知的高风险构造（宁可误拒，不能卡死）；
 *   2. 编译时再验一次语法（防止调用方绕过 validate 直接 run）；
 *   3. 被匹配的文本按行长截断，给漏网的模式设一个硬上限。
 *
 * 这不是完整的正则复杂度分析，也不打算是——目的是把「用户可控输入 → 无界计算」
 * 这条链掐断，而不是实现一个新的正则引擎。
 */

export const MAX_REGEX_LENGTH = 200;
/** 单行参与正则匹配的最大字符数；超长部分不参与 test（输出本来也只留 200 字符）。 */
export const MAX_TEST_LINE_CHARS = 2000;

/** 括号里有量词、括号外再跟量词：`(a+)+` / `(a*)*` / `(.*a){10}`。 */
const NESTED_QUANTIFIER = /\([^()]*[*+][^()]*\)\s*[*+{]/;
/** 括号内的 alternation 再被量词化：`(a|aa)+` / `(foo|foobar)*`（保守拒绝）。 */
const QUANTIFIED_ALTERNATION = /\([^()]*\|[^()]*\)\s*[*+{]/;
/** 三位以上的重复次数，或无上界的两位以上重复：{1000} / {20,}。 */
const LARGE_REPEAT = /\{\d{3,}(?:,\s*\d*)?\}/;
const UNBOUNDED_REPEAT = /\{\d{2,},\s*\}/;

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/** 返回 null 表示可用；否则是给模型看的中文拒绝原因。 */
export function safeRegExpError(pattern: string): string | null {
  if (typeof pattern !== "string" || !pattern.trim()) return "正则不能为空";
  if (pattern.length > MAX_REGEX_LENGTH) return `正则太长（上限 ${MAX_REGEX_LENGTH} 字符）`;
  if (NESTED_QUANTIFIER.test(pattern)) return "含嵌套量词，可能灾难性回溯";
  if (QUANTIFIED_ALTERNATION.test(pattern)) return "含量词化的分支重复，可能灾难性回溯";
  if (LARGE_REPEAT.test(pattern)) return "重复次数过大";
  if (UNBOUNDED_REPEAT.test(pattern)) return "无上界的大重复";
  if (countChar(pattern, "(") > 8) return "分组过多（上限 8 个）";
  if (countChar(pattern, "|") > 8) return "分支过多（上限 8 个）";
  if (countChar(pattern, "*") + countChar(pattern, "+") > 12) return "量词过多（上限 12 个）";
  try {
    new RegExp(pattern);
  } catch {
    return "正则语法不合法";
  }
  return null;
}

/**
 * 编译一条搜索正则。**run 入口也走这里**，不假设调用方一定先跑过 validate：
 * 审批重放、批量执行、子代理将来都可能直接调 `run`（与 `run_command` 二次查白名单同理）。
 */
export function compileSearchRegExp(pattern: string): { re: RegExp | null; error: string | null } {
  const error = safeRegExpError(pattern);
  if (error) return { re: null, error };
  try {
    return { re: new RegExp(pattern, "i"), error: null };
  } catch {
    return { re: null, error: "正则语法不合法" };
  }
}
