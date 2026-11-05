/** ADR 0004 统一工具策略视图的回归：MCP 与未知工具必须 fail-closed。 */

import { describe, expect, it } from "vitest";
import {
  isParallelSafe,
  isParallelSafeWithMcp,
  mcpScope,
  MCP_SCOPE_PREFIX,
  resolveToolPolicy,
  type McpPolicyEntry,
} from "./toolpolicy";

const MCP_SPECS: McpPolicyEntry[] = [
  { name: "mcp_context_mode_ctx_execute", server: "context-mode", tool: "ctx_execute" },
  { name: "mcp_context_mode_ctx_search", server: "context-mode", tool: "ctx_search" },
];

describe("resolveToolPolicy：三类工具的统一身份", () => {
  it("内置只读工具：none / cheap / 可并发", () => {
    const p = resolveToolPolicy("read_file");
    expect(p).toMatchObject({ source: "builtin", access: "read", approval: "none", cost: "cheap" });
    expect(isParallelSafe(p)).toBe(true);
  });

  it("内置 exec 工具走 ask（Rust 侧授权闸门）", () => {
    const p = resolveToolPolicy("run_command");
    expect(p).toMatchObject({ source: "builtin", access: "exec", approval: "ask" });
    expect(isParallelSafe(p)).toBe(false);
  });

  it("explore 是 expensive，不进只读并发层（成本闸门的前提）", () => {
    const p = resolveToolPolicy("explore");
    expect(p).toMatchObject({ source: "builtin", access: "read", cost: "expensive" });
    expect(isParallelSafe(p)).toBe(false);
  });

  it("MCP 动态工具：exec / ask / expensive，带 server 与 tool", () => {
    const p = resolveToolPolicy("mcp_context_mode_ctx_execute", MCP_SPECS);
    expect(p).toMatchObject({
      source: "mcp",
      access: "exec",
      approval: "ask",
      cost: "expensive",
      server: "context-mode",
      tool: "ctx_execute",
    });
    expect(isParallelSafe(p)).toBe(false);
  });

  it("同一名字没在动态清单里就是 unknown，按最严档处理（fail-closed）", () => {
    const p = resolveToolPolicy("mcp_context_mode_ctx_execute");
    expect(p.source).toBe("unknown");
    expect(p).toMatchObject({ access: "exec", approval: "ask", cost: "expensive" });
    expect(isParallelSafe(p)).toBe(false);
  });

  it("模型拼错的变形工具名不归一化，落到 unknown", () => {
    for (const name of ["Run_Command", "read_file ", "mcp_ghost_x"]) {
      expect(resolveToolPolicy(name, MCP_SPECS).source).toBe("unknown");
    }
  });
});

describe("isParallelSafeWithMcp：调度层用的判据", () => {
  it("普通只读工具仍可并发，写/执行/子代理/MCP 都不可", () => {
    expect(isParallelSafeWithMcp("read_file")).toBe(true);
    expect(isParallelSafeWithMcp("search_files")).toBe(true);
    expect(isParallelSafeWithMcp("glob")).toBe(true);
    expect(isParallelSafeWithMcp("write_file")).toBe(false);
    expect(isParallelSafeWithMcp("run_command")).toBe(false);
    expect(isParallelSafeWithMcp("explore")).toBe(false);
    expect(isParallelSafeWithMcp("mcp_context_mode_ctx_search", MCP_SPECS)).toBe(false);
  });
});

describe("mcpScope：与 Rust 侧 perms::mcp_scope 镜像一致", () => {
  it("scope = [mcp, server, tool]，大小写归一", () => {
    expect(mcpScope("Context-Mode", "CTX_EXECUTE")).toEqual([
      MCP_SCOPE_PREFIX,
      "context-mode",
      "ctx_execute",
    ]);
  });

  it("不同服务器 / 不同工具落在不同格子里，授权不外溢", () => {
    expect(mcpScope("a", "x")).not.toEqual(mcpScope("b", "x"));
    expect(mcpScope("a", "x")).not.toEqual(mcpScope("a", "y"));
  });
});
