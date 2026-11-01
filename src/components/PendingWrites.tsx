import { useEffect, useMemo, useState } from "react";

import { diffBadge, diffLines } from "../lib/diff";
import type { PendingWrite } from "../lib/pending";
import { defaultSelected } from "../lib/pending";
import { DiffModal } from "./DiffModal";

export interface PendingWritesProps {
  /** null = 面板关闭；非 null = 正在等这一批的批复，发送流程会挂起 */
  items: PendingWrite[] | null;
  onApprove: (approved: PendingWrite[]) => void;
  onDiscard: () => void;
}

/** 写入前确认面板：先看差异，批了才写盘；关不掉，只能选“写勾选的”或“全部放弃” */
export function PendingWrites({ items, onApprove, onDiscard }: PendingWritesProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [diffPath, setDiffPath] = useState<string | null>(null);

  useEffect(() => {
    if (items) setSelected(defaultSelected(items));
  }, [items]);

  const diffItem = useMemo(() => items?.find((it) => it.path === diffPath) ?? null, [items, diffPath]);

  if (!items) return null;

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const approved = items.filter((it) => selected.has(it.path));

  return (
    <div className="modal-scrim" id="pendingWrites">
      <div className="modal diff-modal" role="dialog" aria-label="确认写入">
        <header className="modal-head">
          <h2>确认写入（{items.length} 个文件）</h2>
          <span className="diff-note">模型已给出改动，还没落盘。勾选的才会写，放弃则本轮一个都不写。</span>
        </header>

        <div className="diff-body">
          {items.map((it) => {
            const badge = diffBadge(diffLines(it.oldText, it.content));
            return (
              <label key={it.path} className="pending-row">
                <input type="checkbox" checked={selected.has(it.path)} onChange={() => toggle(it.path)} />
                <span className="pending-path" title={it.path}>
                  {it.path}
                </span>
                <span className="pending-meta">
                  {it.created ? "新建" : "覆盖"} · {badge || "无改动"}
                </span>
                <button className="ghost-btn" type="button" onClick={() => setDiffPath(it.path)}>
                  看差异
                </button>
              </label>
            );
          })}
        </div>

        <footer className="modal-foot">
          <button className="btn" type="button" onClick={onDiscard}>
            全部放弃
          </button>
          <div className="spacer" />
          <button
            className="btn primary"
            type="button"
            disabled={!approved.length}
            onClick={() => onApprove(approved)}
          >
            写入勾选的 {approved.length} 个
          </button>
        </footer>
      </div>

      <DiffModal
        open={Boolean(diffItem)}
        path={diffItem?.path ?? ""}
        oldText={diffItem?.oldText ?? ""}
        newText={diffItem?.content ?? ""}
        note={diffItem?.created ? "新建文件，左边为空。" : undefined}
        onClose={() => setDiffPath(null)}
      />
    </div>
  );
}
