/** 应用内控制助手 C1（第一批）：斜杠命令只动 zxzgpt1 自己的开关和会话。
 *
 * 设计约束（别顺手放宽）：
 * 1) 只能动应用内状态：计划模式、工具调用、自动测试、写入前确认、探索模式、
 *    新建会话。绝不读文件、绝不写文件、绝不跑命令——那些是 C2 工程控制的事，
 *    不在这个文件里出现。
 * 2) 命令只在用户主动输入、且**首词命中已知命令名**时才解析；其余一个字都不拦截（D16）。
 *    已知命令的参数解析失败（开关值不是 开/关、多带参数）只返回错误文本，不改任何状态。
 * 3) 语音触发时同样走这条解析：App 侧在执行前必须先把命令复述给用户看，
 *    本文件只负责"这句话是不是一条合法命令、改哪个开关"，不负责执行。
 *
 * 分层：parseAppCommand 只解析；planAppCommand 把解析结果加上入口/busy 语义
 * 打包成执行计划（App 只消费计划，便于单测覆盖状态变化）；withToggleApplied /
 * appendAssistantMessage 是对状态的纯变换，与 App 使用的是同一份实现。
 */

import type { Conversation, Message, Settings } from "../types";

export type AppAction =
  | { kind: "toggle"; key: "planMode" | "toolCalls" | "autoTest" | "confirmWrites" | "exploreMode"; value: boolean }
  | { kind: "new_session" }
  | { kind: "preview"; target: string }
  | { kind: "help" };

export type AppCommandResult = { action: AppAction } | { error: string };

type ToggleKey = Extract<AppAction, { kind: "toggle" }>["key"];

const TOGGLE_KEYS: Record<string, ToggleKey> = {
  plan: "planMode",
  计划: "planMode",
  tools: "toolCalls",
  工具: "toolCalls",
  autotest: "autoTest",
  自动测试: "autoTest",
  confirm: "confirmWrites",
  写入确认: "confirmWrites",
  explore: "exploreMode",
  探索: "exploreMode",
};

/** 命令名的唯一权威：新增命令要同时改这里、TOGGLE_KEYS 与 appCommandHelp 的清单。 */
const COMMAND_NAMES = new Set<string>(["help", "帮助", "new", "新建", "preview", "预览", ...Object.keys(TOGGLE_KEYS)]);

function parseOnOff(word: string): boolean | null {
  if (word === "on" || word === "开" || word === "开启") return true;
  if (word === "off" || word === "关" || word === "关闭") return false;
  return null;
}

/** 解析一条斜杠命令。
 *  D16：只有**首词命中已知命令名**才算命令，其余一律返回 null 当普通消息发出去。
 *  旧判定是「trim 后以 / 开头就是命令」，于是 `/etc/hosts 里的 127.0.0.1 是干嘛的`
 *  这类以斜杠开头的正常句子被命令层吞掉，永远到不了模型——那正是约束 2 承诺不会做的事。
 *  代价：命令打错（/pln 开）不再得到「未知命令」提示，而是原样发给模型；
 *  已知命令的参数错误（/plan 也许吧、/help foo）仍然报错。
 *  大小写策略：只认小写英文与中英别名（/plan、/计划）；/PLAN 不命中命令名，按普通消息发出。 */
export function parseAppCommand(text: string): AppCommandResult | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const parts = t.slice(1).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !COMMAND_NAMES.has(parts[0])) return null;
  const [cmd, arg] = parts;
  if (cmd === "help" || cmd === "帮助") {
    if (parts.length > 1) return { error: "/help 后面不带参数，直接显示命令清单" };
    return { action: { kind: "help" } };
  }
  if (cmd === "new" || cmd === "新建") {
    if (parts.length > 1) return { error: "/new 后面不带参数，直接新建一个会话" };
    return { action: { kind: "new_session" } };
  }
  if (cmd === "preview" || cmd === "预览") {
    const target = parts.slice(1).join(" ");
    if (!target) return { error: "/preview 后面要跟一个 http(s) 地址或本地 HTML 文件路径" };
    return { action: { kind: "preview", target } };
  }
  const key = TOGGLE_KEYS[cmd];
  if (arg === undefined) return { error: `/${cmd} 后面要跟 开 或 关，例如 /${cmd} 开` };
  const value = parseOnOff(arg);
  if (value === null) return { error: `/${cmd} 的值只能是 开 或 关，你写的是 ${arg}` };
  if (parts.length > 2) return { error: `/${cmd} 只接受一个 开/关 参数` };
  return { action: { kind: "toggle", key, value } };
}

/** App 侧的执行计划：把解析结果与入口/busy 语义打包，App 只按 kind 分发。 */
export type AppCommandPlan =
  | { kind: "passthrough" } // 不是命令，照常当消息发（含 reuse 重生成路径）
  | { kind: "reject_busy" } // 生成进行中：命令与消息一样不执行，输入框原样保留
  | { kind: "error"; message: string }
  | { kind: "help"; message: string }
  | { kind: "new_session" }
  | { kind: "preview"; target: string }
  | { kind: "toggle"; key: ToggleKey; value: boolean; label: string };

/** 入口判定 + busy 语义 + 解析，一次给出执行计划。
 *  active 由调用方传入（用户输入 trim 后以 / 开头、且非 reuse 重生成）。 */
export function planAppCommand(text: string, opts: { busy: boolean; active: boolean }): AppCommandPlan {
  if (!opts.active) return { kind: "passthrough" };
  const parsed = parseAppCommand(text);
  if (!parsed) return { kind: "passthrough" };
  if (opts.busy) return { kind: "reject_busy" };
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  const action = parsed.action;
  if (action.kind === "help") return { kind: "help", message: appCommandHelp() };
  if (action.kind === "new_session") return { kind: "new_session" };
  if (action.kind === "preview") return { kind: "preview", target: action.target };
  return { kind: "toggle", key: action.key, value: action.value, label: appActionLabel(action) };
}

/** 命令分发后输入框应保留什么：
 *  - error（解析失败）保留原文，用户能在原地改命令，不必重打；
 *  - help / toggle 已执行，清空；
 *  - new_session 返回原文：清空由 App 侧 createConv() 内部完成，这里不重复清。
 *  reject_busy 在 App 里更早返回、不会走到这里，语义同样是保留原文。 */
export function nextInputAfterCommand(prevInput: string, plan: AppCommandPlan): string {
  if (plan.kind === "help" || plan.kind === "toggle" || plan.kind === "preview") return "";
  return prevInput;
}

/** 开关命令对 settings 的纯变换：与设置抽屉写的是同一份 settings 对象。 */
export function withToggleApplied(settings: Settings, plan: { key: ToggleKey; value: boolean }): Settings {
  return { ...settings, [plan.key]: plan.value };
}

/** /help 对会话的纯变换：把一条助手消息追加到当前会话；无匹配会话返回原数组。 */
export function appendAssistantMessage(
  conversations: Conversation[],
  activeId: string | null,
  content: string,
  now: number
): { conversations: Conversation[]; appended: boolean } {
  const conv = conversations.find((c) => c.id === activeId);
  if (!conv) return { conversations, appended: false };
  const msg: Message = { role: "assistant", content, createdAt: now };
  return {
    conversations: conversations.map((c) =>
      c.id === conv.id ? { ...c, messages: [...c.messages, msg], updatedAt: now } : c
    ),
    appended: true,
  };
}

/** 命令清单：App 在 /help 时原样展示，改命令要同步改这里和测试。 */
export function appCommandHelp(): string {
  return [
    "应用内命令（只改本应用自己的开关，不读文件、不写文件、不跑命令）：",
    "/plan 开|关 —— 计划模式",
    "/tools 开|关 —— 工具调用",
    "/autotest 开|关 —— 自动测试回路",
    "/confirm 开|关 —— 写入前确认",
    "/explore 开|关 —— 探索模式开关（只读拦截属后续批次，当前仅开关）",
    "/preview <地址|文件> —— 在内置窗口打开预览（http(s) 链接或本地 HTML 文件）",
    "/new —— 新建会话",
    "/help —— 显示本清单",
  ].join("\n");
}

/** 开关动作对应的人话，供 App 在执行后 toast 用，不含任何执行逻辑。 */
export function appActionLabel(action: AppAction): string {
  if (action.kind === "help") return "应用内命令清单";
  if (action.kind === "new_session") return "已新建会话";
  if (action.kind === "preview") return "已打开预览";
  const names: Record<string, string> = {
    planMode: "计划模式",
    toolCalls: "工具调用",
    autoTest: "自动测试回路",
    confirmWrites: "写入前确认",
    exploreMode: "探索模式",
  };
  return `${names[action.key]}已${action.value ? "开启" : "关闭"}`;
}
