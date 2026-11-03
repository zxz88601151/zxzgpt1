/** 撤销栈：读写 `.zxz/undo/<时间戳>/<相对路径>` 快照。
 *
 * 写入时 App 已经把被覆盖文件的旧内容塞进这个目录，这里只负责把它读出来、
 * 列成「什么时候改了什么」，以及把某一版写回去。
 *
 * 恢复本身也是可撤销的：写回之前，当前内容会先被存进一个新的时间戳目录。
 *
 * 工程根目录不经过这里：所有读写都只认 Rust 登记的 sessionId（见 fsapi.ts）。
 */

import { UNDO_DIR } from "./files";
import { fsExists, fsListIn, fsRead, fsWrite, undoWrite, type FsEntry } from "./fsapi";

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

/** 快照目录在工程内的相对路径前缀 */
const UNDO_PREFIX = `${UNDO_DIR}/`;

/** 列出所有快照，新的在前；单个快照里按路径排序 */
export async function listUndo(sessionId: string): Promise<UndoSnapshot[]> {
  // 目录不存在是正常情况（还没覆盖过任何文件）；存在却列不出来是真故障。
  // 旧实现把这两种都 `catch` 成空数组，界面就显示「没有快照」——
  // 用户会以为备份不存在，而实际上可能是权限或会话出了问题。
  const hasUndo = await fsExists(sessionId, UNDO_DIR);
  if (!hasUndo) return [];
  const top = await fsListIn(sessionId, UNDO_DIR);

  const snapshots: UndoSnapshot[] = [];
  for (const dir of top.filter((e) => e.dir)) {
    const files: UndoFile[] = [];
    const base = `${UNDO_PREFIX}${dir.name}`;
    await walk(sessionId, base, base, files, 0);
    snapshots.push({ stamp: dir.name, files: files.sort((x, y) => x.rel.localeCompare(y.rel)) });
  }
  return snapshots.sort((x, y) => y.stamp.localeCompare(x.stamp));

  /** base 是快照目录（`.zxz/undo/<时间戳>`），out 里的 rel 都是相对它的工程内路径 */
  async function walk(sid: string, base: string, dirRel: string, out: UndoFile[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: FsEntry[];
    try {
      entries = await fsListIn(sid, dirRel);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const rel = `${dirRel}/${e.name}`;
      if (e.dir) {
        await walk(sid, base, rel, out, depth + 1);
      } else {
        out.push({ rel: rel.slice(base.length + 1), bytes: e.size });
      }
    }
  }
}

/** 读某一版备份的正文 */
export async function readUndoFile(sessionId: string, stamp: string, rel: string): Promise<string> {
  return fsRead(sessionId, `${UNDO_DIR}/${stamp}/${rel}`);
}

export interface RestoreResult {
  /** 恢复前当前内容被存到了哪个快照（当前文件不存在时为 null） */
  safety: string | null;
  bytes: number;
}

/**
 * 把某个文件的某一版写回去。
 * 写之前先把当前内容再备份一份，所以「恢复」本身也能再恢复。
 *
 * 备份失败必须抛错中止，不能沿用旧的「读不到就跳过」：
 * 旧写法在一个 5MB 文件上（超过读取上限）会静默跳过备份，然后照样覆盖——
 * 用户看到「已恢复」，实际这次恢复不可撤销。恢复是一条数据改写操作，
 * 它的失败语义必须和写入一致：拿不到可回滚点，就不动手。
 */
export async function restoreUndo(sessionId: string, stamp: string, rel: string): Promise<RestoreResult> {
  const content = await readUndoFile(sessionId, stamp, rel);

  // 「确认不存在」与「校验失败」必须分开：后者意味着我们根本不知道当前状态
  let exists: boolean;
  try {
    exists = await fsExists(sessionId, rel);
  } catch (e) {
    throw new Error(`无法确认当前文件状态，已中止恢复：${(e as Error).message}`);
  }

  let safety: string | null = null;
  if (exists) {
    let current: string;
    try {
      current = await fsRead(sessionId, rel);
    } catch (e) {
      throw new Error(`当前内容读不出来（二进制或超过 4MB），恢复将不可撤销，已中止：${(e as Error).message}`);
    }
    const now = stampNow();
    try {
      // 专用通道：普通 fsWrite 拒绝 .zxz/undo，模型不可达
      await undoWrite(sessionId, now, rel, current);
    } catch (e) {
      throw new Error(`恢复前的备份没有写成，已中止恢复：${(e as Error).message}`);
    }
    safety = now;
  }

  const r = await fsWrite(sessionId, rel, content);
  return { safety, bytes: r.bytes };
}
