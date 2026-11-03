import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { chatStream, detectTransport, DIRECT } from "./api";
import { buildTree, fsAvailable, fsExists, fsListIn, fsRead, fsWrite, runAllowed, sessionFor, undoWrite, wsClose, wsInfo, wsOpen as openSession } from "./lib/fsapi";
import { buildMessages, filterConversations, findActive, loadState, newConversation, persist, titleFrom } from "./state";
import { clamp, copyText, uid } from "./lib/text";
import { diffLines, diffStats } from "./lib/diff";
import { stampNow } from "./lib/undo";
import { builtinSkills } from "./skills";
import { SOURCES, buildAuditMarkdown } from "./skills/sources";
import { buildAuditReportMarkdown } from "./skills/audit";
import { buildScanMarkdown, scanSkill } from "./lib/skillscan";
import {
  buildSkillPrompt,
  matchSkills,
  MAX_ACTIVE_SKILLS,
  parseSkillRefs,
  skillCatalogPrompt,
  skillRefLabel,
  type Skill,
  type SkillRef,
} from "./lib/skill";
import { PROJECT_MEMORY_FILES, truncateProjectMemory } from "./lib/project";
import { buildPendingWrites, type PendingWrite } from "./lib/pending";
import {
  appendAssistantMessage,
  appActionLabel,
  nextInputAfterCommand,
  planAppCommand,
  withToggleApplied,
} from "./lib/appcontrol";
import { loadLocalSkills, mergeSkills, pickSkills } from "./lib/skillstore";
import {
  backupRelPath,
  buildReadPayload,
  parseFileBlocks,
  parseReadRequests,
  relPathError,
  UNDO_DIR,
  type FileBlock,
  type ReadOutcome,
} from "./lib/files";
import {
  MAX_TEST_ROUNDS,
  runResultHead,
  testLoopDecision,
  truncateToolOutput,
} from "./lib/tools";
import { findTool, planModeBlocks, TOOL_DEFS, type ToolContext } from "./lib/registry";
import type { AppState, Conversation, FileWriteResult, Message, Settings, Theme, ToolCallRecord, Transport, Usage } from "./types";
import type { ToastKind } from "./components/ui";

import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Composer } from "./components/Composer";
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
    const conv = newConversation();
    update((s) => ({ ...s, conversations: [...s.conversations, conv], activeId: conv.id }));
    setInput("");
    setScrollSignal((n) => n + 1);
    setFocusSignal((n) => n + 1);
    if (window.innerWidth <= 860) setCollapsed(true);
    return conv;
  }, [update]);

  const selectConv = useCallback(
    (id: string) => {
      update((s) => ({ ...s, activeId: id }));
      setScrollSignal((n) => n + 1);
      if (window.innerWidth <= 860) setCollapsed(true);
    },
    [update]
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
      update((s) => {
        const conversations = s.conversations.filter((c) => c.id !== id);
        const activeId = s.activeId === id ? conversations[0]?.id || null : s.activeId;
        return { ...s, conversations, activeId };
      });
    },
    [update]
  );

  const clearConv = useCallback(() => {
    const conv = findActive(stateRef.current);
    if (!conv || !conv.messages.length) return;
    if (!window.confirm("清空当前对话的所有消息？")) return;
    update((s) => ({
      ...s,
      conversations: s.conversations.map((c) => (c.id === conv.id ? { ...c, messages: [] } : c)),
    }));
  }, [update]);

  /* ------------------------------------------------------------ 本地工程：真实写盘 */

  /** 单次对话最多几轮「读文件 → 改文件」，防止模型自己绕圈 */
  const MAX_ROUNDS = 6;

  const patchMessage = useCallback(
    (convId: string, index: number, fn: (m: Message) => Message) => {
      update((prev) => ({
        ...prev,
        conversations: prev.conversations.map((c) => {
          if (c.id !== convId) return c;
          const list = c.messages.slice();
          const old = list[index];
          if (!old) return c;
          list[index] = fn(old);
          return { ...c, messages: list, updatedAt: Date.now() };
        }),
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

  /**
   * 把回复里的 file: 块真的写进磁盘。不弹确认——本地工程模式的约定就是「模型直接改代码」；
   * 覆盖已有文件前先把旧内容备份到 .zxz/undo/<时间戳>/，要退回去随时取。
   */
  const applyFiles = useCallback(
    async (blocks: FileBlock[]): Promise<FileWriteResult[]> => {
      const ws = stateRef.current.settings.workspace;
      if (!ws || !blocks.length) return [];

      const stamp = stampNow();
      const results: FileWriteResult[] = [];
      let backedUp = 0;

      for (const b of blocks) {
        const bad = relPathError(b.path);
        if (bad) {
          results.push({ path: b.path, ok: false, error: bad });
          continue;
        }
        try {
          let oldText = "";
          let backup: string | undefined;
          // 「确认不存在」与「校验失败」必须分开：fsExists 现在会把后者抛出来。
          // 抛了就不能往下写——不然等于把一次越界/链接校验失败当成"新建文件"，
          // 静默跳过备份，覆盖就变成不可撤销的操作。
          let exists: boolean;
          try {
            exists = await fsExists(ws.sessionId, b.path);
          } catch (e) {
            results.push({
              path: b.path,
              ok: false,
              error: `无法确认目标是否存在，已中止写入：${(e as Error).message}`,
            });
            continue;
          }
          if (exists) {
            // 备份失败必须阻断写入：没有备份的覆盖不可撤销，不能"先写了再说"。
            oldText = await fsRead(ws.sessionId, b.path);
            backup = backupRelPath(stamp, b.path);
            // 走撤销专用通道：普通 fsWrite 现在整目录拒绝 .zxz/undo，
            // 因为模型手里的 write_file 用的正是那条通道。
            await undoWrite(ws.sessionId, stamp, b.path, oldText);
            backedUp += 1;
          }
          const r = await fsWrite(ws.sessionId, b.path, b.content);
          // 写完回读校验：Claude Code 那套“改完要验证”在本工具里没有终端可跑，
          // 至少做到写进去的东西和模型给的东西逐字一致，否则不能算“写好了”。
          let verified = true;
          try {
            verified = (await fsRead(ws.sessionId, b.path)) === b.content;
          } catch {
            verified = false;
          }
          const stats = diffStats(diffLines(oldText, b.content));
          results.push({
            path: b.path,
            ok: true,
            bytes: r.bytes,
            created: r.created,
            ...(backup ? { backup } : {}),
            add: stats.add,
            del: stats.del,
            verified,
          });
        } catch (e) {
          results.push({ path: b.path, ok: false, error: (e as Error).message });
        }
      }

      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      const unverified = results.filter((r) => r.ok && r.verified === false).length;
      const backupNote = backedUp ? `，${backedUp} 个覆盖前已备份到 ${UNDO_DIR}` : "";
      toast(
        `已写入 ${ok} 个文件${backupNote}${fail ? `，${fail} 个失败` : ""}${unverified ? `，${unverified} 个回读不一致` : ""}`,
        fail || unverified ? "error" : "ok"
      );

      await refreshTree();
      return results;
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

      const olds = new Map<string, string>();
      for (const b of blocks) {
        try {
          if (await fsExists(ws.sessionId, b.path)) olds.set(b.path, await fsRead(ws.sessionId, b.path));
        } catch {
          /* 读不到旧内容就按新建处理，面板里会显示为空 */
        }
      }
      const items = buildPendingWrites(blocks, olds);
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

  /** 接入工程时读项目记忆：CLAUDE.md 优先，没有就退到 AGENTS.md，读不到就算没有 */
  const loadProjectMemory = useCallback(async (sessionId: string): Promise<{ source: string; body: string } | null> => {
    for (const file of PROJECT_MEMORY_FILES) {
      try {
        const body = await fsRead(sessionId, file);
        if (body.trim()) return { source: file, body: truncateProjectMemory(body) };
      } catch {
        /* 这个文件不存在就试下一个 */
      }
    }
    return null;
  }, []);

  /** 按模型的要求读真实文件内容 */
  const readForModel = useCallback(async (sessionId: string, paths: string[]): Promise<ReadOutcome[]> => {
    const out: ReadOutcome[] = [];
    for (const p of paths) {
      const bad = relPathError(p);
      if (bad) {
        out.push({ path: p, error: bad });
        continue;
      }
      try {
        out.push({ path: p, content: await fsRead(sessionId, p) });
      } catch (e) {
        out.push({ path: p, error: (e as Error).message });
      }
    }
    return out;
  }, []);

  /** 按模型要求取技能附件：内建技能只有正文，外部技能从它自己的目录读 */
  const readSkillRefs = useCallback(async (all: Skill[], refs: SkillRef[]): Promise<ReadOutcome[]> => {
    const out: ReadOutcome[] = [];
    for (const r of refs) {
      const label = skillRefLabel(r);
      const sk = all.find((x) => x.id === r.skillId);
      if (!sk) {
        out.push({ path: label, error: `没有这个技能（可用：${all.map((x) => x.id).slice(0, 8).join("、")}）` });
        continue;
      }
      if (!sk.dir) {
        out.push(
          r.rel === "SKILL.md"
            ? { path: label, content: sk.body }
            : { path: label, error: "内建技能没有附带文件，只能取 SKILL.md" }
        );
        continue;
      }
      try {
        out.push({ path: label, content: await fsRead(await sessionFor(sk.dir), r.rel) });
      } catch (e) {
        out.push({ path: label, error: (e as Error).message });
      }
    }
    return out;
  }, []);

  /**
   * 工具执行上下文：把「当前会话」和几个副作用通道包成一个对象交给注册表。
   *
   * 用 stateRef 取会话而不是闭包捕获 workspace，所以 ctx 不随工作区切换重建；
   * 真正让不同工具表现得不同的是 registry 里的 spec，不是这里的分支。
   */
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
        return runAllowed(ws.sessionId, argv);
      },
    }),
    [requestApplyFiles]
  );

  /**
   * 执行一次模型发起的工具调用。顺序执行、不并行，避免两个写操作互相覆盖。
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
      const spec = findTool(call.name);
      if (!spec) return { ...base, error: `未知工具：${call.name}` };
      const ws = stateRef.current.settings.workspace;
      if (!ws) return { ...base, error: "未接入工程目录，工具不可用" };
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        return { ...base, error: "工具参数不是合法 JSON" };
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
        const out = await spec.run(args, ctx);
        return { ...base, ...(out.error ? { error: out.error } : { result: out.result ?? "" }) };
      } catch (e) {
        return { ...base, error: (e as Error).message };
      }
    },
    [ctx]
  );

  /* ------------------------------------------------------------ 发送 */

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

      // 测试回路计数：本次发送里已经跑完的 npm test 轮数，上限 MAX_TEST_ROUNDS
      let testRounds = 0;

      try {
        // 一轮 = 一条助手消息。模型读文件后程序自动再请求一轮，最多 MAX_ROUNDS 轮
        for (let round = 0; round < MAX_ROUNDS; round++) {
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
          update((prev) => ({
            ...prev,
            conversations: prev.conversations.map((c) =>
              c.id === convId ? { ...c, messages, updatedAt: Date.now() } : c
            ),
          }));

          const acc = { content: "", reasoning: "", usage: undefined as Usage | undefined };
          let raf = 0;
          const flush = () => {
            raf = 0;
            patchMessage(convId, index, (m) => ({
              ...m,
              content: acc.content,
              reasoning: acc.reasoning,
              usage: acc.usage,
            }));
          };
          const schedule = () => {
            if (!raf) raf = requestAnimationFrame(flush);
          };

          let aborted = false;
          let failed = "";
          let roundToolCalls: { id: string; name: string; arguments: string }[] = [];

          try {
            const toolModeOn = s.toolCalls !== false && Boolean(stateRef.current.settings.workspace);
            await chatStream({
              settings: s,
              transport,
              messages: buildMessages({ ...target, messages }, s, skillPrompt),
              signal: controller.signal,
              tools: toolModeOn ? TOOL_DEFS : undefined,
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
                  toast(evt.message, "error");
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
              toast(failed, "error");
            }
          } finally {
            if (raf) cancelAnimationFrame(raf);
          }

          // 真实落盘：回复里出现 file: 块就写进工程目录；计划模式只出方案，直接跳过
          const ws = stateRef.current.settings.workspace;
          const blocks = aborted || failed ? [] : parseFileBlocks(acc.content);
          const planMode = Boolean(s.planMode);
          if (planMode && blocks.length) toast("计划模式：本轮 file: 块未落盘，只保留方案", "");
          const files = ws && blocks.length && !planMode ? await requestApplyFiles(blocks) : undefined;

          // 工具调用：按顺序执行，结果挂在助手消息上，下一轮 buildMessages
          // 会把它展开成原生 tool_calls + tool 消息发给上游，模型才能对上号。
          // 工具模式下即使没有 file: 块，写文件也是通过 write_file 工具发生的。
          let toolRecords: ToolCallRecord[] = [];
          if (!aborted && !failed && roundToolCalls.length) {
            for (const call of roundToolCalls) {
              toolRecords.push(await executeTool(call));
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
            ...(usedIds.length ? { skills: usedIds } : {}),
            ...(failed ? { error: failed } : {}),
          };
          patchMessage(convId, index, () => finalMsg);
          baseMessages = [...baseMessages, finalMsg];

          if (aborted || failed) break;

          // 测试回路：本轮写了文件、且自动测试开启、且在桌面端，才自动跑测试。
          // 通过就停在本轮；失败把报错当成隐藏消息回传，模型下一轮再改；
          // 3 轮不过就停下，把失败原样报给人，不许模型宣称已修好。
          let testGiveUp = false;
          // autoTest 默认关，且写成 === true：想开必须显式打开，默认路径不自动跑命令
          if (
            wroteSomething &&
            s.autoTest === true &&
            s.toolCalls !== false &&
            !planMode &&
            fsAvailable() &&
            ws
          ) {
            try {
              // 脚本审计已下沉到 Rust 执行层（runx）：npm test 真正跑的脚本不是
              // 受信任运行器时直接拒绝，这里不再前端预判，拒绝原因走 catch 报出来。
              const r = await runAllowed(ws.sessionId, ["npm", "test"]);
              testRounds += 1;
              const combined = [r.stdout, r.stderr ? `--- stderr ---\n${r.stderr}` : ""].filter(Boolean).join("\n");
              const decision = testLoopDecision(r.exit_code, testRounds);
              if (decision === "pass") {
                toast("测试通过", "ok");
              } else if (decision === "retry") {
                const testMsg: Message = {
                  role: "user",
                  content: `[测试回路] 第 ${testRounds}/${MAX_TEST_ROUNDS} 轮 npm test 未通过，${runResultHead(r)}\n${truncateToolOutput(combined || "(无输出)")}\n请根据上面报错改代码，不要在测试通过前宣称完成。`,
                  createdAt: Date.now(),
                  hidden: true,
                };
                baseMessages = [...baseMessages, testMsg];
                update((prev) => ({
                  ...prev,
                  conversations: prev.conversations.map((c) =>
                    c.id === convId ? { ...c, messages: baseMessages, updatedAt: Date.now() } : c
                  ),
                }));
              } else {
                testGiveUp = true;
                toast(`测试 ${MAX_TEST_ROUNDS} 轮仍未通过，已停止自动修复，请人工处理`, "error");
              }
            } catch (e) {
              // 跑测试本身失败（比如不在桌面端、命令被拒）不阻断主流程，只报一声
              toast("自动测试未能运行：" + (e as Error).message, "error");
            }
          }
          if (testGiveUp) break;

          // 模型要文件 / 技能附件：程序回传真实内容后继续下一轮
          const reads = ws ? parseReadRequests(acc.content) : [];
          const refs = allSkills.length ? parseSkillRefs(acc.content) : [];
          // 有工具调用时必须继续下一轮，模型要看到工具结果才能回应；
          // 只有既没工具调用、又没读/附件请求时，才是本轮真正结束。
          if (!toolRecords.length && !reads.length && !refs.length) break;
          if (round === MAX_ROUNDS - 1) {
            toast(`已达到本次最多 ${MAX_ROUNDS} 轮读写，继续请再发一条消息`, "error");
            break;
          }
          // 工具调用轮次里测试回路已经把报错回传了，读/附件请求仍按原流程回传，
          // 两类隐藏消息都会进下一轮的上下文，不会互相丢。

          const outcomes = ws ? await readForModel(ws.sessionId, reads) : [];
          const refOutcomes = await readSkillRefs(allSkills, refs);
          const toolMsg: Message = {
            role: "user",
            content: buildReadPayload([...outcomes, ...refOutcomes]),
            createdAt: Date.now(),
            hidden: true,
          };
          baseMessages = [...baseMessages, toolMsg];
          update((prev) => ({
            ...prev,
            conversations: prev.conversations.map((c) =>
              c.id === convId ? { ...c, messages: baseMessages, updatedAt: Date.now() } : c
            ),
          }));
        }
      } finally {
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
        setScrollSignal((n) => n + 1);
      }
    },
    [createConv, executeTool, input, patchMessage, readForModel, readSkillRefs, requestApplyFiles, toast, transport, update]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // 正在等写入批复时点停止：直接按“放弃”处理，否则发送流程会一直挂在面板上
    if (pendingResolveRef.current) {
      setPending(null);
      pendingResolveRef.current(null);
      pendingResolveRef.current = null;
    }
  }, []);

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
