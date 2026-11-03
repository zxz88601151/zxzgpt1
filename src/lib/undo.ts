/** 撤销栈：读写 `.zxz/undo/<时间戳>/<相对路径>` 快照。
 *
 * 写入时 App 已经把被覆盖文件的旧内容塞进这个目录，这里只负责把它读出来、
 * 列成「什么时候改了什么」，以及把某一版写回去。
 *
 * 恢复本身也是可撤销的：写回之前，当前内容会先被存进一个新的时间戳目录。
 *
 * 工程根目录不经过这里：所有读写都只认 Rust 登记的 sessionId（见 fsapi.ts）。
 */

import { fsExists, fsRead, fsWrite, undoList, undoRead, undoWrite, type FsEntry } from "./fsapi";

export interface UndoFile {
  /** 工程内相对路径，如 `src/main.js` */
  rel: string;
  bytes: number;
}

export interface UndoSnapshot {
  /** `2026-11-01T02-49-32-123`（目录名，UTC、毫秒精度） */
  stamp: string;
  files: UndoFile[];
  /**
   * 这份清单**不完整**：某个子目录列不出来，或者撞上了条数/深度上限。
   *
   * 为什么要这个标记：逐层 `catch` 会把"打不开"吞成"就这么几个文件"，
   * 于是一份残缺的清单看起来和完整的一模一样。用户据此判断"这版没改过某文件"
   * 就会判断错。恢复操作本身不会因此出错（`undo_read` 会明确报错），
   * 所以这不算数据安全问题——但它是**结论正确性**问题，必须说出来。
   */
  incomplete?: boolean;
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

/** 快照目录名 → 人类可读时间（UTC 的 `2026-11-01T02-49-32-123` → 本地 `11-01 10:49:32`） */
export function stampLabel(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?$/.exec(stamp.trim());
  if (!m) return stamp;
  const [, y, mo, d, hh, mm, ss, ms] = m;
  // 目录名是 UTC，界面要显示本地时间，否则会差出时区（本机就是 8 小时）
  const t = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss), ms ? Number(ms) : 0));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

/** 快照文件名 → 生成目录名（毫秒精度：秒级会在同一秒内两次备份时撞车） */
export function stampNow(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

/** 绝对路径 → 相对某个前缀的工程内路径（统一用 /） */
export function relFromAbs(absPath: string, prefixAbs: string): string {
  const prefix = prefixAbs.replace(/[\\/]+$/, "");
  let rel = absPath;
  if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  return rel.replace(/[\\/]+/g, "/").replace(/^\/+/, "");
}

/** 列出所有快照，新的在前；单个快照里按路径排序。
 *
 * 走 `undo_list` 专用通道：模型的 `list_dir` 对 `.zxz/undo` 已关闭，
 * 因为它会泄漏「用户什么时候改过哪些文件」的操作轨迹。
 */
export async function listUndo(sessionId: string): Promise<UndoSnapshot[]> {
  // 目录不存在时 Rust 侧返回空数组（还没覆盖过任何文件，正常情况）；
  // 存在却列不出来会抛错——不能都吞成空，那会让界面显示「没有快照」。
  const top = await undoList(sessionId, null, "");
  const snapshots: UndoSnapshot[] = [];
  for (const dir of top.filter((e) => e.dir)) {
    const files: UndoFile[] = [];
    const complete = await walk(sessionId, dir.name, "", files, 0);
    const snap: UndoSnapshot = { stamp: dir.name, files: files.sort((x, y) => x.rel.localeCompare(y.rel)) };
    if (!complete) snap.incomplete = true;
    snapshots.push(snap);
  }
  return snapshots.sort((x, y) => y.stamp.localeCompare(x.stamp));

  /**
   * rel 是相对快照目录（`.zxz/undo/<stamp>`）的路径，空串表示快照根。
   *
   * 返回 false 表示「这份清单不完整」：子目录打不开，或者到了条数/深度上限。
   * 不再静默 `return`——那会让残缺的列表看起来是完整的。
   */
  async function walk(
    sid: string,
    stamp: string,
    rel: string,
    out: UndoFile[],
    depth: number
  ): Promise<boolean> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return false;
    let entries: FsEntry[];
    try {
      entries = await undoList(sid, stamp, rel);
    } catch {
      return false;
    }
    let complete = true;
    for (const e of entries) {
      if (out.length >= MAX_FILES) return false;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.dir) {
        if (!(await walk(sid, stamp, childRel, out, depth + 1))) complete = false;
      } else {
        out.push({ rel: childRel, bytes: e.size });
      }
    }
    return complete;
  }
}

/** 读某一版备份的正文 */
export async function readUndoFile(sessionId: string, stamp: string, rel: string): Promise<string> {
  return undoRead(sessionId, stamp, rel);
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
