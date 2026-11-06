/** 会话纯状态变换的回归（App.tsx 接线层抽出的第二块）。 */

import { describe, expect, it } from "vitest";
import {
  addConversation,
  clearMessagesIn,
  normalizeImportedConversations,
  removeConversation,
  renameConversationIn,
  switchActive,
} from "./conversations";
import type { AppState, Conversation } from "../types";

const conv = (id: string, title = "对话"): Conversation => ({
  id, title, messages: [{ role: "user", content: "hi", createdAt: 1 }], createdAt: 1, updatedAt: 1,
});

const state = (): AppState => ({
  settings: {} as AppState["settings"],
  conversations: [conv("a"), conv("b")],
  activeId: "a",
});

describe("会话状态变换", () => {
  it("新建会话追加到末尾并成为当前", () => {
    const c = conv("c");
    const out = addConversation(state(), c);
    expect(out.conversations.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(out.activeId).toBe("c");
  });

  it("切换只改 activeId，不动会话列表", () => {
    const s = state();
    const out = switchActive(s, "b");
    expect(out.activeId).toBe("b");
    expect(out.conversations).toBe(s.conversations); // 复用同一引用，不重建列表
    expect(out.conversations.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("重命名去掉首尾空格；空标题保留原名", () => {
    expect(renameConversationIn([conv("a", "旧")], "a", "  新名  ")[0].title).toBe("新名");
    expect(renameConversationIn([conv("a", "旧")], "a", "   ")[0].title).toBe("旧");
    expect(renameConversationIn([conv("a", "旧")], "x", "新")[0].title).toBe("旧");
  });

  it("删除当前会话时 activeId 回落到第一条", () => {
    const out = removeConversation(state(), "a");
    expect(out.conversations.map((x) => x.id)).toEqual(["b"]);
    expect(out.activeId).toBe("b");
  });

  it("删除最后一个会话时 activeId 为 null", () => {
    const out = removeConversation({ settings: {} as AppState["settings"], conversations: [conv("a")], activeId: "a" }, "a");
    expect(out.conversations).toHaveLength(0);
    expect(out.activeId).toBeNull();
  });

  it("删除非当前会话不影响 activeId", () => {
    const out = removeConversation(state(), "b");
    expect(out.activeId).toBe("a");
  });

  it("清空消息只作用在当前会话", () => {
    const out = clearMessagesIn([conv("a"), conv("b")], "a");
    expect(out[0].messages).toHaveLength(0);
    expect(out[1].messages).toHaveLength(1);
  });
});

describe("normalizeImportedConversations", () => {
  it("单个会话对象也能导入，产出新 id", () => {
    const out = normalizeImportedConversations(conv("原id", "原标题"), 1000);
    expect(out).toHaveLength(1);
    expect(out[0].id).not.toBe("原id");
    expect(out[0].title).toBe("原标题");
    expect(out[0].createdAt).toBe(1000);
  });

  it("数组里坏数据跳过，好数据保留", () => {
    const out = normalizeImportedConversations([null, {}, { title: "x", messages: "不是数组" }, conv("a")], 5);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("对话");
  });

  it("消息字段规整：非法角色降级、内容转字符串、时间补齐", () => {
    const out = normalizeImportedConversations(
      { title: "t", messages: [{ role: "system", content: 42 }, { role: "assistant" }] },
      999
    );
    expect(out[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[0].messages[0].content).toBe("42");
    expect(out[0].messages[1].createdAt).toBe(999);
  });

  it("两次导入生成互不相同的 id，不会覆盖已有会话", () => {
    const a = normalizeImportedConversations(conv("x"), 1);
    const b = normalizeImportedConversations(conv("x"), 1);
    expect(a[0].id).not.toBe(b[0].id);
  });

  it("null / 非对象返回空数组", () => {
    expect(normalizeImportedConversations(null)).toEqual([]);
    expect(normalizeImportedConversations(42)).toEqual([]);
  });
});
