/** 上下文压缩用的模型摘要：纯逻辑（拼 prompt），网络调用留在 App 的薄封装里。
 *  抽出来的目的是让「消息 → 压缩请求」这段能在没有 React / 没有网络的环境里单测。
 */

import type { Message, WireMessage } from "../types";

export const SUMMARIZE_SYSTEM_PROMPT =
  "你是上下文压缩器。把下面这段对话历史压缩为结构化摘要，保留：1) 用户的核心目标与已确认需求；" +
  "2) 涉及的文件路径与已做的修改/创建；3) 关键决策与未解决的问题；4) 重要的命令或错误信息。" +
  "用简洁中文要点列出，不要复述寒暄，控制在 300 字以内。";

/** 把一批历史消息折成 system + user 两条压缩请求消息。 */
export function buildSummarizeMessages(window: Message[]): WireMessage[] {
  const userText = window
    .map(
      (m) =>
        `${m.role === "assistant" ? "助手" : "用户"}: ${
          m.content || (m.toolCalls ? "[工具调用: " + m.toolCalls.map((t) => t.name).join(", ") + "]" : "")
        }`,
    )
    .join("\n\n");
  return [
    { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];
}
