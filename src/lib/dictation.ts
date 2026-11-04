/** 听写助手 V1：按住说话，转文字后填进输入框，不自动发送。
 *
 * 设计约束（别顺手放宽）：
 * 1) 本批只接浏览器语音识别（Web Speech API）：它在 Chrome/WebView 里是把音频
 *    发给浏览器厂商的云服务转录的，不是离线识别。界面和文档必须明说这一点，
 *    不能把“本地听写”四个字贴在它身上。真正的离线 Whisper 是 V1b，单独一题，
 *    需要 Rust 侧接 whisper-rs + 模型下载，本批不假装它已经有了。
 * 2) 只产文本，不产动作：转录结果只进输入框，绝不直接当成用户消息发送，
 *    更不直接触发任何工具、写入或命令。用户改完、自己点发送才生效。
 * 3) 转录失败不阻断主流程：只 toast 报错，输入框里的原有文字原样保留。
 *
 * 本文件是对 48fe069 重做的 V1（2026-11-02 的 0.4.0 批未合入本线，故不叠旧补丁）。
 */

export type DictationStatus = "idle" | "recording" | "unsupported";

/** 浏览器有没有语音识别可用（Chrome 系的 SpeechRecognition / webkit 前缀）。 */
export function isSpeechRecognitionAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof w.SpeechRecognition === "function" || typeof w.webkitSpeechRecognition === "function";
}

/** 把转录文本拼进输入框：已有文字时补一个空格隔开，空转录原样返回。 */
export function appendTranscript(input: string, transcript: string): string {
  const clean = cleanTranscript(transcript);
  if (!clean) return input;
  if (!input) return clean;
  return input.endsWith(" ") || input.endsWith("\n") ? input + clean : input + " " + clean;
}

/** 转录文本清洗：只做空白归一，不改词、不补标点、不猜意思。 */
export function cleanTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 浏览器语音识别的错误码翻译成一句人话，别的错误原样返回。 */
export function dictationErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风或语音识别被浏览器拒绝了，请在浏览器设置里允许本站使用麦克风";
    case "no-speech":
      return "没听到说话，录音已停止，输入框里的文字没有动";
    case "audio-capture":
      return "找不到麦克风或麦克风被别的程序占用了";
    case "network":
      return "浏览器语音识别需要联网（音频发给浏览器厂商转录），请检查网络后重试";
    default:
      return `语音识别失败：${code || "未知错误"}`;
  }
}

/** 按住说话的状态机：只有 idle -> recording -> idle 这一条路，没有别的跳转。 */
export function dictationNextStatus(
  current: DictationStatus,
  event: "start" | "stop" | "error" | "end"
): DictationStatus {
  if (event === "start") return current === "idle" ? "recording" : current;
  if (event === "stop" || event === "end" || event === "error") return "idle";
  return current;
}
