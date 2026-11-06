/** 本地状态：读写 localStorage、会话增删、上下文窗口计算。
 *
 * 存储键仍是 `zxz.state.v1`（改键名会让老用户丢历史与 API Key），但写入时
 * 会附加 `schemaVersion: 2`；读取走 `lib/migration.ts` 的显式迁移链，旧版裸存档
 * 在迁移前先备份到 `zxz.state.v1.backup.*`。内存里的 AppState 形状不变。
 */

import { DEFAULT_SETTINGS } from "./presets";
import { buildWorkspacePrompt } from "./lib/files";
import { buildPlanPrompt, buildProjectMemoryPrompt } from "./lib/project";
import { buildToolsPrompt } from "./lib/registry";
import { clamp, sliceContext, uid } from "./lib/text";
import { decodeState, encodeState } from "./lib/migration";
import type { AppState, Conversation, Message, Settings, WireMessage } from "./types";

export const STORE_KEY = "zxz.state.v1";
export { STATE_SCHEMA_VERSION } from "./lib/migration";

export function loadState(): AppState {
  try {
    const decoded = decodeState(localStorage.getItem(STORE_KEY));
    // 迁移 / 未来版本 / 损坏存档：先把原始内容备份下来再返回可用状态。
    // 备份写失败（配额满）也必须能启动，不能把用户锁在门外。
    if (decoded.backup) {
      try {
        localStorage.setItem(decoded.backup.key, decoded.backup.raw);
      } catch {
        /* 备份失败不阻断启动：原始存档仍在主键里，下次启动会再试 */
      }
    }
    return decoded.state;
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, conversations: [], activeId: null };
  }
}

export function persist(state: AppState): void {
  localStorage.setItem(STORE_KEY, encodeState(state));
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
 * 抽出「可用消息」：剔除报错 / 流式中 / 空内容的消息。
 * buildMessages 与压缩引擎都基于同一份过滤规则，索引才能严格对齐。
 */
export function filterUsable(messages: Message[]): Message[] {
  return messages.filter((m) => !m.error && !m.streaming && (m.content || m.toolCalls?.length));
}

/** 会话当前可被发给模型的可用消息（与 filterUsable 同义，语义更直白，供压缩引擎用）。 */
export function usableMessages(conv: Conversation): Message[] {
  return filterUsable(conv.messages);
}

/**
 * 组装发给上游的消息。
 * 先剔除出错 / 流式中 / 内容为空的消息，再按「压缩截止 + 最近 N 轮」截取。
 *
 * 压缩逻辑：若 `conv.compactAfterIndex` 存在，只发送该索引之后的可用消息，
 * 并在系统段注入 `conv.compactSummary` 作为较早历史的精炼回顾——UI 里仍保留
 * 完整消息列表，模型侧则只看摘要 + 最近上下文，长会话不再膨胀退化。
 *
 * 系统消息的顺序：人设 → 压缩摘要 → 本地工程约定 → 已加载技能。越具体的越靠后，
 * 模型对最近的那条系统消息服从度最高。
 */
export function buildMessages(conv: Conversation, settings: Settings, skillPrompt = ""): WireMessage[] {
  const out: WireMessage[] = [];
  const sys = settings.systemPrompt.trim();
  if (sys) out.push({ role: "system", content: sys });

  // 较早对话的压缩摘要：作为系统上下文注入，模型据此延续任务而不必重读全部历史
  if (conv.compactSummary) {
    out.push({
      role: "system",
      content: `[对话历史压缩摘要 · 以下为较早对话的精炼回顾，模型据此延续任务]\n${conv.compactSummary}`,
    });
  }

  // 本地工程模式：把根目录、目录树和落盘格式约定放在最后，离用户消息最近
  const ws = settings.workspace;
  if (ws) {
    out.push({
      role: "system",
      content: buildWorkspacePrompt(ws.root, ws.tree, {
        toolMode: settings.toolCalls !== false,
        confirmWrites: Boolean(settings.confirmWrites),
        planMode: Boolean(settings.planMode),
        exploreMode: Boolean(settings.exploreMode),
      }),
    });
    // 工具说明：只在工具调用开启时发，放在工作区提示词之后、计划提示词之前
    if (settings.toolCalls !== false) {
      out.push({
        role: "system",
        content: buildToolsPrompt(Boolean(settings.planMode), Boolean(settings.confirmWrites), Boolean(settings.exploreMode)),
      });
    }
    // 项目记忆：工程自己的 CLAUDE.md / AGENTS.md，比通用技能更具体
    const memory = ws.memory && ws.memorySource ? buildProjectMemoryPrompt(ws.memorySource, ws.memory) : "";
    if (memory) out.push({ role: "system", content: memory });
  }

  const skills = skillPrompt.trim();
  if (skills) out.push({ role: "system", content: skills });

  // 计划模式指令放最后：离用户消息最近，模型最不容易把它当成可忽略的背景
  if (settings.planMode) out.push({ role: "system", content: buildPlanPrompt() });

  const usage = filterUsable(conv.messages);
  // 压缩截止：只发送该索引之后的可用消息（更早的已被摘要进 compactSummary）
  const after = conv.compactAfterIndex ?? 0;
  const windowMsgs = after > 0 ? usage.slice(after) : usage;
  const turns = clamp(Number(settings.contextTurns) || 0, 0, 100);
  for (const m of sliceContext(windowMsgs, turns)) {
    // 带工具调用的助手消息要展开成原生协议：先是带 tool_calls 的助手消息，
    // 后面跟每一次调用对应的 tool 消息（tool_call_id 对上），模型才能把
    // “我调了什么、结果是什么”对上号；只发文本会丢掉这层对应关系。
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })),
      });
      for (const t of m.toolCalls) {
        out.push({ role: "tool", content: t.error ? `工具执行失败：${t.error}` : (t.result ?? ""), tool_call_id: t.id });
      }
      continue;
    }
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
