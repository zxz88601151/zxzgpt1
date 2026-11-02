import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../presets";
import type { Conversation } from "../types";
import {
  appendAssistantMessage,
  appActionLabel,
  appCommandHelp,
  nextInputAfterCommand,
  parseAppCommand,
  planAppCommand,
  withToggleApplied,
} from "./appcontrol";

describe("parseAppCommand", () => {
  it("普通消息不是命令，返回 null 不拦截", () => {
    expect(parseAppCommand("帮我看这个文件")).toBeNull();
    expect(parseAppCommand("  今天天气怎么样")).toBeNull();
    expect(parseAppCommand("")).toBeNull();
  });
  it("开关命令中英文都认，值只认 开/关/on/off/开启/关闭", () => {
    expect(parseAppCommand("/plan 开")).toEqual({ action: { kind: "toggle", key: "planMode", value: true } });
    expect(parseAppCommand("/tools off")).toEqual({ action: { kind: "toggle", key: "toolCalls", value: false } });
    expect(parseAppCommand("/explore 开")).toEqual({ action: { kind: "toggle", key: "exploreMode", value: true } });
    expect(parseAppCommand("/计划 关")).toEqual({ action: { kind: "toggle", key: "planMode", value: false } });
    expect(parseAppCommand("/自动测试 开启")).toEqual({ action: { kind: "toggle", key: "autoTest", value: true } });
    expect(parseAppCommand("/写入确认 关闭")).toEqual({ action: { kind: "toggle", key: "confirmWrites", value: false } });
    expect(parseAppCommand("/plan yes")).toMatchObject({ error: expect.stringContaining("只能是") });
  });
  it("已知命令缺参数、多参数只报错不执行", () => {
    expect(parseAppCommand("/plan")).toMatchObject({ error: expect.stringContaining("要跟") });
    expect(parseAppCommand("/plan 开 关")).toMatchObject({ error: expect.stringContaining("只接受") });
  });
  it("D16 收窄：首词不命中命令名就不是命令，原样发给模型", () => {
    // 旧判定「/ 开头即命令」会把这些正常句子吞掉（C1-D1 桌面端 V8b 实测复现）
    expect(parseAppCommand("/etc/hosts 里的 127.0.0.1 是干嘛的")).toBeNull();
    expect(parseAppCommand("/rm -rf /tmp/demo 会有什么后果")).toBeNull();
    expect(parseAppCommand("/usr/local/bin/node --version")).toBeNull();
    expect(parseAppCommand("/2026/11 的排期怎么排")).toBeNull();
    expect(parseAppCommand("/wtf")).toBeNull();
    expect(parseAppCommand("/zzz 开")).toBeNull();
    expect(parseAppCommand("/")).toBeNull();
    expect(parseAppCommand("   /   ")).toBeNull();
  });
  it("/new、/help 独立动作，不带参数；多余参数明确拒绝", () => {
    expect(parseAppCommand("/new")).toEqual({ action: { kind: "new_session" } });
    expect(parseAppCommand("/new xxx")).toMatchObject({ error: expect.stringContaining("不带参数") });
    expect(parseAppCommand("/help")).toEqual({ action: { kind: "help" } });
    expect(parseAppCommand("/help foo")).toMatchObject({ error: expect.stringContaining("不带参数") });
  });
  it("大小写策略锁定：只认小写与中英别名，/PLAN 不命中命令名", () => {
    // 大写不再生成「未知命令」错误，而是不拦截 —— D16 的代价，见 appcontrol.ts:7-8
    expect(parseAppCommand("/PLAN 开")).toBeNull();
    expect(parseAppCommand("/Plan 开")).toBeNull();
    expect(parseAppCommand("/plan 开")).not.toBeNull();
  });
  it("前后空白不影响判定（App 入口已对 input.trim，解析器再兜一次）", () => {
    expect(parseAppCommand("  /plan 开  ")).toEqual({ action: { kind: "toggle", key: "planMode", value: true } });
    expect(parseAppCommand("\t/new\n")).toEqual({ action: { kind: "new_session" } });
  });
  it("清单里列出的命令解析都能过，清单与解析不脱节", () => {
    for (const line of appCommandHelp().split("\n")) {
      const m = line.match(/^\/(\w+) 开\|关/);
      if (m) expect(parseAppCommand(`/${m[1]} 开`)).not.toMatchObject({ error: expect.anything() });
    }
  });
});

describe("appActionLabel", () => {
  it("开关动作说清改了哪个开关、开还是关", () => {
    expect(appActionLabel({ kind: "toggle", key: "planMode", value: true })).toBe("计划模式已开启");
    expect(appActionLabel({ kind: "toggle", key: "exploreMode", value: false })).toBe("探索模式已关闭");
  });
  it("新建会话文案的唯一来源就是本函数（App 的 toast 不得另写一份）", () => {
    expect(appActionLabel({ kind: "new_session" })).toBe("已新建会话");
  });
});

describe("nextInputAfterCommand（F1 回归：解析失败不吞输入）", () => {
  it("解析失败逐字符保留原始输入，含首尾空白", () => {
    const raw = "  /plan 也许吧  ";
    const plan = planAppCommand(raw.trim(), { busy: false, active: true });
    expect(plan.kind).toBe("error");
    expect(nextInputAfterCommand(raw, plan)).toBe(raw);
  });
  it("D16：以 / 开头的普通句子直通，输入同样逐字保留", () => {
    const raw = "/etc/hosts 里的 127.0.0.1 是干嘛的";
    const plan = planAppCommand(raw, { busy: false, active: true });
    expect(plan.kind).toBe("passthrough");
    expect(nextInputAfterCommand(raw, plan)).toBe(raw);
  });
  it("已执行的 help 与 toggle 清空输入", () => {
    const help = planAppCommand("/help", { busy: false, active: true });
    const toggle = planAppCommand("/plan 开", { busy: false, active: true });
    expect(nextInputAfterCommand("/help", help)).toBe("");
    expect(nextInputAfterCommand("/plan 开", toggle)).toBe("");
  });
  it("new_session 不在此处清空（由 App 的 createConv 负责），原样返回", () => {
    const plan = planAppCommand("/new", { busy: false, active: true });
    expect(plan.kind).toBe("new_session");
    expect(nextInputAfterCommand("/new", plan)).toBe("/new");
  });
  it("passthrough 保留原文：命令层对普通消息零影响", () => {
    const plan = planAppCommand("帮我看这个文件", { busy: false, active: false });
    expect(nextInputAfterCommand("帮我看这个文件", plan)).toBe("帮我看这个文件");
  });
});

describe("planAppCommand（入口 + busy 语义）", () => {
  const on = { busy: false, active: true };
  it("普通文本与 active=false 都直通，不拦截", () => {
    expect(planAppCommand("你好", on)).toEqual({ kind: "passthrough" });
    expect(planAppCommand("/plan 开", { busy: false, active: false })).toEqual({ kind: "passthrough" });
  });
  it("busy 时命令拒绝执行且计划不携带任何状态变更", () => {
    expect(planAppCommand("/plan 开", { busy: true, active: true })).toEqual({ kind: "reject_busy" });
    expect(planAppCommand("/new", { busy: true, active: true })).toEqual({ kind: "reject_busy" });
  });
  it("busy 只作用于命令，普通消息仍由调用方走原有 busy 门", () => {
    expect(planAppCommand("普通消息", { busy: true, active: true })).toEqual({ kind: "passthrough" });
  });
  it("解析失败只给错误文本；合法命令给出可执行计划", () => {
    expect(planAppCommand("/wtf", on)).toEqual({ kind: "passthrough" });
    expect(planAppCommand("/plan 也许吧", on)).toMatchObject({ kind: "error", message: expect.stringContaining("只能是") });
    expect(planAppCommand("/help", on)).toMatchObject({ kind: "help", message: expect.stringContaining("/plan 开|关") });
    expect(planAppCommand("/new", on)).toEqual({ kind: "new_session" });
    expect(planAppCommand("/plan 开", on)).toEqual({ kind: "toggle", key: "planMode", value: true, label: "计划模式已开启" });
    expect(planAppCommand("/tools 关", on)).toEqual({ kind: "toggle", key: "toolCalls", value: false, label: "工具调用已关闭" });
  });
});

describe("状态变化（应用真实变换函数，不止解析）", () => {
  it("五个开关逐一落到 settings 对应字段", () => {
    const cases = [
      { key: "planMode", value: true },
      { key: "toolCalls", value: false },
      { key: "autoTest", value: true },
      { key: "confirmWrites", value: true },
      { key: "exploreMode", value: true },
    ] as const;
    for (const c of cases) {
      const next = withToggleApplied(DEFAULT_SETTINGS, c);
      expect(next[c.key]).toBe(c.value);
    }
  });
  it("变换不可变：原 settings 对象不被修改", () => {
    const before = { ...DEFAULT_SETTINGS, planMode: false };
    const next = withToggleApplied(before, { key: "planMode", value: true });
    expect(before.planMode).toBe(false);
    expect(next.planMode).toBe(true);
    expect(next).not.toBe(before);
  });
  it("连续快速执行同一命令幂等：多次应用终值稳定", () => {
    let s = DEFAULT_SETTINGS;
    for (let i = 0; i < 3; i++) s = withToggleApplied(s, { key: "autoTest", value: true });
    expect(s.autoTest).toBe(true);
    s = withToggleApplied(s, { key: "autoTest", value: false });
    expect(s.autoTest).toBe(false);
  });
  it("解析失败不触碰任何状态：错误计划对 settings/会话零改动", () => {
    const plan = planAppCommand("/plan 也许吧", { busy: false, active: true });
    expect(plan.kind).toBe("error");
    expect("key" in plan).toBe(false);
  });
  it("/help 把助手消息追加进当前会话，不动其他会话", () => {
    const convs: Conversation[] = [
      { id: "a", title: "旧", messages: [{ role: "user", content: "hi", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
      { id: "b", title: "当前", messages: [], createdAt: 2, updatedAt: 2 },
    ];
    const r = appendAssistantMessage(convs, "b", appCommandHelp(), 99);
    expect(r.appended).toBe(true);
    const b = r.conversations.find((c) => c.id === "b")!;
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0].role).toBe("assistant");
    expect(b.messages[0].content).toContain("/plan 开|关");
    expect(b.updatedAt).toBe(99);
    expect(r.conversations.find((c) => c.id === "a")!.messages).toHaveLength(1);
    expect(convs[1].messages).toHaveLength(0); // 原数组未被原地修改
  });
  it("无当前会话时帮助消息不落：返回原数组，由 App 决定先建会话", () => {
    const convs: Conversation[] = [];
    const r = appendAssistantMessage(convs, null, appCommandHelp(), 99);
    expect(r.appended).toBe(false);
    expect(r.conversations).toBe(convs);
  });
});
