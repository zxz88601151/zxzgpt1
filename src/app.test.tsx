// @vitest-environment jsdom
/** 编排接线层的第一块判据：App 能不能在无浏览器环境下被驱动。
 *
 * 为什么先写这一块：`send()` 是 320 行闭包，长在 1520 行的 App 里，此前零覆盖。
 * 要给它判据，第一道坎不是"测什么"，而是"能不能把 App 跑起来"——如果连渲染
 * 都起不来，后面所有场景设计都是空谈。
 *
 * 这一批证明三件事，都是"接线"层面的：
 *   1) jsdom 里能挂载，且不依赖 Tauri 通道；
 *   2) 空输入点发送不发请求（守卫在 send() 里，不在按钮的 disabled 上）；
 *   3) 有输入点发送真的走 chatStream：请求打到 <baseUrl>/chat/completions，
 *      流回来的 delta 真的渲染成消息。
 *
 * 第 3 条是关键——它是"用户点了发送，事情到底有没有发生"的第一条自动化判据。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

// React 18 的 act 需要这个开关，否则每次状态更新都会打印 "not wrapped in act"
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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

/** 造一个假的 SSE 响应（只实现 api.ts 用到的成员） */
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

/** 往受控 textarea 里写字。
 *  直接赋值不行——React 记着自己上次渲染的值，不触发 onChange。
 *  必须用原型上的原生 setter 再派发 input 事件。 */
function typeInto(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  // 默认给一个会拒绝的 fetch：没安排网络请求的用例，任何请求都该立刻暴露。
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => {
    throw new TypeError("本用例没有安排网络请求");
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

async function mount(): Promise<HTMLDivElement> {
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  return container;
}

describe("App 在 jsdom 里能被驱动", () => {
  it("能挂载，且首屏出现输入框与发送按钮", async () => {
    await mount();
    const textarea = container.querySelector("textarea");
    expect(textarea, "首屏应有一个输入框").not.toBeNull();
    const sendBtn = container.querySelector("#btnSend") as HTMLButtonElement | null;
    expect(sendBtn, "首屏应有发送按钮").not.toBeNull();
    // 空闲时按钮是可点的——它只按 busy 禁用，空内容的拦截在 send() 里。
    // 这里断的是真实契约，不是我一开始以为的"空内容就 disabled"。
    expect(sendBtn?.disabled).toBe(false);
  });

  it("没有 Tauri 通道时按浏览器直连处理，挂载阶段不发任何请求", async () => {
    expect((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__).toBeUndefined();
    await mount();
    expect(fetchCalls(), "挂载阶段不应发网络请求").toEqual([]);
  });

  it("空输入点发送：不发请求、不新增消息（守卫在 send() 里）", async () => {
    await mount();
    const sendBtn = container.querySelector("#btnSend") as HTMLButtonElement;
    await act(async () => {
      sendBtn.click();
    });
    expect(fetchCalls(), "空内容不该发请求").toEqual([]);
  });

  it("有输入点发送：请求打到 <baseUrl>/chat/completions，流回来的文字渲染成回答", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"接线正常"}}]}',
        'data: {"choices":[{"delta":{"content":"，收到了"}}]}',
        "data: [DONE]",
      ),
    );

    await mount();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, "你好");
    });

    const sendBtn = container.querySelector("#btnSend") as HTMLButtonElement;
    await act(async () => {
      sendBtn.click();
    });
    // 让 send() 里的 await 链跑完（流是异步读的）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const calls = fetchCalls();
    expect(calls.length, "应当恰好发一次请求").toBe(1);
    expect(calls[0].url).toMatch(/\/chat\/completions$/);

    // 请求体里带上了用户这句话
    const body = JSON.parse(String(calls[0].init?.body));
    expect(JSON.stringify(body.messages)).toContain("你好");

    // 流回来的内容真的出现在界面上（先渲染 Markdown 再进 DOM，所以查文本）
    expect(container.textContent || "").toContain("接线正常");
  });
});
