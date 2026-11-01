/** 撤销栈：读写 `.zxz/undo/<时间戳>/<相对路径>` 快照。
 *
 * 写入时 App 已经把被覆盖文件的旧内容塞进这个目录，这里只负责把它读出来、
 * 列成「什么时候改了什么」，以及把某一版写回去。
 *
 * 恢复本身也是可撤销的：写回之前，当前内容会先被存进一个新的时间戳目录。
 */

import { UNDO_DIR } from "./files";
import { fsList, fsRead, fsWrite, type FsEntry } from "./fsapi";

export interface UndoFile {
  /** 工程内相对路径，如 `src/main.js` */
  rel: string;
  bytes: number;
}

export interface UndoSnapshot {
  /** `2026-11-01T02-49-32`（目录名） */
  stamp: string;
  files: UndoFile[];
}

const MAX_FILES = 400;
const MAX_DEPTH = 8;

/** 目录分隔符跟着 root 走：Windows 用反斜杠，类 Unix 用斜杠 */
export function sepOf(root: string): string {
  return root.includes("\\") ? "\\" : "/";
}

export function joinPath(root: string, ...parts: string[]): string {
  const sep = sepOf(root);
  const head = root.replace(/[\\/]+$/, "");
  return [head, ...parts].join(sep);
}

export function undoRootOf(root: string): string {
  return joinPath(root, ".zxz", "undo");
}

/** 快照目录名 → 人类可读时间（`2026-11-01T02-49-32` → `11-01 02:49:32`） */
export function stampLabel(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(stamp.trim());
  if (!m) return stamp;
  const [, , month, day, hh, mm, ss] = m;
  return `${month}-${day} ${hh}:${mm}:${ss}`;
}

/** 快照文件名 → 生成目录名 */
export function stampNow(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** 绝对路径 → 相对某个前缀的工程内路径（统一用 /） */
export function relFromAbs(absPath: string, prefixAbs: string): string {
  const prefix = prefixAbs.replace(/[\\/]+$/, "");
  let rel = absPath;
  if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  return rel.replace(/[\\/]+/g, "/").replace(/^\/+/, "");
}

/** 列出所有快照，新的在前；单个快照里按路径排序 */
export async function listUndo(root: string): Promise<UndoSnapshot[]> {
  const base = undoRootOf(root);
  let top: FsEntry[];
  try {
    top = await fsList(base);
  } catch {
    return []; // 还没写过任何文件时目录不存在，正常情况
  }

  const snapshots: UndoSnapshot[] = [];
  for (const dir of top.filter((e) => e.dir)) {
    const files: UndoFile[] = [];
    await walk(dir.path, dir.path, files, 0);
    snapshots.push({ stamp: dir.name, files: files.sort((x, y) => x.rel.localeCompare(y.rel)) });
  }
  return snapshots.sort((x, y) => y.stamp.localeCompare(x.stamp));

  async function walk(path: string, stampPath: string, out: UndoFile[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: FsEntry[];
    try {
      entries = await fsList(path);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.dir) {
        await walk(e.path, stampPath, out, depth + 1);
      } else {
        out.push({ rel: relFromAbs(e.path, stampPath), bytes: e.size });
      }
    }
  }
}

/** 读某一版备份的正文 */
export async function readUndoFile(root: string, stamp: string, rel: string): Promise<string> {
  return fsRead(root, `${UNDO_DIR}/${stamp}/${rel}`);
}

export interface RestoreResult {
  /** 恢复前当前内容被存到了哪个快照（当前文件不存在时为 null） */
  safety: string | null;
  bytes: number;
}

/**
 * 把某个文件的某一版写回去。
 * 写之前先把当前内容再备份一份，所以「恢复」本身也能再恢复。
 */
export async function restoreUndo(root: string, stamp: string, rel: string): Promise<RestoreResult> {
  const content = await readUndoFile(root, stamp, rel);

  let safety: string | null = null;
  try {
    const current = await fsRead(root, rel);
    const now = stampNow();
    await fsWrite(root, `${UNDO_DIR}/${now}/${rel}`, current);
    safety = now;
  } catch {
    // 当前文件不存在（比如它在别的分支被删了）就没有可备份的东西
  }

  const r = await fsWrite(root, rel, content);
  return { safety, bytes: r.bytes };
}
