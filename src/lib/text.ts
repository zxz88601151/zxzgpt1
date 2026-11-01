/** 与框架无关的小工具，全部是纯函数，便于单测。 */

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 复制到剪贴板；不可用时退回 execCommand，保证在受限 WebView 里也能用 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 落到兜底方案 */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** 把「最近 N 轮」窗口算清楚：本轮提问始终发送，不占用轮数名额 */
export function sliceContext<T extends { role: string }>(usable: T[], turns: number): T[] {
  if (turns <= 0) return usable;
  const lastIsUser = usable.length > 0 && usable[usable.length - 1].role === "user";
  const head = lastIsUser ? usable.slice(0, -1) : usable;
  const window = head.slice(-turns * 2);
  return lastIsUser ? window.concat(usable[usable.length - 1]) : window;
}
