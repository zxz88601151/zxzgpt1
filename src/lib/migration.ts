/** 存档迁移链（D-07）：给单键 `zxz.state.v1` 加显式 schemaVersion。
 *
 * 设计原则（宪章 §3.5「不做不可逆迁移；不确定时先备份再动作」）：
 *   1. **键名不变**：仍是 `zxz.state.v1`，否则老用户一升级就丢历史对话与 API Key。
 *   2. **只加字段**：写入时给顶层对象附 `schemaVersion: 2`，内存里的 AppState 形状不变。
 *   3. **迁移前备份**：旧版 / 未来版本 / 损坏存档的原始字符串先写到
 *      `zxz.state.v1.backup.*`，再返回可用状态；备份失败不能阻断启动。
 *   4. **不丢未知字段**：会话与消息都用 `{...原对象, 覆盖必要字段}`，绝不重建对象。
 *   5. **纯函数**：`decodeState` / `encodeState` 不碰 localStorage，便于单测；
 *      读写副作用留在 `state.ts`。
 *
 * 本层不做：写放大 / 250ms 节流（D-07 的另一半，属独立优化，不在本轮范围）。
 */

import { DEFAULT_SETTINGS } from "../presets";
import { uid } from "./text";
import type { AppState, Conversation, Message, Settings } from "../types";

export const STATE_SCHEMA_VERSION = 2;
export const BACKUP_KEY_PREFIX = "zxz.state.v1.backup.";

export interface BackupRequest {
  key: string;
  raw: string;
  reason: string;
}

export interface DecodeResult {
  state: AppState;
  /** 0 = 无存档；1 = 旧格式（无 schemaVersion）；2 = 当前；>2 = 未来版本 */
  fromVersion: number;
  /** 做了哪些修补，供诊断与文档使用 */
  repairs: string[];
  /** null 表示无需备份；否则调用方应在覆盖存档前把 raw 落到 key */
  backup: BackupRequest | null;
}

function defaultState(): AppState {
  return { settings: { ...DEFAULT_SETTINGS }, conversations: [], activeId: null };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** usableMessages 的口径（与 state.ts 的 filterUsable 一致）：压缩截止索引只在这个空间里有效。 */
function usableCount(messages: Message[]): number {
  return messages.filter((m) => !m.error && !m.streaming && (m.content || m.toolCalls?.length)).length;
}

function normalizeMessage(m: unknown, now: number): Message {
  const src = (isRecord(m) ? m : {}) as Partial<Message>;
  return {
    ...(src as Message),
    role: src.role === "assistant" ? "assistant" : "user",
    content: typeof src.content === "string" ? src.content : String(src.content ?? ""),
    createdAt: typeof src.createdAt === "number" ? src.createdAt : now,
    // 上次进程在流式接收中被关掉，重启后不该永远显示「生成中」
    ...(src.streaming === true ? { streaming: false } : {}),
  };
}

function normalizeConversation(c: unknown, now: number, repairs: string[]): Conversation | null {
  if (!isRecord(c)) return null;
  const src = c as Partial<Conversation> & Record<string, unknown>;
  const messages: Message[] = Array.isArray(src.messages)
    ? src.messages.map((m) => normalizeMessage(m, now))
    : [];
  if (!Array.isArray(src.messages)) repairs.push("会话 messages 不是数组，已置空");

  let after = typeof src.compactAfterIndex === "number" && Number.isFinite(src.compactAfterIndex)
    ? Math.max(0, Math.floor(src.compactAfterIndex))
    : undefined;
  if (after !== undefined) {
    const usable = usableCount(messages);
    if (after > usable) {
      repairs.push(`compactAfterIndex ${after} 越界，已钳制到 ${usable}`);
      after = usable;
    }
  }

  return {
    ...(src as Conversation), // 保留所有未知字段，不做不可逆丢弃
    id: typeof src.id === "string" && src.id ? src.id : uid(),
    title: typeof src.title === "string" && src.title ? src.title : "新对话",
    messages,
    createdAt: typeof src.createdAt === "number" ? src.createdAt : now,
    updatedAt: typeof src.updatedAt === "number" ? src.updatedAt : now,
    ...(typeof src.compactSummary === "string" ? { compactSummary: src.compactSummary } : {}),
    ...(after !== undefined ? { compactAfterIndex: after } : { compactAfterIndex: undefined }),
  };
}

function buildState(obj: Record<string, unknown>, now: number): { state: AppState; repairs: string[] } {
  const repairs: string[] = [];
  const settings = { ...DEFAULT_SETTINGS, ...(isRecord(obj.settings) ? obj.settings : {}) } as Settings;
  if (!isRecord(obj.settings)) repairs.push("settings 缺失或不是对象，已补默认值");

  const rawConvs = Array.isArray(obj.conversations) ? obj.conversations : [];
  if (!Array.isArray(obj.conversations)) repairs.push("conversations 不是数组，已置空");
  const conversations = rawConvs
    .map((c) => normalizeConversation(c, now, repairs))
    .filter((c): c is Conversation => c !== null);

  const ids = new Set(conversations.map((c) => c.id));
  const activeId = typeof obj.activeId === "string" && ids.has(obj.activeId) ? obj.activeId : null;
  if (obj.activeId != null && activeId === null) repairs.push("activeId 指向不存在的会话，已置空");
  return { state: { settings, conversations, activeId }, repairs };
}

/** 解析一份存档字符串；不抛异常，任何异常输入都回落到可用状态。 */
export function decodeState(raw: string | null, now = Date.now()): DecodeResult {
  if (raw === null || raw === "") {
    return { state: defaultState(), fromVersion: 0, repairs: ["无存档，使用默认设置"], backup: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: defaultState(),
      fromVersion: 0,
      repairs: ["存档 JSON 损坏，已回落到默认设置"],
      backup: { key: `${BACKUP_KEY_PREFIX}corrupt`, raw, reason: "JSON 解析失败，原始内容已备份" },
    };
  }
  if (!isRecord(parsed)) {
    return {
      state: defaultState(),
      fromVersion: 0,
      repairs: ["存档顶层不是对象，已回落到默认设置"],
      backup: { key: `${BACKUP_KEY_PREFIX}corrupt`, raw, reason: "顶层结构不是对象，原始内容已备份" },
    };
  }

  // 没有 schemaVersion 就是旧版 v1（键名本身就是 .v1）
  const declared = typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion)
    ? Math.floor(parsed.schemaVersion)
    : 1;
  const repairs: string[] = [];
  let backup: BackupRequest | null = null;
  if (declared > STATE_SCHEMA_VERSION) {
    backup = {
      key: `${BACKUP_KEY_PREFIX}v${declared}`,
      raw,
      reason: `未来版本 v${declared} 的存档，按 v${STATE_SCHEMA_VERSION} 尽力读取，原始内容已备份`,
    };
    repairs.push(backup.reason);
  } else if (declared < STATE_SCHEMA_VERSION) {
    backup = {
      key: `${BACKUP_KEY_PREFIX}v${declared || 1}`,
      raw,
      reason: `迁移 v${declared || 1} → v${STATE_SCHEMA_VERSION} 前备份原始存档`,
    };
    repairs.push(backup.reason); // 诊断里要能看出「迁移前已备份」，不只是「迁移了」
  }

  const built = buildState(parsed, now);
  repairs.push(...built.repairs);
  return { state: built.state, fromVersion: declared, repairs, backup };
}

/** 写入格式：内存 AppState 不变，只在顶层附加版本号。 */
export function encodeState(state: AppState): string {
  return JSON.stringify({ ...state, schemaVersion: STATE_SCHEMA_VERSION });
}
