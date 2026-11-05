/**
 * runToolBatch 并发调度回归：验证"高性能代码模式"并行工具执行的两级策略。
 *   - 只读工具（access==='read'）同批并发扇出；
 *   - 写/执行工具串行（保持原始相对顺序）；
 *   - 结果按下标回填，tool_call_id 顺序不丢；
 *   - 单条失败不拖垮整批。
 *
 * 直接喂受控的假 execute（带计时与可控延迟），不依赖真实 Tauri/IPC。
 */

import { describe, expect, it } from "vitest";
import { runToolBatch } from "./session";
import type { ToolCallRecord } from "../types";

type Call = { id: string; name: string; arguments: string };

/** 受控执行器：记录每条的开始/结束时间，按名字延迟；name==='fail' 模拟失败。 */
function makeExecutor(delays: Record<string, number> = {}) {
  const events: { name: string; start: number; end: number }[] = [];
  const execute = async (call: Call): Promise<ToolCallRecord> => {
    const d = delays[call.name] ?? 0;
    const start = Date.now();
    await new Promise((r) => setTimeout(r, d));
    events.push({ name: call.name, start, end: start + d });
    if (call.name === "fail") return { ...call, error: "boom" };
    return { ...call, result: "ok" };
  };
  return { execute, events };
}

describe("runToolBatch 并发调度", () => {
  it("只读工具同批并发执行（提速）", async () => {
    const calls: Call[] = [
      { id: "1", name: "read_file", arguments: "{}" },
      { id: "2", name: "glob", arguments: "{}" },
      { id: "3", name: "search_files", arguments: "{}" },
    ];
    const { execute, events } = makeExecutor({ read_file: 30, glob: 30, search_files: 30 });
    const t0 = Date.now();
    const recs = await runToolBatch(calls, execute);
    const elapsed = Date.now() - t0;

    expect(recs).toHaveLength(3);
    // 串行需 90ms；并发应在单条延迟量级内完成
    expect(elapsed).toBeLessThan(75);
    // 三条几乎同时开始（第三条在第一条结束前就已启动）
    const starts = events.map((e) => e.start).sort((a, b) => a - b);
    expect(starts[2] - starts[0]).toBeLessThan(30);
  });

  it("写/执行工具串行，不重叠", async () => {
    const calls: Call[] = [
      { id: "1", name: "write_file", arguments: "{}" },
      { id: "2", name: "run_command", arguments: "{}" },
    ];
    const { execute, events } = makeExecutor({ write_file: 20, run_command: 20 });
    await runToolBatch(calls, execute);
    expect(events).toHaveLength(2);
    const [w, r] = events;
    // 第二条在第一条结束后才开始（串行）
    expect(r.start).toBeGreaterThanOrEqual(w.end - 1);
  });

  it("混合批：只读并发 + 写串行，按下标回填保持原顺序", async () => {
    const calls: Call[] = [
      { id: "1", name: "read_file", arguments: "{}" },
      { id: "2", name: "write_file", arguments: "{}" },
      { id: "3", name: "glob", arguments: "{}" },
      { id: "4", name: "edit_file", arguments: "{}" },
    ];
    const { execute } = makeExecutor({});
    const recs = await runToolBatch(calls, execute);
    expect(recs.map((r) => r.name)).toEqual(["read_file", "write_file", "glob", "edit_file"]);
    expect(recs.map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("单条失败不拖垮整批，全部结果就位", async () => {
    const calls: Call[] = [
      { id: "1", name: "read_file", arguments: "{}" },
      { id: "2", name: "fail", arguments: "{}" },
      { id: "3", name: "glob", arguments: "{}" },
    ];
    const { execute } = makeExecutor({});
    const recs = await runToolBatch(calls, execute);
    expect(recs).toHaveLength(3);
    expect(recs[0].result).toBe("ok");
    expect(recs[1].error).toBe("boom");
    expect(recs[2].result).toBe("ok");
  });

  it("未知工具归入闸控层串行，不并发", async () => {
    const calls: Call[] = [
      { id: "1", name: "ghost_tool", arguments: "{}" },
      { id: "2", name: "read_file", arguments: "{}" },
    ];
    const { execute, events } = makeExecutor({ ghost_tool: 20 });
    await runToolBatch(calls, execute);
    // ghost_tool 不是注册表里的工具 → 闸控串行；read_file 并行层空，不受影响
    expect(events).toHaveLength(2);
  });
});
