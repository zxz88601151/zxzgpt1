import { describe, it, expect } from "vitest";
import { runToolBatch } from "./session";
import { maybeCompact, forceCompact, structuralSummary } from "./compact";
import { buildMessages, filterUsable } from "../state";
import { estimateTokens, estimateWireTokens } from "../lib/tokens";
import type { Conversation, Message, Settings, ToolCallRecord } from "../types";

/**
 * 性能基准：量化「并行工具执行」与「上下文压缩引擎」两个功能的真实收益。
 * 默认 skip，避免拖慢全量测试；手动跑：RUN_PERF=1 npx vitest run src/orchestration/perf.test.ts
 * 并行部分用模拟慢工具（web_search 类网络延迟）真实计时；压缩部分用真实大小会话 + 离线结构化摘要。
 */
const RUN = !!process.env.RUN_PERF;
const d = RUN ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 用户消息 + 长助手回复（约 220 字中文，模拟真实长对话）
const LONG_ANSWER =
  "好的，我来帮你实现。首先分析需求：需要在现有组件树中插入一个新的状态管理层，" +
  "并复用已有的 ToolContext 通道。关键改动点有三处：其一是类型定义扩展，需要给 Message 增加可选字段;" +
  "其二是调度层从串行改为并发扇出，只读层 Promise.allSettled 并发、写层串行保序;" +
  "其三是把压缩元数据持久化回会话。每一步都配套了单测，覆盖并发耗时、失败隔离、顺序回填。" +
  "下面给出具体实现方案与回归测试策略，并标注每个改动的风险等级。";

function makeConversation(rounds: number): Conversation {
  const messages: Message[] = [];
  const now = Date.now();
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: "user", content: `第 ${i + 1} 轮：请继续推进刚才的任务，注意边界情况。`, createdAt: now + i });
    const toolCalls: ToolCallRecord[] | undefined =
      i % 3 === 0
        ? [
            { id: `t${i}a`, name: "read_file", arguments: "{}", result: "文件内容…" },
            { id: `t${i}b`, name: "search_files", arguments: "{}", result: "命中 3 处" },
          ]
        : undefined;
    messages.push({
      role: "assistant",
      content: LONG_ANSWER,
      toolCalls,
      createdAt: now + i + 1,
    });
  }
  return { id: "perf", title: "perf", messages, createdAt: now, updatedAt: now };
}

const settings = {
  systemPrompt: "你是一个本地编程助手。",
  contextTurns: 200,
  contextBudget: 100000,
  compactKeepRounds: 3,
  autoCompact: false,
  toolCalls: true,
} as unknown as Settings;

function makeSettings(): Settings {
  return { ...settings };
}

// ── 并行基准：模拟慢工具真实计时 ──────────────────────────────────────────
interface Timing {
  name: string;
  start: number;
  end: number;
  dur: number;
}
function timedExecutor(delays: Record<string, number>) {
  const log: Timing[] = [];
  const exec = async (call: { id: string; name: string; arguments: string }): Promise<ToolCallRecord> => {
    const t0 = Date.now();
    const d = delays[call.name] ?? 50;
    await sleep(d);
    const t1 = Date.now();
    log.push({ name: call.name, start: t0, end: t1, dur: t1 - t0 });
    return { id: call.id, name: call.name, arguments: call.arguments, result: "ok" };
  };
  return { exec, log };
}

function callsOf(names: string[]) {
  return names.map((n, i) => ({ id: `c${i}`, name: n, arguments: "{}" }));
}

d("性能基准 · 并行工具执行", () => {
  it("3× web_search(300ms) 并发 ≈300ms（串行需 900ms）→ 加速比≈3x", async () => {
    const { exec, log } = timedExecutor({ web_search: 300 });
    const calls = callsOf(["web_search", "web_search", "web_search"]);
    const t0 = Date.now();
    const recs = await runToolBatch(calls, exec);
    const total = Date.now() - t0;

    // 并发证据：三条开始时间几乎同时（最大间隔 < 单条耗时）
    const starts = log.map((l) => l.start);
    const spread = Math.max(...starts) - Math.min(...starts);
    console.log(`  [并行] 3×web_search 总耗时 ${total}ms，启动间隔 ${spread}ms`);
    console.log(`  [对照] 串行理论值 900ms，加速比 ≈${(900 / total).toFixed(2)}x`);

    expect(recs).toHaveLength(3);
    expect(total).toBeLessThan(900); // 明显低于串行
    expect(spread).toBeLessThan(300); // 几乎同时启动 = 真并发
  });

  it("10× read(50ms) 并发 ≈50ms（串行需 500ms）→ 加速比≈10x", async () => {
    const { exec, log } = timedExecutor({ read_file: 50 });
    const calls = callsOf(Array.from({ length: 10 }, () => "read_file"));
    const t0 = Date.now();
    const recs = await runToolBatch(calls, exec);
    const total = Date.now() - t0;
    const spread = Math.max(...log.map((l) => l.start)) - Math.min(...log.map((l) => l.start));
    console.log(`  [并行] 10×read 总耗时 ${total}ms，启动间隔 ${spread}ms，加速比 ≈${(500 / total).toFixed(2)}x`);
    expect(recs).toHaveLength(10);
    expect(total).toBeLessThan(500);
    expect(spread).toBeLessThan(50);
  });

  it("混合批 3 read(40)+2 write(60)：read 并发、write 串行、顺序回填", async () => {
    const { exec, log } = timedExecutor({ read_file: 40, write_file: 60 });
    const calls = callsOf(["read_file", "write_file", "read_file", "read_file", "write_file"]);
    const t0 = Date.now();
    const recs = await runToolBatch(calls, exec);
    const total = Date.now() - t0;
    console.log(`  [混合] 总耗时 ${total}ms（理论：read并发40 + write串行120 = 160ms）`);

    // 顺序回填：id 顺序必须与入参一致
    expect(recs.map((r) => r.name)).toEqual(["read_file", "write_file", "read_file", "read_file", "write_file"]);
    // 写工具必须串行（第二条 write 在 第一条 write 结束后才开始）
    const writes = log.filter((l) => l.name === "write_file");
    expect(writes[1].start).toBeGreaterThanOrEqual(writes[0].end - 5);
    // 总耗时 ≈ 40(读并发) + 120(写串行) = 160，远小于全串行 240
    expect(total).toBeLessThan(240);
    expect(total).toBeGreaterThanOrEqual(140);
  });
});

// ── 压缩基准：真实会话大小 + 离线结构化摘要 ──────────────────────────────
d("性能基准 · 上下文压缩引擎", () => {
  it("estimateTokens 对长文本即时（<5ms / 3000字）", () => {
    const text = LONG_ANSWER.repeat(15); // ~3300 字
    const t0 = performance.now();
    const tok = estimateTokens(text);
    const ms = performance.now() - t0;
    console.log(`  [计量] ${text.length}字 → 估算 ${tok} token，耗时 ${ms.toFixed(3)}ms`);
    expect(ms).toBeLessThan(5);
    expect(tok).toBeGreaterThan(500);
  });

  it("40 轮真实会话：压缩前→后 token 节省率量化", async () => {
    const conv = makeConversation(40);
    const beforeMsgs = buildMessages({ ...conv, compactAfterIndex: undefined, compactSummary: undefined }, makeSettings());
    const beforeTok = estimateWireTokens(beforeMsgs);
    console.log(`  [压缩前] 发给模型的 token ≈ ${beforeTok}`);

    // 把预算压到全量的一半，必然触发超预算压缩
    const budget = Math.floor(beforeTok * 0.5);
    const patch = await maybeCompact(conv, conv.messages, makeSettings(), "", {
      summarize: async (w) => `摘要:${w.length}条历史`,
      budget,
      keepRounds: 3,
    });
    expect(patch).not.toBeNull();
    console.log(`  [触发] 超预算(${budget})，压掉前 ${patch!.summarizedCount} 条，afterIndex=${patch!.afterIndex}`);

    const afterMsgs = buildMessages(
      { ...conv, compactAfterIndex: patch!.afterIndex, compactSummary: patch!.summary },
      makeSettings(),
    );
    const afterTok = estimateWireTokens(afterMsgs);
    const saved = beforeTok - afterTok;
    const pct = ((saved / beforeTok) * 100).toFixed(1);
    console.log(`  [压缩后] token ≈ ${afterTok}，节省 ${saved} (${pct}%)`);
    const totalUsable = filterUsable(conv.messages).length;
    console.log(`  [保留] 最近 ${totalUsable - patch!.afterIndex} 条原文(${(totalUsable - patch!.afterIndex) / 2}轮) + 摘要 ${estimateTokens(patch!.summary)} token`);

    expect(afterTok).toBeLessThan(beforeTok);
    expect(Number(pct)).toBeGreaterThan(20); // 半预算下应有显著节省
  });

  it("增量压缩：每条历史只摘要一次（forceCompact 二次返回 null）", async () => {
    let summarizeCalls = 0;
    const summarize = async (w: Message[]) => {
      summarizeCalls++;
      return structuralSummary(w);
    };
    const conv = makeConversation(40);

    const p1 = await forceCompact(conv, conv.messages, { summarize, budget: 0, keepRounds: 3 });
    expect(p1).not.toBeNull();
    expect(summarizeCalls).toBe(1);

    const conv2: Conversation = {
      ...conv,
      compactAfterIndex: p1!.afterIndex,
      compactSummary: p1!.summary,
    };
    const p2 = await forceCompact(conv2, conv.messages, { summarize, budget: 0, keepRounds: 3 });
    // 第一次已把可压区间压到 keepRecent，第二次无新空间 → null，不再调用模型
    expect(p2).toBeNull();
    expect(summarizeCalls).toBe(1);
    console.log(`  [增量] 两次 forceCompact 仅触发 1 次摘要调用（每条历史只摘要一次）✓`);
  });
});
