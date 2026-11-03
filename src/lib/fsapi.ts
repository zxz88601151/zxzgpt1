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

export interface RunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
}

/**
 * 受控命令执行：只在 Tauri 桌面端可用，浏览器直开时直接报错。
 * 白名单、超时、输出上限都在 Rust 侧（runx.rs）再校验一次，这里不做最终裁决，
 * 只做参数转发与错误归一；前端的 isAllowedCommand 只是提前拦截、省一次 IPC。
 * 工作目录由 Rust 按 sessionId 决定，这里传不了 cwd。
 */
export async function runAllowed(sessionId: string, argv: string[]): Promise<RunResult> {
  try {
    return await call<RunResult>("run_allowed", { sessionId, argv });
  } catch (e) {
    throw new Error(errText(e));
  }
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
