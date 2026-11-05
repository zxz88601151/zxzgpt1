/** 一次发送的轮循环（原来长在 `App.tsx` 的 `send()` 闭包里）。
 *
 * 搬出来的目的只有一个：让"一轮结束后下一步做什么"这件事能在**没有 React**的
 * 环境里被驱动和断言。B12-B1 / B12-B2 已经在 jsdom 里给这段逻辑建了回归网
 * （挂载、整轮重放 7 类），本文件是 ADR 0001 第 2 步的搬运落点。
 *
 * **边界（读之前先看这条）**：这里只放"循环"，不放 UI 状态。
 *   - 不放：input / busy / drawer / toast 列表 / AbortController 的生命周期；
 *   - 不放：工具怎么执行（`executeTool` 由调用方注入，它还要问审批）、
 *     文件怎么落盘（`writeFiles` 注入）、命令怎么跑（`runTest` 注入）。
 * 依赖全部从 `deps` 进来，所以本文件不 import react，也不 import App。
 *
 * **只搬运，不改语义**（ADR 0001 D3）：轮数上限、测试回路 3 轮独立计数、
 * `file:` / `@@read:` 兼容协议、工具结果展开成原生协议，全部原样保留。
 * 任何"顺手优化"都会让搬家前后的 447 条断言失去对照意义。
 */

import { buildReadPayload, parseFileBlocks, parseReadRequests, type FileBlock, type ReadOutcome } from "../lib/files";
import { findTool } from "../lib/registry";
import {
  MAX_TEST_ROUNDS,
  runResultHead,
  testLoopDecision,
  truncateToolOutput,
  type ToolDefinition,
} from "../lib/tools";
import { parseSkillRefs, type Skill, type SkillRef } from "../lib/skill";
import type { RunResult } from "../lib/fsapi";
import { buildMessages } from "../state";
import type {
  Conversation,
  FileWriteResult,
  Message,
  Settings,
  ToolCallRecord,
  Transport,
  Usage,
  Workspace,
} from "../types";
import type { ChatOptions } from "../api";
import { MAX_ROUNDS, nextRound, shouldAutoTest, stopNotice } from "./round";

/** 流式增量按帧合并。Node 环境没有 rAF（orchestration 要能在无浏览器下单测），
 *  退化成 16ms 定时器；浏览器路径与原来的 requestAnimationFrame 完全一致。 */
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;
const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === "function" ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h);

/** toast 的最小形状。不引用组件的 ToastKind，免得编排层反向依赖 UI 目录。 */
export type Notice = (text: string, kind?: "ok" | "error" | "") => void;

/**
 * 一次发送需要外部提供的全部能力。
 *
 * 看起来偏宽，但这是"只搬运"的代价：这些能力在 App 里各自连着 UI、IPC 或审批流程，
 * 不能跟着循环一起搬。注入之后，测试可以只给假实现就驱动整轮。
 */
export interface RunDeps {
  /** 本轮开始时的设置快照（旧代码在 send() 开头取一次 `s`，语义保持一致） */
  settings: Settings;
  /** 会话快照，只用于 buildMessages 的 system 段（root / tree / memory） */
  conversation: Conversation;
  /** 本轮已选中的技能（正文进 prompt）与它们的 id（写进助手消息，便于回溯） */
  skillPrompt: string;
  usedSkillIds: string[];
  skills: Skill[];
  /** 已含本轮用户消息的初始消息列表（重新生成时是裁剪后的历史） */
  baseMessages: Message[];
  /** 轮数上限。默认 MAX_ROUNDS（主对话 6）；子代理传 4。 */
  maxRounds?: number;

  transport: Transport;
  /** 发一次流式请求。注入而非直接 import，测试可以换成假上游 */
  chat: (opts: ChatOptions) => Promise<void>;
  /** 发给模型的工具定义；返回 undefined 表示本轮按纯聊天发（工具模式关闭或没接工程）。
   *  做成函数而不是值：旧代码每轮都重新判断一次 workspace 是否还在。 */
  tools: () => ToolDefinition[] | undefined;
  signal: AbortSignal;
  /** 是否为桌面端（决定能不能跑命令）。每次求值，与原来的 `fsAvailable()` 一致 */
  desktop: () => boolean;
  /** 当前工程的会话号；未接入工程返回 null。旧代码每轮都读一次最新设置 */
  currentWorkspace: () => Workspace | null;

  /** 把当前会话的消息整体替换成给定列表（等价于原来的 update(...conversations...)） */
  commitMessages: (messages: Message[]) => void;
  /** 就地更新某条消息（流式增量用） */
  patchMessage: (index: number, fn: (m: Message) => Message) => void;
  toast: Notice;

  /** 执行一次模型发起的工具调用（含权限拦截、参数校验、审批） */
  executeTool: (call: { id: string; name: string; arguments: string }) => Promise<ToolCallRecord>;
  /** 落盘。计划模式由调用方在循环外拦；这里只负责"给了块就写" */
  writeFiles: (blocks: FileBlock[]) => Promise<FileWriteResult[]>;
  /** 按 `@@read:` 回传文件内容 */
  readFiles: (paths: string[]) => Promise<ReadOutcome[]>;
  /** 按 `@@ref:` 回传技能附件 */
  readRefs: (refs: SkillRef[]) => Promise<ReadOutcome[]>;
  /** 跑一次白名单命令（测试回路用） */
  runTest: (argv: string[]) => Promise<RunResult>;
}

/**
 * 跑完整的一轮发送。返回时"这一轮结束"的所有副作用都已经落到 `commitMessages` 上。
 *
 * 中止与报错都不会抛出：它们由 `nextRound` 判定为 stop，然后正常返回——
 * 调用方只需要在 finally 里复位 busy。这一点与旧实现一致（旧代码也把异常吞在
 * 循环内部的 try/catch 里）。
 */
export async function runRounds(deps: RunDeps): Promise<void> {
  const s = deps.settings;
  const target = deps.conversation;
  let baseMessages = deps.baseMessages.slice();

  /** 把 baseMessages 写回会话。旧代码用 update() 逐次展开，这里收敛成一个入口。 */
  const writeBack = (messages: Message[]) => {
    baseMessages = messages;
    deps.commitMessages(messages);
  };

  // 测试回路计数：本次发送里已经跑完的 npm test 轮数，上限 MAX_TEST_ROUNDS
  let testRounds = 0;
  const maxRounds = deps.maxRounds ?? MAX_ROUNDS;

  for (let round = 0; round < maxRounds; round++) {
    const assist: Message = {
      role: "assistant",
      content: "",
      reasoning: "",
      model: s.model,
      createdAt: Date.now(),
      streaming: true,
    };
    const messages = [...baseMessages, assist];
    const index = messages.length - 1;
    writeBack(messages);

    const acc = { content: "", reasoning: "", usage: undefined as Usage | undefined };
    let raf = 0;
    const flush = () => {
      raf = 0;
      deps.patchMessage(index, (m) => ({
        ...m,
        content: acc.content,
        reasoning: acc.reasoning,
        usage: acc.usage,
      }));
    };
    const schedule = () => {
      if (!raf) raf = scheduleFrame(flush);
    };

    let aborted = false;
    let failed = "";
    let roundToolCalls: { id: string; name: string; arguments: string }[] = [];

    try {
      await deps.chat({
        settings: s,
        transport: deps.transport,
        messages: buildMessages({ ...target, messages }, s, deps.skillPrompt),
        signal: deps.signal,
        tools: deps.tools(),
        onEvent: (evt) => {
          if (evt.type === "delta") {
            acc.content += evt.text;
            schedule();
          } else if (evt.type === "reasoning") {
            acc.reasoning += evt.text;
            schedule();
          } else if (evt.type === "usage") {
            acc.usage = evt.usage;
            schedule();
          } else if (evt.type === "error") {
            failed = evt.message;
            deps.toast(evt.message, "error");
          } else if (evt.type === "tool_calls") {
            roundToolCalls = evt.calls;
          }
        },
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        aborted = true;
        acc.content = acc.content ? acc.content + "\n\n（已停止生成）" : "（已停止生成）";
      } else {
        failed = err.message || String(err);
        deps.toast(failed, "error");
      }
    } finally {
      if (raf) cancelFrame(raf);
    }

    // 真实落盘：回复里出现 file: 块就写进工程目录；计划模式只出方案，直接跳过。
    // 探索模式同样不落盘：工具调用有执行层拦，文本协议这条旁路也要拦，
    // 否则模型绕开工具、用 file: 块一样能写盘。
    const ws = deps.currentWorkspace();
    const blocks = aborted || failed ? [] : parseFileBlocks(acc.content);
    const planMode = Boolean(s.planMode);
    const exploreMode = Boolean(s.exploreMode);
    if (planMode && blocks.length) deps.toast("计划模式：本轮 file: 块未落盘，只保留方案", "");
    if (exploreMode && blocks.length) deps.toast("探索模式：本轮 file: 块未落盘，只保留方案", "");
    const files = ws && blocks.length && !planMode && !exploreMode ? await deps.writeFiles(blocks) : undefined;

    // 工具调用：按顺序执行，结果挂在助手消息上，下一轮 buildMessages
    // 会把它展开成原生 tool_calls + tool 消息发给上游，模型才能对上号。
    // 工具模式下即使没有 file: 块，写文件也是通过 write_file 工具发生的。
    const toolRecords: ToolCallRecord[] = [];
    if (!aborted && !failed && roundToolCalls.length) {
      for (const call of roundToolCalls) {
        toolRecords.push(await deps.executeTool(call));
      }
    }
    // 按权限等级判断"这一轮动过磁盘"，而不是按工具名：
    // 将来新增任何 write 级工具都会自动纳入测试回路，不会漏跑。
    const wroteSomething =
      Boolean(files?.some((f) => f.ok)) || toolRecords.some((r) => findTool(r.name)?.access === "write" && !r.error);

    const finalMsg: Message = {
      ...assist,
      content: acc.content,
      reasoning: acc.reasoning,
      usage: acc.usage,
      streaming: false,
      ...(files ? { files } : {}),
      ...(toolRecords.length ? { toolCalls: toolRecords } : {}),
      ...(deps.usedSkillIds.length ? { skills: deps.usedSkillIds } : {}),
      ...(failed ? { error: failed } : {}),
    };
    deps.patchMessage(index, () => finalMsg);
    baseMessages = [...baseMessages, finalMsg];

    // 这一行不能删：它才是"报错/中止后不跑 npm test"的真正守卫。
    // nextRound 里也有 aborted/failed 分支，但那要等测试回路跑完才轮到——
    // 判定太晚，拦不住已经发生的事。
    if (aborted || failed) break;

    // 测试回路：本轮写了文件、且自动测试开启、且在桌面端，才自动跑测试。
    // 通过就停在本轮；失败把报错当成隐藏消息回传，模型下一轮再改；
    // 3 轮不过就停下，把失败原样报给人，不许模型宣称已修好。
    let testGiveUp = false;
    if (
      ws &&
      shouldAutoTest({
        wroteSomething,
        autoTest: s.autoTest,
        toolCalls: s.toolCalls,
        planMode,
        desktop: deps.desktop(),
        hasWorkspace: Boolean(ws),
      })
    ) {
      try {
        // 脚本审计已下沉到 Rust 执行层（runx）：npm test 真正跑的脚本不是
        // 受信任运行器时直接拒绝，这里不再前端预判，拒绝原因走 catch 报出来。
        const r = await deps.runTest(["npm", "test"]);
        // 用户点了停止：命令是被我们杀掉的，不是测试没过。
        // 这时候既不能回传"未通过"给模型，也不能再走重试——直接收摊。
        if (r.cancelled) {
          deps.toast("已停止自动测试", "");
          break;
        }
        testRounds += 1;
        const combined = [r.stdout, r.stderr ? `--- stderr ---\n${r.stderr}` : ""].filter(Boolean).join("\n");
        const decision = testLoopDecision(r.exit_code, testRounds);
        if (decision === "pass") {
          deps.toast("测试通过", "ok");
        } else if (decision === "retry") {
          const testMsg: Message = {
            role: "user",
            content: `[测试回路] 第 ${testRounds}/${MAX_TEST_ROUNDS} 轮 npm test 未通过，${runResultHead(r)}\n${truncateToolOutput(combined || "(无输出)")}\n请根据上面报错改代码，不要在测试通过前宣称完成。`,
            createdAt: Date.now(),
            hidden: true,
          };
          writeBack([...baseMessages, testMsg]);
        } else {
          // 提示文案由 stopNotice 统一给出，这里不再重复写一份——
          // 两处各写一句，改一处忘一处的那天用户会看到两种结论。
          testGiveUp = true;
        }
      } catch (e) {
        // 跑测试本身失败（比如不在桌面端、命令被拒）不阻断主流程，只报一声
        deps.toast("自动测试未能运行：" + (e as Error).message, "error");
      }
    }

    // 模型要文件 / 技能附件：程序回传真实内容后继续下一轮
    const reads = ws ? parseReadRequests(acc.content) : [];
    const refs = deps.skills.length ? parseSkillRefs(acc.content) : [];
    // 轮末判定统一走 nextRound。顺序（中断/报错 → 测试放弃 → 自然收尾 → 轮数用尽）
    // 由 round.ts 的测试锁住；这里不再自己排 if。停止时的提示也由 stopNotice 给，
    // 包括"测试 3 轮未过"那句——原先两边各写一份，早晚会不一致。
    const step = nextRound({
      aborted,
      // `failed` 在这一层是报错原文（空串表示没失败），判定层只认布尔：
      // 把"空串=没失败"这种约定挡在纯函数外面。
      failed: failed !== "",
      testGiveUp,
      toolCalls: toolRecords.length,
      reads: reads.length,
      skillRefs: refs.length,
      round,
      maxRounds,
    });
    if (step.kind === "stop") {
      const notice = stopNotice(step.reason);
      if (notice) deps.toast(notice, "error");
      break;
    }
    // 工具调用轮次里测试回路已经把报错回传了，读/附件请求仍按原流程回传，
    // 两类隐藏消息都会进下一轮的上下文，不会互相丢。
    // 注意：这里是无条件回传的（含"只有工具调用、没有读请求"的轮次）。
    // buildReadPayload([]) 仍会产出一句"基于以上真实内容继续"的引导，
    // 这是既有行为，本批只做抽取，没有改它。

    const outcomes = ws ? await deps.readFiles(reads) : [];
    const refOutcomes = await deps.readRefs(refs);
    const toolMsg: Message = {
      role: "user",
      content: buildReadPayload([...outcomes, ...refOutcomes]),
      createdAt: Date.now(),
      hidden: true,
    };
    writeBack([...baseMessages, toolMsg]);
  }
}
