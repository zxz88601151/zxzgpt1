/** 上下文压缩 prompt 的纯逻辑回归。 */

import { describe, expect, it } from "vitest";
import { buildSummarizeMessages, SUMMARIZE_SYSTEM_PROMPT } from "./summarize";
import type { Message } from "../types";

describe("buildSummarizeMessages", () => {
  it("产出 system + user 两条，系统提示要求保留目标/路径/决策/报错", () => {
    const out = buildSummarizeMessages([
      { role: "user", content: "帮我改登录页", createdAt: 1 },
      { role: "assistant", content: "已改完", createdAt: 2 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe(SUMMARIZE_SYSTEM_PROMPT);
    expect(out[0].content).toMatch(/文件路径|核心目标/);
    expect(out[1].role).toBe("user");
    expect(out[1].content).toContain("用户: 帮我改登录页");
    expect(out[1].content).toContain("助手: 已改完");
  });

  it("没有正文但有工具调用的消息用占位，不变成空行", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      createdAt: 1,
      toolCalls: [
        { id: "1", name: "read_file", arguments: "{}", result: "" },
        { id: "2", name: "glob", arguments: "{}", result: "" },
      ],
    };
    expect(buildSummarizeMessages([m])[1].content).toContain("[工具调用: read_file, glob]");
  });

  it("空窗口仍产出两条消息，user 为空串", () => {
    const out = buildSummarizeMessages([]);
    expect(out).toHaveLength(2);
    expect(out[1].content).toBe("");
  });
});
