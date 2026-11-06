/** 用户正则的安全边界（D-21；独立复审 P1-2 加固）。
 *
 * `search_files` 会把模型给的 query 编译成 `RegExp` 并对每个文件的每一行调
 * `test()`。JS 正则没有超时或中断机制：`(a+)+$` 这种 20 字符的模式在长行上
 * 就能灾难性回溯，把渲染进程卡死。防护只能放在**执行前**：
 *   1. 静态拒绝「分组内部含量词/分支、分组又被量词化」——指数回溯的唯一来源；
 *   2. 编译时再验一次语法（防止调用方绕过 validate 直接 run）；
 *   3. 被匹配的文本按行长截断，兜住多项式回溯与超长行。
 *
 * **行长上限挡不住指数回溯**：`(a+)+$` 对约 30 个 a 就会卡死，远低于 2000。
 * 所以第 1 条才是主防线，宁可误拒也不放行。第 1 版只认括号内的 `*`/`+`，
 * `(a?)+$`、`(a{1,}){1,}$` 都能穿过（2026-11-06 独立复审发现）；第二版虽补了量词
 * token，却因风险不向上传播漏掉 `((a+))+$` 这类嵌套组（同日第二轮复审实测 >4s 挂死）。
 * 现在组的风险在闭合时传播给父组，「组内任意深度含歧义 + 组外量词化」统一判拒。
 *
 * 这不是完整的正则复杂度分析，也不打算是——目的是把「用户可控输入 → 无界计算」
 * 这条链掐断，而不是实现一个新的正则引擎。
 */

export const MAX_REGEX_LENGTH = 200;
/** 单行参与匹配的最大字符数；只兜多项式回溯与超长行，挡不住指数回溯。 */
export const MAX_TEST_LINE_CHARS = 2000;
export const MAX_QUANTIFIERS = 12;
export const MAX_GROUPS = 8;
export const MAX_ALTERNATIONS = 8;

type GroupRisk = "quantifier" | "alternation" | null;

export interface RegexRisk {
  /** 分组内含量词、分组又被量词化：(a+)+ / (a?)+ / (a{1,}){1,} */
  nestedQuantifier: boolean;
  /** 分组内含分支、分组又被量词化：(a|aa)+ */
  quantifiedAlternation: boolean;
  /** 量词 token 总数（* + ? {m,n} 都算，转义与字符类里的不算） */
  quantifiers: number;
}

/** 逐字符扫描，跳过转义与字符类；把「组内歧义 + 组外量词」这一组合找出来。 */
export function scanRegexRisk(pattern: string): RegexRisk {
  const stack: { risk: GroupRisk }[] = [];
  let lastClosedAt = -1;
  let lastClosedRisk: GroupRisk = null;
  let quantifiers = 0;
  let nestedQuantifier = false;
  let quantifiedAlternation = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i += 1; // 转义字符不是量词
      continue;
    }
    if (c === "[") {
      // 字符类整段跳过：里面的 * + ? { } | ( ) 都不是语法
      i += 1;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "(") {
      // (?: / (?= / (?! / (?<= / (?<! 的前导 ? 是组语法，不是量词
      if (pattern[i + 1] === "?") {
        i += 1;
        if (":=!<>".includes(pattern[i + 1] ?? "")) {
          i += 1;
          if (pattern[i] === "<" && "=!".includes(pattern[i + 1] ?? "")) i += 1;
        }
      }
      stack.push({ risk: null });
      continue;
    }
    if (c === ")") {
      const g = stack.pop();
      if (g) {
        lastClosedAt = i;
        lastClosedRisk = g.risk;
        // 风险必须向上传播：((a+))+$ 里内层组带量词，外层组「内部含歧义」
        // 同样成立。只留一个 lastClosedRisk 槽会被外层 ')' 的 null 覆盖，
        // 外层再被量词化时就漏判（2026-11-06 第二轮独立复审核实）。
        const parent = stack[stack.length - 1];
        if (parent && g.risk && parent.risk === null) parent.risk = g.risk;
      }
      continue;
    }
    if (c === "|") {
      const top = stack[stack.length - 1];
      if (top && top.risk === null) top.risk = "alternation";
      continue;
    }

    const tokenStart = i;
    let isQuantifier = c === "*" || c === "+" || c === "?";
    if (c === "{") {
      const m = /^\{\d+(?:,\s*\d*)?\}/.exec(pattern.slice(i));
      if (m) {
        isQuantifier = true;
        i += m[0].length - 1;
      }
    }
    if (!isQuantifier) continue;

    quantifiers += 1;
    // 量词紧跟在刚闭合的分组后面：组内已有量词/分支就构成灾难性回溯构造
    if (lastClosedAt === tokenStart - 1 && lastClosedRisk) {
      if (lastClosedRisk === "quantifier") nestedQuantifier = true;
      else quantifiedAlternation = true;
      lastClosedAt = -1;
    }
    const top = stack[stack.length - 1];
    if (top && top.risk === null) top.risk = "quantifier";
  }
  return { nestedQuantifier, quantifiedAlternation, quantifiers };
}

/** 三位以上的重复次数，或 {m,n} 里 n 过大：{1000} / {1000,} / {1,1000}。 */
const LARGE_REPEAT = /\{\d{3,}(?:,\s*\d*)?\}|\{\d+,\s*\d{3,}\}/;
/** 无上界的两位以上重复：{20,}。 */
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
  const risk = scanRegexRisk(pattern);
  if (risk.nestedQuantifier) return "含嵌套量词，可能灾难性回溯";
  if (risk.quantifiedAlternation) return "含量词化的分支重复，可能灾难性回溯";
  if (LARGE_REPEAT.test(pattern)) return "重复次数过大";
  if (UNBOUNDED_REPEAT.test(pattern)) return "无上界的大重复";
  if (countChar(pattern, "(") > MAX_GROUPS) return `分组过多（上限 ${MAX_GROUPS} 个）`;
  if (countChar(pattern, "|") > MAX_ALTERNATIONS) return `分支过多（上限 ${MAX_ALTERNATIONS} 个）`;
  if (risk.quantifiers > MAX_QUANTIFIERS) return `量词过多（上限 ${MAX_QUANTIFIERS} 个）`;
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
