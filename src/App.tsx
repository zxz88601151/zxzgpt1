import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { chatStream, detectTransport, DIRECT } from "./api";
import {
  buildTree,
  ExecGrantRequired,
  fsAvailable,
  fsListIn,
  fsRead,
  fsWrite,
  permGrant,
  runAllowed,
  runCancel,
  openPreview,
  webSearch as webSearchApi,
  wsClose,
  wsInfo,
  wsOpen as openSession,
} from "./lib/fsapi";
import { filterConversations, findActive, loadState, newConversation, persist, titleFrom } from "./state";
import { clamp, copyText, uid } from "./lib/text";
import { stampNow } from "./lib/undo";
import { builtinSkills } from "./skills";
import { SOURCES, buildAuditMarkdown } from "./skills/sources";
import { buildAuditReportMarkdown } from "./skills/audit";
import { buildScanMarkdown, scanSkill } from "./lib/skillscan";
import {
  buildSkillPrompt,
  matchSkills,
  MAX_ACTIVE_SKILLS,
  skillCatalogPrompt,
  type Skill,
} from "./lib/skill";
import type { PendingWrite } from "./lib/pending";
import {
  appendAssistantMessage,
  appActionLabel,
  nextInputAfterCommand,
  planAppCommand,
  withToggleApplied,
} from "./lib/appcontrol";
import { loadLocalSkills, mergeSkills, pickSkills } from "./lib/skillstore";
import { UNDO_DIR, type FileBlock } from "./lib/files";
import { EXPLORE_TOOL_NAMES, exploreToolDefs, findTool, isExploreTool, parseToolArgs, planModeBlocks, TOOL_DEFS, type ToolContext } from "./lib/registry";
import { mcpScope, resolveToolPolicy } from "./lib/toolpolicy";
import { executeMcpToolCall, mcpCallTool, mcpToolDefs } from "./lib/mcp";
import { runRounds } from "./orchestration/session";
import { forceCompact } from "./orchestration/compact";
import { runSubagent } from "./orchestration/subagent";
import {
  applyFileBlocks,
  buildPendingItems,
  loadProjectMemory,
  patchMessageAt,
  readForModel,
  readSkillRefs,
} from "./lib/workspace";
import { buildSummarizeMessages } from "./orchestration/summarize";
import { useMcpServers } from "./hooks/useMcpServers";
import { useExecApproval } from "./hooks/useExecApproval";
import type { AppState, Conversation, FileWriteResult, Message, Settings, Theme, ToolCallRecord, Transport } from "./types";
import type { ToastKind } from "./components/ui";

import { ConfirmExec } from "./components/ConfirmExec";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Composer } from "./components/Composer";
import { DictationButton } from "./components/DictationButton";
import { appendTranscript } from "./lib/dictation";
import { MessageList } from "./components/MessageList";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { Welcome } from "./components/Welcome";
import { FolderPicker } from "./components/FolderPicker";
import { UndoPanel } from "./components/UndoPanel";
import { PendingWrites } from "./components/PendingWrites";
import { SkillPanel } from "./components/SkillPanel";
import { SkillChips } from "./components/SkillChips";
import { ToastContext, Toasts, type ToastItem } from "./components/ui";

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const stateRef = useRef(state);

  /** 所有写状态都走 commit：ref 与 state 同步更新，异步流程读不到过期快照 */
  const commit = useCallback((next: AppState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const update = useCallback(
    (fn: (prev: AppState) => AppState) => {
      commit(fn(stateRef.current));
    },
    [commit]
  );

  const [transport, setTransport] = useState<Transport>(DIRECT);
  const [ready, setReady] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 当前生效的执行授权（Rust 侧记账，这里只是镜像给界面看） */
  const [wsOpen, setWsOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillDirPick, setSkillDirPick] = useState(false);
  const [skills, setSkills] = useState<Skill[]>(() => builtinSkills());
  const [skillErrors, setSkillErrors] = useState<{ id: string; error: string }[]>([]);
  const [skillLoading, setSkillLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /** 写入前确认：非 null 时发送流程挂起，等人在面板里批复这一批 */
  const [pending, setPending] = useState<PendingWrite[] | null>(null);
  const pendingResolveRef = useRef<((approved: PendingWrite[] | null) => void) | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  /** 本轮发送的取消信号。子代理必须复用它，不能自己 new 一个（D-17）。
   *  与 abortRef 分开存：finally 会把 abortRef 置空，但已中止的 signal 要留给
   *  还在收尾的子代理，否则它会拿到一个「全新且未中止」的信号继续跑模型请求。 */
  const mainSignalRef = useRef<AbortSignal | null>(null);
  const busyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const skillsRef = useRef<Skill[]>(skills);

  const settings = state.settings;
  const activeConv = findActive(state);

  /* ------------------------------------------------------------ Toast */

  const toast = useCallback((text: string, kind: ToastKind = "") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2600);
  }, []);

  /* MCP 生命周期与执行授权桥已抽成 hooks（ADR 0001 第 5 步）：
     组件只消费返回值，不再持有这些 ref 与 Promise 桥的实现细节。 */
  const {
    grants,
    execAsk,
    askExec,
    answerExec,
    refreshGrants,
    revokeGrant,
    dropExecGrants,
  } = useExecApproval({ stateRef, toast, drawerOpen });
  const mcpSpecsRef = useMcpServers(state.settings.workspace, toast);

  /* ------------------------------------------------------------ 持久化 */

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        persist(state);
      } catch (e) {
        toast("本地存储写入失败：" + (e as Error).message, "error");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [state, toast]);

  /* ------------------------------------------------------------ 主题 / 侧边栏 */

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme === "light" ? "light" : "dark";
  }, [settings.theme]);

  useEffect(() => {
    document.body.classList.toggle("collapsed", collapsed);
  }, [collapsed]);

  /* ------------------------------------------------------------ 启动：探测通道 */

  useEffect(() => {
    let alive = true;
    detectTransport().then((t) => {
      if (!alive) return;
      setTransport(t);
      setReady(true);
      if (!stateRef.current.settings.apiKey && t.mode === "direct") {
        toast("尚未配置 API Key，先在设置里接入模型", "error");
      }
    });
    return () => {
      alive = false;
    };
  }, [toast]);

  /* ------------------------------------------------------------ 会话操作 */




  const createConv = useCallback(() => {
    void dropExecGrants();
    const conv = newConversation();
    update((s) => ({ ...s, conversations: [...s.conversations, conv], activeId: conv.id }));
    setInput("");
    setScrollSignal((n) => n + 1);
    setFocusSignal((n) => n + 1);
    if (window.innerWidth <= 860) setCollapsed(true);
    return conv;
  }, [dropExecGrants, update]);

  const selectConv = useCallback(
    (id: string) => {
      // 切对话就把上一个对话批过的执行许可收回，理由见 dropExecGrants
      if (id !== stateRef.current.activeId) void dropExecGrants();
      update((s) => ({ ...s, activeId: id }));
      setScrollSignal((n) => n + 1);
      if (window.innerWidth <= 860) setCollapsed(true);
    },
    [dropExecGrants, update]
  );

  const renameConv = useCallback(
    (id: string) => {
      const conv = stateRef.current.conversations.find((c) => c.id === id);
      if (!conv) return;
      const next = window.prompt("重命名对话", conv.title || "");
      if (next === null) return;
      update((s) => ({
        ...s,
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: next.trim() || c.title } : c)),
      }));
    },
    [update]
  );

  const deleteConv = useCallback(
    (id: string) => {
      if (!window.confirm("删除这个对话？删除后无法恢复。")) return;
      // 删的如果是当前对话，activeId 会换人——那条授权属于被删掉的对话，必须跟着作废。
      // 删后台对话则不影响当前授权（Rust 侧按会话记账，只有一个桶）。
      const switching = stateRef.current.activeId === id;
      if (switching) void dropExecGrants();
      update((s) => {
        const conversations = s.conversations.filter((c) => c.id !== id);
        const activeId = s.activeId === id ? conversations[0]?.id || null : s.activeId;
        return { ...s, conversations, activeId };
      });
    },
    [dropExecGrants, update]
  );

  const clearConv = useCallback(() => {
    const conv = findActive(stateRef.current);
    if (!conv || !conv.messages.length) return;
    if (!window.confirm("清空当前对话的所有消息？")) return;
    // 消息清空后，当初"因为这个对话在做什么"而批的授权就失去了依据，一并收回
    void dropExecGrants();
    update((s) => ({
      ...s,
      conversations: s.conversations.map((c) => (c.id === conv.id ? { ...c, messages: [] } : c)),
    }));
  }, [dropExecGrants, update]);

  /* ------------------------------------------------------------ 本地工程：真实写盘 */

  // 轮数上限与轮末判定都在 src/orchestration/round.ts，App 只负责执行

  const patchMessage = useCallback(
    (convId: string, index: number, fn: (m: Message) => Message) => {
      update((prev) => ({
        ...prev,
        conversations: patchMessageAt(prev.conversations, convId, index, fn, Date.now()),
      }));
    },
    [update]
  );

  /** 重扫目录树：写盘、回滚之后都要跑一次，下一轮模型才看得到当前状态 */
  const refreshTree = useCallback(async () => {
    const ws = stateRef.current.settings.workspace;
    if (!ws) return;
    try {
      const tree = await buildTree(ws.sessionId);
      update((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          workspace: prev.settings.workspace ? { ...prev.settings.workspace, tree } : null,
        },
      }));
    } catch {
      /* 目录树刷新失败不影响主流程 */
    }
  }, [update]);

  /** 把回复里的 file: 块真的写进磁盘：备份、写入、回读校验在 lib/workspace.ts，
   *  这里只保留 toast 与目录树刷新这两项 UI 副作用。 */
  const applyFiles = useCallback(
    async (blocks: FileBlock[]): Promise<FileWriteResult[]> => {
      const ws = stateRef.current.settings.workspace;
      if (!ws || !blocks.length) return [];
      const r = await applyFileBlocks(blocks, ws.sessionId);
      const backupNote = r.backedUp ? `，${r.backedUp} 个覆盖前已备份到 ${UNDO_DIR}` : "";
      toast(
        `已写入 ${r.ok} 个文件${backupNote}${r.fail ? `，${r.fail} 个失败` : ""}${r.unverified ? `，${r.unverified} 个回读不一致` : ""}`,
        r.fail || r.unverified ? "error" : "ok"
      );
      await refreshTree();
      return r.results;
    },
    [refreshTree, toast]
  );

  /**
   * 写入的统一入口：默认走原来的自动落盘；开了“写入前确认”就先把这一批
   * 挂到面板上，人批了才调 applyFiles。计划模式不走这里，发送循环里直接跳过。
   */
  const requestApplyFiles = useCallback(
    async (blocks: FileBlock[]): Promise<FileWriteResult[]> => {
      const ws = stateRef.current.settings.workspace;
      if (!ws || !blocks.length) return [];
      if (!stateRef.current.settings.confirmWrites) return applyFiles(blocks);
      const items = await buildPendingItems(blocks, ws.sessionId);
      const approved = await new Promise<PendingWrite[] | null>((resolve) => {
        pendingResolveRef.current = resolve;
        setPending(items);
      });
      if (!approved || !approved.length) {
        toast("已放弃本轮写入，磁盘没有改动", "");
        return [];
      }
      return applyFiles(approved.map((a) => ({ path: a.path, content: a.content })));
    },
    [applyFiles, toast]
  );


  /**
   * 工具执行上下文：把「当前会话」和几个副作用通道包成一个对象交给注册表。
   *
   * 用 stateRef 取会话而不是闭包捕获 workspace，所以 ctx 不随工作区切换重建；
   * 真正让不同工具表现得不同的是 registry 里的 spec，不是这里的分支。
   *
   * ctx 与 executeTool 互相引用（ctx.runSubagent 要派子代理、子代理又要 executeTool），
   * 用 ref 打破循环：executeTool 读 ctxRef，runSubagent 读 executeToolRef，赋值在两者
   * 都定义之后。
   */
  const ctxRef = useRef<ToolContext | null>(null);
  const executeToolRef = useRef<((call: { id: string; name: string; arguments: string }) => Promise<ToolCallRecord>) | null>(null);

  const ctx = useMemo<ToolContext>(
    () => ({
      readFile: async (rel) => {
        const ws = stateRef.current.settings.workspace;
        if (!ws) throw new Error("未接入工程目录");
        return fsRead(ws.sessionId, rel);
      },
      listDir: async (rel) => {
        const ws = stateRef.current.settings.workspace;
        if (!ws) throw new Error("未接入工程目录");
        return fsListIn(ws.sessionId, rel);
      },
      writeFile: (rel, content) => requestApplyFiles([{ path: rel, content }]),
      runCommand: async (argv) => {
        const ws = stateRef.current.settings.workspace;
        if (!ws) throw new Error("未接入工程目录");
        // exec 默认 ask：Rust 侧没有授权就抛 ExecGrantRequired，界面问过用户再重试。
        // 循环最多三轮，避免授权逻辑出 bug 时变成死循环。
        for (let attempt = 0; ; attempt++) {
          try {
            return await runAllowed(ws.sessionId, argv);
          } catch (e) {
            if (!(e instanceof ExecGrantRequired)) throw e;
            if (attempt >= 2) throw new Error("多次授权后仍然无法执行，已停止重试");
            const choice = await askExec(e.label);
            if (choice === "deny") throw new Error("用户拒绝了这次命令执行");
            // 授权失败会让下一轮再抛一次 ExecGrantRequired，由上面的 attempt 上限兜住
            await permGrant(ws.sessionId, e.scope, choice === "once" ? 1 : null, e.label);
            void refreshGrants();
          }
        }
      },
      webSearch: (query) => webSearchApi(query),
      runSubagent: (query) =>
        runSubagent(query, {
          settings: stateRef.current.settings,
          transport,
          chat: chatStream,
          // 复用主链路 signal：点「停止」时子代理的流式请求与后续轮次一起中止。
          // 以前这里 new 了一个独立控制器，界面说已停止、子代理还能跑满 4 轮（D-17）。
          signal: mainSignalRef.current ?? new AbortController().signal,
          desktop: fsAvailable,
          currentWorkspace: () => stateRef.current.settings.workspace,
          executeTool: (call) => {
            const fn = executeToolRef.current;
            if (!fn)
              return Promise.resolve({ id: call.id, name: call.name, arguments: call.arguments, error: "子代理执行器未就绪" });
            // 子代理是只读探索：MCP 插件工具不在它的工具定义里（subagentToolDefs），
            // 万一模型凭空拼出一个 mcp_ 名字，这里也要拦——context-mode 的
            // ctx_execute 会跑任意代码，不能让它绕过探索模式的只读三道门。
            if (call.name.startsWith("mcp_"))
              return Promise.resolve({ id: call.id, name: call.name, arguments: call.arguments, error: "子代理不能调 MCP 插件工具" });
            return fn(call);
          },
          readFiles: async (paths) => {
            const w = stateRef.current.settings.workspace;
            return w ? readForModel(w.sessionId, paths) : [];
          },
          toast,
        }),
    }),
    [requestApplyFiles, askExec, transport, readForModel, toast]
  );
  ctxRef.current = ctx;

  /**
   * 执行一次模型发起的工具调用。本函数仍是"单次调用"的执行体；并发调度由
   * runRounds 里的 runToolBatch 统一做：同批只读工具并发、写/执行工具串行，
   * 这样既提速又避免确认面板/exec 授权弹窗叠加。
   *
   * 这里只做四件事：查注册表 → 按权限等级拦 → 校验参数 → 交给工具自己执行。
   * 具体怎么读、怎么写、怎么跑都在 `lib/registry.ts` 的 spec 里，所以新增工具
   * 不需要碰这个函数，也不会出现「某个工具忘了写权限判断」这种漏。
   */
  const executeTool = useCallback(
    async (call: { id: string; name: string; arguments: string }): Promise<ToolCallRecord> => {
      const base: ToolCallRecord = { id: call.id, name: call.name, arguments: call.arguments };
      // 精确匹配，不做归一化：`Run_Command`、`run_command ` 这类变形一律落到「未知工具」，
      // 不允许它绕过下面按 spec.access 做的拦截。
      const ws = stateRef.current.settings.workspace;
      if (!ws) return { ...base, error: "未接入工程目录，工具不可用" };
      const parsedArgs = parseToolArgs(call.arguments);
      if (!parsedArgs.ok) return { ...base, error: parsedArgs.error };
      const args = parsedArgs.args;
      const spec = findTool(call.name);
      if (!spec) {
        // 统一策略视图（ADR 0004）：内置 / MCP 动态 / 未知三类走同一个入口解析，
        // 动态工具不再有「不在注册表里就绕过权限模型」的第二条旁路。
        // 精确匹配，不做归一化；查不到就是未知工具。
        const policy = resolveToolPolicy(call.name, mcpSpecsRef.current);
        if (policy.source !== "mcp" || !policy.server || !policy.tool) {
          return { ...base, error: `未知工具：${call.name}` };
        }
        const out = await executeMcpToolCall({
          name: call.name,
          args,
          specs: mcpSpecsRef.current,
          planMode: Boolean(stateRef.current.settings.planMode),
          exploreMode: Boolean(stateRef.current.settings.exploreMode),
          scope: mcpScope(policy.server, policy.tool),
          // 停止信号贯穿到审批等待：abort 时 waitAbortable 以 deny 结算，不挂死串行层
          signal: mainSignalRef.current ?? undefined,
          // 默认 Ask：Rust 侧 guard_mcp 未授权 → need_grant → 问用户 →
          // permGrant 记账 → 重试；会话级授权批过之后首次调用直接放行。
          call: (server, tool, a) => mcpCallTool(server, tool, a, ws.sessionId),
          ask: (req) => askExec(req.label),
          grant: async (scope, uses, grantLabel) => {
            await permGrant(ws.sessionId, scope, uses, grantLabel);
            void refreshGrants();
          },
        });
        return { ...base, ...(out.error ? { error: out.error } : { result: out.result ?? "" }) };
      }
      // 探索模式第二道门（第一道在 tools()：发给模型的定义里已经没有写/跑工具）：
      // 模型就算硬调写与跑命令，执行层也到不了磁盘和子进程。名单制，不按权限推导，
      // 将来新增的工具默认不认。
      if (Boolean(stateRef.current.settings.exploreMode) && !isExploreTool(call.name)) {
        return { ...base, error: `探索模式已拦截：只读的探索助手只能调 ${EXPLORE_TOOL_NAMES.join("、")}` };
      }
      if (Boolean(stateRef.current.settings.planMode) && planModeBlocks(spec.access)) {
        return { ...base, error: "计划模式已拦截：本轮只出方案，不写文件、不跑命令" };
      }
      const bad = spec.validate(args);
      if (bad) return { ...base, error: bad };
      if (spec.access === "exec" && !fsAvailable()) {
        return { ...base, error: "跑命令只在桌面端可用，浏览器直开时不可用" };
      }
      try {
        const out = await spec.run(args, ctxRef.current!);
        return { ...base, ...(out.error ? { error: out.error } : { result: out.result ?? "" }) };
      } catch (e) {
        return { ...base, error: (e as Error).message };
      }
    },
    [ctxRef, askExec, refreshGrants]
  );
  executeToolRef.current = executeTool;

  /* ------------------------------------------------------------ 发送 */

  /** 上下文压缩用的模型摘要：拼 prompt 的纯逻辑在 orchestration/summarize.ts。 */
  const summarizeWindow = useCallback(async (window: Message[]): Promise<string> => {
    const settings = stateRef.current.settings;
    // 复用主链路 signal（复审 P2-3）：点停止后压缩用的模型请求也要能被中断；
    // 手动压缩（不在 send 生命周期内）时用一次性控制器，语义不变。
    const signal = mainSignalRef.current ?? new AbortController().signal;
    let acc = "";
    try {
      await chatStream({
        settings: { ...settings, stream: false, maxTokens: 600 },
        transport,
        messages: buildSummarizeMessages(window),
        signal,
        onEvent: (evt) => {
          if (evt.type === "delta") acc += evt.text;
        },
      });
    } catch {
      acc = "";
    }
    return acc.trim();
  }, [transport]);

  /** 手动压缩：用户点「压缩上下文」时触发，无论是否超预算都压一步。 */
  const runCompactNow = useCallback(async () => {
    const conv0 = findActive(stateRef.current);
    if (!conv0) return;
    if (conv0.messages.length < 4) {
      toast("对话太短，暂无需压缩", "");
      return;
    }
    const patch = await forceCompact(conv0, conv0.messages, {
      summarize: summarizeWindow,
      budget: 0,
      keepRounds: Number(stateRef.current.settings.compactKeepRounds) || 3,
    });
    if (patch) {
      update((prev) => ({
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === conv0.id ? { ...c, compactSummary: patch.summary, compactAfterIndex: patch.afterIndex, updatedAt: Date.now() } : c,
        ),
      }));
      toast(`已压缩 ${patch.summarizedCount} 条历史，保留最近上下文`, "ok");
    } else {
      toast("没有可压缩的历史（已较短或仅剩最近轮次）", "");
    }
  }, [summarizeWindow, toast]);

  const send = useCallback(
    async (opts?: { reuseUser?: boolean }) => {
      const reuse = Boolean(opts?.reuseUser);
      const text = input.trim();
      // 重新生成时输入框里是上一次的原文，允许为空判断跳过
      if (!reuse && !text) return;

      // 应用内命令 C1：只有首词命中已知命令名（/plan /tools /new /help 及中文别名）才当命令，
      // 其余以 / 开头的正常句子照常发给模型（D16）。
      // 先于 busy/模型配置检查：busy 期间命令不执行且输入原样保留；改开关不需要已配好模型。
      const plan = planAppCommand(text, { busy: busyRef.current, active: !reuse && text.startsWith("/") });
      if (plan.kind === "reject_busy") return;
      if (busyRef.current) return; // 普通消息的原有 busy 门
      if (plan.kind !== "passthrough") {
        // F1：只有真正执行的命令才清空输入；解析失败保留原文，用户可原地改
        setInput(nextInputAfterCommand(input, plan));
        if (plan.kind === "error") {
          toast(plan.message, "error");
          return;
        }
        if (plan.kind === "help") {
          let conv = findActive(stateRef.current);
          if (!conv) conv = createConv();
          const helpConvId = conv.id;
          update((prev) => ({
            ...prev,
            conversations: appendAssistantMessage(prev.conversations, helpConvId, plan.message, Date.now()).conversations,
          }));
          return;
        }
        if (plan.kind === "new_session") {
          createConv();
          toast(appActionLabel({ kind: "new_session" }), "");
          return;
        }
        if (plan.kind === "preview") {
          openPreview(plan.target)
            .then(() => toast("已打开预览", ""))
            .catch((e) => toast(`预览失败：${e instanceof Error ? e.message : String(e)}`, "error"));
          return;
        }
        // toggle：与设置抽屉写同一份 settings，经 update() 走同一持久化通道
        update((prev) => ({ ...prev, settings: withToggleApplied(prev.settings, plan) }));
        toast(plan.label, "");
        return;
      }

      const s = stateRef.current.settings;
      if (!s.model) {
        toast("请先在设置里填写 Base URL 和模型名", "error");
        setDrawerOpen(true);
        return;
      }

      // 没有会话就先建一个（与旧版 ensureConv 一致）
      let conv = findActive(stateRef.current);
      if (!conv) conv = createConv();
      const convId = conv.id;

      const target = findActive(stateRef.current);
      if (!target) return;

      const current = reuse ? target.messages[target.messages.length - 1] : null;
      if (reuse && (!current || current.role !== "user")) return;

      // 技能：已启用的固定带上，再按这句话的触发词自动补几个。
      // 重新生成时输入框可能是空的，所以回退到最后一条用户消息来判断触发词。
      const allSkills = skillsRef.current;
      const lastUser = [...target.messages].reverse().find((m) => m.role === "user" && !m.hidden && m.content);
      const probe = text || lastUser?.content || "";
      const enabledIds = s.skills || [];
      const enabled = pickSkills(allSkills, enabledIds);
      const auto = s.skillAuto ? matchSkills(allSkills, probe, enabledIds) : [];
      const used = [...enabled, ...auto].slice(0, MAX_ACTIVE_SKILLS);
      const usedIds = used.map((x) => x.id);
      // 没启用技能时一个 token 都不花：目录清单只在用到技能时才带上，
      // 这时它的作用是让模型知道还能 @@ref 取哪个技能的附件。
      const skillPrompt = used.length
        ? [skillCatalogPrompt(allSkills), buildSkillPrompt(used)].filter(Boolean).join("\n\n")
        : "";
      if (auto.length) toast(`已按关键词加载技能：${auto.map((a) => a.name).join("、")}`, "");

      const userMsg: Message = reuse
        ? (current as Message)
        : { role: "user", content: text, createdAt: Date.now() };
      let baseMessages: Message[] = reuse ? target.messages.slice() : [...target.messages, userMsg];

      update((prev) => ({
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === convId
            ? {
                ...c,
                title: c.title === "新对话" || !c.title ? titleFrom(text) : c.title,
                messages: baseMessages,
                updatedAt: Date.now(),
              }
            : c
        ),
      }));

      setInput("");
      setScrollSignal((n) => n + 1);
      busyRef.current = true;
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      mainSignalRef.current = controller.signal;

      try {
        // 轮循环已搬到 src/orchestration/session.ts（ADR 0001 第 2 步，只搬运不改语义）。
        // 这里只装配依赖：状态写入、工具执行、落盘、读文件、跑命令各自还连着 UI 与 IPC，
        // 搬不走，只能注入。装配错一个，B12-B1/B12-B2 的整轮用例会当场变红。
        await runRounds({
          settings: s,
          conversation: target,
          skillPrompt,
          usedSkillIds: usedIds,
          skills: allSkills,
          baseMessages,
          transport,
          chat: chatStream,
          // 每轮重新判断：工具模式要求设置没关、且工程还在
          // 探索模式第一道门：发给模型的工具定义只剩只读三件套
          tools: () =>
            s.toolCalls !== false && stateRef.current.settings.workspace
              ? stateRef.current.settings.exploreMode
                ? exploreToolDefs()
                : // 探索模式第一道门只剩三件套，MCP 工具不进探索模式；
                  // 正常模式下把已加载的 MCP 动态工具拼在内置工具后面。
                  [...TOOL_DEFS, ...mcpToolDefs(mcpSpecsRef.current)]
              : undefined,
          signal: controller.signal,
          desktop: fsAvailable,
          currentWorkspace: () => stateRef.current.settings.workspace,
          commitMessages: (messages) =>
            update((prev) => ({
              ...prev,
              conversations: prev.conversations.map((c) =>
                c.id === convId ? { ...c, messages, updatedAt: Date.now() } : c
              ),
            })),
          patchMessage: (index, fn) => patchMessage(convId, index, fn),
          toast,
          executeTool,
          writeFiles: requestApplyFiles,
          readFiles: async (paths) => {
            const w = stateRef.current.settings.workspace;
            return w ? readForModel(w.sessionId, paths) : [];
          },
          readRefs: (refs) => readSkillRefs(allSkills, refs),
          runTest: (argv) => {
            const w = stateRef.current.settings.workspace;
            if (!w) throw new Error('未接入工程目录');
            return runAllowed(w.sessionId, argv);
          },
          // 上下文压缩引擎：用模型把最旧历史压成摘要（离线/限流时退化成结构化兜底）
          summarize: summarizeWindow,
          patchConversation: (patch) =>
            update((prev) => ({
              ...prev,
              conversations: prev.conversations.map((c) => (c.id === convId ? { ...c, ...patch, updatedAt: Date.now() } : c)),
            })),
        });
      } finally {
        abortRef.current = null;
        mainSignalRef.current = null;
        busyRef.current = false;
        setBusy(false);
        setScrollSignal((n) => n + 1);
      }
    },
    [createConv, executeTool, input, patchMessage, readForModel, readSkillRefs, requestApplyFiles, toast, transport, update]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // 正在等执行/MCP 授权时点停止：把挂起的确认框按「拒绝」结算，
    // 否则 ask() 的 Promise 永不 resolve，发送流程会挂在串行工具层（复审 P1-1）。
    answerExec("deny");
    // 正在等写入批复时点停止：直接按“放弃”处理，否则发送流程会一直挂在面板上
    if (pendingResolveRef.current) {
      setPending(null);
      pendingResolveRef.current(null);
      pendingResolveRef.current = null;
    }
    // 光 abort 掉 fetch 管不到已经起的子进程（npm test 在 Rust 里跑）。
    // 点停止就该真的停：通知 Rust 终止，没在跑的时候它什么也不做。
    const ws = stateRef.current.settings.workspace;
    if (ws) void runCancel(ws.sessionId);
  }, [answerExec]);

  const regenerate = useCallback(async () => {
    if (busyRef.current) return;
    const conv = findActive(stateRef.current);
    if (!conv) return;

    // 只看用户看得到的消息：程序注入的读文件回传不算一轮
    const visible = conv.messages.filter((m) => !m.hidden);
    if (visible.length < 2) return;
    const last = visible[visible.length - 1];
    const prevUser = visible[visible.length - 2];
    if (last.role !== "assistant" || prevUser.role !== "user") return;

    // 末尾可能是若干条隐藏的工具消息，一并丢掉
    const cut = conv.messages.lastIndexOf(last);
    update((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === conv.id ? { ...c, messages: c.messages.slice(0, cut) } : c
      ),
    }));
    setInput(prevUser.content);
    setScrollSignal((n) => n + 1);
    // 复用最后一条用户消息重新发一次，不再重复追加
    await send({ reuseUser: true });
  }, [send, update]);

  /* ------------------------------------------------------------ 本地工程 */

  // 工程目录可能被删掉或移动，Rust 进程重启后旧会话也一定失效：
  // 启动时按本地存的展示路径重新登记一次会话，登记不上就退出该模式，
  // 否则后续每次读写都会报「会话已关闭」，用户不知道从哪改。
  const ensureWorkspaceSession = useCallback(async () => {
    const ws = stateRef.current.settings.workspace;
    if (!ws || !fsAvailable()) return;
    try {
      await wsInfo(ws.sessionId);
      return; // 会话还活着，直接用
    } catch {
      /* 进程重启或会话已失效：走下面重新登记 */
    }
    try {
      // root 只在这一次出现：之后所有操作都只认会话号
      const s = await openSession(ws.root);
      commit({
        ...stateRef.current,
        settings: {
          ...stateRef.current.settings,
          workspace: { ...ws, sessionId: s.id, root: s.root, name: s.name || ws.name },
        },
      });
    } catch {
      commit({ ...stateRef.current, settings: { ...stateRef.current.settings, workspace: null } });
      toast("工程目录已不存在，已退出本地工程模式", "error");
    }
  }, [commit, toast]);

  useEffect(() => {
    if (!ready) return;
    void ensureWorkspaceSession();
  }, [ready, ensureWorkspaceSession]);


  const openWorkspace = useCallback(() => {
    if (!fsAvailable()) {
      toast("本地写代码需要桌面端运行，浏览器直开无法访问磁盘", "error");
      return;
    }
    setWsOpen(true);
  }, [toast]);

  const pickWorkspace = useCallback(
    async (root: string, name: string) => {
      // 先登记会话：root 只在这一步出现，之后 buildTree / 读写都只认 sessionId
      let session: { id: string; root: string; name: string };
      try {
        session = await openSession(root);
      } catch (e) {
        toast(`接入工程失败：${(e as Error).message}`, "error");
        return;
      }
      let tree = "";
      try {
        tree = await buildTree(session.id);
      } catch {
        /* 目录树拿不到不影响接入，模型仍能靠 @@read 取内容 */
      }
      const memory = await loadProjectMemory(session.id);
      const prev = stateRef.current.settings.workspace;
      if (prev?.sessionId && prev.sessionId !== session.id) await wsClose(prev.sessionId);
      commit({
        ...stateRef.current,
        settings: {
          ...stateRef.current.settings,
          workspace: {
            sessionId: session.id,
            root: session.root,
            name: session.name || name,
            tree,
            memory: memory?.body ?? null,
            memorySource: memory?.source ?? null,
          },
        },
      });
      setWsOpen(false);
      toast(`已接入工程：${session.name || name}${memory ? `（已加载项目记忆 ${memory.source}）` : ""}`, "ok");
    },
    [commit, loadProjectMemory, toast]
  );

  const clearWorkspace = useCallback(() => {
    const prev = stateRef.current.settings.workspace;
    if (prev?.sessionId) void wsClose(prev.sessionId);
    commit({ ...stateRef.current, settings: { ...stateRef.current.settings, workspace: null } });
    setWsOpen(false);
    toast("已退出本地工程模式", "");
  }, [commit, toast]);

  /* ------------------------------------------------------------ 技能库 */

  /** 内建技能是随包带的，外部技能目录每次启动 / 换目录都要重扫 */
  const reloadSkills = useCallback(async () => {
    const base = builtinSkills();
    const dir = stateRef.current.settings.skillsDir;
    if (!dir || !fsAvailable()) {
      skillsRef.current = base;
      setSkills(base);
      setSkillErrors([]);
      return;
    }
    setSkillLoading(true);
    try {
      const out = await loadLocalSkills(dir);
      const merged = mergeSkills(base, out.skills);
      skillsRef.current = merged;
      setSkills(merged);
      setSkillErrors(out.errors);
    } catch (e) {
      skillsRef.current = base;
      setSkills(base);
      setSkillErrors([{ id: dir, error: (e as Error).message }]);
    } finally {
      setSkillLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void reloadSkills();
  }, [ready, settings.skillsDir, reloadSkills]);

  const toggleSkill = useCallback(
    (id: string) => {
      update((s) => {
        const list = s.settings.skills || [];
        if (list.includes(id)) {
          return { ...s, settings: { ...s.settings, skills: list.filter((x) => x !== id) } };
        }
        if (list.length >= MAX_ACTIVE_SKILLS) {
          toast(`最多同时启用 ${MAX_ACTIVE_SKILLS} 个技能，先关掉一个`, "error");
          return s;
        }
        return { ...s, settings: { ...s.settings, skills: [...list, id] } };
      });
    },
    [toast, update]
  );

  const setSkillAuto = useCallback(
    (v: boolean) => {
      commit({ ...stateRef.current, settings: { ...stateRef.current.settings, skillAuto: v } });
    },
    [commit]
  );

  const pickSkillDir = useCallback(
    (path: string) => {
      commit({ ...stateRef.current, settings: { ...stateRef.current.settings, skillsDir: path } });
      setSkillDirPick(false);
      toast("已接入技能库：" + path, "ok");
    },
    [commit, toast]
  );

  const clearSkillDir = useCallback(() => {
    const base = builtinSkills();
    commit({ ...stateRef.current, settings: { ...stateRef.current.settings, skillsDir: null } });
    skillsRef.current = base;
    setSkills(base);
    setSkillErrors([]);
    toast("已断开外部技能库，只保留内建技能", "");
  }, [commit, toast]);

  /**
   * 把一份 Markdown 落盘或下载：有工程目录就写进 `<工程>/.zxz/audit/`，否则让浏览器下载。
   * 返回一句「去了哪」，由调用方拼进 toast。两份导出都走这里，省得各写一遍协议。
   */
  const persistMarkdown = useCallback(
    async (name: string, md: string): Promise<string> => {
      const stamp = stampNow();
      // 用渲染时的 settings，而不是 stateRef：界面显示哪个工程，就导到哪个工程，
      // 避免首帧（state 还没从本地恢复完）读到空 workspace 而误走下载分支
      const ws = settings.workspace;

      if (ws && fsAvailable()) {
        const rel = `.zxz/audit/${name}-${stamp}.md`;
        try {
          const r = await fsWrite(ws.sessionId, rel, md);
          await refreshTree();
          return `已写入 ${rel}（${r.bytes} 字节）`;
        } catch (e) {
          toast(`写盘失败，改为下载：${(e as Error).message}`, "error");
        }
      }

      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}-${stamp}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 立刻 revoke 会让部分内核的下载中断，推迟一拍
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      return "已下载";
    },
    [refreshTree, settings.workspace, toast]
  );

  /**
   * 导出审计底稿：清单（该查什么）+ 实测报告（查完是什么）。
   * 合成一份文件——浏览器会把「同站点连续两次自动下载」拦掉第二个，
   * 而且审计底稿本来就是一份东西的两半。内容不含任何第三方技能正文。
   */
  const exportAudit = useCallback(async () => {
    const when = new Date().toLocaleString("zh-CN", { hour12: false });
    const md = [
      buildAuditMarkdown(SOURCES, {
        when,
        skills: skillsRef.current.map((s) => ({ id: s.id, name: s.name, category: s.category, stage: s.stage })),
      }),
      "",
      "---",
      "",
      buildAuditReportMarkdown(),
    ].join("\n");
    const where = await persistMarkdown("source-audit", md);
    toast(`审计底稿${where}（清单 + 实测报告）`, "ok");
  }, [persistMarkdown, toast]);

  /**
   * 导出本地技能扫描结果。只含「哪个技能第几行写了什么」，不含技能正文，
   * 所以这份东西可以直接发给别人一起看。
   */
  const exportScan = useCallback(async () => {
    const local = skillsRef.current.filter((s) => s.source === "local");
    if (!local.length) {
      toast("还没接入外部技能库，没东西可导", "error");
      return;
    }
    const when = new Date().toLocaleString("zh-CN", { hour12: false });
    const results = local.map((s) => scanSkill(s.id, s.name, s.body));
    const where = await persistMarkdown("skill-scan", buildScanMarkdown(results, when));
    toast(`扫描结果${where}（${local.length} 个技能）`, "ok");
  }, [persistMarkdown, toast]);

  /* ------------------------------------------------------------ 设置 / 主题 / 导入导出 */

  const saveSettings = useCallback(
    (next: Settings) => {
      commit({ ...stateRef.current, settings: { ...next, contextTurns: clamp(next.contextTurns, 0, 100) } });
      setDrawerOpen(false);
      toast("设置已保存", "ok");
    },
    [commit, toast]
  );

  const previewTheme = useCallback((theme: Theme) => {
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  }, []);

  const toggleTheme = useCallback(() => {
    const next = stateRef.current.settings.theme === "light" ? "dark" : "light";
    commit({ ...stateRef.current, settings: { ...stateRef.current.settings, theme: next } });
  }, [commit]);

  const exportConversations = useCallback(() => {
    const list = stateRef.current.conversations;
    if (!list.length) {
      toast("还没有可导出的对话", "error");
      return;
    }
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zxz-conversations-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("已导出 " + list.length + " 个对话", "ok");
  }, [toast]);

  const importFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result)) as Conversation | Conversation[];
          const list = Array.isArray(data) ? data : [data];
          const imported: Conversation[] = [];
          for (const conv of list) {
            if (!conv || !Array.isArray(conv.messages)) continue;
            imported.push({
              id: uid(),
              title: conv.title || "导入的对话",
              messages: conv.messages.map((m) => ({
                role: m.role === "assistant" ? "assistant" : "user",
                content: String(m.content || ""),
                reasoning: m.reasoning || "",
                createdAt: m.createdAt || Date.now(),
              })),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
          update((s) => ({ ...s, conversations: [...s.conversations, ...imported] }));
          toast(imported.length ? `已导入 ${imported.length} 个对话` : "文件中没有可用对话", imported.length ? "ok" : "error");
        } catch {
          toast("导入失败：不是合法的 JSON", "error");
        }
      };
      reader.readAsText(file);
    },
    [toast, update]
  );

  const handleCopy = useCallback(
    (text: string) => {
      copyText(text)
        .then(() => toast("已复制到剪贴板", "ok"))
        .catch(() => toast("复制失败", "error"));
    },
    [toast]
  );

  /* ------------------------------------------------------------ 快捷键 */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        createConv();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setDrawerOpen((v) => !v);
      } else if (e.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
      } else if (e.key === "Escape" && wsOpen) {
        setWsOpen(false);
      } else if (e.key === "Escape" && skillDirPick) {
        setSkillDirPick(false);
      } else if (e.key === "Escape" && skillOpen) {
        setSkillOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [createConv, drawerOpen, skillDirPick, skillOpen, wsOpen]);

  /* ------------------------------------------------------------ 渲染 */

  const conversations = useMemo(
    () => filterConversations(state.conversations, keyword),
    [state.conversations, keyword]
  );

  const showRegen = Boolean(
    activeConv && activeConv.messages.length && activeConv.messages[activeConv.messages.length - 1].role === "assistant"
  );

  const title = activeConv ? activeConv.title || "新对话" : "zxz";

  return (
    <ToastContext.Provider value={toast}>
      <div className={"app" + (collapsed ? " sidebar-collapsed" : "")} id="app">
        <Sidebar
          conversations={conversations}
          activeId={state.activeId}
          keyword={keyword}
          transport={transport}
          ready={ready}
          onKeyword={setKeyword}
          onNew={createConv}
          onSelect={selectConv}
          onRename={renameConv}
          onDelete={deleteConv}
          onCollapse={() => setCollapsed(true)}
          onImport={() => fileRef.current?.click()}
          onExport={exportConversations}
          onOpenSettings={() => setDrawerOpen(true)}
        />

        <main className="main">
          <TopBar
            title={title}
            model={settings.model}
            workspace={settings.workspace}
            theme={settings.theme}
            showRegen={showRegen}
            onOpenSidebar={() => setCollapsed(false)}
            onRegen={regenerate}
            onClear={clearConv}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => setDrawerOpen(true)}
            onOpenWorkspace={openWorkspace}
            onOpenUndo={() => setUndoOpen(true)}
            onCompact={runCompactNow}
            compactCount={activeConv?.compactAfterIndex ?? 0}
          />

          {activeConv && activeConv.messages.length > 0 ? (
            <MessageList
              messages={activeConv.messages}
              activeId={state.activeId}
              onCopy={handleCopy}
              workspace={settings.workspace}
              onApply={requestApplyFiles}
              scrollSignal={scrollSignal}
            />
          ) : (
            <section className="chat" id="chat" aria-live="polite">
              <div className="chat-inner">
                <Welcome
                  model={settings.model}
                  noConv={!activeConv}
                  onChip={(text) => {
                    setInput(text);
                    setFocusSignal((n) => n + 1);
                  }}
                />
              </div>
            </section>
          )}

          <Composer
            value={input}
            busy={busy}
            onChange={setInput}
            onSend={() => void send()}
            onStop={stop}
            focusSignal={focusSignal}
            dictation={
              <DictationButton
                disabled={busy}
                onTranscript={(t) => {
                  setInput((prev) => appendTranscript(prev, t));
                  setFocusSignal((n) => n + 1);
                }}
                onError={(msg) => toast(msg, "error")}
              />
            }
            toolbar={
              <SkillChips
                skills={skills}
                active={settings.skills || []}
                disabled={busy}
                onToggle={toggleSkill}
                onOpen={() => setSkillOpen(true)}
              />
            }
          />
        </main>
      </div>

      <SettingsDrawer
        open={drawerOpen}
        settings={settings}
        transport={transport}
        onClose={() => setDrawerOpen(false)}
        onSave={saveSettings}
        onThemePreview={previewTheme}
        grants={grants}
        onRevoke={(scope) => revokeGrant(scope)}
        onRevokeAll={() => revokeGrant()}
      />

      <FolderPicker
        open={wsOpen}
        current={settings.workspace?.root || null}
        onClose={() => setWsOpen(false)}
        onPick={pickWorkspace}
        onClear={clearWorkspace}
      />

      <SkillPanel
        open={skillOpen}
        skills={skills}
        active={settings.skills || []}
        dir={settings.skillsDir}
        errors={skillErrors}
        loading={skillLoading}
        auto={settings.skillAuto !== false}
        onToggle={toggleSkill}
        onToggleAuto={setSkillAuto}
        onOpenDir={() => {
          if (!fsAvailable()) {
            toast("接入外部技能库需要桌面端运行", "error");
            return;
          }
          setSkillDirPick(true);
        }}
        onClearDir={clearSkillDir}
        onReload={() => void reloadSkills()}
        onExportAudit={() => void exportAudit()}
        onExportScan={() => void exportScan()}
        onClose={() => setSkillOpen(false)}
      />

      <FolderPicker
        open={skillDirPick}
        current={settings.skillsDir}
        title="选择技能库目录"
        confirmText="接入这个技能库"
        clearText="断开技能库"
        onClose={() => setSkillDirPick(false)}
        onPick={(path) => pickSkillDir(path)}
        onClear={clearSkillDir}
      />

      {/* exec 默认 ask：模型要跑命令时先在这里确认，白名单外的东西连框都不会弹 */}
      <ConfirmExec ask={execAsk} onChoose={answerExec} />

      <UndoPanel
        open={undoOpen}
        sessionId={settings.workspace?.sessionId || null}
        onClose={() => setUndoOpen(false)}
        onRestored={(text) => {
          toast(text, "ok");
          void refreshTree();
        }}
      />

      <PendingWrites
        items={pending}
        onApprove={(approved) => {
          setPending(null);
          pendingResolveRef.current?.(approved);
          pendingResolveRef.current = null;
        }}
        onDiscard={() => {
          setPending(null);
          pendingResolveRef.current?.(null);
          pendingResolveRef.current = null;
        }}
      />

      <Toasts list={toasts} />

      <input
        type="file"
        id="fileInput"
        accept="application/json"
        hidden
        ref={fileRef}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importFile(file);
          e.target.value = "";
        }}
      />
    </ToastContext.Provider>
  );
}
