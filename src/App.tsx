import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { chatStream, detectTransport, DIRECT } from "./api";
import { buildTree, fsAvailable, fsExists, fsList, fsRead, fsWrite } from "./lib/fsapi";
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
import type { AppState, Conversation, FileWriteResult, Message, Settings, Theme, Transport, Usage } from "./types";
import type { ToastKind } from "./components/ui";

import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { Welcome } from "./components/Welcome";
import { FolderPicker } from "./components/FolderPicker";
import { UndoPanel } from "./components/UndoPanel";
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
      const tree = await buildTree(ws.root);
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
          if (await fsExists(ws.root, b.path)) {
            try {
              oldText = await fsRead(ws.root, b.path);
              backup = backupRelPath(stamp, b.path);
              await fsWrite(ws.root, backup, oldText);
              backedUp += 1;
            } catch {
              /* 备份失败不阻断写入 */
            }
          }
          const r = await fsWrite(ws.root, b.path, b.content);
          const stats = diffStats(diffLines(oldText, b.content));
          results.push({
            path: b.path,
            ok: true,
            bytes: r.bytes,
            created: r.created,
            ...(backup ? { backup } : {}),
            add: stats.add,
            del: stats.del,
          });
        } catch (e) {
          results.push({ path: b.path, ok: false, error: (e as Error).message });
        }
      }

      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      const backupNote = backedUp ? `，${backedUp} 个覆盖前已备份到 ${UNDO_DIR}` : "";
      toast(`已写入 ${ok} 个文件${backupNote}${fail ? `，${fail} 个失败` : ""}`, fail ? "error" : "ok");

      await refreshTree();
      return results;
    },
    [refreshTree, toast]
  );

  /** 按模型的要求读真实文件内容 */
  const readForModel = useCallback(async (root: string, paths: string[]): Promise<ReadOutcome[]> => {
    const out: ReadOutcome[] = [];
    for (const p of paths) {
      const bad = relPathError(p);
      if (bad) {
        out.push({ path: p, error: bad });
        continue;
      }
      try {
        out.push({ path: p, content: await fsRead(root, p) });
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
        out.push({ path: label, content: await fsRead(sk.dir, r.rel) });
      } catch (e) {
        out.push({ path: label, error: (e as Error).message });
      }
    }
    return out;
  }, []);

  /* ------------------------------------------------------------ 发送 */

  const send = useCallback(
    async (opts?: { reuseUser?: boolean }) => {
      if (busyRef.current) return;
      const reuse = Boolean(opts?.reuseUser);
      const text = input.trim();
      // 重新生成时输入框里是上一次的原文，允许为空判断跳过
      if (!reuse && !text) return;

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

          try {
            await chatStream({
              settings: s,
              transport,
              messages: buildMessages({ ...target, messages }, s, skillPrompt),
              signal: controller.signal,
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

          // 真实落盘：回复里出现 file: 块就直接写进工程目录
          const ws = stateRef.current.settings.workspace;
          const blocks = aborted || failed ? [] : parseFileBlocks(acc.content);
          const files = ws && blocks.length ? await applyFiles(blocks) : undefined;

          const finalMsg: Message = {
            ...assist,
            content: acc.content,
            reasoning: acc.reasoning,
            usage: acc.usage,
            streaming: false,
            ...(files ? { files } : {}),
            ...(usedIds.length ? { skills: usedIds } : {}),
            ...(failed ? { error: failed } : {}),
          };
          patchMessage(convId, index, () => finalMsg);
          baseMessages = [...baseMessages, finalMsg];

          if (aborted || failed) break;

          // 模型要文件 / 技能附件：程序回传真实内容后继续下一轮
          const reads = ws ? parseReadRequests(acc.content) : [];
          const refs = allSkills.length ? parseSkillRefs(acc.content) : [];
          if (!reads.length && !refs.length) break;
          if (round === MAX_ROUNDS - 1) {
            toast(`已达到本次最多 ${MAX_ROUNDS} 轮读写，继续请再发一条消息`, "error");
            break;
          }

          const outcomes = ws ? await readForModel(ws.root, reads) : [];
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
    [applyFiles, createConv, input, patchMessage, readForModel, readSkillRefs, toast, transport, update]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
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

  // 工程目录可能被删掉或移动：启动时校验一次，失效就自动退出该模式，
  // 否则后续每次写入都会报「工程目录不可用」，用户不知道从哪改。
  useEffect(() => {
    if (!ready) return;
    const ws = stateRef.current.settings.workspace;
    if (!ws || !fsAvailable()) return;
    let alive = true;
    (async () => {
      try {
        await fsList(ws.root);
      } catch {
        if (!alive) return;
        commit({ ...stateRef.current, settings: { ...stateRef.current.settings, workspace: null } });
        toast("工程目录已不存在，已退出本地工程模式", "error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [ready, commit, toast]);


  const openWorkspace = useCallback(() => {
    if (!fsAvailable()) {
      toast("本地写代码需要桌面端运行，浏览器直开无法访问磁盘", "error");
      return;
    }
    setWsOpen(true);
  }, [toast]);

  const pickWorkspace = useCallback(
    async (root: string, name: string) => {
      let tree = "";
      try {
        tree = await buildTree(root);
      } catch {
        /* 目录树拿不到不影响接入，模型仍能靠 @@read 取内容 */
      }
      commit({
        ...stateRef.current,
        settings: { ...stateRef.current.settings, workspace: { root, name, tree } },
      });
      setWsOpen(false);
      toast(`已接入工程：${name}`, "ok");
    },
    [commit, toast]
  );

  const clearWorkspace = useCallback(() => {
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
          const r = await fsWrite(ws.root, rel, md);
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
              onApply={applyFiles}
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
        root={settings.workspace?.root || null}
        onClose={() => setUndoOpen(false)}
        onRestored={(text) => {
          toast(text, "ok");
          void refreshTree();
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
