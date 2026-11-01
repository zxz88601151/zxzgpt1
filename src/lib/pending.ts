/** 写入前确认：把模型给的文件块先变成“待批清单”，人批了才落盘。
 *
 * 纯逻辑，不碰 IPC：旧内容由调用方在弹面板前读好传进来，这样面板里看到的
 * 差异和最终写入时的旧内容来自同一份快照，不会在中间被别的写入悄悄换掉。
 * 注意：这一步只决定“写不写”，真正的路径校验与落盘仍在 Rust 侧 fsx.rs。
 */

import type { FileBlock } from "./files";

export interface PendingWrite {
  path: string;
  content: string;
  /** 磁盘上的旧内容；新建文件为空串 */
  oldText: string;
  created: boolean;
}

export function buildPendingWrites(blocks: FileBlock[], olds: Map<string, string>): PendingWrite[] {
  return blocks.map((b) => {
    const oldText = olds.get(b.path) ?? "";
    return { path: b.path, content: b.content, oldText, created: !olds.has(b.path) };
  });
}

/** 面板里默认全勾选：人只把不想写的去掉，而不是一个个点允许 */
export function defaultSelected(items: PendingWrite[]): Set<string> {
  return new Set(items.map((it) => it.path));
}
