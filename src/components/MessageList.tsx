import React, { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { FileWriteResult, Message, Workspace } from "../types";
import { renderMarkdown } from "../lib/md";
import { formatTime } from "../lib/text";
import { parseFileBlocks, stripControl, stripReadLines, type FileBlock } from "../lib/files";
import { Avatar } from "./ui";
import { FileWrites } from "./FileWrites";

function usageText(msg: Message): string {
  if (!msg.usage) return "";
  const p = msg.usage.prompt_tokens ?? msg.usage.input_tokens;
  const c = msg.usage.completion_tokens ?? msg.usage.output_tokens;
  return [p != null ? `${p} in` : null, c != null ? `${c} out` : null].filter(Boolean).join(" · ");
}

const MessageRow = memo(function MessageRow({
  msg,
  onCopy,
  workspace,
  onApply,
}: {
  msg: Message;
  onCopy: (t: string) => void;
  workspace: Workspace | null;
  onApply: (blocks: FileBlock[]) => Promise<FileWriteResult[]>;
}) {
  const usage = usageText(msg);
  const streaming = Boolean(msg.streaming);
  // 流式过程中不解析，避免每帧跑正则；结束后才判断有没有要落盘的文件
  const blocks = useMemo(
    () => (msg.role === "assistant" && !streaming && msg.content ? parseFileBlocks(msg.content) : []),
    [msg.role, streaming, msg.content]
  );
  // 已写进磁盘的回复只留解释文字：代码在文件里，不在这里重复一遍；
  // @@read 是给程序看的指令，任何情况下都不显示
  const body = useMemo(() => {
    if (!msg.content) return "";
    return msg.files?.length ? stripControl(msg.content) : stripReadLines(msg.content);
  }, [msg.content, msg.files]);
  const md = body ? renderMarkdown(body) + (streaming ? '<span class="caret"></span>' : "") : "";

  return (
    <article className={"msg " + msg.role}>
      <div className="msg-head">
        <Avatar role={msg.role} />
        <span className="role-name">{msg.role === "user" ? "你" : "zxz"}</span>
        <span className="msg-time">{formatTime(msg.createdAt || Date.now())}</span>
      </div>
      <div className="msg-body">
        {msg.role === "user" ? (
          <div className="bubble">{msg.content}</div>
        ) : (
          <>
            {msg.reasoning ? (
              <details className="reasoning">
                <summary>已生成思考过程</summary>
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.reasoning) }} />
              </details>
            ) : null}
            {blocks.length ? (
              <FileWrites blocks={blocks} files={msg.files} workspace={workspace} onApply={onApply} />
            ) : null}
            {msg.toolCalls?.length ? (
              <details className="tool-calls">
                <summary>工具调用 {msg.toolCalls.length} 次</summary>
                <ul>
                  {msg.toolCalls.map((tc) => (
                    <li key={tc.id}>
                      <code>{tc.name}</code>
                      {tc.error ? (
                        <span className="tool-error">失败：{tc.error}</span>
                      ) : (
                        <span className="tool-result">{(tc.result || "(无输出)").slice(0, 500)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {msg.error ? (
              <div className="md">
                <blockquote style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{msg.error}</blockquote>
              </div>
            ) : md || streaming ? (
              <div
                className="md"
                dangerouslySetInnerHTML={{
                  __html: md || '<span class="thinking-dots"><i></i><i></i><i></i></span>',
                }}
              />
            ) : null}
          </>
        )}
      </div>
      <div className={"msg-foot" + (streaming ? " hidden" : "")}>
        {msg.role === "assistant" && !streaming && msg.content ? (
          <button className="link-btn" type="button" onClick={() => onCopy(msg.content)}>
            复制
          </button>
        ) : null}
        {usage ? <span>{usage}</span> : null}
        {msg.skills?.length ? <span title="本次加载的技能">技能 {msg.skills.join(" · ")}</span> : null}
        {msg.model ? <span>{msg.model}</span> : null}
      </div>
    </article>
  );
});

interface MessageListProps {
  messages: Message[];
  activeId: string | null;
  onCopy: (text: string) => void;
  workspace: Workspace | null;
  onApply: (blocks: FileBlock[]) => Promise<FileWriteResult[]>;
  /** 供外部（发送、切换会话）触发强制滚到底 */
  scrollSignal: number;
}

export function MessageList({ messages, activeId, onCopy, workspace, onApply, scrollSignal }: MessageListProps) {
  const chatRef = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  const lastSignal = useRef(0);

  const handleScroll = useCallback(() => {
    const el = chatRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }, []);

  // 新消息 / 切换会话 / 发送：强制到底；流式增量：仅在贴近底部时跟随
  useLayoutEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    const force = scrollSignal !== lastSignal.current;
    lastSignal.current = scrollSignal;
    if (force || stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, activeId, scrollSignal]);

  // 代码块复制走事件委托：按钮是 markdown 生成的 HTML，不在 React 树里
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const btn = target.closest(".copy");
      if (!btn) return;
      const block = btn.closest(".code-block") as HTMLElement | null;
      const code = block?.dataset.copyTarget ? document.getElementById(block.dataset.copyTarget) : null;
      if (code) onCopy(code.textContent || "");
    },
    [onCopy]
  );

  return (
    <section className="chat" id="chat" aria-live="polite" ref={chatRef} onScroll={handleScroll} onClick={handleClick}>
      <div className="chat-inner">
        {messages
          .filter((m) => !m.hidden)
          .map((msg, i) => (
            <MessageRow key={`${msg.createdAt}-${i}`} msg={msg} onCopy={onCopy} workspace={workspace} onApply={onApply} />
          ))}
      </div>
    </section>
  );
}
