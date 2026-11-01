import { describe, expect, it } from "vitest";
import { buildMessages, filterConversations, normalizeImportedMessages, titleFrom } from "./state";
import { DEFAULT_SETTINGS } from "./presets";
import { sliceContext } from "./lib/text";
import type { Conversation, Message, Settings } from "./types";

const msg = (role: "user" | "assistant", content: string, extra: Partial<Message> = {}): Message => ({
  role,
  content,
  createdAt: 1,
  ...extra,
});

const conv = (messages: Message[], title = "新对话"): Conversation => ({
  id: "c1",
  title,
  messages,
  createdAt: 1,
  updatedAt: 1,
});

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

describe("buildMessages", () => {
  it("没有系统提示词时不插入 system 消息", () => {
    const out = buildMessages(conv([msg("user", "你好")]), settings({ contextTurns: 0 }));
    expect(out).toEqual([{ role: "user", content: "你好" }]);
  });

  it("有系统提示词时放在最前面，并去掉首尾空白", () => {
    const out = buildMessages(conv([msg("user", "你好")]), settings({ systemPrompt: "  你是助手  " }));
    expect(out[0]).toEqual({ role: "system", content: "你是助手" });
  });

  it("轮数为 0 表示不带历史限制", () => {
    const c = conv([msg("user", "1"), msg("assistant", "2"), msg("user", "3")]);
    expect(buildMessages(c, settings({ contextTurns: 0 }))).toHaveLength(3);
  });

  it("轮数为 1 时带上一轮问答 + 本次提问", () => {
    const c = conv([msg("user", "1"), msg("assistant", "2"), msg("user", "3")]);
    const out = buildMessages(c, settings({ contextTurns: 1 }));
    expect(out.map((m) => m.content)).toEqual(["1", "2", "3"]);
  });

  it("轮数为 1 时更早的历史被裁掉", () => {
    const c = conv([
      msg("user", "老问题"),
      msg("assistant", "老回答"),
      msg("user", "上一问"),
      msg("assistant", "上一答"),
      msg("user", "本次"),
    ]);
    const out = buildMessages(c, settings({ contextTurns: 1 }));
    expect(out.map((m) => m.content)).toEqual(["上一问", "上一答", "本次"]);
  });

  it("剔除出错、流式中与空内容的消息", () => {
    const c = conv([
      msg("user", "问题"),
      msg("assistant", "", { streaming: true }),
      msg("assistant", "", { error: "上游 401" }),
      msg("assistant", "有效回答"),
    ]);
    const out = buildMessages(c, settings({ contextTurns: 0 }));
    expect(out.map((m) => m.content)).toEqual(["问题", "有效回答"]);
  });

  it("空助手占位不会挤掉真实的一轮上下文", () => {
    const c = conv([
      msg("user", "第一问"),
      msg("assistant", "第一答"),
      msg("user", "第二问"),
      msg("assistant", "", { streaming: true }),
    ]);
    const out = buildMessages(c, settings({ contextTurns: 1 }));
    expect(out.map((m) => m.content)).toEqual(["第一问", "第一答", "第二问"]);
  });
});

describe("sliceContext", () => {
  it("turns<=0 时原样返回", () => {
    const list = [{ role: "user" }, { role: "assistant" }];
    expect(sliceContext(list, 0)).toBe(list);
  });

  it("最后一条不是 user 时不特殊处理", () => {
    const list = [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }];
    expect(sliceContext(list, 1).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("titleFrom", () => {
  it("压缩空白并截断到 24 字", () => {
    expect(titleFrom("  你好   世界 ")).toBe("你好 世界");
    expect(titleFrom("字".repeat(40))).toHaveLength(24);
  });

  it("空文本回落到默认标题", () => {
    expect(titleFrom("   ")).toBe("新对话");
  });
});

describe("filterConversations", () => {
  const list: Conversation[] = [
    { ...conv([msg("user", "关于 Rust 的问题")], "Rust 讨论"), id: "a", updatedAt: 100 },
    { ...conv([msg("user", "关于 Python")], "脚本"), id: "b", updatedAt: 200 },
  ];

  it("按最近更新倒序", () => {
    expect(filterConversations(list, "").map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("命中标题", () => {
    expect(filterConversations(list, "rust").map((c) => c.id)).toEqual(["a"]);
  });

  it("命中消息正文", () => {
    expect(filterConversations(list, "python").map((c) => c.id)).toEqual(["b"]);
  });

  it("没有命中时返回空数组", () => {
    expect(filterConversations(list, "golang")).toEqual([]);
  });
});

describe("normalizeImportedMessages", () => {
  it("非法角色统一降级为 user", () => {
    const out = normalizeImportedMessages([
      { role: "assistant", content: "答" },
      { role: "system", content: "奇怪的系统消息" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("非数组返回空", () => {
    expect(normalizeImportedMessages(null)).toEqual([]);
    expect(normalizeImportedMessages({})).toEqual([]);
  });
});
