/** 本机文件系统 IPC：只在 Tauri 桌面端可用，浏览器直开时全部返回不可用。
 *
 * 命令在 Rust 侧（`src-tauri/src/fsx.rs`）做了三道校验，这里只做参数转发与错误归一。
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

/** 在 dir 下新建一层文件夹，返回新目录的绝对路径（校验与落点都在 Rust 侧） */
export async function fsMkdir(dir: string, name: string): Promise<string> {
  try {
    return await call<string>("fs_mkdir", { dir, name });
  } catch (e) {
    throw new Error(errText(e));
  }
}

export async function fsRead(root: string, rel: string): Promise<string> {
  return call<string>("fs_read", { root, rel });
}

export async function fsExists(root: string, rel: string): Promise<boolean> {
  try {
    return await call<boolean>("fs_exists", { root, rel });
  } catch {
    return false;
  }
}

export async function fsWrite(root: string, rel: string, content: string): Promise<WriteResult> {
  try {
    return await call<WriteResult>("fs_write", { root, rel, content });
  } catch (e) {
    throw new Error(errText(e));
  }
}

/** 拼出给模型看的目录树（深度优先，忽略依赖与构建产物，最多 300 条） */
export async function buildTree(root: string, depth = 2): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  async function walk(dir: string, level: number): Promise<void> {
    if (level > depth || count >= 300) return;
    let entries: FsEntry[];
    try {
      entries = await fsList(dir);
    } catch {
      return; // 无权限的目录直接跳过，不影响整体树
    }
    for (const e of entries) {
      if (count >= 300) return;
      if (e.dir && shouldSkipDir(e.name)) continue;
      count += 1;
      lines.push(treeLine({ name: e.name, path: e.path, dir: e.dir }, level - 1));
      if (e.dir) await walk(e.path, level + 1);
    }
  }

  await walk(root, 1);
  return lines.join("\n");
}
