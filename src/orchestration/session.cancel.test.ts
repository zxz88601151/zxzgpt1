/** 轮循环的取消判据（独立复审 P2-5：此前 `session.ts` 的 signal.aborted break 无直接用例）。
 *  用最小假 deps 驱动真实 runRounds，不依赖 React / Tauri。 */

import { describe, expect, it, vi } from "vitest";
import { runRounds, type RunDeps } from "./session";
import { DEFAULT_SETTINGS } from "../presets";
import type { Conversation } from "../types";

function deps(over: Partial<RunDeps> = {}): RunDeps {
  const conv: Conversation = { id: "c1", title: "t", messages: [], createdAt: 1, updatedAt: 1 };
  return {
    settings: { ...DEFAULT_SETTINGS, toolCalls: false, autoCompact: false },
    conversation: conv,
    skillPrompt: "",
    usedSkillIds: [],
    skills: [],
    baseMessages: [{ role: "user", content: "hi", createdAt: 1 }],
    transport: {},
    chat: vi.fn().mockResolvedValue(undefined),
    tools: () => undefined,
    signal: new AbortController().signal,
    desktop: () => false,
    currentWorkspace: () => null,
    commitMessages: vi.fn(),
    patchMessage: vi.fn(),
    toast: vi.fn(),
    executeTool: vi.fn().mockResolvedValue({ id: "1", name: "read_file", arguments: "{}", result: "ok" }),
    writeFiles: vi.fn().mockResolvedValue([]),
    readFiles: vi.fn().mockResolvedValue([]),
    readRefs: vi.fn().mockResolvedValue([]),
    runTest: vi.fn().mockResolvedValue({ exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false }),
    ...over,
  } as unknown as RunDeps;
}

describe("runRounds：停止后不再继续", () => {
  it("signal 一开始就中止 → 一次 chat 都不发（轮首 break 的真实覆盖）", async () => {
    const controller = new AbortController();
    controller.abort();
    const chat = vi.fn();
    await runRounds(deps({ signal: controller.signal, chat }));
    expect(chat).not.toHaveBeenCalled();
  });

  it("工具轮中 abort → 工具一个都不执行，也不发第二轮 chat", async () => {
    const controller = new AbortController();
    const chat = vi.fn().mockImplementation(async (opts: { onEvent: (e: unknown) => void }) => {
      opts.onEvent({ type: "delta", text: "用工具" });
      opts.onEvent({ type: "tool_calls", calls: [{ id: "t1", name: "read_file", arguments: "{}" }] });
      controller.abort();
    });
    const executeTool = vi.fn();
    await runRounds(deps({ signal: controller.signal, chat, executeTool }));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("runRounds：停止后不再产生新副作用（第二轮复审）", () => {
  it("chat 中 abort → 不落盘、不跑自动测试、不读文件、不发第二轮", async () => {
    const controller = new AbortController();
    const chat = vi.fn().mockImplementation(async (opts: { onEvent: (e: unknown) => void }) => {
      opts.onEvent({ type: "delta", text: "回答" });
      opts.onEvent({ type: "tool_calls", calls: [{ id: "t1", name: "write_file", arguments: "{}" }] });
      controller.abort();
    });
    const writeFiles = vi.fn().mockResolvedValue([]);
    const runTest = vi.fn().mockResolvedValue({ exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false });
    const readFiles = vi.fn().mockResolvedValue([]);
    const readRefs = vi.fn().mockResolvedValue([]);
    await runRounds(deps({
      signal: controller.signal,
      chat,
      writeFiles,
      runTest,
      readFiles,
      readRefs,
      currentWorkspace: () => ({ sessionId: "s", root: "r", name: "n", tree: "" }),
      settings: { ...DEFAULT_SETTINGS, toolCalls: true, autoTest: true, autoCompact: false },
    }));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(writeFiles).not.toHaveBeenCalled();
    expect(runTest).not.toHaveBeenCalled();
    expect(readFiles).not.toHaveBeenCalled();
    expect(readRefs).not.toHaveBeenCalled();
  });
});
