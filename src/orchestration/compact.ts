/** 上下文压缩引擎（「高性能代码模式」双支柱之一）。
 *
 * 设计要点：
 *  - **预算计量**：把 buildMessages 即将发出的全部内容估算成 token，与 `contextBudget` 比较。
 *    系统消息、工具说明、项目记忆、摘要本身都计入预算——这是和「只按轮数裁」的本质区别。
 *  - **增量摘要**：每次只摘要「上一次压缩截止 → 保留区之前」这段新窗口，拼到旧摘要后面，
 *    保证每条历史消息只被摘要一次，不会越压越丢信息。
 *  - **保留最近轮次**：压缩后始终保留最近 `keepRounds` 轮原文，模型对当前任务上下文不降级。
 *  - **模型摘要优先、结构化兜底**：优先用模型产出高质量摘要；模型不可用（离线/限流）时
 *    退化成确定性结构化摘要，压缩永不因网络失败而中断整轮。
 *  - **与 buildMessages 索引对齐**：窗口划分、截止索引都只在 `filterUsable` 的索引空间内算，
 *    直接喂给 buildMessages 的 `compactAfterIndex`。
 */

import { buildMessages, filterUsable } from "../state";
import { estimateWireTokens } from "../lib/tokens";
import type { Conversation, Message, Settings } from "../types";

export interface CompactOptions {
  /** 模型摘要：把一批历史消息压成结构化摘要。失败由调用方兜底。 */
  summarize: (window: Message[]) => Promise<string>;
  /** 输入 token 预算（估算）；<=0 视为不限制。 */
  budget: number;
  /** 压缩后保留最近几轮（1 轮 = 用户+助手一组）。 */
  keepRounds: number;
}

export interface CompactPatch {
  /** 合并后的完整摘要（旧摘要 + 本次增量）。 */
  summary: string;
  /** 写入 Conversation.compactAfterIndex（指向 usable 列表的切片起点）。 */
  afterIndex: number;
  /** 本次实际被摘要掉的可用消息条数。 */
  summarizedCount: number;
}

/** 把窗口结构化成确定性摘要（模型摘要失败时的兜底，不联网）。 */
export function structuralSummary(window: Message[]): string {
  const actions: string[] = [];
  const files = new Set<string>();
  for (const m of window) {
    if (m.role === "user") {
      const line = (m.content || "").split("\n")[0].trim().slice(0, 100);
      if (line) actions.unshift(`- 用户诉求：${line}`);
    }
    if (m.toolCalls) {
      for (const t of m.toolCalls) {
        actions.push(`- 工具 ${t.name}${t.error ? `（失败：${t.error.slice(0, 60)}）` : ""}`);
        const pm = (t.arguments || "").match(/"path"\s*:\s*"([^"]+)"/);
        if (pm) files.add(pm[1]);
      }
    }
  }
  const lines = [...actions];
  if (files.size) lines.push(`- 涉及文件：${[...files].join("、")}`);
  return lines.join("\n") || "- （空窗口）";
}

/**
 * 纯函数：在「已发送可用消息」列表里划出本次要摘要的窗口。
 * 返回 null 表示没有可压缩空间（窗口为空，或压缩后无内容可保留）。
 * 只在 `filterUsable(messages)` 的索引空间内计算，与 buildMessages 的切片严格对齐。
 */
export function planCompaction(
  conv: Pick<Conversation, "compactAfterIndex">,
  messages: Message[],
  keepRounds: number,
): { window: Message[]; afterIndex: number; summarizedCount: number } | null {
  const full = filterUsable(messages);
  const after = conv.compactAfterIndex ?? 0;
  const keepRecent = Math.max(1, keepRounds) * 2;
  const newEnd = Math.max(after, full.length - keepRecent);
  if (newEnd <= after) return null; // 没有新消息可摘要
  if (newEnd >= full.length) return null; // 全压没了，无意义
  const window = full.slice(after, newEnd);
  if (window.length < 1) return null;
  return { window, afterIndex: newEnd, summarizedCount: window.length };
}

/** 合并摘要：把增量拼到旧摘要之后。 */
function mergeSummary(existing: string | undefined, delta: string): string {
  return existing ? `${existing}\n\n${delta}` : delta;
}

async function summarizeWindow(opts: CompactOptions, window: Message[]): Promise<string> {
  let delta = "";
  try {
    delta = (await opts.summarize(window)).trim();
  } catch {
    delta = "";
  }
  return delta || structuralSummary(window);
}

/**
 * 自动压缩：仅在超预算时触发。返回 null 表示无需压缩（未超预算或无空间）。
 * 既用于主对话，也通过 runRounds 自动惠及子代理（子代理复用同一套 buildMessages/runRounds）。
 */
export async function maybeCompact(
  conv: Conversation,
  baseMessages: Message[],
  settings: Settings,
  skillPrompt: string,
  opts: CompactOptions,
): Promise<CompactPatch | null> {
  if (opts.budget <= 0) return null;
  const effective = buildMessages({ ...conv, messages: baseMessages }, settings, skillPrompt);
  if (estimateWireTokens(effective) <= opts.budget) return null;

  const plan = planCompaction(conv, baseMessages, opts.keepRounds);
  if (!plan) return null;

  const delta = await summarizeWindow(opts, plan.window);
  return { summary: mergeSummary(conv.compactSummary, delta), afterIndex: plan.afterIndex, summarizedCount: plan.summarizedCount };
}

/**
 * 手动压缩：无论是否超预算，都尝试压缩一步（用户点「压缩上下文」按钮时调用）。
 * 没有可压缩空间时返回 null。只需历史消息与保留轮数，不依赖预算/系统提示。
 */
export async function forceCompact(
  conv: Conversation,
  baseMessages: Message[],
  opts: CompactOptions,
): Promise<CompactPatch | null> {
  const plan = planCompaction(conv, baseMessages, opts.keepRounds);
  if (!plan) return null;
  const delta = await summarizeWindow(opts, plan.window);
  return { summary: mergeSummary(conv.compactSummary, delta), afterIndex: plan.afterIndex, summarizedCount: plan.summarizedCount };
}
