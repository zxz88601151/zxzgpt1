/** 本地状态：读写 localStorage、会话增删、上下文窗口计算。
 *
 * 存储结构（键 `zxz.state.v1`）与旧版前端完全一致，
 * 这样升级到 React 版之后用户的历史对话与 API Key 不会丢。
 */

import { DEFAULT_SETTINGS } from "./presets";
import { buildWorkspacePrompt } from "./lib/files";
import { clamp, sliceContext, uid } from "./lib/text";
import type { AppState, Conversation, Message, Settings, WireMessage } from "./types";

export const STORE_KEY = "zxz.state.v1";

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      activeId: parsed.activeId || null,
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, conversations: [], activeId: null };
  }
}

export function persist(state: AppState): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

export function newConversation(now = Date.now()): Conversation {
  return { id: uid(), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}

export function findActive(state: AppState): Conversation | null {
  return state.conversations.find((c) => c.id === state.activeId) || null;
}

/** 首条消息决定会话标题：压缩空白 + 去首尾空格 + 截断 24 字 */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 24).trim();
  return t || "新对话";
}

/**
 * 组装发给上游的消息。
 * 先剔除出错 / 流式中 / 内容为空的消息，再按「最近 N 轮」截取 —— 顺序反过来的话，
 * 本次刚插入的空助手占位会占掉窗口名额，导致实际少带一轮上下文。
 *
 * 系统消息的顺序：人设 → 本地工程约定 → 已加载技能。越具体的越靠后，
 * 模型对最近的那条系统消息服从度最高。
 */
export function buildMessages(conv: Conversation, settings: Settings, skillPrompt = ""): WireMessage[] {
  const out: WireMessage[] = [];
  const sys = settings.systemPrompt.trim();
  if (sys) out.push({ role: "system", content: sys });

  // 本地工程模式：把根目录、目录树和落盘格式约定放在最后，离用户消息最近
  const ws = settings.workspace;
  if (ws) out.push({ role: "system", content: buildWorkspacePrompt(ws.root, ws.tree) });

  const skills = skillPrompt.trim();
  if (skills) out.push({ role: "system", content: skills });

  const usage = conv.messages.filter((m) => !m.error && !m.streaming && m.content);
  const turns = clamp(Number(settings.contextTurns) || 0, 0, 100);
  for (const m of sliceContext(usage, turns)) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** 导入外部 JSON 时把消息规整成内部结构 */
export function normalizeImportedMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m: Partial<Message>) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: String(m?.content || ""),
    reasoning: m?.reasoning || "",
    createdAt: m?.createdAt || Date.now(),
  }));
}

/** 会话按最近更新排序后按关键词过滤（标题或任一消息命中） */
export function filterConversations(list: Conversation[], keyword: string): Conversation[] {
  const k = keyword.trim().toLowerCase();
  return list
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .filter((c) => {
      if (!k) return true;
      if ((c.title || "").toLowerCase().includes(k)) return true;
      return c.messages.some((m) => (m.content || "").toLowerCase().includes(k));
    });
}
