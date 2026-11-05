/** D-22：并发分波与成本闸门的纯函数回归。 */

import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_READS,
  MAX_EXPENSIVE_PER_BATCH,
  planToolBatch,
  type BatchClass,
} from "./budget";

const names = (...n: string[]) => n.map((name) => ({ name }));

function classify(name: string): BatchClass {
  if (name === "explore") return "expensive";
  if (name.startsWith("read") || name === "glob" || name === "search_files") return "cheap";
  return "gated";
}

describe("planToolBatch：只读并发分波", () => {
  it("9 个只读工具按 4 个一波切成 3 波", () => {
    const plan = planToolBatch(names(...Array(9).fill("read_file")), classify);
    expect(plan.waves.map((w) => w.length)).toEqual([4, 4, 1]);
    expect(plan.serial).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("上限可配置（2 个一波）", () => {
    const plan = planToolBatch(names("read_file", "glob", "search_files", "read_file", "read_file"), classify, {
      maxConcurrentReads: 2,
    });
    expect(plan.waves.map((w) => w.length)).toEqual([2, 2, 1]);
  });

  it("空批不产生任何波次", () => {
    const plan = planToolBatch([], classify);
    expect(plan).toEqual({ waves: [], serial: [], skipped: [] });
  });
});

describe("planToolBatch：成本闸门", () => {
  it("一批 3 个 explore 只执行 1 个，其余被跳过并带原因", () => {
    const plan = planToolBatch(names("explore", "explore", "explore"), classify);
    expect(plan.serial).toEqual([0]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.map((s) => s.idx)).toEqual([1, 2]);
    expect(plan.skipped[0].reason).toMatch(/上限 1|成本/);
  });

  it("上限设为 0 时全部高成本工具都不执行", () => {
    const plan = planToolBatch(names("explore", "explore"), classify, { maxExpensivePerBatch: 0 });
    expect(plan.serial).toEqual([]);
    expect(plan.skipped.map((s) => s.idx)).toEqual([0, 1]);
  });

  it("上限调宽后按新上限放行", () => {
    const plan = planToolBatch(names("explore", "explore", "explore"), classify, {
      maxExpensivePerBatch: 2,
    });
    expect(plan.serial).toEqual([0, 1]);
    expect(plan.skipped.map((s) => s.idx)).toEqual([2]);
  });

  it("混合批：cheap 分波、expensive 与 gated 串行且按原下标升序", () => {
    const plan = planToolBatch(
      names("read_file", "write_file", "explore", "glob", "run_command", "search_files"),
      classify
    );
    expect(plan.waves).toEqual([[0, 3, 5]]); // 3 个 cheap 未超 4，同一波并发
    expect(plan.serial).toEqual([1, 2, 4]);
    expect(plan.skipped).toEqual([]);
  });

  it("默认常量就是调度层用的值", () => {
    expect(MAX_CONCURRENT_READS).toBe(4);
    expect(MAX_EXPENSIVE_PER_BATCH).toBe(1);
  });
});
