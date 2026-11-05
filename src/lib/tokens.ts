/** 与框架无关的 token 估算。
 *
 * 为什么需要：上下文压缩引擎要在「发给模型前」判断当前上下文是否超预算，
 * 但各家 tokenizer 不同、且我们不能每次都真去数。这里用一套对中文混排
 * 足够准的启发式估算：CJK 统一表意文字约 1 字≈1 token，其余字符约 4 个≈1 token。
 * 这是偏保守的近似——略高估能更早触发压缩，不会让模型真撞到硬上限。 */

import type { WireMessage } from "../types";

/** 单段文本的 token 估算。空串返回 0。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  let cjk = 0;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    // CJK 统一表意文字 + 扩展 A + 兼容表意：覆盖绝大多数中文、日文、韩文汉字
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    }
  }
  const nonCjk = len - cjk;
  return Math.max(1, Math.ceil(cjk + nonCjk / 4));
}

/** 一组发给上游的消息的总 token 估算（含 tool_calls 参数）。 */
export function estimateWireTokens(messages: WireMessage[]): number {
  let sum = 0;
  for (const m of messages) {
    sum += estimateTokens(m.content || "");
    if (m.tool_calls?.length) sum += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return sum;
}
