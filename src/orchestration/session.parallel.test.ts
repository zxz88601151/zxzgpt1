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

  it("并发层执行器抛异常 → 补成可读 error 记录，records 无空洞", async () => {
    const calls: Call[] = [
      { id: "1", name: "read_file", arguments: "{}" },
      { id: "2", name: "glob", arguments: "{}" },
      { id: "3", name: "search_files", arguments: "{}" },
    ];
    const execute = async (call: Call): Promise<ToolCallRecord> => {
      if (call.name === "read_file") throw new Error("IPC 断了");
      return { ...call, result: "ok" };
    };
    const recs = await runToolBatch(calls, execute);
    expect(recs).toHaveLength(3);
    expect(recs.every((r) => r !== undefined)).toBe(true);
    expect(recs[0].error).toMatch(/工具执行异常：IPC 断了/);
    expect(recs[0].id).toBe("1");
    expect(recs[1].result).toBe("ok");
    expect(recs[2].result).toBe("ok");
  });

  it("闸控层（写/执行）抛异常同样补 error，不拖垮后续调用", async () => {
    const calls: Call[] = [
      { id: "1", name: "write_file", arguments: "{}" },
      { id: "2", name: "run_command", arguments: "{}" },
    ];
    let n = 0;
    const execute = async (call: Call): Promise<ToolCallRecord> => {
      n += 1;
      if (n === 1) throw new Error("写入面板崩了");
      return { ...call, result: "ok" };
    };
    const recs = await runToolBatch(calls, execute);
    expect(recs).toHaveLength(2);
    expect(recs[0].error).toMatch(/工具执行异常：写入面板崩了/);
    expect(recs[1].result).toBe("ok");
    expect(n).toBe(2);
  });

  it("执行器返回 undefined 也补成错误记录，绝不留空洞", async () => {
    const calls: Call[] = [{ id: "1", name: "read_file", arguments: "{}" }];
    const execute = async () => undefined as unknown as ToolCallRecord;
    const recs = await runToolBatch(calls, execute);
    expect(recs).toHaveLength(1);
    expect(recs[0].error).toMatch(/工具执行异常/);
  });

  it("一批 3 个 explore 只执行 1 个，其余被成本闸门跳过", async () => {
    const calls: Call[] = [1, 2, 3].map((i) => ({ id: String(i), name: "explore", arguments: "{}" }));
    const { execute, events } = makeExecutor({});
    const recs = await runToolBatch(calls, execute);
    expect(events).toHaveLength(1);
    expect(recs).toHaveLength(3);
    expect(recs[0].result).toBe("ok");
    expect(recs[1].error).toMatch(/成本|上限/);
    expect(recs[2].error).toMatch(/成本|上限/);
  });

  it("9 个只读工具按 4 个一波限流，不是一次全扇出", async () => {
    const calls: Call[] = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      name: "read_file",
      arguments: "{}",
    }));
    const { execute, events } = makeExecutor({ read_file: 20 });
    const t0 = Date.now();
    const recs = await runToolBatch(calls, execute);
    const elapsed = Date.now() - t0;
    expect(recs).toHaveLength(9);
    expect(events).toHaveLength(9);
    // 全串行 = 180ms；3 波并发约 60ms；上限 150ms 能区分两者
    expect(elapsed).toBeLessThan(150);
  });

  it("MCP 动态工具名按 unknown 归入闸控层，不与只读工具并发", async () => {
    const calls: Call[] = [
      { id: "1", name: "mcp_context_mode_ctx_execute", arguments: "{}" },
      { id: "2", name: "read_file", arguments: "{}" },
    ];
    const { execute } = makeExecutor({ mcp_context_mode_ctx_execute: 20, read_file: 20 });
    const t0 = Date.now();
    const recs = await runToolBatch(calls, execute);
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r !== undefined)).toBe(true);
    // 两条串行 = 40ms；若被误判为并发则约 20ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
  });
});
