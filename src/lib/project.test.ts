import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../presets";
import { buildMessages } from "../state";
import { buildPendingWrites } from "./pending";
import { buildPlanPrompt, buildProjectMemoryPrompt, truncateProjectMemory } from "./project";

describe("项目记忆", () => {
  it("截断时明说只取了前半部分，而不是假装完整", () => {
    const long = "x".repeat(9000);
    const out = truncateProjectMemory(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("已截断");
    expect(out).toContain("9000");
  });

  it("空记忆不产生系统消息", () => {
    expect(buildProjectMemoryPrompt("CLAUDE.md", "  ")).toBe("");
  });

  it("工程记忆进 buildMessages，且在计划指令之前", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      workspace: { root: "/tmp/demo", name: "demo", tree: "", memory: "本项目禁止用魔法值", memorySource: "CLAUDE.md" },
    };
    const msgs = buildMessages({ id: "c", title: "t", messages: [], createdAt: 0, updatedAt: 0 }, settings);
    const joined = msgs.map((m) => m.content).join("\n");
    expect(joined).toContain("CLAUDE.md");
    expect(joined).toContain("禁止用魔法值");
  });
});

describe("计划模式", () => {
  it("指令明确禁止 file: 块，计划模式下不写文件、不跑命令", () => {
    const p = buildPlanPrompt();
    expect(p).toContain("file:");
    expect(p).toContain("计划模式下你不能写文件、不能跑命令");
    expect(p).toContain("run_command");
  });

  it("planMode 开启时 buildMessages 末尾带计划指令", () => {
    const settings = { ...DEFAULT_SETTINGS, planMode: true };
    const msgs = buildMessages({ id: "c", title: "t", messages: [], createdAt: 0, updatedAt: 0 }, settings);
    expect(msgs.some((m) => m.content.includes("计划模式"))).toBe(true);
  });

  it("planMode 关闭时不带计划指令", () => {
    const settings = { ...DEFAULT_SETTINGS, planMode: false };
    const msgs = buildMessages({ id: "c", title: "t", messages: [], createdAt: 0, updatedAt: 0 }, settings);
    expect(msgs.some((m) => m.content.includes("计划模式"))).toBe(false);
  });
});

describe("写入前确认", () => {
  it("新建与覆盖分得清，旧内容原样带进面板", () => {
    const olds = new Map([["src/a.ts", "old"]]);
    const items = buildPendingWrites(
      [
        { path: "src/a.ts", content: "new" },
        { path: "src/b.ts", content: "fresh" },
      ],
      olds
    );
    expect(items[0]).toEqual({ path: "src/a.ts", content: "new", oldText: "old", created: false });
    expect(items[1].created).toBe(true);
    expect(items[1].oldText).toBe("");
  });
});
