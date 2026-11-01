import { useCallback, useEffect, useMemo, useState } from "react";
import { fsList, fsMkdir, fsRoots, type FsEntry } from "../lib/fsapi";
import { Icon } from "./ui";

interface FolderPickerProps {
  open: boolean;
  /** 当前已选目录（可能为空） */
  current: string | null;
  /** 弹层标题，工程目录与技能库共用这个组件 */
  title?: string;
  confirmText?: string;
  clearText?: string;
  onClose: () => void;
  onPick: (path: string, name: string) => void;
  onClear: () => void;
}

/** 把 `F:\a\b` 拆成可点的面包屑 */
function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = "";
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    acc = acc ? acc + "\\" + seg : seg;
    if (i === 0 && /^[a-zA-Z]:$/.test(seg)) acc = seg + "\\";
    out.push({ label: seg, path: acc });
  }
  return out;
}

function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed || /^[a-zA-Z]:$/.test(trimmed)) return null;
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  return /^[a-zA-Z]:$/.test(parent) ? parent + "\\" : parent;
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || path;
}

export function FolderPicker({
  open,
  current,
  title = "选择工程文件夹",
  confirmText = "使用此文件夹",
  clearText = "退出工程模式",
  onClose,
  onPick,
  onClear,
}: FolderPickerProps) {
  const [path, setPath] = useState<string>(current || "");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 新建文件夹：这里独立一套状态，出错时不把列表的错误位顶掉
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newErr, setNewErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError("");
    try {
      const list = await fsList(target);
      setEntries(list);
      setPath(target);
    } catch (e) {
      setEntries([]);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setNewName("");
    setNewErr("");
  }, []);

  /** 建在当前目录下，成功后直接进到新目录（用户下一步多半就是要选它） */
  const submitCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || busy || !path) return;
    setBusy(true);
    setNewErr("");
    try {
      const created = await fsMkdir(path, name);
      setCreating(false);
      setNewName("");
      await load(created);
    } catch (e) {
      setNewErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, newName, path, load]);

  useEffect(() => {
    if (!open) return;
    setCreating(false);
    setNewName("");
    setNewErr("");
    let alive = true;
    (async () => {
      try {
        const roots = await fsRoots();
        if (!alive) return;
        setDrives(roots);
        const start = current || roots[0] || "";
        if (start) await load(start);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, current, load]);

  const trail = useMemo(() => (path ? crumbs(path) : []), [path]);
  const up = path ? parentOf(path) : null;

  if (!open) return null;

  const confirmPick = () => {
    if (!path) return;
    onPick(path, baseName(path));
  };

  return (
    <div className="modal-scrim" id="folderPicker" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" type="button" title="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="fp-drives">
          {drives.map((d) => (
            <button
              key={d}
              type="button"
              className={"fp-drive" + (path.startsWith(d) ? " on" : "")}
              onClick={() => void load(d)}
            >
              {d}
            </button>
          ))}
        </div>

        <div className="fp-path">
          <button className="icon-btn" type="button" title="上一级" disabled={!up} onClick={() => up && void load(up)}>
            <Icon name="up" />
          </button>
          <div className="fp-crumbs">
            {trail.map((c, i) => (
              <button key={c.path} type="button" className="fp-crumb" onClick={() => void load(c.path)}>
                {c.label}
                {i < trail.length - 1 ? <span className="fp-sep">›</span> : null}
              </button>
            ))}
          </div>
        </div>

        {creating ? (
          <div className="fp-new" id="fpNewRow">
            <div className="fp-new-line">
              <Icon name="folder" size={13} />
              <input
                id="fpNewName"
                autoFocus
                value={newName}
                placeholder="新文件夹名称（建在当前目录下）"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (newErr) setNewErr("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitCreate();
                  } else if (e.key === "Escape") {
                    // 只关新建这一行，别把整个选择器一起关掉
                    e.stopPropagation();
                    cancelCreate();
                  }
                }}
              />
              <button
                className="btn primary small"
                id="fpNewOk"
                type="button"
                disabled={!newName.trim() || busy}
                onClick={() => void submitCreate()}
              >
                {busy ? "创建中…" : "创建"}
              </button>
              <button className="btn ghost small" id="fpNewCancel" type="button" onClick={cancelCreate}>
                取消
              </button>
            </div>
            {newErr ? (
              <p className="fp-error" id="fpNewErr">
                {newErr}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="fp-list" id="fpList">
          {loading ? <p className="fp-hint">读取中…</p> : null}
          {error ? <p className="fp-error">{error}</p> : null}
          {!loading && !error && entries.length === 0 ? <p className="fp-hint">这个文件夹是空的</p> : null}
          {entries.map((e) =>
            e.dir ? (
              <button key={e.path} type="button" className="fp-row dir" onClick={() => void load(e.path)}>
                <Icon name="folder" />
                <span>{e.name}</span>
              </button>
            ) : (
              <div key={e.path} className="fp-row file" title={e.path}>
                <Icon name="file" />
                <span>{e.name}</span>
              </div>
            )
          )}
        </div>

        <footer className="modal-foot">
          <div className="fp-target" title={path}>
            {path || "未选择"}
          </div>
          {current ? (
            <button className="btn ghost" id="fpClear" type="button" onClick={onClear}>
              {clearText}
            </button>
          ) : null}
          <button
            className="btn ghost"
            id="fpNewDir"
            type="button"
            title="在当前目录下新建一个文件夹"
            disabled={!path || creating}
            onClick={() => {
              setCreating(true);
              setNewErr("");
            }}
          >
            新建文件夹
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" id="fpConfirm" type="button" disabled={!path} onClick={confirmPick}>
            {confirmText}
          </button>
        </footer>
      </div>
    </div>
  );
}
