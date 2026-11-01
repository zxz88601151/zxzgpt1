import { useState } from "react";
import { countLines, relPathError, type FileBlock } from "../lib/files";
import { fsRead } from "../lib/fsapi";
import type { FileWriteResult, Workspace } from "../types";
import { DiffModal } from "./DiffModal";

interface FileWritesProps {
  blocks: FileBlock[];
  /** 已经自动落盘的结果（来自消息，刷新后仍在） */
  files?: FileWriteResult[];
  workspace: Workspace | null;
  onApply: (blocks: FileBlock[]) => Promise<FileWriteResult[]>;
}

function kb(bytes?: number): string {
  if (!bytes) return "";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** `+12 −3`；新建文件只有 +N */
function changeText(r: FileWriteResult): string {
  const add = r.add || 0;
  const del = r.del || 0;
  if (!add && !del) return "";
  return [add ? `+${add}` : "", del ? `−${del}` : ""].filter(Boolean).join(" ");
}

/**
 * 回复里 file: 块的落盘结果。
 * 有工程目录时程序已经自动写完，这里只是回执（代码正文不再堆在对话框里）；
 * 点任意一行可以看「覆盖前 vs 现在」的差异。
 */
export function FileWrites({ blocks, files, workspace, onApply }: FileWritesProps) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [extra, setExtra] = useState<FileWriteResult[] | null>(null);
  const [diff, setDiff] = useState<{ path: string; oldText: string; newText: string; note?: string } | null>(null);

  const results = files ?? extra;
  const okList = results ? results.filter((r) => r.ok) : [];
  const failList = results ? results.filter((r) => !r.ok) : [];
  const retryable = failList.filter((r) => relPathError(r.path) === null);

  const run = async () => {
    if (!workspace || running) return;
    const valid = blocks.filter((b) => relPathError(b.path) === null);
    if (!valid.length) return;
    setRunning(true);
    try {
      setExtra(await onApply(valid));
    } finally {
      setRunning(false);
    }
  };

  /** 点文件：旧版读快照，新版读磁盘（不是读内存字符串，看到的才是真文件） */
  const openDiff = async (rel: string, r?: FileWriteResult) => {
    if (!workspace) return;
    let newText = "";
    let note = "";
    try {
      newText = await fsRead(workspace.root, rel);
    } catch (e) {
      note = "读不到磁盘上的这个文件：" + (e as Error).message;
    }

    if (!r) {
      setDiff({ path: rel, oldText: "", newText, note: note || "这个文件没有写入回执，下面是它当前的内容。" });
      return;
    }
    if (!r.backup) {
      setDiff({
        path: rel,
        oldText: "",
        newText,
        note: r.created ? "新文件，之前磁盘上没有它。" : "覆盖前的快照没存下来，只能看到现在的内容。",
      });
      return;
    }
    try {
      const oldText = await fsRead(workspace.root, r.backup);
      setDiff({ path: rel, oldText, newText, note });
    } catch (e) {
      setDiff({ path: rel, oldText: "", newText, note: "快照读取失败：" + (e as Error).message });
    }
  };

  return (
    <div className="file-writes" id="fileWrites">
      <div className="fa-head">
        <span className="fa-title">
          {results ? (
            <>
              已写入 <b>{okList.length}</b> 个文件
              {failList.length ? (
                <>
                  ，<b>{failList.length}</b> 个失败
                </>
              ) : null}
            </>
          ) : (
            <>
              这份回复包含 <b>{blocks.length}</b> 个文件
            </>
          )}
        </span>
        <button className="link-btn" type="button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "文件列表"}
        </button>
        <div className="spacer" />
        {results ? (
          <span className={"fa-status " + (failList.length ? "bad" : "good")} id="faStatus">
            {failList.length ? "有失败项" : `已落盘 · ${workspace ? workspace.name : ""}`}
          </span>
        ) : (
          <span className="fa-status bad" id="faStatus">
            {workspace ? "未写入" : "未选工程目录"}
          </span>
        )}
        {retryable.length > 0 && workspace ? (
          <button className="btn primary small" id="btnApplyFiles" type="button" disabled={running} onClick={() => void run()}>
            {running ? "写入中…" : "重试"}
          </button>
        ) : null}
      </div>

      {!workspace && !results ? (
        <p className="fa-warn">选择工程文件夹后，模型给出的文件会直接写进磁盘，不再只显示在对话里。</p>
      ) : null}

      {expanded ? (
        <ul className="fa-list">
          {blocks.map((b) => {
            const bad = relPathError(b.path);
            const r = results?.find((x) => x.path === b.path);
            const change = r ? changeText(r) : "";
            const meta =
              bad || (r && !r.ok ? r.error : r ? `${r.created ? "新建" : "覆盖"} · ${kb(r.bytes)}` : `${countLines(b.content)} 行`);
            return (
              <li key={b.path} className={bad || (r && !r.ok) ? "bad" : ""}>
                <button
                  className="fa-open"
                  type="button"
                  disabled={!workspace || Boolean(bad) || Boolean(r && !r.ok)}
                  title={workspace ? "看这个文件改了什么" : "选工程目录后可查看差异"}
                  onClick={() => void openDiff(b.path, r)}
                >
                  <code>{b.path}</code>
                </button>
                {change ? <span className={"fa-diff" + (r && r.del ? " has-del" : "")}>{change}</span> : null}
                <span className="fa-meta">{meta}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <DiffModal
        open={Boolean(diff)}
        path={diff?.path || ""}
        oldText={diff?.oldText || ""}
        newText={diff?.newText || ""}
        note={diff?.note}
        onClose={() => setDiff(null)}
      />
    </div>
  );
}
