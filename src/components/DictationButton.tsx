import { useEffect, useRef, useState } from "react";
import { dictationErrorMessage, dictationNextStatus, isSpeechRecognitionAvailable, type DictationStatus } from "../lib/dictation";
import { Icon } from "./ui";

interface DictationButtonProps {
  disabled?: boolean;
  /** 最终转录（只在用户松手、识别出完整一句时回调一次，不自动发送） */
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

/** 听写按钮：按住说话、松手结束。转录只回调给父组件填进输入框，不在这里发送。 */
export function DictationButton({ disabled, onTranscript, onError }: DictationButtonProps) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const recogRef = useRef<unknown | null>(null);
  const supported = isSpeechRecognitionAvailable();

  useEffect(() => {
    return () => {
      const r = recogRef.current as { stop?: () => void } | null;
      try {
        r?.stop?.();
      } catch {
        // 卸载时停录音失败不影响主流程
      }
    };
  }, []);

  const start = () => {
    if (disabled || status !== "idle") return;
    if (!supported) {
      onError("当前浏览器不支持语音识别，请用 Chrome 系浏览器打开，或手动输入");
      return;
    }
    const w = window as unknown as Record<string, new () => unknown>;
    const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition) as new () => Record<string, unknown>;
    const recog = new Ctor() as {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: ((e: unknown) => void) | null;
      onerror: ((e: { error?: string }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    recog.lang = "zh-CN";
    recog.interimResults = false;
    recog.continuous = false;
    recog.onresult = (e) => {
      const ev = e as { results?: Array<Array<{ transcript?: string }>> };
      const text = (ev.results || []).map((r) => r[0]?.transcript || "").join("").trim();
      if (text) onTranscript(text);
    };
    recog.onerror = (e) => {
      setStatus(dictationNextStatus(status, "error"));
      onError(dictationErrorMessage(e.error || ""));
    };
    recog.onend = () => {
      setStatus(dictationNextStatus("recording", "end"));
    };
    recogRef.current = recog;
    try {
      recog.start();
      setStatus(dictationNextStatus("idle", "start"));
    } catch {
      setStatus("idle");
      onError("语音识别启动失败，请检查麦克风权限后重试");
    }
  };

  const stop = () => {
    const r = recogRef.current as { stop?: () => void } | null;
    try {
      r?.stop?.();
    } catch {
      // 松手时停录音失败时 onend 仍会把状态带回 idle
    }
    setStatus(dictationNextStatus(status, "stop"));
  };

  if (status === "recording") {
    return (
      <button type="button" className="mic-btn recording" title="松手结束听写，转录只填进输入框、不自动发送" onMouseUp={stop} onTouchEnd={stop} onClick={stop}>
        <Icon name="mic" /> 录音中…
      </button>
    );
  }
  return (
    <button type="button" className="mic-btn" title="按住说话，松手后转录填进输入框（浏览器语音识别需联网，不是离线识别）" disabled={disabled} onMouseDown={start} onTouchStart={start} onClick={start}>
      <Icon name="mic" />
    </button>
  );
}
