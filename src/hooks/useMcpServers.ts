/** MCP 插件随工程会话启动/停止（从 App.tsx 抽出的生命周期 hook）。
 *
 * 服务器随工程走：工程一打开就按 mcp.json 拉起 enabled 的服务器并列出工具；
 * 换工程 / 关工程先停旧服务器（cwd 跟着工程走，不停就串目录）；单个服务器挂了
 * 只 toast 报错，不阻断主流程（失败隔离）。只返回动态工具清单 ref，
 * App 的 executeTool / tools() 直接读它，不需要知道生命周期细节。
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import { fsAvailable } from "../lib/fsapi";
import { loadMcpServers, stopMcpServers, type McpToolSpec } from "../lib/mcp";
import type { Notice } from "../orchestration/session";
import type { Workspace } from "../types";

export function useMcpServers(
  workspace: Workspace | null,
  toast: Notice
): MutableRefObject<McpToolSpec[]> {
  const mcpSpecsRef = useRef<McpToolSpec[]>([]);
  const mcpSessionRef = useRef<string | null>(null);
  const mcpLoadGen = useRef(0);

  useEffect(() => {
    const ws = workspace;
    if (!ws || !fsAvailable()) {
      if (mcpSessionRef.current) {
        const names = [...new Set(mcpSpecsRef.current.map((s) => s.server))];
        mcpSessionRef.current = null;
        mcpSpecsRef.current = [];
        void stopMcpServers(names);
      }
      return;
    }
    if (mcpSessionRef.current === ws.sessionId) return;
    const prevSession = mcpSessionRef.current;
    const prevNames = [...new Set(mcpSpecsRef.current.map((s) => s.server))];
    mcpSessionRef.current = ws.sessionId;
    mcpSpecsRef.current = [];
    const gen = ++mcpLoadGen.current;
    const run = async () => {
      if (prevSession) await stopMcpServers(prevNames);
      const { specs, errors } = await loadMcpServers(ws.sessionId);
      // 换工程时旧的一次加载还在飞：用代号作废，别把旧工具清单写回新工程
      if (gen !== mcpLoadGen.current) return;
      mcpSpecsRef.current = specs;
      for (const e of errors) toast(`MCP 服务器 ${e.server} 启动失败：${e.error}`, "error");
      if (specs.length) {
        const servers = [...new Set(specs.map((s) => s.server))].join("、");
        toast(`MCP 插件已就绪：${specs.length} 个工具（${servers}）`, "");
      }
    };
    run().catch((e) => {
      if (gen !== mcpLoadGen.current) return;
      toast(`MCP 配置读取失败：${(e as Error).message}`, "error");
    });
  }, [workspace?.sessionId, toast]);

  return mcpSpecsRef;
}
