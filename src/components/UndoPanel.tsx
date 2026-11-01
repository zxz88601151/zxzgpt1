import { useCallback, useEffect, useState } from "react";
import { fsRead } from "../lib/fsapi";
import { listUndo, readUndoFile, restoreUndo, stampLabel, type UndoSnapshot } from "../lib/undo";
import { DiffModal } from "./DiffModal";
import { Icon } from "./ui";

interface UndoPanelProps {
  open: boolean;
  root: string | null;
  onClose: () => void;
  /** 恢复成功后通知外层（刷新目录树 + toast） */
  onRestored: (text: string) => void;
}

interface DiffState {
  path: string;
  oldText: string;
  newText: string;
  note?: string;
}

/** 撤销栈：每次模型覆盖文件前的旧内容都在这，看差异 / 恢复某一版 */
export function UndoPanel({ open, root, onClose, onRestored }: UndoPanelProps) {
  const [snaps, setSnaps] = useState<UndoSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    setError("");
    try {
      const list = await listUndo(root);
      setSnaps(list);
      setOpened(list[0]?.stamp ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    if (!open || !root) return;
    void load();
  }, [open, root, load]);

  const showDiff = async (snap: UndoSnapshot, rel: string) => {
    if (!root) return;
    setBusy("diff:" + rel);
    try {
      const oldText = await readUndoFile(root, snap.stamp, rel);
      let newText = "";
      let note = "";
      try {
        newText = await fsRead(root, rel);
      } catch {
        note = "这个文件现在已经不在磁盘上了，下面只有旧版内容。";
      }
      setDiff({ path: `${rel} · ${stampLabel(snap.stamp)}`, oldText, newText, note });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const doRestore = async (snap: UndoSnapshot, rel: string) => {
    if (!root) return;
    const ok = window.confirm(
      `把 ${rel} 恢复到 ${stampLabel(snap.stamp)} 这一版？\n\n当前内容会先存进一个新的快照，恢复错了还能再退回来。`
    );
    if (!ok) return;
    setBusy("restore:" + rel);
    try {
      const r = await restoreUndo(root, snap.stamp, rel);
      onRestored(`已恢复 ${rel}（${r.bytes} 字节${r.safety ? "，当前版本已备份" : ""}）`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (!open) return null;

  return (
    <>
    <div
      className="modal-scrim"
      id="undoPanel"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal undo-modal" role="dialog" aria-label="写入历史">
        <header className="modal-head">
          <h2>写入历史</h2>
          <span className="undo-sub">{snaps.length ? `共 ${snaps.length} 次快照` : ""}</span>
          <button className="icon-btn" type="button" title="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="undo-body" id="undoBody">
          {loading ? <p className="fp-hint">读取中…</p> : null}
          {error ? <p className="fp-error">{error}</p> : null}
          {!loading && !error && snaps.length === 0 ? (
            <p className="fp-hint">还没有历史。模型第一次覆盖你的文件时，旧内容会出现在这里。</p>
          ) : null}

          {snaps.map((snap) => {
            const openNow = opened === snap.stamp;
            return (
              <section key={snap.stamp} className="undo-snap">
                <button
                  type="button"
                  className={"undo-snap-head" + (openNow ? " on" : "")}
                  onClick={() => setOpened(openNow ? null : snap.stamp)}
                >
                  <Icon name="history" size={13} />
                  <span className="undo-stamp">{stampLabel(snap.stamp)}</span>
                  <span className="undo-count">{snap.files.length} 个文件</span>
                </button>
                {openNow ? (
                  <ul className="undo-files">
                    {snap.files.map((f) => (
                      <li key={f.rel}>
                        <code>{f.rel}</code>
                        <span className="fa-meta">{Math.max(1, Math.round(f.bytes / 1024))} KB</span>
                        <div className="spacer" />
                        <button
                          className="link-btn"
                          type="button"
                          disabled={busy !== ""}
                          onClick={() => void showDiff(snap, f.rel)}
                        >
                          {busy === "diff:" + f.rel ? "读取中…" : "看差异"}
                        </button>
                        <button
                          className="link-btn"
                          type="button"
                          disabled={busy !== ""}
                          onClick={() => void doRestore(snap, f.rel)}
                        >
                          {busy === "restore:" + f.rel ? "恢复中…" : "恢复这一版"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>

        <footer className="modal-foot">
          <span className="undo-hint">快照在工程目录的 .zxz/undo 下，可直接删除。</span>
          <div className="spacer" />
          <button className="btn ghost" type="button" onClick={() => void load()} disabled={loading}>
            刷新
          </button>
          <button className="btn primary" type="button" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>

      <DiffModal
        open={Boolean(diff)}
        path={diff?.path || ""}
        oldText={diff?.oldText || ""}
        newText={diff?.newText || ""}
        note={diff?.note}
        onClose={() => setDiff(null)}
      />
    </>
  );
}
