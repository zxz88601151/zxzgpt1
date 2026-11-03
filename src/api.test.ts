/** 传输层契约测试：上游出错时到底发生了什么。
 *
 * 为什么要有这个文件：`api.ts` 302 行此前零覆盖，而"上游报错"这条路径
 * 没有任何自动化判据——401 怎么说、流断在半路怎么办、用户点停止和网络断了
 * 能不能区分，全靠人眼。这不是数据安全问题，是**界面会不会说实话**的问题。
 *
 * 不需要 jsdom：这里测的是 fetch / SSE / 错误映射，不碰 DOM。
 * 假 fetch 直接替换 `globalThis.fetch`，和 `fsapi.test.ts` 替换 IPC 是同一套写法。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatStream, describeError, detectTransport, DIRECT, fetchModels, normalizeBase, testConnection } from "./api";
import type { Settings, StreamEvent, Transport } from "./types";

const BASE: Settings = {
  preset: "custom",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "m1",
  temperature: 0,
  maxTokens: null,
  contextTurns: 6,
  systemPrompt: "",
  stream: true,
  theme: "dark",
  workspace: null,
  skills: [],
  skillAuto: false,
  skillsDir: null,
};

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...BASE, ...patch };
}

const DIRECT_T: Transport = { mode: "direct", port: 0, token: "" };
const PROXY_T: Transport = { mode: "proxy", port: 43210, token: "tok-abc" };

/** 造一个假的 Response；只实现被测代码真正用到的成员。
 *
 * 注意 `body` 默认 null 是简化：真实 Response 的 body 只在 204/304/HEAD 时为 null。
 * 所以"靠 !res.body 走一次性 JSON 分支"的用例证明的不是生产路径。真正接近真实的
 * 情形（有 body、content-type: application/json、stream:true）在
 * 「上游没按 SSE 回」那一组里单独覆盖。
 */
function res(opts: {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: unknown;
  text?: string;
  json?: unknown;
}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? (opts.contentType ?? "application/json") : null) },
    text: async () => opts.text ?? "",
    json: async () => {
      if (opts.json === undefined) throw new Error("不是 JSON");
      return opts.json;
    },
    body: opts.body === undefined ? null : opts.body,
  } as unknown as Response;
}

/** 按给定的网络分片喂数据；每次 read 返回一片，最后 done */
function streamOf(chunks: (string | Uint8Array)[]): { getReader: () => unknown } & { cancelled: () => boolean } {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
  let i = 0;
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    getReader: () => ({
      read: async () => {
        if (i >= queue.length) return { value: undefined, done: true };
        return { value: queue[i++], done: false };
      },
      cancel: async () => {
        cancelled = true;
      },
    }),
  };
}

/** 读一句话就正常结束的流（省得每个用例都手写） */
function sseStream(...lines: string[]) {
  return streamOf(lines.map((l) => l + "\n"));
}

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  fetchMock = vi.fn(impl as never);
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

beforeEach(() => {
  installFetch(async () => res({}));
});

afterEach(() => {
  vi.restoreAllMocks();
  // 不还原 window 会留下顺序依赖：目前每个用例都自带赋值所以还没出事，
  // 但只要有人在文件尾追加一条读 window 的用例，就会变成"看谁先跑"。
  delete (globalThis as { window?: unknown }).window;
});

// ───────────────────────────── describeError ─────────────────────────────

describe("describeError：上游的错话要能原样传到界面上", () => {
  it("优先取 error.message", () => {
    expect(describeError(429, '{"error":{"message":"额度已用尽"}}')).toBe("请求失败（HTTP 429）：额度已用尽");
  });

  it("没有 message 时退到 error.code", () => {
    expect(describeError(400, '{"error":{"code":"invalid_model"}}')).toBe("请求失败（HTTP 400）：invalid_model");
  });

  it("不是 JSON 就把正文截到 300 字（云厂商常返回整页 HTML）", () => {
    const html = "<html>" + "x".repeat(1000) + "</html>";
    const out = describeError(502, html);
    expect(out.startsWith("请求失败（HTTP 502）：<html>")).toBe(true);
    // 前缀 + 300 字，不能把整页 HTML 灌进界面
    expect(out.length).toBe("请求失败（HTTP 502）：".length + 300);
  });

  it("正文为空也不能渲染成 undefined", () => {
    expect(describeError(500, "")).toBe("请求失败（HTTP 500）：");
  });
});

// ───────────────────────────── 请求构造 ─────────────────────────────

describe("请求怎么发：Key 不能跑到 URL 或请求行上", () => {
  it("直连：Key 走 Authorization 头，URL 只带路径", async () => {
    installFetch(async () =>
      res({ json: { choices: [{ message: { content: "hi" } }] } }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings({ stream: false }),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    const { url, init } = lastCall();
    // url 精确相等已经蕴含"Key 没拼进 URL"，不另写一条永不独立失败的断言
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("代理：Key 只在请求体里，不带 Authorization 头（它会落进代理日志）", async () => {
    installFetch(async () => res({ json: { choices: [{ message: { content: "hi" } }] } }));
    await chatStream({
      settings: settings({ stream: false }),
      transport: PROXY_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const { url, init } = lastCall();
    expect(url).toBe("http://127.0.0.1:43210/chat");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-zxz-token"]).toBe("tok-abc");
    expect(JSON.parse(String(init.body)).api_key).toBe("sk-test");
  });

  it("没给工具定义就不发 tools 字段（老行为不能被改动带歪）", async () => {
    installFetch(async () => res({ json: { choices: [{ message: { content: "hi" } }] } }));
    await chatStream({
      settings: settings({ stream: false }),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const sent = JSON.parse(String(lastCall().init.body));
    expect("tools" in sent).toBe(false);
    expect("tool_choice" in sent).toBe(false);
  });

  it("normalizeBase：空值给默认端点，尾部斜杠不重复", () => {
    expect(normalizeBase("")).toBe("https://api.openai.com/v1");
    expect(normalizeBase("https://a.example/v1///")).toBe("https://a.example/v1");
  });
});

// ───────────────────────────── 上游错误 ─────────────────────────────

describe("上游报错：每一类都要说出是什么，不能吞成一句「失败」", () => {
  it("HTTP 非 2xx：把上游的 error.message 带出来", async () => {
    installFetch(async () => res({ ok: false, status: 401, text: '{"error":{"message":"无效的令牌"}}' }));
    await expect(
      chatStream({
        settings: settings(),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("请求失败（HTTP 401）：无效的令牌");
  });

  it("HTTP 非 2xx 且 body 读不出来时，仍要报 HTTP 状态而不是崩掉", async () => {
    installFetch(async () => {
      const r = res({ ok: false, status: 503 });
      r.text = async () => {
        throw new Error("连接已被重置");
      };
      return r;
    });
    await expect(
      chatStream({
        settings: settings(),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("请求失败（HTTP 503）：");
  });

  it("网络层失败：报的是「网络请求失败」，并提示去查 Base URL", async () => {
    installFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      chatStream({
        settings: settings(),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("网络请求失败：Failed to fetch（请检查 Base URL、网络或代理）");
  });

  it("用户点停止引发的 AbortError 必须原样抛出，不能被包成「网络请求失败」", async () => {
    // 这条是「停止」和「网络断了」的唯一区分点：App 靠 err.name === "AbortError"
    // 判断是不是用户自己停的。包一层就把两者混成一件事了。
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    installFetch(async () => {
      throw abort;
    });
    await expect(
      chatStream({
        settings: settings(),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toBe(abort);
  });

  it("非流式响应里带 error 字段：报错而不是当成空回答", async () => {
    installFetch(async () => res({ body: null, json: { error: { message: "该模型不支持此参数" } } }));
    await expect(
      chatStream({
        settings: settings({ stream: false }),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("该模型不支持此参数");
  });

  it("响应既不是 SSE 也不是 JSON：说「解析失败」，不要静默当作空回答", async () => {
    installFetch(async () => res({ body: null, json: undefined }));
    await expect(
      chatStream({
        settings: settings({ stream: false }),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("响应解析失败：无法读取 JSON");
  });

  it("流里夹了一条 error 事件：变成 error 事件交给界面，不抛异常", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: sseStream('data: {"error":{"message":"上下文超长"}}'),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([{ type: "error", message: "上下文超长" }, { type: "done" }]);
  });
});

// ───────────────────────────── SSE 解析 ─────────────────────────────

describe("SSE 解析：手写的分帧逻辑在最难看的输入下也不能崩", () => {
  it("正常增量按顺序变成 delta 事件，最后一定有 done", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: sseStream(
          'data: {"choices":[{"delta":{"content":"你"}}]}',
          'data: {"choices":[{"delta":{"content":"好"}}]}',
          "data: [DONE]",
        ),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([
      { type: "delta", text: "你" },
      { type: "delta", text: "好" },
      { type: "done" },
    ]);
  });

  it("一行被拆成两个网络分片（含中文被切开）也要拼回来", async () => {
    // 直接按字节切，"好"的 UTF-8 三个字节分两次到。TextDecoder 必须用
    // {stream:true}，否则会在边界处解出替换字符——用户看到的就是乱码。
    const payload = 'data: {"choices":[{"delta":{"content":"好"}}]}\n';
    const bytes = new TextEncoder().encode(payload);
    // 找到"好"的起始字节位置，再多切一个字节，把它彻底劈开
    const byteCut = new TextEncoder().encode(payload.slice(0, payload.indexOf("好"))).length + 1;
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: streamOf([bytes.slice(0, byteCut), bytes.slice(byteCut)]),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([{ type: "delta", text: "好" }, { type: "done" }]);
  });

  it("注释行、空行、非 data 行一律忽略", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: sseStream(": keep-alive", "", "event: ping", 'data: {"choices":[{"delta":{"content":"A"}}]}'),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([{ type: "delta", text: "A" }, { type: "done" }]);
  });

  it("半截 JSON 不能崩：解析失败就当没有这行", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: sseStream('data: {"choices":[{"delta":{"cont', 'data: {"choices":[{"delta":{"content":"B"}}]}'),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([{ type: "delta", text: "B" }, { type: "done" }]);
  });

  it("最后一行没有换行符收尾也不能丢", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: streamOf(['data: {"choices":[{"delta":{"content":"尾巴"}}]}']),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([{ type: "delta", text: "尾巴" }, { type: "done" }]);
  });

  it("usage 也要透传（界面靠它显示 token 用量）", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: sseStream('data: {"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}'),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    // 整段断言，不是只看第一条：只查 evts[0] 的话，重复发同一个事件也照样绿
    expect(evts).toEqual([
      { type: "usage", usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } },
      { type: "done" },
    ]);
  });
});

// ───────────────────────────── 流中断 ─────────────────────────────

describe("流断在半路：已经收到的内容保留，错误照样抛出来", () => {
  it("reader 抛错时异常向上传，不吞", async () => {
    let n = 0;
    const enc = new TextEncoder();
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: {
          getReader: () => ({
            read: async () => {
              n += 1;
              if (n === 1) return { value: enc.encode('data: {"choices":[{"delta":{"content":"前半"}}]}\n'), done: false };
              throw new Error("upstream reset");
            },
            cancel: async () => {},
          }),
        },
      }),
    );
    const evts: StreamEvent[] = [];
    await expect(
      chatStream({
        settings: settings(),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: (e) => evts.push(e),
      }),
    ).rejects.toThrow("upstream reset");
    // 断之前收到的那半句不能丢
    expect(evts).toEqual([{ type: "delta", text: "前半" }]);
    // 断在半路就不该有 done —— 否则界面会以为回答完整结束了
    expect(evts.some((e) => e.type === "done")).toBe(false);
  });

  it("cancel 自己抛错不能把真正的错误盖掉", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: {
          getReader: () => ({
            read: async () => {
              throw new Error("真正的错误");
            },
            cancel: async () => {
              throw new Error("取消失败");
            },
          }),
        },
      }),
    );
    await expect(
      chatStream({
        settings: settings(),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("真正的错误");
  });

  it("正常读完也要 cancel 掉 reader（不留悬挂连接）", async () => {
    const body = sseStream('data: {"choices":[{"delta":{"content":"x"}}]}');
    installFetch(async () => res({ contentType: "text/event-stream", body }));
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(body.cancelled()).toBe(true);
  });
});

// ───────────────────────────── 工具调用 ─────────────────────────────

describe("流式工具调用：参数被切碎时合成一次完整调用", () => {
  it("直连：多片 delta 拼成一个调用，参数不残缺", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: sseStream(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}',
          "data: [DONE]",
        ),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([
      { type: "tool_calls", calls: [{ id: "call_1", name: "read", arguments: '{"path":"a.ts"}' }] },
      { type: "done" },
    ]);
  });

  it("代理：tool_call_delta 不直接透传，只在流末合成一次", async () => {
    installFetch(async () =>
      res({
        contentType: "text/event-stream",
        body: sseStream(
          'data: {"type":"tool_call_delta","index":0,"id":"c1","name":"list"}',
          'data: {"type":"tool_call_delta","index":0,"arguments":"{}"}',
          'data: {"type":"done"}',
        ),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings(),
      transport: PROXY_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    // 中间态不出现在界面上：App 收到半截参数会执行一个错调用
    // 并且 done 只能有一个、且必须是最后一个——代理自己会发一条 done，
    // 原样转发就会出现「done 在 tool_calls 之前」，任何按 done 收尾的消费者
    // 都会在拿到工具调用之前结束本轮。
    expect(evts).toEqual([
      { type: "tool_calls", calls: [{ id: "c1", name: "list", arguments: "{}" }] },
      { type: "done" },
    ]);
  });
});

// ───────────────────────────── 一次性 JSON ─────────────────────────────

describe("上游没按 SSE 回：内容不能静默丢掉", () => {
  it("要了流式、上游却返回整段 JSON：照样要吐出正文", async () => {
    // 真实场景：网关不认 stream 参数、或 200 + JSON 错误体（国内厂商常见）。
    // 老代码只判 `!wantStream` 才走一次性 JSON 分支，于是把 JSON 当 SSE 行解析，
    // 每行都不以 data: 开头 → 一个 delta 都没有，也没有报错 → 用户看到空回答。
    const payload = JSON.stringify({
      choices: [{ message: { content: "完整回答" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    installFetch(async () =>
      res({
        contentType: "application/json",
        body: streamOf([payload]),
        json: JSON.parse(payload),
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings({ stream: true }), // 默认就是 true
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([
      { type: "delta", text: "完整回答" },
      { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      { type: "done" },
    ]);
  });

  it("非流式的四类事件要按顺序全出：reasoning → delta → tool_calls → usage → done", async () => {
    installFetch(async () =>
      res({
        contentType: "application/json",
        json: {
          choices: [
            {
              message: {
                content: "正文",
                reasoning_content: "思考",
                tool_calls: [{ id: "c9", function: { name: "read", arguments: '{"path":"a"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        },
      }),
    );
    const evts: StreamEvent[] = [];
    await chatStream({
      settings: settings({ stream: false }),
      transport: DIRECT_T,
      messages: [{ role: "user", content: "yo" }],
      signal: new AbortController().signal,
      onEvent: (e) => evts.push(e),
    });
    expect(evts).toEqual([
      { type: "reasoning", text: "思考" },
      { type: "delta", text: "正文" },
      { type: "tool_calls", calls: [{ id: "c9", name: "read", arguments: '{"path":"a"}' }] },
      { type: "usage", usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } },
      { type: "done" },
    ]);
  });
});

// ───────────────────────────── 参数传导 ─────────────────────────────

describe("参数怎么传下去：静默吞掉一个都是故障", () => {
  it("给了工具就要在两种模式下都传到上游，直连还要带 tool_choice=auto", async () => {
    const tools = [{ type: "function" as const, function: { name: "read", description: "读文件", parameters: {} } }];
    for (const t of [DIRECT_T, PROXY_T]) {
      installFetch(async () => res({ body: null, json: { choices: [{ message: { content: "x" } }] } }));
      await chatStream({
        settings: settings({ stream: false }),
        transport: t,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
        tools,
      });
      const sent = JSON.parse(String(lastCall().init.body));
      // 传不下去 = 模型永远不发起工具调用，且界面上看不出为什么
      expect(sent.tools, `${t.mode} 模式丢了 tools`).toEqual(tools);
      if (t.mode === "direct") expect(sent.tool_choice).toBe("auto");
    }
  });

  it("maxTokens 设了就两种模式都要带（不带就是用户设的上限被静默吞掉）", async () => {
    for (const t of [DIRECT_T, PROXY_T]) {
      installFetch(async () => res({ body: null, json: { choices: [{ message: { content: "x" } }] } }));
      await chatStream({
        settings: settings({ stream: false, maxTokens: 256 }),
        transport: t,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      const sent = JSON.parse(String(lastCall().init.body));
      expect(sent.max_tokens, `${t.mode} 模式丢了 max_tokens`).toBe(256);
    }
  });

  it("maxTokens 为 null 或 0 时不发 max_tokens（由上游决定，而不是发个 0 把回答掐死）", async () => {
    for (const bad of [null, 0]) {
      installFetch(async () => res({ body: null, json: { choices: [{ message: { content: "x" } }] } }));
      await chatStream({
        settings: settings({ stream: false, maxTokens: bad }),
        transport: DIRECT_T,
        messages: [{ role: "user", content: "yo" }],
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      expect("max_tokens" in JSON.parse(String(lastCall().init.body))).toBe(false);
    }
  });
});

// ───────────────────────────── 其它入口 ─────────────────────────────

describe("探测与旁路接口", () => {
  it("没有 IPC 就是直连", async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    await expect(detectTransport()).resolves.toEqual(DIRECT);
  });

  it("有 IPC 但 /health 不通，回落到直连（不能因为代理挂了就连不上）", async () => {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: { invoke: async () => ({ port: 43210, token: "t" }) },
    };
    installFetch(async () => {
      throw new TypeError("connect ECONNREFUSED");
    });
    await expect(detectTransport()).resolves.toEqual(DIRECT);
  });

  it("/health 活着但返回非 2xx（代理起来了但状态不对），也要回落直连", async () => {
    // 上一条走的是 fetch 抛错（服务没起来）；这条走的是 res.ok === false，
    // 两个分支不同：只测前者的话，把 `if (res.ok)` 改成无条件返回代理也照样绿。
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: { invoke: async () => ({ port: 43210, token: "t" }) },
    };
    installFetch(async () => res({ ok: false, status: 500 }));
    await expect(detectTransport()).resolves.toEqual(DIRECT);
  });

  it("有 IPC 且 /health 通，走代理并带上 token", async () => {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: { invoke: async () => ({ port: 43210, token: "t" }) },
    };
    installFetch(async () => res({ ok: true }));
    await expect(detectTransport()).resolves.toEqual({ mode: "proxy", port: 43210, token: "t" });
    const { url, init } = lastCall();
    expect(url).toBe("http://127.0.0.1:43210/health");
    expect((init.headers as Record<string, string>)["x-zxz-token"]).toBe("t");
  });

  it("testConnection 失败时把上游原话带回来，而不是只给一句失败", async () => {
    installFetch(async () => res({ ok: false, status: 403, text: '{"error":{"message":"区域不支持"}}' }));
    await expect(testConnection(settings(), DIRECT_T)).resolves.toEqual({
      ok: false,
      message: "请求失败（HTTP 403）：区域不支持",
    });
  });

  it("fetchModels 过滤掉没有 id 的条目（否则下拉框里会出现空行）", async () => {
    installFetch(async () => res({ ok: true, json: { data: [{ id: "a" }, {}, { id: "b" }] } }));
    await expect(fetchModels(settings(), DIRECT_T)).resolves.toEqual({ ok: true, models: ["a", "b"], message: "" });
  });
});
