import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./ui";

interface ComposerProps {
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** 由外部递增，用于把焦点交回输入框 */
  focusSignal: number;
  /** 输入框上方的工具条（技能胶囊），由 App 注入 */
  toolbar?: ReactNode;
}

export function Composer({ value, busy, onChange, onSend, onStop, focusSignal, toolbar }: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 自增高：先置 auto 再按 scrollHeight 收，最高 220px
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  return (
    <div className="composer-wrap">
      {toolbar}
      <form
        className="composer"
        id="composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <textarea
          id="input"
          ref={inputRef}
          rows={1}
          placeholder="给 zxz 发送消息…（Enter 发送，Shift+Enter 换行）"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            } else if (e.key === "Escape") {
              onStop();
            }
          }}
        />
        <div className="composer-actions">
          <button type="button" className="stop-btn" id="btnStop" title="停止生成" hidden={!busy} onClick={onStop}>
            <Icon name="stop" />
          </button>
          <button type="submit" className="send-btn" id="btnSend" title="发送" disabled={busy}>
            <Icon name="send" />
          </button>
        </div>
      </form>
      <p className="composer-hint">zxz 只是一个外壳，回答由你接入的模型生成，请注意甄别</p>
    </div>
  );
}
