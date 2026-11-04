// @vitest-environment jsdom
/** 编排接线层的第二块判据：一整轮"发送 → 失败/工具/停止"跑下来到底发生了什么。
 *
 * 为什么要有这一层：`app.test.tsx` 只证明了"点了发送真的打到上游、delta 能渲染"。
 * 但 send() 里最容易出事的是**轮的边界**——上游报错之后会不会继续打第二轮、
 * 工具调用结果有没有按原生协议回填、用户点停止之后还会不会再发请求。
 * 这三件事此前只能靠人点界面看，一处改错就是"错误被当成回答继续跑"或者
 * "停止只停住了界面"。
 *
 * 这里的 fetch 是假的、Tauri IPC 是假的，但走的是 App 真实的 send()/executeTool/
 * buildMessages 路径——没有为测试在业务代码里开洞。
 *
 * 关于判据的写法：断言落在"发了几个请求""第二个请求里有什么"这类可观察事实上，
 * 不去断言内部变量。内部实现随便改，只要行为还对，这些用例就该继续绿。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { Settings } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORE_KEY = "zxz.state.v1";

let container: HTMLDivElement;
let root: Root;
let ipc: { cmd: string; args?: Record<string, unknown> }[];

interface Call {
  url: string;
  init?: RequestInit;
}

function fetchCalls(): Call[] {
  const f = globalThis.fetch as unknown as { mock?: { calls: unknown[][] } };
  return (f?.mock?.calls || []).map((c) => {
    const [url, init] = c as [string, RequestInit];
    return { url: String(url), init };
  });
}

/* ------------------------------------------------------------ 假 Tauri */

/**
 * 装上一条假的 IPC 通道。
 *
 * 为什么必须装：工具模式的前置条件是 `fsAvailable()`（= window.__TAURI_INTERNALS__
 * 存在）加 settings.workspace。不装的话 toolModeOn 永远是 false，
 * "工具调用结果回填"这条路径在测试里根本走不到——那等于没测。
 *
 * 默认实现只覆盖本文件用到的命令；传 overrides 可以改单条命令的行为。
 */
function installTauri(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}): void {
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    ipc.push({ cmd, args });
    const h = overrides[cmd];
    if (h) return h(args || {});
    switch (cmd) {
      case "proxy_info":
        // 返回 null：退回浏览器直连，测试里不需要真起本地代理
        return null;
      case "ws_info":
        return { id: "s1", root: "F:/proj", name: "proj" };
      case "fs_read":
        return "export const answer = 42;\n";
      case "fs_list_in":
        return [];
      case "fs_exists":
        return false;
      case "fs_write":
        return { path: String(args?.rel || ""), bytes: 1, created: true };
      case "undo_write":
        return { path: "undo", bytes: 1, created: true };
      case "perm_list":
        return [];
      default:
        return null;
    }
  };
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
}

function seed(settings: Partial<Settings> = {}): void {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      settings: { baseUrl: "https://upstream.test/v1", model: "test-model", ...settings },
      conversations: [],
      activeId: null,
    }),
  );
}

/* ------------------------------------------------------------ 假上游 */

function sseResponse(...lines: string[]): Response {
  const enc = new TextEncoder();
  const queue = lines.map((l) => enc.encode(l + "\n"));
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    text: async () => "",
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () => (i >= queue.length ? { value: undefined, done: true } : { value: queue[i++], done: false }),
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
    body: null,
  } as unknown as Response;
}

/** 一条永远读不完的流：只有用户点停止（signal.abort）才会以 AbortError 结束。
 *  用"能读到一半但不结束"来模拟真实的长回答，而不是让 fetch 立刻返回。 */
function hangingResponse(signal: AbortSignal): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    text: async () => "",
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

/** 按顺序取响应；第 N 次之后的请求都复用最后一个 handler。
 *  这样一个用例里可以写"第一轮工具调用、第二轮 500"。 */
function stubFetch(...handlers: ((url: string, init: RequestInit) => Response)[]): void {
  let i = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string, init: RequestInit) => {
    const h = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return h(url, init);
  });
}

/* ------------------------------------------------------------ 驱动 */

beforeEach(() => {
  localStorage.clear();
  ipc = [];
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  container = document.createElement("div");
  document.body.appendChild(container);
  // 没安排网络的用例，任何请求都该立刻暴露成失败，而不是悄悄通过
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => {
    throw new TypeError("本用例没有安排网络请求");
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
}

/** 让 await 链、rAF 与 React 的更新都跑完。
 *  一次 setTimeout(0) 不够：工具轮里有 IPC 往返，每层 await 各占一个微任务。 */
async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function typeInto(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function typeAndSend(text: string): Promise<void> {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(textarea, text);
  });
  const sendBtn = container.querySelector("#btnSend") as HTMLButtonElement;
  await act(async () => {
    sendBtn.click();
  });
}

function bodyOf(call: Call): { messages: { role: string; content: string; tool_calls?: { function: { name: string } }[]; tool_call_id?: string }[]; tools?: { function: { name: string } }[] } {
  return JSON.parse(String(call.init?.body));
}

/* ------------------------------------------------------------ 用例 */

describe("一整轮的边界", () => {
  it("上游报错：把上游原话报出来，不自动重试下一轮", async () => {
    installTauri();
    seed();
    stubFetch(() => errorResponse(500, '{"error":{"message":"上游炸了"}}'));

    await mount();
    await settle(1); // 等 detectTransport / ws 恢复这类挂载副作用跑完
    await typeAndSend("你好");
    await settle();

    const calls = fetchCalls();
    expect(calls.length, "报错后不该再打第二轮").toBe(1);
    expect(calls[0].url).toMatch(/\/chat\/completions$/);

    const text = container.textContent || "";
    expect(text, "错误要带 HTTP 状态").toContain("HTTP 500");
    expect(text, "上游原话要透传，不能被吞成通用文案").toContain("上游炸了");

    // 失败不是"还在生成"：按钮必须回到可点状态，否则用户只能刷新页面
    expect((container.querySelector("#btnSend") as HTMLButtonElement).disabled).toBe(false);
  });

  it("工具调用轮：结果按原生协议回填后再发一轮；上游随后失败即收摊", async () => {
    installTauri();
    seed({ workspace: { sessionId: "s1", root: "F:/proj", name: "proj", tree: "a.txt" } });
    stubFetch(
      () =>
        sseResponse(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
          "data: [DONE]",
        ),
      () => errorResponse(502, "bad gateway"),
    );

    await mount();
    await settle(1);
    await typeAndSend("读一下 a.txt");
    await settle(12);

    const calls = fetchCalls();
    expect(calls.length, "第一轮工具调用 + 第二轮失败，恰好两次请求").toBe(2);

    // 第一轮必须把工具定义发出去，否则模型根本不知道能调 read_file
    expect((bodyOf(calls[0]).tools || []).map((t) => t.function.name)).toContain("read_file");

    const second = bodyOf(calls[1]);
    const toolMsgs = second.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length, "每次工具调用对应一条 tool 消息").toBe(1);
    expect(toolMsgs[0].tool_call_id, "tool_call_id 必须对上，否则模型接不住结果").toBe("call_1");
    expect(toolMsgs[0].content, "回填的是真实读到的内容，不是占位符").toContain("answer = 42");

    const assistant = second.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(assistant, "带 tool_calls 的助手消息必须原样带上").toBeTruthy();
    expect(assistant?.tool_calls?.[0].function.name).toBe("read_file");

    const text = container.textContent || "";
    expect(text).toContain("HTTP 502");
    expect(text).toContain("bad gateway");

    // 502 之后既不该再发第三轮，也不该把工具结果当成最终回答
    expect(fetchCalls().length).toBe(2);
    expect((container.querySelector("#btnSend") as HTMLButtonElement).disabled).toBe(false);
  });

  it("中途停止：显示已停止生成，之后不再发任何请求", async () => {
    installTauri();
    seed();
    stubFetch((_url, init) => hangingResponse(init.signal as AbortSignal));

    await mount();
    await settle(1);
    await typeAndSend("写一首很长的诗");
    await settle(1); // 让请求发出去、流挂起

    const stopBtn = container.querySelector("#btnStop") as HTMLButtonElement;
    expect(stopBtn.hidden, "流没结束时停止按钮必须可见").toBe(false);

    await act(async () => {
      stopBtn.click();
    });
    await settle();

    const text = container.textContent || "";
    expect(text, "停止要有一个明确的收尾标记").toContain("已停止生成");
    // 停止是人的操作，不是故障：不该同时出现"请求失败"这类红字
    expect(text).not.toContain("请求失败");

    expect(fetchCalls().length, "停止后不该自动再来一轮").toBe(1);
    expect((container.querySelector("#btnSend") as HTMLButtonElement).disabled).toBe(false);
  });
});
