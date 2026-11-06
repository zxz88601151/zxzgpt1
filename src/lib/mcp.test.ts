import { describe, expect, it, vi } from "vitest";
import { exploreToolDefs, subagentToolDefs } from "./registry";
import {
  buildMcpSpecs,
  CONTEXT_MODE_SERVER,
  DEFAULT_MCP_CONFIG,
  executeMcpToolCall,
  mcpToolDef,
  mcpToolDefs,
  mcpToolName,
  parseMcpGrantRequired,
  validateMcpConfigFile,
  validateMcpServerConfig,
  validateMcpToolArgs,
  type McpTool,
  type McpToolSpec,
} from "./mcp";

function server(over: Record<string, unknown> = {}) {
  return {
    name: "context-mode",
    command: "npx",
    args: ["-y", "context-mode"],
    env: {},
    enabled: false,
    ...over,
  };
}

function spec(over: Partial<McpToolSpec> = {}): McpToolSpec {
  return {
    name: "mcp_context_mode_ctx_search",
    server: "context-mode",
    tool: "ctx_search",
    description: "在已索引的内容里搜索",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    ...over,
  };
}

describe("默认配置", () => {
  it("默认只内置 context-mode，且默认关闭", () => {
    expect(DEFAULT_MCP_CONFIG.servers).toHaveLength(1);
    expect(DEFAULT_MCP_CONFIG.servers[0]).toEqual(CONTEXT_MODE_SERVER);
    expect(CONTEXT_MODE_SERVER.command).toBe("npx");
    expect(CONTEXT_MODE_SERVER.args).toEqual(["-y", "context-mode"]);
    expect(CONTEXT_MODE_SERVER.enabled).toBe(false);
  });

  it("默认配置本身能通过校验", () => {
    expect(validateMcpConfigFile(DEFAULT_MCP_CONFIG)).toBeNull();
  });
});

describe("validateMcpServerConfig：注册表就是白名单", () => {
  it("合法配置放行", () => {
    expect(validateMcpServerConfig(server())).toBeNull();
    expect(validateMcpServerConfig(server({ name: "my-server_1", command: "uvx", args: ["mcp-server"] }))).toBeNull();
  });

  it("服务器名非法：大写、数字开头、空、超长", () => {
    expect(validateMcpServerConfig(server({ name: "Context-Mode" }))).toMatch(/服务器名非法/);
    expect(validateMcpServerConfig(server({ name: "1abc" }))).toMatch(/服务器名非法/);
    expect(validateMcpServerConfig(server({ name: "" }))).toMatch(/服务器名非法/);
    expect(validateMcpServerConfig(server({ name: "a".repeat(33) }))).toMatch(/服务器名非法/);
  });

  it("启动命令带路径直接拒绝", () => {
    expect(validateMcpServerConfig(server({ command: "/usr/bin/npx" }))).toMatch(/裸命令名/);
    expect(validateMcpServerConfig(server({ command: "C:\\node\\npx" }))).toMatch(/裸命令名/);
    expect(validateMcpServerConfig(server({ command: "./npx" }))).toMatch(/裸命令名/);
  });

  it("启动命令与参数里的 shell 元字符直接拒绝", () => {
    expect(validateMcpServerConfig(server({ command: "npx;rm" }))).toMatch(/shell 元字符/);
    expect(validateMcpServerConfig(server({ command: "npx|sh" }))).toMatch(/shell 元字符/);
    expect(validateMcpServerConfig(server({ args: ["-y", "context-mode;curl x"] }))).toMatch(/shell 元字符/);
    expect(validateMcpServerConfig(server({ args: ["-y", "context-mode$(id)"] }))).toMatch(/shell 元字符/);
    expect(validateMcpServerConfig(server({ args: ["x\ny"] }))).toMatch(/shell 元字符|控制字符/);
  });

  it("凭据类环境变量名直接拒绝", () => {
    expect(validateMcpServerConfig(server({ env: { API_KEY: "x" } }))).toMatch(/凭据/);
    expect(validateMcpServerConfig(server({ env: { GITHUB_TOKEN: "x" } }))).toMatch(/凭据/);
    expect(validateMcpServerConfig(server({ env: { MY_SECRET: "x" } }))).toMatch(/凭据/);
    expect(validateMcpServerConfig(server({ env: { DB_PASSWORD: "x" } }))).toMatch(/凭据/);
  });

  it("环境变量名只认大写，非凭据的普通变量放行", () => {
    expect(validateMcpServerConfig(server({ env: { NODE_ENV: "production" } }))).toBeNull();
    expect(validateMcpServerConfig(server({ env: { node_env: "x" } }))).toMatch(/环境变量名非法/);
  });

  it("enabled 不是布尔值拒绝", () => {
    expect(validateMcpServerConfig(server({ enabled: "yes" }))).toMatch(/enabled 必须是布尔值/);
  });
});

describe("validateMcpConfigFile", () => {
  it("服务器名重复拒绝", () => {
    expect(validateMcpConfigFile({ servers: [server(), server()] })).toMatch(/重复/);
  });

  it("超过 16 台拒绝", () => {
    const servers = Array.from({ length: 17 }, (_, i) => server({ name: `s${i}` }));
    expect(validateMcpConfigFile({ servers })).toMatch(/太多/);
  });
});

describe("mcpToolName：命名空间", () => {
  it("context-mode 的工具拼成 mcp_context_mode_ctx_search", () => {
    expect(mcpToolName("context-mode", "ctx_search")).toBe("mcp_context_mode_ctx_search");
  });

  it("非法字符变下划线，不留首尾下划线", () => {
    expect(mcpToolName("my.server", "ctx/search")).toBe("mcp_my_server_ctx_search");
  });

  it("超 64 字符截断", () => {
    expect(mcpToolName("a".repeat(40), "b".repeat(40)).length).toBeLessThanOrEqual(64);
  });
});

describe("buildMcpSpecs：重名不静默覆盖", () => {
  const tool = (name: string): McpTool => ({ name, description: "", inputSchema: { type: "object" } });

  it("多服务器的工具拼成一张清单", () => {
    const { specs, errors } = buildMcpSpecs([
      { server: "context-mode", tools: [tool("ctx_search"), tool("ctx_index")] },
      { server: "other", tools: [tool("do_thing")] },
    ]);
    expect(errors).toEqual([]);
    expect(specs.map((s) => s.name)).toEqual([
      "mcp_context_mode_ctx_search",
      "mcp_context_mode_ctx_index",
      "mcp_other_do_thing",
    ]);
    expect(specs[0].server).toBe("context-mode");
    expect(specs[0].tool).toBe("ctx_search");
  });

  it("重名时只留第一个，多的记进 errors", () => {
    const { specs, errors } = buildMcpSpecs([
      { server: "a-b", tools: [tool("x")] },
      { server: "a_b", tools: [tool("x")] },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].server).toBe("a-b");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/冲突/);
  });
});

describe("mcpToolDef：描述里写明边界", () => {
  it("描述带服务器来源与默认 Ask 说明，不再自承权限旁路", () => {
    const def = mcpToolDef(spec());
    expect(def.function.name).toBe("mcp_context_mode_ctx_search");
    expect(def.function.description).toMatch(/context-mode/);
    expect(def.function.description).toMatch(/默认需要用户逐次确认|Ask/);
    expect(def.function.description).toMatch(/Rust 侧授权闸门/);
    expect(def.function.description).not.toMatch(/不受本程序受控执行白名单约束/);
    expect(def.function.parameters).toEqual(spec().parameters);
  });

  it("mcpToolDefs 批量派生", () => {
    expect(mcpToolDefs([spec(), spec({ name: "mcp_context_mode_ctx_index", tool: "ctx_index" })])).toHaveLength(2);
  });
});

describe("validateMcpToolArgs：浅层校验", () => {
  it("必填缺失、类型不对、未知参数都拒绝", () => {
    expect(validateMcpToolArgs(spec(), {})).toMatch(/缺少必填参数：query/);
    expect(validateMcpToolArgs(spec(), { query: 123 })).toMatch(/类型不对，应为 string/);
    expect(validateMcpToolArgs(spec(), { query: "x", limit: 1.5 })).toMatch(/类型不对，应为 integer/);
    expect(validateMcpToolArgs(spec(), { query: "x", nope: 1 })).toMatch(/不接受未知参数：nope/);
  });

  it("合法参数放行", () => {
    expect(validateMcpToolArgs(spec(), { query: "hello", limit: 5 })).toBeNull();
  });
});

describe("MCP 工具不进探索与子代理", () => {
  it("探索模式与子代理的工具定义里没有 mcp_ 工具", () => {
    for (const def of [...exploreToolDefs(), ...subagentToolDefs()]) {
      expect(def.function.name.startsWith("mcp_")).toBe(false);
    }
  });

  it("动态工具拼进正常模式的定义后，探索模式用的仍是三件套", () => {
    expect(exploreToolDefs()).toHaveLength(3);
  });
});

/** ADR 0004：默认 Ask 之后，调用参数带一整套假审批通道。
 *  「直接成功的 call」代表 Rust 侧已有会话级授权；单个用例按需覆盖。 */
type McpOpts = Parameters<typeof executeMcpToolCall>[0];
const SCOPE = ["mcp", "context-mode", "ctx_search"];

function mcpOpts(over: Partial<McpOpts> = {}): McpOpts {
  return {
    name: spec().name,
    args: { query: "x" },
    specs: [spec()],
    planMode: false,
    exploreMode: false,
    scope: SCOPE,
    ask: vi.fn().mockResolvedValue("session"),
    grant: vi.fn().mockResolvedValue(undefined),
    call: async (server: string, tool: string) => `${server}/${tool} ok`,
    ...over,
  } as McpOpts;
}

/** Rust 闸门回传的 need_grant 错误（与 perms::GateDenied::to_json 同形）。 */
function needGrant(): string {
  return JSON.stringify({
    kind: "need_grant",
    scope: SCOPE,
    label: "MCP context-mode/ctx_search",
  });
}

describe("executeMcpToolCall：分发 + 默认 Ask", () => {
  it("已有会话授权时直接返回结果，不弹框", async () => {
    const ask = vi.fn();
    const out = await executeMcpToolCall(mcpOpts({ ask }));
    expect(out.result).toContain("ok");
    expect(ask).not.toHaveBeenCalled();
  });

  it("未知工具直接拒绝，不调服务器", async () => {
    const call = vi.fn();
    const out = await executeMcpToolCall(mcpOpts({ name: "mcp_nope_x", call }));
    expect(out.error).toMatch(/未知工具/);
    expect(call).not.toHaveBeenCalled();
  });

  it("计划模式与探索模式在审批之前就拦截", async () => {
    const ask = vi.fn();
    const plan = await executeMcpToolCall(mcpOpts({ planMode: true, ask }));
    expect(plan.error).toMatch(/计划模式已拦截/);
    const explore = await executeMcpToolCall(mcpOpts({ exploreMode: true, ask }));
    expect(explore.error).toMatch(/探索模式已拦截/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("参数校验失败不调服务器", async () => {
    const call = vi.fn();
    const out = await executeMcpToolCall(mcpOpts({ args: {}, call }));
    expect(out.error).toMatch(/缺少必填参数/);
    expect(call).not.toHaveBeenCalled();
  });

  it("成功时返回结果，超长截断并注明", async () => {
    const out = await executeMcpToolCall(mcpOpts({ call: async () => "y".repeat(30000) }));
    expect(out.result).toMatch(/工具输出已截断/);
    expect(out.result!.length).toBeLessThan(30000);
  });

  it("服务器抛非授权错误时转成 error，不抛异常、也不弹框", async () => {
    const ask = vi.fn();
    const out = await executeMcpToolCall(
      mcpOpts({
        ask,
        call: async () => {
          throw new Error("MCP 服务器 context-mode 无响应");
        },
      })
    );
    expect(out.error).toMatch(/无响应/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("Rust 回 need_grant → 问用户 → 记账 → 重试成功", async () => {
    const call = vi.fn().mockRejectedValueOnce(needGrant()).mockResolvedValueOnce("ok");
    const ask = vi.fn().mockResolvedValue("once");
    const grant = vi.fn().mockResolvedValue(undefined);
    const out = await executeMcpToolCall(mcpOpts({ call, ask, grant }));
    expect(out.result).toBe("ok");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({
      server: "context-mode",
      tool: "ctx_search",
      scope: SCOPE,
    });
    // once = 只授权 1 次；scope 用 Rust 回传的那份，不自己另拼
    expect(grant).toHaveBeenCalledWith(SCOPE, 1, "MCP context-mode/ctx_search");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("用户 deny → 不重试、不记账，返回拒绝错误", async () => {
    const call = vi.fn().mockRejectedValue(needGrant());
    const grant = vi.fn();
    const out = await executeMcpToolCall(mcpOpts({ call, grant, ask: vi.fn().mockResolvedValue("deny") }));
    expect(out.error).toMatch(/用户拒绝/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(grant).not.toHaveBeenCalled();
  });

  it("审批通道缺失 → fail-closed，绝不调用服务器", async () => {
    const call = vi.fn().mockResolvedValue("不该被调用");
    const out = await executeMcpToolCall(
      mcpOpts({ call, ask: undefined, grant: undefined })
    );
    expect(out.error).toMatch(/审批通道不可用/);
    expect(call).not.toHaveBeenCalled();
  });

  it("重复 need_grant → 最多 3 轮后停止，不死循环", async () => {
    const call = vi.fn().mockRejectedValue(needGrant());
    const ask = vi.fn().mockResolvedValue("session");
    const grant = vi.fn().mockResolvedValue(undefined);
    const out = await executeMcpToolCall(mcpOpts({ call, ask, grant }));
    expect(out.error).toMatch(/多次授权/);
    expect(call).toHaveBeenCalledTimes(3);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("授权记账失败 → 报错，不再重试调用", async () => {
    const call = vi.fn().mockRejectedValue(needGrant());
    const grant = vi.fn().mockRejectedValue(new Error("Rust 记账失败"));
    const out = await executeMcpToolCall(mcpOpts({ call, grant }));
    expect(out.error).toMatch(/MCP 授权记账失败/);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("parseMcpGrantRequired：闸门错误通道", () => {
  it("认 Rust 回传的 JSON 字符串", () => {
    expect(parseMcpGrantRequired(needGrant())).toEqual({
      scope: SCOPE,
      label: "MCP context-mode/ctx_search",
    });
  });

  it("也认前端已转换的 ExecGrantRequired 形态", () => {
    expect(
      parseMcpGrantRequired({ name: "ExecGrantRequired", scope: SCOPE, label: "MCP a/x" })
    ).toEqual({ scope: SCOPE, label: "MCP a/x" });
  });

  it("普通错误 / 非法 JSON 返回 null", () => {
    expect(parseMcpGrantRequired(new Error("无响应"))).toBeNull();
    expect(parseMcpGrantRequired("{ not json")).toBeNull();
    expect(parseMcpGrantRequired(JSON.stringify({ kind: "refused", reason: "x" }))).toBeNull();
  });
});

describe("executeMcpToolCall：取消信号贯穿（独立复审 P1-1）", () => {
  it("signal 已中止 → 不调服务器、不弹审批，直接返回取消错误", async () => {
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn();
    const ask = vi.fn();
    const out = await executeMcpToolCall(mcpOpts({ signal: controller.signal, call, ask }));
    expect(out.error).toMatch(/已停止/);
    expect(call).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("审批框挂起时 abort → 立刻收摊，不重试、不记账、不死锁", async () => {
    const controller = new AbortController();
    const call = vi.fn().mockRejectedValue(needGrant());
    let settleAsk!: (v: "session") => void;
    const ask = vi.fn().mockImplementation(() => new Promise<"session">((r) => { settleAsk = r; }));
    const grant = vi.fn();
    const p = executeMcpToolCall(mcpOpts({ signal: controller.signal, call, ask, grant }));
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const out = await p;
    expect(out.error).toMatch(/已停止/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(grant).not.toHaveBeenCalled();
    settleAsk("session"); // 晚到的人点「允许」不能让已停止的调用继续
  });

  it("call 返回后才发现已停止 → 不把结果交给模型", async () => {
    const controller = new AbortController();
    const call = vi.fn().mockImplementation(async () => {
      controller.abort();
      return "ok";
    });
    const out = await executeMcpToolCall(mcpOpts({ signal: controller.signal, call }));
    expect(out.error).toMatch(/已停止/);
  });
});

describe("executeMcpToolCall：IO 挂起时也能被停止结算（第二轮复审）", () => {
  it("call 挂起 60s 时 abort → 前端立刻收摊，不死锁", async () => {
    const controller = new AbortController();
    const call = vi.fn().mockImplementation(() => new Promise<string>(() => {}));
    const p = executeMcpToolCall(mcpOpts({ signal: controller.signal, call }));
    await Promise.resolve();
    controller.abort();
    const out = await p;
    expect(out.error).toMatch(/已停止/);
  });

  it("grant 挂起时 abort → 不重试，立刻收摊", async () => {
    const controller = new AbortController();
    const call = vi.fn().mockRejectedValue(needGrant());
    const grant = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    const p = executeMcpToolCall(mcpOpts({
      signal: controller.signal,
      call,
      grant,
      ask: vi.fn().mockResolvedValue("session"),
    }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const out = await p;
    expect(out.error).toMatch(/已停止/);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
