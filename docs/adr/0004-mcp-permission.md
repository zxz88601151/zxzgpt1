# ADR 0004：MCP 工具纳入统一权限视图并默认 `Ask`

> 日期：2026-11-06 · 状态：**ACCEPTED（业主裁定后实施）**
> 关联：ADR 0002（工具权限模型）、`docs/audit/MCP_PREREQUISITE_AUDIT.md` §4、
> `docs/audit/HEAD_2083011_INDEPENDENT_AUDIT_20261105.md` P1-2、技术债 D-19

---

## 背景

11-05 的 `9e713f5` 合入了 MCP 客户端与 context-mode 工具。独立审计发现它绕开了
ADR 0002 建立的权限模型：

- MCP 动态工具不在 `TOOLS` 注册表内，`findTool()` 查不到，权限等级、计划/探索
  拦截、并行分流全部按「未知工具」处理；
- `executeMcpToolCall` 只拦计划/探索模式，**不经过 `perms::decide`、不弹授权、
  没有默认 `Ask`**；
- 发给模型的工具描述自承「不受本程序受控执行白名单约束」；
- `mcp_call_tool` 这个 IPC 命令不接收 `session_id`，Rust 侧没有任何授权判定，
  前端一旦被绕过（devtools / 前端 bug / 第三方脚本），`ctx_execute` 可执行任意代码。

`MCP_PREREQUISITE_AUDIT.md` §4 早已明确「MCP 排在 P0-4 权限模型之后……
先做 MCP 等于先把闸门拆了再装门」。`STATE.md` DEC-013 因此把本项列为
**需业主裁定的重大架构决策**，不擅自实施。

**裁定依据**：业主于 2026-11-06 明确确认执行队列
「① 归档 → ② 取消传播 → ③ MCP 工具纳入注册表并默认 Ask → ④ 成本闸门 → ⑤ 拆分 → ⑥ CSP」，
其中第 ③ 项点名了信任模型变更，构成本 ADR 的授权来源。

---

## 决策

### D1：统一策略视图，而不是把动态工具塞进静态数组

新增 `src/lib/toolpolicy.ts`，导出 `resolveToolPolicy(name, mcpSpecs) -> ToolPolicy`。
内置工具、MCP 动态工具、未知工具三类都经它解析成同一张表：

| 字段 | 内置 read | 内置 write/exec | MCP | 未知 |
|---|---|---|---|---|
| `source` | `builtin` | `builtin` | `mcp` | `unknown` |
| `access` | 原值 | 原值 | `exec` | `exec` |
| `approval` | `none` | `ask`（exec；write 走确认面板） | **`ask`** | `ask` |
| `cost` | `cheap`（`explore` 除外） | `cheap` | **`expensive`** | `expensive` |

MCP 工具是运行时由服务器 `tools/list` 动态给出的，**不能**写进静态 `TOOLS`
数组（那样等于把插件清单编译进程序）。「纳入注册表」的准确含义是：
权限判定、并行分流、执行分发都走同一个解析入口，动态工具不再有第二条旁路。

### D2：默认 `Ask`，且 Rust 侧是权威

MCP 调用链改为与 `run_command` 完全同构：

```
模型 → executeTool → resolveToolPolicy → executeMcpToolCall
   → mcpCallTool(server, tool, args, sessionId)
   → Rust mcp_call_tool → perms::guard_mcp(session, server, tool)
        ├─ 无授权 → Err("need_grant") → 前端 askExec 弹框
        │            用户批准 → permGrant(scope, uses, label) → 重试
        └─ 有授权 → 消耗一次授权 → tools/call
```

- 授权 **scope = `["mcp", server, tool]`**（大小写归一），与前端 `mcpScope()`
  镜像一致（宪章 §5.4 要求两侧同步）；
- 复用 ADR 0002 既有的 `perms` 授权表、`perm_grant` IPC、`ConfirmExec` 确认框，
  **不新增依赖、不新增 UI、不新增持久化**；授权仍不落盘、随会话失效；
- 「本会话都允许」真的生效：Rust 侧已有授权时首次 `call` 直接成功，不弹框；
- `executeMcpToolCall` **fail-closed**：审批通道（`ask` / `grant`）缺失或不是函数时
  直接拒绝，不调用服务器；`need_grant` 重试最多 3 轮，避免授权逻辑出 bug 时死循环。

### D3：计划/探索模式拦截保持不变；`mcpToolDef` 描述纠正

删除「不受本程序受控执行白名单约束」这句自承绕过的文案，改为明示
「默认需要用户逐次确认（Ask），由 Rust 侧授权闸门记账」。
子代理仍硬拦 `mcp_` 前缀（其工具定义本来就不含 MCP 工具）。

### D4：明确的非目标

- 不做 MCP 管理页、不自动启用任何服务器（默认 `context-mode.enabled = false` 不变）；
- 不改变 `mcp.json` 的位置与校验（它在应用配置目录、工程根之外，已有独立审计排除
  「模型改配置 → RCE」这条链）；
- 不改 `tauri.conf.json` 的 CSP（宪章 §3.7，改 CSP 需真机宿主证据）；
- 不推送远端、不打包、不新增依赖。

---

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 把 MCP 工具运行时注入 `TOOLS` 数组 | 注册表是模块级常量，`TOOL_DEFS` / 提示词 / 校验都由它派生；运行时改写会让全局单例产生跨会话污染，且 `TOOLS` 的 readonly 语义与「唯一权威清单」定位相悖 |
| 只在前端弹确认框 | 违反 ADR 0002 的核心结论：前端弹框是体验，不是安全属性；任何能执行 JS 的路径都能跳过它 |
| 给每个 MCP 工具单独做一份权限表 | 又回到「五处手写」的老问题，漏一处就是一条新旁路 |
| 对 MCP 一律 `Deny`（禁用插件） | 与业主已确认的「启用 MCP 能力」目标冲突；`Ask` 是既保留能力又守住人类意图的最小改动 |

---

## 后果

**正面**：MCP 与内置 exec 共用同一套人类授权闸门；前端镜像与 Rust 权威同步；
动态工具在策略层有明确身份，④ 的并发成本闸门可以直接消费 `cost`/`approval`。

**代价**：启用 MCP 后每次新 scope 首次调用会弹一次确认框；`mcp_call_tool` IPC
签名增加 `session_id`（仅内部调用方，非公开 API）；`mcp.ts` 的
`executeMcpToolCall` 参数变多，测试需同步改写。

**风险与未验证项**：Rust `src-tauri` 全量编译需要 Windows + WebView2 导入库，
Ubuntu 沙箱 **NOT_TESTED**；`perms::decide_mcp` 的纯逻辑由
`tools/fs-harness`（不依赖 tauri）真实单测覆盖。真机弹框交互、WebView2 宿主行为
仍为 `NOT_TESTED`，不标 `PASS`。

---

## 验收标准

1. `resolveToolPolicy` 对 MCP / 未知工具一律 `approval: "ask"` 且并行不安全（单测）；
2. `executeMcpToolCall` 在 `need_grant` 路径必经 `ask` → `grant` → 重试；
   用户 `deny`、审批通道缺失、重试超限三种情况都不调通服务器（单测）；
3. Rust 侧 `perms::guard_mcp` 新会话必 `Ask`、授权只解锁自身 scope、
   非法名字 `Deny`、一次性授权用完即失效（fs-harness 真实 `cargo test`）；
4. `npm test` 全绿、`npm run build` PASS；README §15.2 第 1 条同步为已修。

真机 CSP 验证（队列 ⑥）不在本 ADR 范围内。
