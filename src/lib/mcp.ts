/** MCP 客户端（前端侧）：插件/服务器注册表、工具动态注入与调用分发。
 *
 * 这是自研插件系统的第一块，只做一件事：让 ZXZGPT 能以 MCP 客户端的身份
 * 连上本地 MCP 服务器（第一个是 context-mode），把服务器提供的工具
 * （ctx_execute、ctx_index、ctx_search 等）当成模型可用工具。
 *
 * 分层（与 Rust 侧一一对应，职责不越界）：
 *   - Rust `src-tauri/src/mcp.rs`：拉子进程、走 JSON-RPC over stdio、
 *     握手、超时、杀进程、读写 mcp.json 配置文件。前端永远不直接 spawn。
 *   - 本文件：注册表类型与校验、工具名命名空间、参数校验、调用分发、
 *     以及对 Rust 命令的 invoke 封装。
 *
 * 安全边界（读之前先看这三条，改代码时别顺手放宽）：
 *   1. 启动命令白名单就是注册表本身：Rust 只接受注册表里用户明确配置过
 *      的命令启动服务器；模型与对话内容传不进来启动命令——没有任何模型
 *      工具能调到 `mcp_start`，只有 App 里「读配置 → 按 enabled 启动」
 *      这一条调用路径。
 *   2. context-mode 自带沙箱、自己跑命令，这是一条独立于 ZXZGPT 受控执行
 *      白名单之外的命令通道。所以 MCP 工具在前端一律按 `exec` 级对待：
 *      计划模式拦、探索模式拦、并行调度里串行（见 `isParallelSafeTool`，
 *      MCP 名字不在内置注册表里，默认落到闸控层）；工具描述里也写明了
 *      这一点，让模型与人都能看到。
 *   3. 凭据不进 MCP 配置：`validateMcpServerConfig` 直接拒绝 KEY / TOKEN /
 *      SECRET / PASSWORD / AUTH / CREDENTIAL 这类环境变量名；context-mode
 *      本身不需要 API Key，需要凭据的服务器走现有凭据机制（本批不做）。
 *
 * 本批不做（别顺手扩）：输出拦截/hooks 层、插件市场/安装/更新、skills
 * 加载、UI 管理页、MCP over HTTP/SSE、P0 审计日志集成、Windows 真机验证。
 */

import { EXPLORE_TOOL_NAMES, type ToolRunResult } from "./registry";
import { truncateToolOutput, type ToolDefinition } from "./tools";
import { waitAbortable } from "./abort";

/** 一台 MCP 服务器的注册信息：存在 mcp.json 配置文件里（Rust 侧读写）。 */
export interface McpServerConfig {
  /** 注册名，只允许小写字母、数字、-、_，首字符小写字母；同时是工具名前缀 */
  name: string;
  /** 启动命令：只允许 PATH 上的裸命令名，不接受路径与 shell 元字符 */
  command: string;
  /** 启动参数，如 context-mode 的 ["-y", "context-mode"] */
  args: string[];
  /** 附加环境变量：只允许大写键，凭据类键直接拒绝（见 validateMcpServerConfig） */
  env: Record<string, string>;
  /** 启用开关：默认 false，用户显式改成 true 才拉起子进程 */
  enabled: boolean;
}

/** mcp.json 的文件结构：目前只有服务器列表，没有别的字段。 */
export interface McpConfigFile {
  servers: McpServerConfig[];
}

/** 默认内置的唯一服务器：context-mode（MCP-only 模式，官方安装命令就是它）。
 *
 *  `npx -y context-mode` 是 context-mode 的 stdio MCP 服务器入口
 * （`claude mcp add context-mode -- npx -y context-mode` 同款），提供 11 个
 * ctx_* 工具：6 个沙箱工具（ctx_batch_execute、ctx_execute、ctx_execute_file、
 * ctx_index、ctx_search、ctx_fetch_and_index）+ 5 个元工具（ctx_stats、
 * ctx_doctor、ctx_upgrade、ctx_purge、ctx_insight）。前置要求 Node 24.15+，
 * 未装或版本过低时 Rust 侧启动前置检查会直接报人话错误，不会静默失败。
 */
export const CONTEXT_MODE_SERVER: McpServerConfig = {
  name: "context-mode",
  command: "npx",
  args: ["-y", "context-mode"],
  env: {},
  enabled: false,
};

/** 缺省配置：只有 context-mode 一项，且默认关闭。 */
export const DEFAULT_MCP_CONFIG: McpConfigFile = { servers: [CONTEXT_MODE_SERVER] };

/** 服务器返回的单个工具（tools/list 的原始形态）。 */
export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema（inputSchema），原样发给模型 */
  inputSchema: Record<string, unknown>;
}

/** 服务器运行状态（mcp_status 的返回形态）。 */
export interface McpServerStatus {
  name: string;
  running: boolean;
  /** 已缓存的工具数（未 list 时为 0） */
  tools: number;
  /** 失败原因：有值表示服务器已挂（超时/崩溃/握手失败），需要重新开启 */
  error?: string | null;
}

/** 发给模型用的动态工具：名字是命名空间化的，执行时按 server/tool 反查。 */
export interface McpToolSpec {
  /** 发给模型的名字：mcp_<server>_<tool>，精确匹配，不做归一化 */
  name: string;
  /** 注册表里的服务器名 */
  server: string;
  /** 服务器原生的工具名 */
  tool: string;
  description: string;
  /** 服务器给的 inputSchema，原样发给模型 */
  parameters: Record<string, unknown>;
}

/* ------------------------------------------------------------ 校验 */

const SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
/** 凭据类环境变量名：命中即拒绝，凭据不得写进 MCP 配置 */
const SECRET_ENV_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)/;
/** 与 Rust `runx.rs` 的 has_shell_meta 同款字符集：启动命令与参数里一个都不能有。
 *  注意：参数里的 `-y` 这类正常 flag 不受影响，只有这些元字符被拦。 */
const SHELL_META = /[;|&$`\\\n\r<>^%!"'()]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function hasControlChars(s: string): boolean {
  return /[\0\n\r]/.test(s);
}

/**
 * 注册表项校验：返回 null 表示合法，否则是给人看的中文原因。
 *
 * 与 Rust `mcp.rs` 的 validate_server_config 是同一套规则（两边各一份，
 * 前端提前拦截、Rust 执行时必然重查——前端校验永远不能代替 Rust 校验，
 * 改一边就要改另一边）。
 */
export function validateMcpServerConfig(cfg: unknown): string | null {
  if (!isRecord(cfg)) return "MCP 服务器配置必须是对象";
  if (typeof cfg.name !== "string" || !SERVER_NAME_RE.test(cfg.name)) {
    return "MCP 服务器名非法：只允许小写字母、数字、-、_，首字符为小写字母，最长 32 字符";
  }
  if (typeof cfg.command !== "string" || !cfg.command) return `MCP 服务器 ${cfg.name} 需要启动命令`;
  if (cfg.command.length > 64) return `MCP 服务器 ${cfg.name} 的启动命令太长（上限 64 字符）`;
  if (cfg.command.includes("/") || cfg.command.includes("\\")) {
    return `MCP 服务器 ${cfg.name} 的启动命令必须是 PATH 上的裸命令名，不接受路径`;
  }
  if (SHELL_META.test(cfg.command) || hasControlChars(cfg.command)) {
    return `MCP 服务器 ${cfg.name} 的启动命令含 shell 元字符或控制字符，已拒绝`;
  }
  if (!Array.isArray(cfg.args)) return `MCP 服务器 ${cfg.name} 的 args 必须是数组`;
  if (cfg.args.length > 32) return `MCP 服务器 ${cfg.name} 的启动参数太多（上限 32 个）`;
  for (const a of cfg.args as unknown[]) {
    if (typeof a !== "string") return `MCP 服务器 ${cfg.name} 的启动参数必须是字符串`;
    if (a.length > 512) return `MCP 服务器 ${cfg.name} 的启动参数太长（上限 512 字符）`;
    if (SHELL_META.test(a) || hasControlChars(a)) {
      return `MCP 服务器 ${cfg.name} 的启动参数含 shell 元字符或控制字符，已拒绝`;
    }
  }
  if (cfg.env !== undefined && !isRecord(cfg.env)) return `MCP 服务器 ${cfg.name} 的 env 必须是对象`;
  const env = (cfg.env ?? {}) as Record<string, unknown>;
  if (Object.keys(env).length > 16) return `MCP 服务器 ${cfg.name} 的环境变量太多（上限 16 个）`;
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) return `MCP 服务器 ${cfg.name} 的环境变量名非法：${k}（只允许大写字母、数字、下划线）`;
    if (SECRET_ENV_KEY_RE.test(k)) {
      return `MCP 服务器 ${cfg.name} 的环境变量 ${k} 看起来像凭据（KEY/TOKEN/SECRET/PASSWORD 等），凭据不得写进 MCP 配置，context-mode 本身也不需要 API Key`;
    }
    if (typeof v !== "string") return `MCP 服务器 ${cfg.name} 的环境变量 ${k} 必须是字符串`;
    if (v.length > 1024) return `MCP 服务器 ${cfg.name} 的环境变量 ${k} 太长（上限 1024 字符）`;
    if (hasControlChars(v)) return `MCP 服务器 ${cfg.name} 的环境变量 ${k} 含控制字符，已拒绝`;
  }
  if (typeof cfg.enabled !== "boolean") return `MCP 服务器 ${cfg.name} 的 enabled 必须是布尔值`;
  return null;
}

/** 整个配置文件的校验：服务器名唯一、总数上限 16。 */
export function validateMcpConfigFile(cfg: unknown): string | null {
  if (!isRecord(cfg)) return "MCP 配置文件必须是对象";
  if (!Array.isArray(cfg.servers)) return "MCP 配置文件需要 servers 数组";
  if (cfg.servers.length > 16) return "MCP 服务器太多（上限 16 个）";
  const seen = new Set<string>();
  for (const s of cfg.servers as unknown[]) {
    const bad = validateMcpServerConfig(s);
    if (bad) return bad;
    const name = (s as McpServerConfig).name;
    if (seen.has(name)) return `MCP 服务器名重复：${name}`;
    seen.add(name);
  }
  return null;
}

/* ------------------------------------------------------------ 命名空间 */

/**
 * 工具名命名空间：`mcp_<server>_<tool>`。
 *
 * 只做清洗不做语义映射：非法字符变 `_`、连续 `_` 合并、首尾 `_` 去掉；
 * 超 64 字符截断（上游对工具名长度有限制，截断比发一个超长名被拒要好，
 * 截断后重名的风险由 `buildMcpSpecs` 的重名检查兜住）。
 * 执行时按 spec.name 精确匹配，不做反向解析，所以清洗不可逆也没关系。
 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) =>
    s
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  const name = `mcp_${clean(server)}_${clean(tool)}`;
  return name.length > 64 ? name.slice(0, 64) : name;
}

/**
 * 把各服务器的 tools/list 结果拼成发给模型的动态工具清单。
 *
 * 重名（两个服务器的工具洗成同一个名字）时只留第一个，多的记进 errors——
 * 静默覆盖等于模型调 A 却跑到 B，必须说出来。
 */
export function buildMcpSpecs(
  serverTools: { server: string; tools: McpTool[] }[]
): { specs: McpToolSpec[]; errors: { server: string; error: string }[] } {
  const specs: McpToolSpec[] = [];
  const errors: { server: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const { server, tools } of serverTools) {
    for (const t of tools) {
      const name = mcpToolName(server, t.name);
      if (seen.has(name)) {
        errors.push({ server, error: `工具名冲突，已跳过：${name}（与另一服务器的工具重名）` });
        continue;
      }
      seen.add(name);
      specs.push({
        name,
        server,
        tool: t.name,
        description: t.description,
        parameters: t.inputSchema,
      });
    }
  }
  return { specs, errors };
}

/**
 * 发给模型的函数声明。描述里固定带一句边界说明：
 * MCP 工具默认需要用户逐次确认（Ask），由 Rust 侧授权闸门记账——
 * 模型与人都应该在调之前就看到这句话，而不是在出事之后才知道。
 *
 * 旧文案写着「不受本程序受控执行白名单约束」，那是在自承存在权限旁路；
 * ADR 0004 把 MCP 纳入统一策略视图后，这句话已经不成立，必须改掉。
 */
export function mcpToolDef(spec: McpToolSpec): ToolDefinition {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: `${spec.description || spec.tool}（MCP 插件工具，来自 ${spec.server} 服务器：默认需要用户逐次确认（Ask），由 Rust 侧授权闸门记账；计划模式与探索模式下不可用）`,
      parameters: spec.parameters,
    },
  };
}

/** 动态工具清单对应的函数声明（tools() 里拼到 TOOL_DEFS 后面）。 */
export function mcpToolDefs(specs: McpToolSpec[]): ToolDefinition[] {
  return specs.map(mcpToolDef);
}

/* ------------------------------------------------------------ 参数校验 */

/**
 * 按服务器给的 inputSchema 做浅层校验：必填、类型、additionalProperties。
 *
 * 只做一层（properties 的 type），不做全量 JSON Schema 校验：嵌套对象的
 * 内部结构由服务器自己在 tools/call 时再拒绝，前端这里只拦住「缺必填」
 * 与「类型明显不对」这两类模型最常犯的错。
 */
export function validateMcpToolArgs(spec: McpToolSpec, args: Record<string, unknown>): string | null {
  const schema = spec.parameters;
  if (!isRecord(schema)) return null;
  const props = isRecord(schema.properties) ? (schema.properties as Record<string, Record<string, unknown>>) : {};
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (!(key in args)) return `${spec.name} 缺少必填参数：${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `${spec.name} 不接受未知参数：${key}`;
      continue;
    }
    const t = prop.type;
    if (typeof t !== "string") continue;
    const ok =
      t === "string"
        ? typeof value === "string"
        : t === "number"
          ? typeof value === "number" && !Number.isNaN(value)
          : t === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : t === "boolean"
              ? typeof value === "boolean"
              : t === "object"
                ? Boolean(value) && typeof value === "object" && !Array.isArray(value)
                : t === "array"
                  ? Array.isArray(value)
                  : true;
    if (!ok) return `${spec.name} 的参数 ${key} 类型不对，应为 ${t}`;
  }
  return null;
}

/* ------------------------------------------------------------ 调用分发 */

/** 审批选择。与 `components/ConfirmExec.tsx` 的 ExecChoice 同形，避免反向依赖 UI。 */
export type McpApprovalChoice = "once" | "session" | "deny";

export interface McpApprovalRequest {
  server: string;
  tool: string;
  label: string;
  scope: string[];
}

/**
 * 从 Rust 闸门错误里还原 `need_grant`。Rust 用 JSON 字符串回传（与 exec 同款），
 * 前端也可能已经把它转成带 `name/scope/label` 的 Error；两种形态都认。
 */
export function parseMcpGrantRequired(e: unknown): { scope: string[]; label: string } | null {
  if (e && typeof e === "object") {
    const x = e as { name?: unknown; scope?: unknown; label?: unknown };
    if (x.name === "ExecGrantRequired") {
      return {
        scope: Array.isArray(x.scope) ? x.scope.map(String) : [],
        label: typeof x.label === "string" ? x.label : "",
      };
    }
  }
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  if (!text.trim().startsWith("{")) return null;
  try {
    const j = JSON.parse(text) as { kind?: unknown; scope?: unknown; label?: unknown };
    if (j.kind !== "need_grant") return null;
    return {
      scope: Array.isArray(j.scope) ? j.scope.map(String) : [],
      label: typeof j.label === "string" ? j.label : "",
    };
  } catch {
    return null;
  }
}

export function mcpErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e ?? "未知错误");
}

/**
 * 执行一次 MCP 工具调用（App.tsx 的 `executeTool` 在统一策略视图判定为 mcp 后走这里）。
 *
 * ADR 0004：查动态清单（精确匹配）→ 计划/探索拦截 → 校验参数 → **默认 Ask**。
 * 授权链与 `run_command` 同构：先调 Rust，未授权时 `guard_mcp` 回 `need_grant`，
 * 前端问用户 → `perm_grant` 记账 → 重试。Rust 侧是权威，前端弹框只是体验；
 * 会话级授权批准过之后首次调用直接放行，不会反复骚扰。
 *
 * **fail-closed**：审批通道缺失、用户拒绝、重试超限、记账失败，都不允许调到
 * tools/call。本函数自己不抛异常：失败一律以 `{ error }` 回去。
 */
export async function executeMcpToolCall(opts: {
  name: string;
  args: Record<string, unknown>;
  specs: McpToolSpec[];
  planMode: boolean;
  exploreMode: boolean;
  /** Rust 侧授权 scope，由调用方按 `mcpScope(server, tool)` 生成 */
  scope: string[];
  /** 主链路取消信号：审批框等待中用户点「停止」时立刻以 deny 结算（复审 P1-1）。 */
  signal?: AbortSignal;
  /** 问用户。App 注入 askExec */
  ask: (req: McpApprovalRequest) => Promise<McpApprovalChoice>;
  /** 记账。App 注入 permGrant，写进 Rust 侧同一张授权表 */
  grant: (scope: string[], uses: number | null, label: string) => Promise<void>;
  call: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<ToolRunResult> {
  const spec = opts.specs.find((s) => s.name === opts.name);
  if (!spec) return { error: `未知工具：${opts.name}` };
  if (opts.planMode) return { error: "计划模式已拦截：本轮只出方案，不写文件、不跑命令" };
  if (opts.exploreMode) {
    return { error: `探索模式已拦截：只读的探索助手只能调 ${EXPLORE_TOOL_NAMES.join("、")}` };
  }
  const bad = validateMcpToolArgs(spec, opts.args);
  if (bad) return { error: bad };
  if (typeof opts.ask !== "function" || typeof opts.grant !== "function") {
    return { error: "MCP 工具需要用户授权，但审批通道不可用，已拒绝调用" };
  }

  const defaultLabel = `MCP ${spec.server}/${spec.tool}`;
  for (let attempt = 0; ; attempt++) {
    // 每一轮（含重试）都先看停止：已停止就绝不碰服务器，也不再弹审批框。
    if (opts.signal?.aborted) return { error: "已停止：MCP 工具调用已取消" };
    try {
      // Rust 的 tools/call 有 60s spawn_blocking 超时，前端无法中断它；
      // 但至少不能让 await 把发送流程挂死——signal 一到就以空串结算，
      // 紧接着的 aborted 检查把这一轮收掉。Rust 侧进程会自己超时结束（已知限制）。
      const text = await waitAbortable(
        opts.call(spec.server, spec.tool, opts.args),
        opts.signal,
        "",
      );
      if (opts.signal?.aborted) return { error: "已停止：MCP 工具调用已取消" };
      return { result: truncateToolOutput(text) };
    } catch (e) {
      const need = parseMcpGrantRequired(e);
      if (!need) return { error: mcpErrorMessage(e) };
      if (opts.signal?.aborted) return { error: "已停止：MCP 工具调用已取消" };
      if (attempt >= 2) return { error: "多次授权后仍无法执行 MCP 工具，已停止重试" };
      const label = need.label || defaultLabel;
      const scope = need.scope.length ? need.scope : opts.scope;
      // ask() 只有人点按钮才 resolve；主链路 abort 时必须由 signal 兜底结算，
      // 否则 runToolBatch 的串行层永远等不到它，runRounds 的 finally 不复位 busy。
      const choice = await waitAbortable(
        opts.ask({ server: spec.server, tool: spec.tool, label, scope }),
        opts.signal,
        "deny",
      );
      if (opts.signal?.aborted) return { error: "已停止：MCP 工具调用已取消" };
      if (choice === "deny") return { error: "用户拒绝了这次 MCP 工具调用" };
      try {
        await waitAbortable(
          opts.grant(scope, choice === "once" ? 1 : null, label),
          opts.signal,
          undefined,
        );
        if (opts.signal?.aborted) return { error: "已停止：MCP 工具调用已取消" };
      } catch (grantErr) {
        if (opts.signal?.aborted) return { error: "已停止：MCP 工具调用已取消" };
        return { error: `MCP 授权记账失败：${mcpErrorMessage(grantErr)}` };
      }
      // 授权已记进 Rust 侧，下一轮 call 会过闸门；最多 3 轮防死循环
    }
  }
}

/* ------------------------------------------------------------ Rust 命令封装 */

interface Internals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function internals(): Internals | null {
  const i = (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;
  return i && typeof i.invoke === "function" ? i : null;
}

/** MCP 只在桌面端可用（浏览器直开没有 Rust 侧，自然也没有子进程可拉）。 */
export function mcpAvailable(): boolean {
  return internals() !== null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const inv = internals();
  if (!inv) throw new Error("MCP 只在桌面端可用");
  return (await inv.invoke(cmd, args)) as T;
}

/** 读 mcp.json（文件不存在时 Rust 侧写一份默认配置再返回）。 */
export async function mcpConfigRead(): Promise<{ path: string; servers: McpServerConfig[] }> {
  return call<{ path: string; servers: McpServerConfig[] }>("mcp_config_read");
}

/** 保存整份 mcp.json（Rust 侧解析 + 校验后原子写入，不合法直接拒绝）。 */
export async function mcpConfigSave(servers: McpServerConfig[]): Promise<void> {
  await call("mcp_config_save", { content: JSON.stringify({ servers }, null, 2) });
}

/** 启动一台服务器（带握手；已在跑时直接返回当前状态，不重复拉进程）。 */
export async function mcpStart(server: McpServerConfig, sessionId: string): Promise<McpServerStatus> {
  return call<McpServerStatus>("mcp_start", { config: server, sessionId });
}

/** 停掉一台服务器（没在跑也算成功，幂等）。 */
export async function mcpStop(name: string): Promise<void> {
  await call("mcp_stop", { name });
}

/** 列出工具（tools/list，Rust 侧会缓存，重复调用不重复发请求）。 */
export async function mcpListTools(name: string): Promise<McpTool[]> {
  return call<McpTool[]>("mcp_list_tools", { name });
}

/** 调一次工具（tools/call，60 秒超时；超时后 Rust 侧会杀掉该服务器）。 */
export async function mcpCallTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<string> {
  // sessionId 是 Rust 侧 guard_mcp 授权闸门的入口（ADR 0004），不能省：
  // 少了它，MCP 调用就退回到「前端自己说了算」的老路。
  return call<string>("mcp_call_tool", { name: server, tool, arguments: args, sessionId });
}

/** 所有服务器的运行状态（含已挂的，带失败原因）。 */
export async function mcpStatus(): Promise<McpServerStatus[]> {
  return call<McpServerStatus[]>("mcp_status");
}

/** 停掉一批服务器（换工程/关工程时用，单个失败不阻断其余的）。 */
export async function stopMcpServers(names: string[]): Promise<void> {
  for (const name of [...new Set(names)]) {
    try {
      await mcpStop(name);
    } catch {
      /* 停不掉的就留给应用退出时 Rust 侧统一杀，不阻断主流程 */
    }
  }
}

/**
 * 加载 MCP 插件：读配置 → 把 enabled 的服务器逐个拉起 → 列出工具 → 拼清单。
 *
 * 失败隔离是这里的核心不变量：单个服务器起不来（没装 Node、握手失败、
 * 配置非法），只把原因记进 errors、继续下一个，绝不让一次插件失败
 * 拖垮主流程；调用方把 errors 逐条 toast 出来即可。
 */
export async function loadMcpServers(sessionId: string): Promise<{
  specs: McpToolSpec[];
  errors: { server: string; error: string }[];
}> {
  const cfg = await mcpConfigRead();
  const errors: { server: string; error: string }[] = [];
  const serverTools: { server: string; tools: McpTool[] }[] = [];
  for (const server of cfg.servers) {
    if (!server.enabled) continue;
    const bad = validateMcpServerConfig(server);
    if (bad) {
      errors.push({ server: server.name, error: bad });
      continue;
    }
    try {
      await mcpStart(server, sessionId);
      const tools = await mcpListTools(server.name);
      serverTools.push({ server: server.name, tools });
    } catch (e) {
      errors.push({ server: server.name, error: (e as Error).message });
      // 起一半挂了（比如握手失败）要把残留进程清掉，不留僵尸占着名字
      try {
        await mcpStop(server.name);
      } catch {
        /* ignore */
      }
    }
  }
  const { specs, errors: nameErrors } = buildMcpSpecs(serverTools);
  return { specs, errors: [...errors, ...nameErrors] };
}
