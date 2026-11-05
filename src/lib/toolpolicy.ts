/** 统一工具策略视图：内置工具、动态 MCP 工具、未知工具在同一个入口解析。
 *
 * 为什么不是「把 MCP 工具塞进 `TOOLS` 数组」：`TOOLS` 是模块级常量，
 * `TOOL_DEFS` / 提示词 / 参数校验 / 分发全由它派生；MCP 工具是服务器运行时
 * 通过 `tools/list` 动态给出的，运行时改写全局单例会造成跨会话污染，也让
 * 「唯一权威清单」失去意义。ADR 0004 D1 选择的是：保留静态注册表，
 * 但在**权限判定层**给动态工具一个明确的、与内置工具同构的身份。
 *
 * 依赖方向单向：toolpolicy → registry。registry 不反向依赖本文件，
 * 否则 ADR 0001 里那条「避免运行时环」的约束会被破坏。
 */

import { findTool, type ToolAccess } from "./registry";

/** 动态工具在策略层需要的最小信息；`McpToolSpec` 结构上兼容，无需反向 import mcp.ts。 */
export interface McpPolicyEntry {
  name: string;
  server: string;
  tool: string;
}

export type ApprovalMode = "none" | "ask";
export type CostClass = "cheap" | "expensive";

export interface ToolPolicy {
  name: string;
  source: "builtin" | "mcp" | "unknown";
  access: ToolAccess;
  /** `ask` 表示执行前必须有人类授权（Rust 侧闸门为权威）。 */
  approval: ApprovalMode;
  /** `expensive` 会拉起模型请求或外部进程，并发时要有成本闸门。 */
  cost: CostClass;
  server?: string;
  tool?: string;
}

/** MCP 授权 scope 前缀。与 Rust 侧 `perms::mcp_scope` 必须逐字一致（宪章 §5.4）。 */
export const MCP_SCOPE_PREFIX = "mcp";

/** MCP 授权粒度：服务器 + 工具。大小写归一，与 `perms::grant` 的规范化保持一致。 */
export function mcpScope(server: string, tool: string): string[] {
  return [MCP_SCOPE_PREFIX, server.toLocaleLowerCase(), tool.toLocaleLowerCase()];
}

/**
 * 解析一个工具名的策略。**未知工具按最严档处理**（exec / ask / expensive），
 * 这是 fail-closed：新加的、拼错的、模型凭空造的名字都不该被当成只读工具放行。
 */
export function resolveToolPolicy(name: string, mcpSpecs: readonly McpPolicyEntry[] = []): ToolPolicy {
  const builtin = findTool(name);
  if (builtin) {
    return {
      name,
      source: "builtin",
      access: builtin.access,
      approval: builtin.access === "exec" ? "ask" : "none",
      // explore 会派生子代理、最多 4 轮模型请求，不能按普通只读工具无上限并发
      cost: name === "explore" ? "expensive" : "cheap",
    };
  }
  const mcp = mcpSpecs.find((s) => s.name === name);
  if (mcp) {
    return {
      name,
      source: "mcp",
      access: "exec",
      approval: "ask",
      cost: "expensive",
      server: mcp.server,
      tool: mcp.tool,
    };
  }
  return { name, source: "unknown", access: "exec", approval: "ask", cost: "expensive" };
}

/** 能不能进 `runToolBatch` 的只读并发层。MCP 与未知工具一律不可（串行闸控层）。 */
export function isParallelSafe(policy: ToolPolicy): boolean {
  return (
    policy.source === "builtin" &&
    policy.access === "read" &&
    policy.approval === "none" &&
    policy.cost === "cheap"
  );
}

/** 给调度层用的便捷判据：不传动态清单时，MCP 名字落到 unknown，同样不可并发。 */
export function isParallelSafeWithMcp(name: string, mcpSpecs: readonly McpPolicyEntry[] = []): boolean {
  return isParallelSafe(resolveToolPolicy(name, mcpSpecs));
}
