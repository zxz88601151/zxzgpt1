import { describe, expect, it } from "vitest";
import { DIRECT } from "../api";
import { DEFAULT_SETTINGS } from "../presets";
import type { Conversation, FileWriteResult, Settings, Workspace } from "../types";
import { runRounds, type RunDeps } from "./session";

/**
 * 探索模式 file: 块门的直接判据：不挂载整个 App，只给 runRounds 喂假依赖。
 * 假上游只发一段带 file: 块的回答，看 writeFiles 到底有没有被调到。
 */
function runOnce(exploreMode: boolean): Promise<{ writes: FileWriteResult[][]; toasts: string[]; chats: number }> {
  const ws: Workspace = { sessionId: "s1", root: "F:/proj", name: "proj", tree: "" };
  const settings: Settings = { ...DEFAULT_SETTINGS, exploreMode, workspace: ws };
  const conversation: Conversation = { id: "c1", title: "t", messages: [], createdAt: 1, updatedAt: 1 };
  const writes: FileWriteResult[][] = [];
  const toasts: string[] = [];
  let chats = 0;

  const deps: RunDeps = {
    settings,
    conversation,
    skillPrompt: "",
    usedSkillIds: [],
    skills: [],
    baseMessages: [{ role: "user", content: "查一下", createdAt: 1 }],
    transport: DIRECT,
    chat: async (opts) => {
      chats += 1;
      opts.onEvent({ type: "delta", text: "```file:a.txt\nnew content\n```" });
    },
    tools: () => undefined,
    signal: new AbortController().signal,
    desktop: () => true,
    currentWorkspace: () => ws,
    commitMessages: () => {},
    patchMessage: () => {},
    toast: (text) => {
      toasts.push(text);
    },
    executeTool: async () => ({ id: "x", name: "read_file", arguments: "{}" }),
    writeFiles: async (blocks) => {
      writes.push(blocks as unknown as FileWriteResult[]);
      return blocks.map((b) => ({ path: b.path, ok: true, bytes: b.content.length, created: false, verified: true }));
    },
    readFiles: async () => [],
    readRefs: async () => [],
    runTest: async () => ({ exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false }),
  };
  return runRounds(deps).then(() => ({ writes, toasts, chats }));
}

describe("探索模式 file: 块门", () => {
  it("探索模式下 file: 块不落盘，只 toast 保留方案", async () => {
    const { writes, toasts, chats } = await runOnce(true);
    expect(writes).toEqual([]);
    expect(toasts).toContain("探索模式：本轮 file: 块未落盘，只保留方案");
    expect(chats).toBe(1);
  });

  it("关掉探索模式后同一段 file: 块正常落盘", async () => {
    const { writes, toasts } = await runOnce(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([{ path: "a.txt", content: "new content" }]);
    expect(toasts).not.toContain("探索模式：本轮 file: 块未落盘，只保留方案");
  });
});
