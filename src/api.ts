/** 传输层：桌面端走 Rust 本机代理，浏览器直开则降级为直连。
 *
 * 两条通道对上层暴露同一套事件（StreamEvent），组件不关心底层是谁在发请求。
 */

import { safeJsonParse } from "./lib/text";
import { accumulateToolCallDeltas, type ToolCallFragment } from "./lib/tools";
import type { ModelListResult, Settings, StreamEvent, TestResult, Transport, WireMessage } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  }
}

export const DIRECT: Transport = { mode: "direct", port: 0, token: "" };

/**
 * 探测通道：
 * - 存在 Tauri IPC → 取本地代理端口并探活，成功则用代理
 * - 否则 direct：前端自己请求远端（受厂商跨域策略影响）
 */
export async function detectTransport(): Promise<Transport> {
  const internals = window.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === "function") {
    try {
      const info = (await internals.invoke("proxy_info")) as { port?: number; token?: string } | null;
      if (info && info.port) {
        const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
          headers: { "x-zxz-token": info.token || "" },
        });
        if (res.ok) return { mode: "proxy", port: info.port, token: info.token || "" };
      }
    } catch {
      /* 回落到直连 */
    }
  }
  return DIRECT;
}

export function normalizeBase(base: string): string {
  const trimmed = String(base || "").trim().replace(/\/+$/, "");
  return trimmed || "https://api.openai.com/v1";
}

export function describeError(status: number, text: string): string {
  const json = safeJsonParse(text) as { error?: { message?: string; msg?: string; code?: string } } | null;
  const detail = json?.error?.message || json?.error?.msg || json?.error?.code || null;
  const body = detail || String(text || "").slice(0, 300);
  return `请求失败（HTTP ${status}）：${body}`;
}

export interface ChatOptions {
  settings: Settings;
  transport: Transport;
  messages: WireMessage[];
  signal: AbortSignal;
  onEvent: (evt: StreamEvent) => void;
  /** 工具定义：给了才发 tools + tool_choice=auto；不给就是纯聊天，不改老行为 */
  tools?: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
}

/** 发起一次对话；SSE 解析是手写的，桌面端与直连共用同一套逻辑。 */
export async function chatStream({ settings, transport, messages, signal, onEvent, tools }: ChatOptions): Promise<void> {
  const wantStream = settings.stream !== false;
  const payload = {
    model: settings.model,
    messages,
    temperature: Number(settings.temperature),
    stream: wantStream,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };
  const maxTokens = settings.maxTokens && Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : null;

  let url: string;
  let body: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (transport.mode === "proxy") {
    url = `http://127.0.0.1:${transport.port}/chat`;
    headers["x-zxz-token"] = transport.token;
    body = JSON.stringify({
      base_url: normalizeBase(settings.baseUrl),
      api_key: settings.apiKey,
      model: settings.model,
      messages,
      temperature: payload.temperature,
      max_tokens: maxTokens,
      stream: wantStream,
      ...(tools?.length ? { tools } : {}),
    });
  } else {
    url = `${normalizeBase(settings.baseUrl)}/chat/completions`;
    if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;
    headers["Accept"] = "text/event-stream";
    body = JSON.stringify(maxTokens ? { ...payload, max_tokens: maxTokens } : payload);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal });
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") throw err;
    throw new Error("网络请求失败：" + (err.message || String(err)) + "（请检查 Base URL、网络或代理）");
  }

  if (!res.ok) {
    throw new Error(describeError(res.status, await res.text().catch(() => "")));
  }

  const contentType = res.headers.get("content-type") || "";

  // 非流式，或代理返回一次性 JSON
  if (!res.body || (!wantStream && !contentType.includes("event-stream"))) {
    const json = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      choices?: {
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
      usage?: Record<string, number>;
    } | null;
    if (!json) throw new Error("响应解析失败：无法读取 JSON");
    if (json.error) throw new Error(json.error.message || "上游返回错误");
    const msg = json.choices?.[0]?.message || {};
    if (msg.reasoning_content) onEvent({ type: "reasoning", text: msg.reasoning_content });
    if (msg.content) onEvent({ type: "delta", text: msg.content });
    if (Array.isArray((msg as { tool_calls?: unknown }).tool_calls)) {
      const calls = (msg as { tool_calls: { id?: string; function?: { name?: string; arguments?: string } }[] }).tool_calls.map(
        (c, i) => ({ id: c.id || `call_${i}`, name: c.function?.name || "", arguments: c.function?.arguments || "" }),
      );
      if (calls.length) onEvent({ type: "tool_calls", calls });
    }
    if (json.usage) onEvent({ type: "usage", usage: json.usage });
    onEvent({ type: "done" });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 流式 tool_calls 增量：direct 模式从上游 delta 里取，proxy 模式从 Rust 转发的
  // tool_call_delta 事件里取；流结束时合成一次完整调用再交给 App 执行。
  const toolFragments: ToolCallFragment[] = [];

  const handleLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;

    const json = safeJsonParse(data) as
      | {
          type?: string;
          text?: string;
          message?: string;
          usage?: Record<string, number>;
          error?: { message?: string };
          index?: number;
          id?: string;
          name?: string;
          arguments?: string;
          choices?: {
            delta?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        }
      | null;
    if (!json) return;

    if (transport.mode === "proxy") {
      // Rust 侧已经转成统一事件；tool_call_delta 只累计、不直接透传，
      // 流结束时由本函数合成一次 tool_calls 事件，避免 App 收到半截参数。
      if (json.type === "tool_call_delta" && typeof json.index === "number") {
        toolFragments.push({
          index: json.index,
          ...(typeof json.id === "string" ? { id: json.id } : {}),
          ...(typeof json.name === "string" ? { name: json.name } : {}),
          ...(typeof json.arguments === "string" ? { arguments: json.arguments } : {}),
        });
        return;
      }
      onEvent(json as StreamEvent); // Rust 侧已经转成统一事件
      return;
    }

    if (json.error) {
      onEvent({ type: "error", message: json.error.message || "上游返回错误" });
      return;
    }
    if (json.usage && typeof json.usage === "object") {
      onEvent({ type: "usage", usage: json.usage });
    }
    const delta = json.choices?.[0]?.delta;
    if (delta) {
      if (delta.reasoning_content) onEvent({ type: "reasoning", text: delta.reasoning_content });
      if (delta.content) onEvent({ type: "delta", text: delta.content });
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
          toolFragments.push({
            index: typeof tc.index === "number" ? tc.index : toolFragments.length,
            ...(tc.id ? { id: tc.id } : {}),
            ...(tc.function?.name ? { name: tc.function.name } : {}),
            ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
          });
        }
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";
      for (const part of parts) handleLine(part);
    }
    if (buffer.trim()) handleLine(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  if (toolFragments.length) {
    const calls = accumulateToolCallDeltas(toolFragments).filter((c) => c.name);
    if (calls.length) onEvent({ type: "tool_calls", calls });
  }

  onEvent({ type: "done" });
}

export async function testConnection(settings: Settings, transport: Transport): Promise<TestResult> {
  const messages: WireMessage[] = [{ role: "user", content: "hi" }];

  if (transport.mode === "proxy") {
    const res = await fetch(`http://127.0.0.1:${transport.port}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-zxz-token": transport.token },
      body: JSON.stringify({
        base_url: normalizeBase(settings.baseUrl),
        api_key: settings.apiKey,
        model: settings.model,
        messages,
        temperature: 0,
        max_tokens: 1,
        stream: false,
      }),
    });
    return (await res.json()) as TestResult;
  }

  try {
    const res = await fetch(`${normalizeBase(settings.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: settings.model, messages, max_tokens: 1, stream: false }),
    });
    const text = await res.text();
    if (res.ok) return { ok: true, message: "连接正常，模型可用" };
    return { ok: false, message: describeError(res.status, text) };
  } catch (e) {
    return { ok: false, message: "网络请求失败：" + ((e as Error).message || String(e)) };
  }
}

export async function fetchModels(settings: Settings, transport: Transport): Promise<ModelListResult> {
  if (transport.mode === "proxy") {
    const qs = new URLSearchParams({ base_url: normalizeBase(settings.baseUrl), api_key: settings.apiKey });
    const res = await fetch(`http://127.0.0.1:${transport.port}/models?${qs}`, {
      headers: { "x-zxz-token": transport.token },
    });
    return (await res.json()) as ModelListResult;
  }
  try {
    const res = await fetch(`${normalizeBase(settings.baseUrl)}/models`, {
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    });
    const json = (await res.json()) as { data?: { id?: string }[] };
    const ids = (json.data || []).map((m) => m.id).filter((v): v is string => Boolean(v));
    return { ok: res.ok, models: ids, message: res.ok ? "" : "拉取失败" };
  } catch (e) {
    return { ok: false, models: [], message: (e as Error).message || String(e) };
  }
}
