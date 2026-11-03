/** 轮末判定的出口用例：每条出口一条断言，另外锁住「顺序不能重排」和「文案逐字不变」。 */

import { describe, expect, it } from "vitest";

import { MAX_ROUNDS, nextRound, shouldAutoTest, stopNotice, type RoundSignals } from "./round";
import { MAX_TEST_ROUNDS } from "../lib/tools";

/** 一个"正常推进中"的默认信号，用例里只改要测的那几个字段 */
function sig(over: Partial<RoundSignals> = {}): RoundSignals {
  return { aborted: false, failed: false, testGiveUp: false, toolCalls: 0, reads: 0, skillRefs: 0, round: 0, ...over };
}

describe("nextRound：六种出口", () => {
  // 下面三条测的是"兜底语义"：生产路径上调用方已经提前 break 过，
  // 这里保证纯函数对全定义域有明确取值（见 round.ts 头部对边界的说明）。
  it("中断 → stop/aborted", () => {
    expect(nextRound(sig({ aborted: true, failed: true, testGiveUp: true, toolCalls: 3 }))).toEqual({
      kind: "stop",
      reason: "aborted",
    });
  });

  it("报错 → stop/failed", () => {
    expect(nextRound(sig({ failed: true, toolCalls: 5, reads: 2 }))).toEqual({ kind: "stop", reason: "failed" });
  });

  it("测试放弃 → stop/test_gave_up", () => {
    expect(nextRound(sig({ testGiveUp: true, reads: 3 }))).toEqual({ kind: "stop", reason: "test_gave_up" });
  });

  it("没有任何后续请求 → stop/no_followup（正常收尾）", () => {
    expect(nextRound(sig())).toEqual({ kind: "stop", reason: "no_followup" });
  });

  it("有工具调用 → continue", () => {
    expect(nextRound(sig({ toolCalls: 2 }))).toEqual({ kind: "continue" });
  });

  it("只有读文件请求 → continue", () => {
    expect(nextRound(sig({ reads: 1 }))).toEqual({ kind: "continue" });
  });

  it("只有技能附件请求 → continue", () => {
    expect(nextRound(sig({ skillRefs: 1 }))).toEqual({ kind: "continue" });
  });

  // 工具调用与读文件同时出现时必须判为「有后续」，不能因为 toolCalls>0 就短路过 reads 的判断
  it("工具调用 + 读文件同时出现 → continue", () => {
    expect(nextRound(sig({ toolCalls: 1, reads: 2, skillRefs: 1 }))).toEqual({ kind: "continue" });
  });
});

describe("轮数上限：顺序与边界", () => {
  // 顺序断言：最后一轮「本来就没后续请求」时应按正常收尾停，而不是报「轮数用尽」。
  // 两者对用户的含义完全不同——后者像是被强行掐断。
  it("最后一轮没有后续请求 → 正常收尾，不是轮数用尽", () => {
    expect(nextRound(sig({ round: MAX_ROUNDS - 1 }))).toEqual({ kind: "stop", reason: "no_followup" });
  });

  it("最后一轮还有后续请求 → 轮数用尽", () => {
    expect(nextRound(sig({ round: MAX_ROUNDS - 1, toolCalls: 1 }))).toEqual({
      kind: "stop",
      reason: "rounds_exhausted",
    });
  });

  it("最后一轮只有读请求也算还有后续 → 轮数用尽", () => {
    expect(nextRound(sig({ round: MAX_ROUNDS - 1, reads: 1 }))).toEqual({
      kind: "stop",
      reason: "rounds_exhausted",
    });
  });

  it("倒数第二轮仍可继续", () => {
    expect(nextRound(sig({ round: MAX_ROUNDS - 2, toolCalls: 1 }))).toEqual({ kind: "continue" });
  });

  it("上限来自导出的常量，被改小整体跟着变", () => {
    // MAX_ROUNDS 是导出常量而不是散落的字面量 6：这条锁住"判定用的是它"
    expect(MAX_ROUNDS).toBeGreaterThan(0);
    expect(nextRound(sig({ round: MAX_ROUNDS - 1, toolCalls: 1 })).kind).toBe("stop");
    expect(nextRound(sig({ round: MAX_ROUNDS - 2, toolCalls: 1 })).kind).toBe("continue");
  });
});

describe("stopNotice：文案逐字锁住，静默必须有理由", () => {
  it("轮数用尽：文案与旧版逐字相同", () => {
    expect(stopNotice("rounds_exhausted")).toBe("已达到本次最多 6 轮读写，继续请再发一条消息");
  });

  it("测试放弃：带上具体轮数，说清是「停止自动修复」而不是「失败」", () => {
    expect(stopNotice("test_gave_up")).toBe(`测试 ${MAX_TEST_ROUNDS} 轮仍未通过，已停止自动修复，请人工处理`);
  });

  it("正常收尾、用户主动中止、已报过错的都不再弹", () => {
    expect(stopNotice("no_followup")).toBeNull();
    expect(stopNotice("aborted")).toBeNull();
    expect(stopNotice("failed")).toBeNull();
  });

  // 用 Record<StopReason, ...> 而不是手写数组：将来给 StopReason 加成员时
  // 这里会编译不过，逼着作者同时决定"那句提示该说什么"。
  it("每种停止原因都有归宿：要么一句提示，要么 null（不能是 undefined）", () => {
    const expected: Record<Parameters<typeof stopNotice>[0], "text" | "silent"> = {
      aborted: "silent",
      failed: "silent",
      test_gave_up: "text",
      no_followup: "silent",
      rounds_exhausted: "text",
    };
    for (const [reason, kind] of Object.entries(expected) as [keyof typeof expected, "text" | "silent"][]) {
      const out = stopNotice(reason);
      if (kind === "text") expect(typeof out).toBe("string");
      else expect(out).toBeNull();
    }
  });
});

describe("shouldAutoTest：默认路径绝不自动执行", () => {
  const on = {
    wroteSomething: true,
    autoTest: true,
    toolCalls: true,
    planMode: false,
    desktop: true,
    hasWorkspace: true,
  };

  it("全部满足才跑", () => {
    expect(shouldAutoTest(on)).toBe(true);
  });

  it.each([
    ["没写文件", { wroteSomething: false }],
    ["没开自动测试", { autoTest: undefined }],
    ["自动测试为 false", { autoTest: false }],
    // 任何非 true 的值都不能开启：写成 !autoTest 会把 "false" 当成开
    ["自动测试是字符串 \"false\"", { autoTest: "false" }],
    ["自动测试是数字 1", { autoTest: 1 }],
    ["自动测试是字符串 \"true\"", { autoTest: "true" }],
    ["关闭了工具调用", { toolCalls: false }],
    ["计划模式", { planMode: true }],
    ["浏览器直开", { desktop: false }],
    ["未接入工程目录", { hasWorkspace: false }],
  ])("%s → 不跑", (_label, over) => {
    expect(shouldAutoTest({ ...on, ...over })).toBe(false);
  });

  // 这两条是给"归一化"兜底的：开关默认开，缺字段不该被当成用户关掉。
  // 如果谁把函数里的 `g.toolCalls === false` 改成 `!g.toolCalls`，这里会红。
  it("toolCalls 缺字段（undefined）视为开启，不阻断测试回路", () => {
    expect(shouldAutoTest({ ...on, toolCalls: undefined })).toBe(true);
  });

  it("toolCalls 是 null / 0 / 空串 也视为开启", () => {
    for (const v of [null, 0, ""]) expect(shouldAutoTest({ ...on, toolCalls: v })).toBe(true);
  });
});
