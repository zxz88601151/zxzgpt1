/** 存档迁移链（D-07）：给单键 `zxz.state.v1` 加显式 schemaVersion。
 *
 * 设计原则（宪章 §3.5「不做不可逆迁移；不确定时先备份再动作」）：
 *   1. **键名不变**：仍是 `zxz.state.v1`，否则老用户一升级就丢历史对话与 API Key。
 *   2. **只加字段**：写入时给顶层对象附 `schemaVersion: 2`，内存里的 AppState 形状不变。
 *   3. **迁移前备份**：旧版 / 未来版本 / 损坏存档的原始字符串先写到
 *      `zxz.state.v1.backup.*`，再返回可用状态；备份失败不能阻断启动。
 *      `BackupRequest.raw` 在产出时即经 `redactBackupRaw` 脱敏（独立复审 P2）：
 *      **含 `apiKey` 键**的存档不会把明文写进备份数据源；没有该键的原始内容
 *      逐字节保留。
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

/** 备份快照里 API Key 的占位值。明文密钥只允许留在主键 `zxz.state.v1`。 */
export const BACKUP_REDACTED = "[已脱敏]";

export interface BackupRequest {
  key: string;
  /** 已脱敏的备份内容：无敏感字段时与原始 raw 逐字节相同 */
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

/** 解析后的键名是不是本项目的 API Key 字段（忽略大小写）。
 *  只认 `apiKey` 本身：`api_key` 等变体不是应用读取的字段，脱敏它们会误改用户正文。
 */
function isApiKeyName(key: string): boolean {
  return key.toLowerCase() === "apikey";
}

/** 判断一份（可能损坏的）存档里是否出现 apiKey 字样。
 *  先把 `\uXXXX` 解码再比，再放宽到 `api` + `key` 的字样，覆盖常见写法；
 *  这是**启发式**而非完备解析器：极端畸形的键名（拼接、非法 hex）仍可能漏判，
 *  但那样的一份损坏存档 Key 不进 state，已登记为 P3 边界。
 */
function hasApiKeyName(raw: string): boolean {
  const normalized = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return /api[_\s-]*key/i.test(normalized);
}

/** 结构化路径失败时的安全摘要：**不含原始内容的任何一个字符**（只留长度）。
 *
 * 这是刻意的降级取舍：畸形存档本来就无法正常迁移，与其冒险做「局部正则脱敏」
 * （盖不住对象 / 数组形式的 `apiKey` 值，第 4 轮复核抓到的 P2 组合），
 * 不如只留一条可诊断的迁移事件。原始存档仍在主键 `zxz.state.v1`，未删除用户数据。
 */
function safeSummary(raw: string): string {
  return JSON.stringify({
    __zxz_backup_redacted__: true,
    apiKey: BACKUP_REDACTED,
    reason: "存档无法结构化脱敏，为不含明文密钥，原始内容未保存",
    bytes: raw.length,
  });
}

/**
 * 迁移前备份的脱敏（纯函数）：把存档里出现的 API Key 值换成占位符。
 *
 * **按解析结果二分**（避免被「某种值类型 + 某种深度」的组合反复绕过）：
 *   1. 合法 JSON → `JSON.parse` 的 **reviver** 按「解析后的真实键名」整体脱敏，
 *      再 `JSON.stringify` 重建。**只要见过 `apiKey` 键就重建**，不能只看「值
 *      是否非空」：同名重复键（如 `{"apiKey":"S","apiKey":""}`）在 parse 阶段
 *      只保留末值，若因末值为空而返回原串，前一段明文就会原样进备份（第 5 轮
 *      复核抓到的 P2）。重建后重复键前值已不存在，明文自然消失。
 *      覆盖 `"ap\u0069Key"` 等转义键名、任意层级、对象 / 数组形式的 `apiKey`
 *      值、`__proto__` 字段；**完全没有 apiKey 键**时返回原串逐字节相同。
 *   2. 任何结构化异常（带 reviver 的 `JSON.parse` 在深嵌套约 2800 层起抛
 *      `RangeError`、`JSON.stringify` 也有引擎深度上限、JSON 损坏）→
 *      **不再尝试局部替换**：含 apiKey 字样就返回零原文的安全摘要，
 *      不含则原串返回。异常绝不冒泡到 `decodeState`，启动不被畸形存档挡住。
 *
 * 空字符串 / null 密钥不含敏感信息，不引入占位，避免让人误以为原来配过 Key。
 */
export function redactBackupRaw(raw: string): string {
  try {
    let sawApiKey = false;
    const parsed: unknown = JSON.parse(raw, (key: string, value: unknown) => {
      if (isApiKeyName(key)) {
        sawApiKey = true;
        if (value !== null && value !== undefined && value !== "") return BACKUP_REDACTED;
      }
      return value;
    });
    if (!sawApiKey) return raw;
    return JSON.stringify(parsed);
  } catch {
    return hasApiKeyName(raw) ? safeSummary(raw) : raw;
  }
}

/** 统一构造备份请求：raw 从产出这一刻起就是脱敏快照，不留给下游拿到明文的机会。 */
function backupRequest(key: string, raw: string, reason: string): BackupRequest {
  return { key, raw: redactBackupRaw(raw), reason };
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
      backup: backupRequest(`${BACKUP_KEY_PREFIX}corrupt`, raw, "JSON 解析失败，原始内容已备份"),
    };
  }
  if (!isRecord(parsed)) {
    return {
      state: defaultState(),
      fromVersion: 0,
      repairs: ["存档顶层不是对象，已回落到默认设置"],
      backup: backupRequest(`${BACKUP_KEY_PREFIX}corrupt`, raw, "顶层结构不是对象，原始内容已备份"),
    };
  }

  // 没有 schemaVersion 就是旧版 v1（键名本身就是 .v1）
  const declared = typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion)
    ? Math.floor(parsed.schemaVersion)
    : 1;
  const repairs: string[] = [];
  let backup: BackupRequest | null = null;
  if (declared > STATE_SCHEMA_VERSION) {
    backup = backupRequest(
      `${BACKUP_KEY_PREFIX}v${declared}`,
      raw,
      `未来版本 v${declared} 的存档，按 v${STATE_SCHEMA_VERSION} 尽力读取，原始内容已备份`,
    );
    repairs.push(backup.reason);
  } else if (declared < STATE_SCHEMA_VERSION) {
    backup = backupRequest(
      `${BACKUP_KEY_PREFIX}v${declared || 1}`,
      raw,
      `迁移 v${declared || 1} → v${STATE_SCHEMA_VERSION} 前备份原始存档`,
    );
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
