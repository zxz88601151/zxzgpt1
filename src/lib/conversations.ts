/** 会话增删改的纯状态变换（ADR 0001 第 5 步续，从 App.tsx 接线层抽出）。
 *
 * 只做「给一个 AppState / 会话列表，返回新的」，不碰 React、不碰 window.confirm、
 * 不碰授权撤回与滚动信号——那些副作用仍留在 App 里，由调用方决定何时发生。
 * 抽出来的目的：这些变换以前藏在五个 useCallback 内部，改一处要在脑内重放整条
 * 发送链路才能确认没坏；现在可以单独断言。
 */

import { uid } from "./text";
import type { AppState, Conversation, Message, Role } from "../types";

export function addConversation(state: AppState, conv: Conversation): AppState {
  return { ...state, conversations: [...state.conversations, conv], activeId: conv.id };
}

export function switchActive(state: AppState, id: string): AppState {
  return { ...state, activeId: id };
}

export function renameConversationIn(list: Conversation[], id: string, title: string): Conversation[] {
  const next = title.trim();
  return list.map((c) => (c.id === id ? { ...c, title: next || c.title } : c));
}

/** 删当前会话时 activeId 回落到列表第一条（沿用旧行为）；删后台会话不影响当前选择。 */
export function removeConversation(state: AppState, id: string): AppState {
  const conversations = state.conversations.filter((c) => c.id !== id);
  return {
    ...state,
    conversations,
    activeId: state.activeId === id ? conversations[0]?.id || null : state.activeId,
  };
}

export function clearMessagesIn(list: Conversation[], id: string): Conversation[] {
  return list.map((c) => (c.id === id ? { ...c, messages: [] } : c));
}

/**
 * 导入外部 JSON：只认「对象或对象数组、且 messages 是数组」的会话，其余一律丢弃。
 * 与 state.ts 的 normalizeImportedMessages 不同：这里产出完整 Conversation（含新 id），
 * 因为导入的会话要作为**独立新会话**追加，绝不能沿用文件里的 id 覆盖已有对话。
 * 不抛异常，坏数据由调用方按「导入了 0 个」处理。
 */
export function normalizeImportedConversations(raw: unknown, now = Date.now()): Conversation[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: Conversation[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const conv = item as Partial<Conversation>;
    if (!Array.isArray(conv.messages)) continue;
    const messages: Message[] = conv.messages.map((m) => {
      const src = (m && typeof m === "object" ? m : {}) as Partial<Message>;
      return {
        role: (src.role === "assistant" ? "assistant" : "user") as Role,
        content: String(src.content ?? ""),
        reasoning: typeof src.reasoning === "string" ? src.reasoning : "",
        createdAt: typeof src.createdAt === "number" ? src.createdAt : now,
      };
    });
    out.push({
      id: uid(),
      title: typeof conv.title === "string" && conv.title ? conv.title : "导入的对话",
      messages,
      createdAt: now,
      updatedAt: now,
    });
  }
  return out;
}
