/** 从 App.tsx 抽出的工程逻辑层回归：纯变换与不触发 IPC 的分支。 */

import { describe, expect, it } from "vitest";
import { applyFileBlocks, patchMessageAt } from "./workspace";
import type { Conversation, Message } from "../types";

function msg(content: string): Message {
  return { role: "assistant", content, createdAt: 1 };
}

function conv(): Conversation {
  return {
    id: "c1",
    title: "会话",
    messages: [msg("第一句"), msg("第二句")],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("patchMessageAt：就地更新一条消息", () => {
  it("命中会话与下标时替换内容并刷新 updatedAt", () => {
    const list = [conv()];
    const out = patchMessageAt(list, "c1", 1, (m) => ({ ...m, content: "改过了" }), 999);
    expect(out[0].messages[1].content).toBe("改过了");
    expect(out[0].messages[0].content).toBe("第一句");
    expect(out[0].updatedAt).toBe(999);
  });

  it("不改原数组（返回新数组与新消息列表）", () => {
    const list = [conv()];
    const out = patchMessageAt(list, "c1", 0, (m) => ({ ...m, content: "x" }), 2);
    expect(list[0].messages[0].content).toBe("第一句");
    expect(out[0].messages).not.toBe(list[0].messages);
  });

  it("会话 id 不匹配 / 下标越界时原样返回，不抛异常", () => {
    const list = [conv()];
    expect(patchMessageAt(list, "other", 0, (m) => m, 2)[0]).toBe(list[0]);
    expect(patchMessageAt(list, "c1", 99, (m) => m, 2)[0]).toBe(list[0]);
  });
});

describe("applyFileBlocks：不触发 IPC 的分支", () => {
  it("空块直接返回零结果，不调任何文件 IPC", async () => {
    const out = await applyFileBlocks([], "s1");
    expect(out).toEqual({ results: [], ok: 0, fail: 0, unverified: 0, backedUp: 0 });
  });

  it("非法相对路径被拒，且不算成功（不写盘）", async () => {
    const out = await applyFileBlocks([{ path: "../evil.ts", content: "x" }], "s1");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].ok).toBe(false);
    expect(out.ok).toBe(0);
    expect(out.fail).toBe(1);
    expect(out.results[0].error).toBeTruthy();
  });
});
