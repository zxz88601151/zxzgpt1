/** 子代理编排：复用 runRounds，独立 context + 只读工具 + 子代理模型。
 *
 * explore 工具触发子代理：子代理用独立 messages + 只读工具跑 N 轮，探索过程
 * （读的文件内容）不进主对话，只把最后一条 assistant 的 content 作为摘要返回。
 *
 * 与主对话的差别全部体现在喂给 runRounds 的 RunDeps 上：
 *   - settings.model 换成 subagentModel（复用 baseUrl/apiKey，同 provider）
 *   - tools 换成只读探索工具（read/list/search/glob/web_search）
 *   - baseMessages 只有一条探索目标，commitMessages 写子代理自己的临时数组
 *   - writeFiles / runTest 是空实现（探索不写盘、不跑测试）
 */

import type { ChatOptions } from "../api";
import type { ReadOutcome } from "../lib/files";
import type { RunResult } from "../lib/fsapi";
import { subagentToolDefs } from "../lib/registry";
import type {
  Conversation,
  FileWriteResult,
  Message,
  Settings,
  ToolCallRecord,
  Transport,
  Workspace,
} from "../types";
import { runRounds, type Notice, type RunDeps } from "./session";

const SUBAGENT_MAX_ROUNDS = 4;
const SUBAGENT_SUMMARY_CHARS = 2000;

/** 子代理需要的外部能力，App 注入。与 RunDeps 大部分一致，去掉写盘/测试/技能。 */
export interface SubagentDeps {
  settings: Settings;
  transport: Transport;
  chat: (opts: ChatOptions) => Promise<void>;
  signal: AbortSignal;
  desktop: () => boolean;
  currentWorkspace: () => Workspace | null;
  executeTool: (call: { id: string; name: string; arguments: string }) => Promise<ToolCallRecord>;
  readFiles: (paths: string[]) => Promise<ReadOutcome[]>;
  toast: Notice;
}

/** 跑一次只读探索子代理，返回摘要文本。 */
export async function runSubagent(query: string, deps: SubagentDeps): Promise<string> {
  const s = deps.settings;
  const subModel = s.subagentModel?.trim();
  if (!subModel) {
    return "（未配置子代理模型，无法探索。请在设置里填写子代理模型，例如 glm-4.5-flash。）";
  }

  // 子代理 settings：换 model，关计划/探索/测试回路，工具调用强制开
  const subSettings: Settings = {
    ...s,
    model: subModel,
    planMode: false,
    exploreMode: false,
    autoTest: false,
    toolCalls: true,
  };

  let messages: Message[] = [
    {
      role: "user",
      content: `${query}\n\n探索完后，务必用一段话总结你的发现（目录结构、主要模块、关键结论），并带上文件路径依据。`,
      createdAt: Date.now(),
    },
  ];

  const subConv: Conversation = {
    id: "subagent",
    title: "探索",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const runDeps: RunDeps = {
    settings: subSettings,
    conversation: subConv,
    skillPrompt: "",
    usedSkillIds: [],
    skills: [],
    baseMessages: messages,
    maxRounds: SUBAGENT_MAX_ROUNDS,
    transport: deps.transport,
    // 每轮请求前再看一次主链路 signal。这样即便上游流式实现完全不理会 signal，
    // 用户点「停止」之后子代理也不会再发起模型请求（D-17 的第二道保险）。
    chat: async (opts) => {
      if (deps.signal.aborted) throw new DOMException("已停止生成", "AbortError");
      return deps.chat({ ...opts, signal: deps.signal });
    },
    tools: () => subagentToolDefs(),
    signal: deps.signal,
    desktop: deps.desktop,
    currentWorkspace: deps.currentWorkspace,
    commitMessages: (msgs) => {
      messages = msgs;
    },
    patchMessage: (i, fn) => {
      messages = messages.map((m, idx) => (idx === i ? fn(m) : m));
    },
    toast: deps.toast,
    executeTool: deps.executeTool,
    writeFiles: async (): Promise<FileWriteResult[]> => [],
    readFiles: deps.readFiles,
    readRefs: async () => [],
    runTest: async (): Promise<RunResult> => {
      throw new Error("子代理不跑测试");
    },
  };

  await runRounds(runDeps);

  // 用户点了停止：不要把「跑到一半的探索」当成正经摘要交回主对话，
  // 否则主模型会基于一份残缺的上下文继续作答。
  if (deps.signal.aborted) return "（子代理已停止）";

  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.content && !m.error);
  const summary = last?.content?.trim() || "（子代理没有产出）";
  return summary.length > SUBAGENT_SUMMARY_CHARS ? summary.slice(0, SUBAGENT_SUMMARY_CHARS) + "…" : summary;
}
