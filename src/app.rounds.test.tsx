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

/** 假文件系统的内容。写进去的东西要能被读回来——否则 write_file 的
 *  回读校验永远是 false，测出来的"写成功"跟真实行为不是一回事。 */
let files: Map<string, string>;

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

function ipcCalls(cmd: string): { cmd: string; args?: Record<string, unknown> }[] {
  return ipc.filter((c) => c.cmd === cmd);
}

/* ------------------------------------------------------------ 假 Tauri */

/**
 * 装上一条假的 IPC 通道。
 *
 * 为什么必须装：工具模式的前置条件是 `fsAvailable()`（= window.__TAURI_INTERNALS__
 * 存在）加 settings.workspace。不装的话 toolModeOn 永远是 false，
 * "工具调用结果回填""审批挂起""自动测试回路"这些路径在测试里根本走不到——
 * 那等于没测。
 *
 * 文件读写落在一个内存 Map 上：`fs_write` 之后 `fs_read` 能读回同一份内容，
 * 这样写入回读校验（verified）才是真的在验证，而不是恒假。
 * 传 overrides 可以改单条命令的行为。
 */
function installTauri(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}): void {
  files = new Map([
    ["a.txt", "export const answer = 42;\n"],
    // run_command 跑 npm/npx 之前会先读 package.json 审脚本内容，
    // 缺了它工具会以"无法读取 package.json"失败——那是夹具缺件，不是产品行为。
    ["package.json", JSON.stringify({ scripts: { test: "vitest run" } })],
  ]);
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
      case "fs_read": {
        const rel = String(args?.rel || "");
        if (!files.has(rel)) throw new Error(`读不到 ${rel}`);
        return files.get(rel);
      }
      case "fs_list_in":
        return [...files.keys()].map((name) => ({ name, path: `F:/proj/${name}`, dir: false, size: files.get(name)!.length }));
      case "fs_exists":
        return files.has(String(args?.rel || ""));
      case "fs_write": {
        const rel = String(args?.rel || "");
        const text = String(args?.content ?? "");
        const created = !files.has(rel);
        files.set(rel, text);
        return { path: rel, bytes: text.length, created };
      }
      case "undo_write":
        return { path: String(args?.rel || ""), bytes: 1, created: false };
      case "perm_list":
      case "perm_grant":
      case "perm_revoke":
        return [];
      case "run_allowed":
        return { exit_code: 0, stdout: "ok", stderr: "", timed_out: false, truncated: false, cancelled: false };
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

/** 造一条"模型要调工具"的 SSE。参数用 JSON.stringify 拼，免得手写转义出错。 */
function toolCallSse(id: string, name: string, args: Record<string, unknown>): Response {
  const frame = {
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }],
  };
  return sseResponse(`data: ${JSON.stringify(frame)}`, "data: [DONE]");
}

function workspaceSettings(): Partial<Settings> {
  return { workspace: { sessionId: "s1", root: "F:/proj", name: "proj", tree: "a.txt" } };
}

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

  it("轮数上限：模型每轮都要读文件时，第 6 轮后停下并说明原因", async () => {
    installTauri();
    seed(workspaceSettings());
    let n = 0;
    stubFetch(() => {
      n += 1;
      return toolCallSse(`call_${n}`, "read_file", { path: "a.txt" });
    });

    await mount();
    await settle(1);
    await typeAndSend("一直读下去");
    // 6 轮、每轮一次 IPC + 一次 fetch，微任务层数不少，给足轮次
    await settle(40);

    expect(fetchCalls().length, "轮数上限必须是硬上限，不能多打一轮").toBe(6);
    expect(container.textContent || "").toContain("已达到本次最多 6 轮读写");
    expect((container.querySelector("#btnSend") as HTMLButtonElement).disabled).toBe(false);
  });

  it("自动测试回路：连续 3 轮不过就停手报人，每一轮的报错都回传给模型", async () => {
    let testRound = 0;
    installTauri({
      run_allowed: () => {
        testRound += 1;
        return { exit_code: 1, stdout: "", stderr: `1 failing (round ${testRound})`, timed_out: false, truncated: false };
      },
    });
    seed({ ...workspaceSettings(), autoTest: true });

    let n = 0;
    stubFetch(() => {
      n += 1;
      return toolCallSse(`call_${n}`, "write_file", { path: "a.txt", content: `版本 ${n}\n` });
    });

    await mount();
    await settle(1);
    await typeAndSend("改到测试通过为止");
    await settle(60);

    const calls = fetchCalls();
    expect(calls.length, "3 轮测试都没过 → 第 3 轮之后停手，不再请求第 4 轮").toBe(3);
    expect(ipcCalls("run_allowed").length, "每轮写了文件就跑一次 npm test").toBe(3);
    expect(ipcCalls("run_allowed")[0].args?.argv).toEqual(["npm", "test"]);

    // 第二轮 / 第三轮的上下文里要带上上一轮的失败原文，否则模型没有可改的依据
    const second = bodyOf(calls[1]);
    const secondText = JSON.stringify(second.messages);
    expect(secondText, "第一轮报错要回传").toContain("第 1/3 轮");
    expect(secondText).toContain("1 failing (round 1)");

    const third = bodyOf(calls[2]);
    const thirdText = JSON.stringify(third.messages);
    expect(thirdText, "第二轮报错也要回传").toContain("第 2/3 轮");
    expect(thirdText).toContain("1 failing (round 2)");

    expect(container.textContent || "").toContain("测试 3 轮仍未通过");
    // 失败收场同样是"结束"，不是"还在生成"
    expect((container.querySelector("#btnSend") as HTMLButtonElement).disabled).toBe(false);
  });

  it("执行审批：没点头之前流程挂住不发下一轮，点「仅这一次」后才放行", async () => {
    let runs = 0;
    installTauri({
      run_allowed: () => {
        runs += 1;
        if (runs === 1) {
          throw JSON.stringify({ kind: "need_grant", scope: ["npm", "test"], label: "npm test" });
        }
        return { exit_code: 0, stdout: "12 passed", stderr: "", timed_out: false, truncated: false };
      },
    });
    seed(workspaceSettings());

    stubFetch(
      () => toolCallSse("call_run", "run_command", { argv: ["npm", "test"] }),
      () => sseResponse('data: {"choices":[{"delta":{"content":"命令跑完了"}}]}', "data: [DONE]"),
    );

    await mount();
    await settle(1);
    await typeAndSend("跑一下测试");
    await settle(10);

    // 挂起：确认框在，命令还没被批准，也绝不会偷偷把下一轮请求发出去
    const dialog = container.querySelector("#confirmExec");
    expect(dialog, "exec 默认必须问人").not.toBeNull();
    expect(dialog?.textContent || "").toContain("npm test");
    expect(fetchCalls().length, "审批没答之前不能继续跑").toBe(1);
    expect(ipcCalls("perm_grant").length, "还没点头就不该有授权").toBe(0);

    const onceBtn = [...(dialog?.querySelectorAll("button") || [])].find(
      (b) => (b.textContent || "").trim() === "仅这一次",
    ) as HTMLButtonElement | undefined;
    expect(onceBtn, "「仅这一次」必须是一个可点的选项").toBeTruthy();
    await act(async () => {
      onceBtn?.click();
    });
    await settle(20);

    expect(ipcCalls("perm_grant").length, "点一次 = 记一条一次性授权").toBe(1);
    expect(ipcCalls("perm_grant")[0].args?.scope).toEqual(["npm", "test"]);
    expect(runs, "授权后必须真的重试那条命令").toBe(2);

    const calls = fetchCalls();
    expect(calls.length, "命令跑完才继续下一轮").toBe(2);
    const toolMsg = bodyOf(calls[1]).messages.find((m) => m.role === "tool");
    expect(toolMsg?.content || "", "执行结果要回填给模型").toContain("12 passed");
    expect(container.textContent || "").toContain("命令跑完了");
  });

  it("探索模式：发给模型的定义只剩只读三件套，硬调补丁工具被执行层拦截、磁盘零改动", async () => {
    installTauri();
    seed({ exploreMode: true, workspace: { sessionId: "s1", root: "F:/proj", name: "proj", tree: "a.txt" } });
    stubFetch(
      () => toolCallSse("call_1", "edit_file", { path: "a.txt", old_text: "answer = 42", new_text: "answer = 43" }),
      () => sseResponse('data: {"choices":[{"delta":{"content":"已查到，改动方案如下"}}]}', "data: [DONE]"),
    );

    await mount();
    await settle(1);
    await typeAndSend("改一下 a.txt");
    await settle(12);

    const calls = fetchCalls();
    expect(calls.length, "第一轮工具调用 + 第二轮收尾，恰好两次请求").toBe(2);

    // 第一道门：发给模型的工具定义里已经没有写/跑工具
    expect((bodyOf(calls[0]).tools || []).map((t) => t.function.name)).toEqual(["read_file", "list_dir", "search_files"]);

    // 第二道门：模型硬调 edit_file，执行层拦下并把拦截原因回填给模型
    const toolMsgs = bodyOf(calls[1]).messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length, "每次工具调用对应一条 tool 消息").toBe(1);
    expect(toolMsgs[0].content, "回填的是拦截原因，不是改动结果").toContain("探索模式已拦截");

    // 磁盘零改动：拦截发生在写通道之前，fs_write 一次都没被调到
    expect(ipcCalls("fs_write")).toHaveLength(0);
    expect(files.get("a.txt")).toBe("export const answer = 42;\n");
  });
});
