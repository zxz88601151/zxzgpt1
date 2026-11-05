import { describe, expect, it } from "vitest";
import { buildMessages, filterUsable, usableMessages } from "../state";
import { estimateTokens, estimateWireTokens } from "../lib/tokens";
import { forceCompact, maybeCompact, planCompaction, structuralSummary } from "./compact";
import type { Conversation, Message, Settings } from "../types";

function msg(role: "user" | "assistant", content: string, toolCalls?: Message["toolCalls"]): Message {
  return { role, content, createdAt: Date.now(), ...(toolCalls ? { toolCalls } : {}) };
}

const settings: Settings = {
  preset: "custom",
  baseUrl: "",
  apiKey: "",
  model: "m",
  temperature: 0.7,
  maxTokens: null,
  contextTurns: 100,
  systemPrompt: "你是助手",
  stream: true,
  theme: "dark",
  workspace: null,
  skills: [],
  skillAuto: true,
  skillsDir: null,
};

describe("estimateTokens", () => {
  it("空串为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("中文按字计、英文按 4 字符计", () => {
    // 6 个中文字 ≈ 6 token；英文 "hello world"（11 字符）≈ ceil(11/4)=3 token
    const zh = estimateTokens("中文中文中文");
    const en = estimateTokens("hello world");
    expect(zh).toBe(6);
    expect(en).toBe(3);
  });
  it("混排取二者之和", () => {
    const mix = estimateTokens("你好world"); // 2 zh + 5 latin = 2 + ceil(5/4)=2 => 4
    expect(mix).toBe(4);
  });
  it("estimateWireTokens 含 tool_calls 参数", () => {
    const wire = [
      { role: "user" as const, content: "你好" },
      { role: "assistant" as const, content: "", tool_calls: [{ id: "c1", type: "function" as const, function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
    ];
    const t = estimateWireTokens(wire);
    expect(t).toBeGreaterThan(estimateTokens("你好"));
  });
});

describe("filterUsable / usableMessages", () => {
  it("剔除报错、流式中、空内容消息", () => {
    const msgs = [
      msg("user", "hi"),
      msg("assistant", "", undefined), // 空内容且无工具 → 剔除
      { ...msg("assistant", ""), error: "boom" } as Message, // 报错 → 剔除
      { ...msg("assistant", "思考中"), streaming: true } as Message, // 流式中 → 剔除
      msg("assistant", "ok", [{ id: "c", name: "read_file", arguments: "{}" }]), // 有工具 → 保留
    ];
    const u = filterUsable(msgs);
    expect(u).toHaveLength(2);
  });
  it("usableMessages 与 filterUsable 等价", () => {
    const conv: Conversation = { id: "c", title: "t", messages: [msg("user", "a"), msg("assistant", "")], createdAt: 0, updatedAt: 0 };
    expect(usableMessages(conv)).toHaveLength(1);
  });
});

describe("structuralSummary", () => {
  it("抽取用户诉求与涉及文件", () => {
    const w = [
      msg("user", "帮我改一下登录页的样式\n多余文字"),
      msg("assistant", "好的", [{ id: "c1", name: "write_file", arguments: '{"path":"/a/login.tsx"}' }]),
      msg("assistant", "失败", [{ id: "c2", name: "edit_file", arguments: '{"path":"/b/x.ts"}', error: "权限不足" }]),
    ];
    const s = structuralSummary(w);
    expect(s).toContain("用户诉求：帮我改一下登录页的样式");
    expect(s).toContain("write_file");
    expect(s).toContain("/a/login.tsx");
    expect(s).toContain("权限不足");
  });
});

describe("planCompaction", () => {
  it("历史过短时无窗口可压（null）", () => {
    const conv: Conversation = { id: "c", title: "t", messages: [], createdAt: 0, updatedAt: 0 };
    const msgs = [msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d")];
    // 4 条全部在保留区（keepRounds=3 → keepRecent=6），无窗口
    expect(planCompaction(conv, msgs, 3)).toBeNull();
  });
  it("长历史划出正确窗口与 afterIndex", () => {
    const conv: Conversation = { id: "c", title: "t", messages: [], createdAt: 0, updatedAt: 0 };
    // 10 条可用；keepRounds=3 → keepRecent=6 → 压掉前 4 条（afterIndex=4）
    const msgs = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`));
    const plan = planCompaction(conv, msgs, 3);
    expect(plan).not.toBeNull();
    expect(plan!.afterIndex).toBe(4);
    expect(plan!.window).toHaveLength(4);
    expect(plan!.window[0].content).toBe("m0");
  });
  it("已压过则从上次截止继续", () => {
    const conv: Conversation = { id: "c", title: "t", messages: [], createdAt: 0, updatedAt: 0, compactAfterIndex: 4 };
    const msgs = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`));
    const plan = planCompaction(conv, msgs, 3);
    // 前 4 条已压（after=4），keepRecent=6 → newEnd=4，window 为空 → 应返回 null
    expect(plan).toBeNull();
  });
});

describe("buildMessages 压缩感知", () => {
  it("按 compactAfterIndex 只发送截止之后的消息", () => {
    const conv: Conversation = {
      id: "c",
      title: "t",
      messages: [msg("user", "旧消息A"), msg("assistant", "旧回复A"), msg("user", "新消息B"), msg("assistant", "新回复B")],
      createdAt: 0,
      updatedAt: 0,
      compactAfterIndex: 2,
      compactSummary: "- 旧摘要",
    };
    const out = buildMessages(conv, settings);
    // 摘要作为系统消息注入
    expect(out.some((m) => m.role === "system" && (m.content || "").includes("旧摘要"))).toBe(true);
    // 旧消息不进模型上下文
    expect(out.some((m) => (m.content || "").includes("旧消息A"))).toBe(false);
    // 新消息保留
    expect(out.some((m) => (m.content || "").includes("新消息B"))).toBe(true);
  });
});

describe("maybeCompact", () => {
  it("未超预算返回 null", async () => {
    const conv: Conversation = { id: "c", title: "t", messages: [msg("user", "hi"), msg("assistant", "yo")], createdAt: 0, updatedAt: 0 };
    const patch = await maybeCompact(conv, conv.messages, settings, "", {
      summarize: async (w) => "摘要:" + w.length,
      budget: 1_000_000,
      keepRounds: 3,
    });
    expect(patch).toBeNull();
  });
  it("超预算触发压缩并产出摘要+afterIndex", async () => {
    // 构造一个超长历史：20 条用户/助手交替，文本足够大
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(msg("user", "用户第" + i + "轮的长问题".repeat(20)));
      msgs.push(msg("assistant", "助手第" + i + "轮的很长回答".repeat(20)));
    }
    const conv: Conversation = { id: "c", title: "t", messages: msgs, createdAt: 0, updatedAt: 0 };
    const patch = await maybeCompact(conv, conv.messages, settings, "", {
      summarize: async (w) => "摘要了" + w.length + "条",
      budget: 50, // 极紧预算，必触发
      keepRounds: 3,
    });
    expect(patch).not.toBeNull();
    expect(patch!.summary).toContain("摘要了");
    expect(patch!.afterIndex).toBeGreaterThan(0);
    expect(patch!.summarizedCount).toBeGreaterThan(0);
  });
  it("模型摘要失败时退化成结构化兜底，不抛错", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(msg("user", "问题".repeat(30)));
      msgs.push(msg("assistant", "回答".repeat(30)));
    }
    const conv: Conversation = { id: "c", title: "t", messages: msgs, createdAt: 0, updatedAt: 0 };
    const patch = await maybeCompact(conv, conv.messages, settings, "", {
      summarize: async () => {
        throw new Error("network");
      },
      budget: 50,
      keepRounds: 3,
    });
    expect(patch).not.toBeNull();
    expect(patch!.summary).toContain("用户诉求"); // 结构化兜底产物
  });
});

describe("forceCompact", () => {
  it("未超预算也压一步", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(msg("user", "u" + i));
      msgs.push(msg("assistant", "a" + i));
    }
    const conv: Conversation = { id: "c", title: "t", messages: msgs, createdAt: 0, updatedAt: 0 };
    const patch = await forceCompact(conv, conv.messages, {
      summarize: async (w) => "Δ" + w.length,
      budget: 0,
      keepRounds: 3,
    });
    expect(patch).not.toBeNull();
    expect(patch!.afterIndex).toBe(18); // 24 条可用 - keepRecent(3轮×2)=6 → 压掉前 18 条
  });
  it("无空间时返回 null", async () => {
    const msgs = [msg("user", "a"), msg("assistant", "b")];
    const conv: Conversation = { id: "c", title: "t", messages: msgs, createdAt: 0, updatedAt: 0 };
    const patch = await forceCompact(conv, conv.messages, {
      summarize: async () => "x",
      budget: 0,
      keepRounds: 3,
    });
    expect(patch).toBeNull();
  });
});
