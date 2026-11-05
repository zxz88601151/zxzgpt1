import { describe, expect, it } from "vitest";
import { exploreToolDefs, subagentToolDefs } from "./registry";
import {
  buildMcpSpecs,
  CONTEXT_MODE_SERVER,
  DEFAULT_MCP_CONFIG,
  executeMcpToolCall,
  mcpToolDef,
  mcpToolDefs,
  mcpToolName,
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
  it("描述带服务器来源与沙箱边界说明", () => {
    const def = mcpToolDef(spec());
    expect(def.function.name).toBe("mcp_context_mode_ctx_search");
    expect(def.function.description).toMatch(/context-mode/);
    expect(def.function.description).toMatch(/不受本程序受控执行白名单约束/);
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

describe("executeMcpToolCall：分发", () => {
  const call = async (server: string, tool: string) => `${server}/${tool} ok`;

  it("未知工具直接拒绝，不调服务器", async () => {
    const out = await executeMcpToolCall({
      name: "mcp_nope_x",
      args: {},
      specs: [spec()],
      planMode: false,
      exploreMode: false,
      call,
    });
    expect(out.error).toMatch(/未知工具/);
  });

  it("计划模式与探索模式都拦截", async () => {
    const plan = await executeMcpToolCall({
      name: spec().name,
      args: { query: "x" },
      specs: [spec()],
      planMode: true,
      exploreMode: false,
      call,
    });
    expect(plan.error).toMatch(/计划模式已拦截/);
    const explore = await executeMcpToolCall({
      name: spec().name,
      args: { query: "x" },
      specs: [spec()],
      planMode: false,
      exploreMode: true,
      call,
    });
    expect(explore.error).toMatch(/探索模式已拦截/);
  });

  it("参数校验失败不调服务器", async () => {
    const out = await executeMcpToolCall({
      name: spec().name,
      args: {},
      specs: [spec()],
      planMode: false,
      exploreMode: false,
      call,
    });
    expect(out.error).toMatch(/缺少必填参数/);
  });

  it("成功时返回结果，超长截断并注明", async () => {
    const out = await executeMcpToolCall({
      name: spec().name,
      args: { query: "x" },
      specs: [spec()],
      planMode: false,
      exploreMode: false,
      call: async () => "y".repeat(30000),
    });
    expect(out.result).toMatch(/工具输出已截断/);
    expect(out.result!.length).toBeLessThan(30000);
  });

  it("服务器抛错时转成 error，不抛异常", async () => {
    const out = await executeMcpToolCall({
      name: spec().name,
      args: { query: "x" },
      specs: [spec()],
      planMode: false,
      exploreMode: false,
      call: async () => {
        throw new Error("MCP 服务器 context-mode 无响应");
      },
    });
    expect(out.error).toMatch(/无响应/);
  });
});
