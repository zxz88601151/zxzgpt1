import { useMemo } from "react";
import { collapseContext, diffBadge, diffLines, type DiffLine } from "../lib/diff";
import { Icon } from "./ui";

export interface DiffModalProps {
  open: boolean;
  /** 文件相对路径，显示在标题上 */
  path: string;
  oldText: string;
  newText: string;
  /** 没有上一版快照之类的说明 */
  note?: string;
  onClose: () => void;
}

const MAX_ROWS = 4000;

/** 只读的红绿对比：磁盘那一版 vs 现在这一版 */
export function DiffModal({ open, path, oldText, newText, note, onClose }: DiffModalProps) {
  const { rows, badge, truncated } = useMemo(() => {
    const lines = diffLines(oldText, newText);
    const collapsed = collapseContext(lines, 3);
    return {
      rows: collapsed.slice(0, MAX_ROWS),
      badge: diffBadge(lines),
      truncated: collapsed.length > MAX_ROWS,
    };
  }, [oldText, newText]);

  if (!open) return null;

  return (
    <div
      className="modal-scrim"
      id="diffModal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal diff-modal" role="dialog" aria-label="文件差异">
        <header className="modal-head">
          <h2 className="diff-path" title={path}>
            {path}
          </h2>
          <span className={"diff-badge" + (badge ? "" : " zero")}>{badge || "无改动"}</span>
          <button className="icon-btn" type="button" title="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="diff-body" id="diffBody">
          {note ? <p className="diff-note">{note}</p> : null}
          {rows.length === 0 ? <p className="diff-note">两边都是空文件。</p> : null}
          {rows.map((row, i) =>
            row.type === "gap" ? (
              <div key={"gap" + i} className="diff-line gap">
                <span className="ln" />
                <span className="ln" />
                <span className="sign" />
                <code>… {row.count} 行未改动 …</code>
              </div>
            ) : (
              <div key={i} className={"diff-line " + (row as DiffLine).type}>
                <span className="ln">{row.a ?? ""}</span>
                <span className="ln">{row.b ?? ""}</span>
                <span className="sign">{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
                <code>{row.text || " "}</code>
              </div>
            )
          )}
          {truncated ? <p className="diff-note">差异超过 {MAX_ROWS} 行，只显示前半部分。</p> : null}
        </div>

        <footer className="modal-foot">
          <span className="diff-legend">
            <i className="lg del" /> 磁盘原内容
            <i className="lg add" /> 现在的内容
          </span>
          <div className="spacer" />
          <button className="btn primary" type="button" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
