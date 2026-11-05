/** 子代理编排的回归：未配模型拒绝 + 配了模型跑编排返回摘要。 */

import { describe, expect, it, vi } from "vitest";

import { runSubagent } from "./subagent";
import type { Settings } from "../types";

function baseSettings(over: Partial<Settings> = {}): Settings {
  return {
    preset: "custom",
    baseUrl: "http://x/v1",
    apiKey: "",
    model: "main-model",
    temperature: 0.7,
    maxTokens: null,
    contextTurns: 10,
    systemPrompt: "",
    stream: true,
    theme: "dark",
    workspace: null,
    skills: [],
    skillAuto: true,
    skillsDir: null,
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    settings: baseSettings(),
    transport: {},
    chat: vi.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal,
    desktop: () => false,
    currentWorkspace: () => null,
    executeTool: vi.fn().mockResolvedValue({ id: "1", name: "read_file", arguments: "{}", result: "" }),
    readFiles: vi.fn().mockResolvedValue([]),
    toast: vi.fn(),
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("runSubagent", () => {
  it("未配置 subagentModel 时返回提示，不发请求", async () => {
    const chat = vi.fn();
    const out = await runSubagent("摸清结构", deps({ settings: baseSettings({ subagentModel: undefined }), chat }));
    expect(out).toContain("未配置子代理模型");
    expect(chat).not.toHaveBeenCalled();
  });

  it("配置了 subagentModel 时跑编排，返回子代理的 content 摘要", async () => {
    const chat = vi.fn().mockImplementation(async (opts: { onEvent: (e: { type: string; text: string }) => void }) => {
      opts.onEvent({ type: "delta", text: "这是子代理的探索摘要" });
    });
    const out = await runSubagent("摸清结构", deps({ settings: baseSettings({ subagentModel: "glm-4.5-flash" }), chat }));
    expect(out).toBe("这是子代理的探索摘要");
    expect(chat).toHaveBeenCalled();
    const callOpts = chat.mock.calls[0][0] as { settings: Settings };
    expect(callOpts.settings.model).toBe("glm-4.5-flash");
  });
});
