/** 本机文件系统 IPC：只在 Tauri 桌面端可用，浏览器直开时全部返回不可用。
 *
 * 工程边界：前端不持有、也不传递工程根目录。
 * 目录只在 `wsOpen` 里登记一次（用户在文件夹选择器里选的那一次），Rust 端
 * canonicalize 后返回一个 sessionId；之后所有读写与命令都只认 sessionId，
 * 落到哪个目录由 Rust 说了算（见 src-tauri/src/wsx.rs）。
 *
 * 例外：`fsList` / `fsMkdir` 是文件夹选择器通道，天生要能浏览任意绝对路径
 * （否则用户没法走到工程目录），所以仍收绝对路径——它只服务界面，
 * 模型侧一律走会话通道。
 *
 * 命令在 Rust 侧（`src-tauri/src/fsx.rs`、`runx.rs`）做校验，这里只做参数转发与错误归一。
 */

import { shouldSkipDir, treeLine } from "./files";

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

/** Rust 登记出来的工作区会话。root 只是给人看的展示值，不能再拿去做文件系统调用。 */
export interface WorkspaceSession {
  id: string;
  root: string;
  name: string;
}

interface Internals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function internals(): Internals | null {
  const i = (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;
  return i && typeof i.invoke === "function" ? i : null;
}

/** 当前环境能否读写本机文件 */
export function fsAvailable(): boolean {
  return internals() !== null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const inv = internals();
  if (!inv) throw new Error("本地文件读写只在桌面端可用");
  return (await inv.invoke(cmd, args)) as T;
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/* ------------------------------------------------------------ 工作区会话 */

/**
 * 登记一个工程目录。这是 root 唯一一次出现在 IPC 里：
 * Rust canonicalize 之后锁死，返回一个不可预测的 sessionId。
 */
export async function wsOpen(root: string): Promise<WorkspaceSession> {
  try {
    return await call<WorkspaceSession>("ws_open", { root });
  } catch (e) {
    throw new Error(errText(e));
  }
}

/** 关掉会话：目录还在，但拿着这个 id 再来一律被拒绝 */
export async function wsClose(sessionId: string): Promise<void> {
  try {
    await call<void>("ws_close", { sessionId });
  } catch {
    /* 关闭失败不影响前端状态清理：会话在 Rust 侧没有副作用 */
  }
}

/** 查会话是否还活着（进程重启后旧 id 一定失效），顺带取展示用的根目录与目录名 */
export async function wsInfo(sessionId: string): Promise<WorkspaceSession> {
  return call<WorkspaceSession>("ws_info", { sessionId });
}

const sessionCache = new Map<string, string>();

/**
 * 给「用户挑的目录」开会话并缓存：技能库这类非工程目录也走同一套会话通道，
 * 不再自己拼 root 去读。工程目录不要用这里——它有明确的开关生命周期（见 App.tsx）。
 */
export async function sessionFor(root: string): Promise<string> {
  const hit = sessionCache.get(root);
  if (hit) {
    try {
      await wsInfo(hit);
      return hit;
    } catch {
      sessionCache.delete(root);
    }
  }
  const s = await wsOpen(root);
  sessionCache.set(root, s.id);
  return s.id;
}

/* ------------------------------------------------------------ 文件读写 */

export async function fsRoots(): Promise<string[]> {
  try {
    return await call<string[]>("fs_roots");
  } catch (e) {
    throw new Error(errText(e));
  }
}

export async function fsList(path: string): Promise<FsEntry[]> {
  try {
    return await call<FsEntry[]>("fs_list", { path });
  } catch (e) {
    throw new Error(errText(e));
  }
}

/**
 * 工程内列目录：模型工具（list_dir / search_files）与目录树专用。
 * 与 fsList 的区别：fsList 是文件夹选择器通道，允许浏览任意绝对路径；
 * 这里只收 sessionId+rel，越界（绝对路径、..、符号链接借道）在 Rust 侧拒绝。
 */
export async function fsListIn(sessionId: string, rel: string): Promise<FsEntry[]> {
  return call<FsEntry[]>("fs_list_in", { sessionId, rel });
}

/** 在 dir 下新建一层文件夹，返回新目录的绝对路径（校验与落点都在 Rust 侧） */
export async function fsMkdir(dir: string, name: string): Promise<string> {
  try {
    return await call<string>("fs_mkdir", { dir, name });
  } catch (e) {
    throw new Error(errText(e));
  }
}

export async function fsRead(sessionId: string, rel: string): Promise<string> {
  return call<string>("fs_read", { sessionId, rel });
}

/** 目标是否存在。
 *
 * 不吞错：`fs_exists` 报错有两种完全不同的含义——「确认不存在」和「校验失败」
 * （越过工程根、会话失效、目标是指到工程外的链接）。把它们都当成 `false`，
 * 覆盖写入就会以为"这是新建文件"从而跳过备份，等于把一次校验失败变成一次
 * 不可撤销的覆盖。错误必须抛给调用方决定。
 */
export async function fsExists(sessionId: string, rel: string): Promise<boolean> {
  return call<boolean>("fs_exists", { sessionId, rel });
}

export async function fsWrite(sessionId: string, rel: string, content: string): Promise<WriteResult> {
  try {
    return await call<WriteResult>("fs_write", { sessionId, rel, content });
  } catch (e) {
    throw new Error(errText(e));
  }
}

/**
 * 撤销快照专用通道：只写 `.zxz/undo/<stamp>/<rel>`。
 *
 * 为什么单独开一条：`fsWrite` 现在整目录拒绝 `.zxz/undo`，因为模型手上的
 * `write_file` 走的正是那条通道——撤销快照是覆盖写失败时唯一的退路，
 * 它能被模型改写等于这张安全网不存在。备份与恢复的写入改到这里，
 * 落点、stamp 形状、是否越出 undo 区都在 Rust 侧（`fsx::undo_write`）校验。
 */
export async function undoWrite(sessionId: string, stamp: string, rel: string, content: string): Promise<WriteResult> {
  try {
    return await call<WriteResult>("undo_write", { sessionId, stamp, rel, content });
  } catch (e) {
    throw new Error(errText(e));
  }
}

/** 撤销快照读取：`fsRead` / `fsListIn` 对 `.zxz/undo` 已关闭，撤销面板走这两条。 */
export async function undoRead(sessionId: string, stamp: string, rel: string): Promise<string> {
  try {
    return await call<string>("undo_read", { sessionId, stamp, rel });
  } catch (e) {
    throw new Error(errText(e));
  }
}

/** `stamp` 为 null 时列出快照目录；给出时列出该快照内 `rel` 子目录（空串 = 快照根） */
export async function undoList(sessionId: string, stamp: string | null, rel: string): Promise<FsEntry[]> {
  try {
    return await call<FsEntry[]>("undo_list", { sessionId, stamp, rel });
  } catch (e) {
    throw new Error(errText(e));
  }
}

export interface RunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  /**
   * 被用户点「停止」终止。
   *
   * 与 `timed_out` 分开：两者都是"进程被我们杀了"，但含义相反——
   * 超时是失败，用户主动停止不是。合在一起，测试回路会在用户点停止后
   * 回传一条"第 1/3 轮 npm test 未通过"，把人的操作说成代码的错。
   *
   * 可选是因为测试桩里构造 RunResult 的地方很多，缺字段按"没取消"处理
   * （Rust 侧总是会发这个字段）。
   */
  cancelled?: boolean;
}

/** 一条执行授权：作用域是「命令 + 子命令」，例如 ["npm","test"] */
export interface ExecGrant {
  scope: string[];
  /** null = 本会话（本工程目录）内不限次 */
  uses_left: number | null;
  label: string;
}

export type ExecDecision =
  | { kind: "allow" }
  | { kind: "ask"; scope: string[]; label: string }
  | { kind: "deny"; reason: string };

/**
 * Rust 侧的 exec 闸门要求用户先授权。
 *
 * 这个类存在的意义是让界面能区分「需要弹框问人」和「命令本身被拒绝」：
 * 前者该等用户点头，后者该直接把原因告诉模型换个写法。两者混在一起的话，
 * 会给 `npm install` 也弹一个确认框，用户点了允许才发现白名单还是拒的。
 */
export class ExecGrantRequired extends Error {
  readonly scope: string[];
  readonly label: string;
  constructor(scope: string[], label: string) {
    super(`需要授权：${label}`);
    this.name = "ExecGrantRequired";
    this.scope = scope;
    this.label = label;
  }
}

/** Rust 用 JSON 字符串回传闸门判定，这里还原成上面两种错误 */
function toExecError(e: unknown): Error {
  const text = errText(e);
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { kind?: unknown; scope?: unknown; label?: unknown; reason?: unknown };
      if (j.kind === "need_grant") {
        const scope = Array.isArray(j.scope) ? j.scope.map(String) : [];
        return new ExecGrantRequired(scope, typeof j.label === "string" ? j.label : scope.join(" "));
      }
      if (j.kind === "refused" && typeof j.reason === "string") return new Error(j.reason);
    } catch {
      /* 不是闸门的 JSON，落到原文 */
    }
  }
  return new Error(text);
}

/**
 * 受控命令执行：只在 Tauri 桌面端可用，浏览器直开时直接报错。
 * 白名单、超时、输出上限都在 Rust 侧（runx.rs）再校验一次，这里不做最终裁决；
 * **执行许可也在 Rust 侧判定**，未批准时抛 `ExecGrantRequired`。
 * 工作目录由 Rust 按 sessionId 决定，这里传不了 cwd。
 */
export async function runAllowed(sessionId: string, argv: string[]): Promise<RunResult> {
  try {
    return await call<RunResult>("run_allowed", { sessionId, argv });
  } catch (e) {
    throw toExecError(e);
  }
}

/**
 * 终止这个会话正在跑的命令（用户点「停止」）。
 *
 * 返回 true 表示当时确实有命令在跑。**不弹错**：点停止的时候出任何问题都不该
 * 用第二个错误提示盖住"已经停了"这件事；真正需要知道的是"没停成"，
 * 而那种情况会在 `run_allowed` 那一侧以正常结果（没被取消）暴露出来。
 *
 * 不经过授权闸门：取消是收窄权限的动作，不需要再批一次。
 */
export async function runCancel(sessionId: string): Promise<boolean> {
  try {
    return await call<boolean>("run_cancel", { sessionId });
  } catch {
    return false;
  }
}

/**
 * 记一条授权。`uses` 为 null 表示本会话内不限次，为数字表示还能用几次。
 *
 * 这是唯一能创建授权的入口，只被界面调用——工具清单里没有它，模型无法通过
 * 工具调用触达；也不存在「先跑起来再自己授权」的路：模型写的代码要跑起来，
 * 本身就得先过闸门。
 */
export async function permGrant(sessionId: string, scope: string[], uses: number | null, label: string): Promise<ExecGrant[]> {
  try {
    return await call<ExecGrant[]>("perm_grant", { sessionId, scope, uses, label });
  } catch (e) {
    throw toExecError(e);
  }
}

/** 撤销授权。不传 scope 就清空该会话的全部授权 */
export async function permRevoke(sessionId: string, scope?: string[]): Promise<ExecGrant[]> {
  try {
    return await call<ExecGrant[]>("perm_revoke", { sessionId, scope });
  } catch (e) {
    throw toExecError(e);
  }
}

export async function permList(sessionId: string): Promise<ExecGrant[]> {
  return call<ExecGrant[]>("perm_list", { sessionId });
}

/** 拼出给模型看的目录树（深度优先，忽略依赖与构建产物，最多 300 条） */
export async function buildTree(sessionId: string, depth = 2): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  async function walk(rel: string, level: number): Promise<void> {
    if (level > depth || count >= 300) return;
    let entries: FsEntry[];
    try {
      entries = await fsListIn(sessionId, rel);
    } catch {
      return; // 无权限的目录直接跳过，不影响整体树
    }
    for (const e of entries) {
      if (count >= 300) return;
      if (e.dir && shouldSkipDir(e.name)) continue;
      count += 1;
      lines.push(treeLine({ name: e.name, path: e.path, dir: e.dir }, level - 1));
      if (e.dir) await walk(rel ? `${rel}/${e.name}` : e.name, level + 1);
    }
  }

  await walk("", 1);
  return lines.join("\n");
}

/** 打开内置预览窗口：http(s) 地址或本地 HTML 文件路径。 */
export async function openPreview(target: string): Promise<void> {
  await call<void>("open_preview", { target });
}

/** 联网搜索的结果条目（Rust 侧解析 Bing 返回） */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 联网搜索：走 Rust 侧（绕 CORS），返回标题/链接/摘要列表。 */
export async function webSearch(query: string): Promise<SearchResult[]> {
  return call<SearchResult[]>("web_search", { query });
}
