# ADR 0001 · Agent Runtime 的落点与形态

- **状态**：提议（Proposed）—— Phase 0 审计产出，**尚未实施**
- **日期**：2026-11-01
- **决策者**：待项目负责人确认
- **相关**：`docs/audit/AGENT_CAPABILITY_MATRIX.md`（能力 1/5/9/11）、`docs/audit/TECHNICAL_DEBT.md`（D1/D6/D15）、`docs/roadmap/DEVELOPMENT_ROADMAP.md`（P1-1）

---

## 背景

当前 Agent 的主循环是一个 `for` 循环，写在 React 组件的 `useCallback` 内：

```ts
// src/App.tsx:601
for (let round = 0; round < MAX_ROUNDS; round++) {   // MAX_ROUNDS = 6 (App.tsx:215)
    ...await chatStream(...)          // 模型调用
    ...await executeTool(call)        // 工具执行（App.tsx:689，串行）
    ...测试回路 / @@read 回传         // 触发下一轮
}
```

它**能跑**（能力 2、3、4 均已实现），但带来四个后果：

1. **不可测**：`vitest.config.ts:8` 的 `include: ["src/**/*.test.ts"]` + `environment: "node"` 使
   `App.tsx` 不可能被单测 —— 本项目**最核心的控制流测试覆盖为 0**；
2. **不可恢复**：`round` / `baseMessages` / `testRounds` 是闭包局部变量（`App.tsx:597-610`），从不落盘；
3. **不可复用**：没有第二个入口能用这条循环 —— Subagents（目标 12）、CLI、后台任务全部无从落地；
4. **中断不完整**：`AbortController`（`App.tsx:593`）只作用于 fetch，工具执行期间不检查中断。

---

## 决策

### D1 · 编排逻辑迁出 React，落在独立模块 `src/orchestration/`

- **不 import react**，可在 node 环境下单测；
- 对外只暴露 5 个方法：`start` / `abort` / `approve` / `subscribe` / `getSnapshot`；
- UI 用 `useSyncExternalStore` 订阅事件流，**取消 `stateRef` 手工双写**（`App.tsx:67-77`）。

### D2 · 形态是"显式状态机"，不是"async 函数里的循环"

```ts
type RunState =
  | { t: "idle" }
  | { t: "awaiting_model";  round: number }
  | { t: "executing_tools"; round: number; pending: ToolCall[] }
  | { t: "awaiting_approval"; round: number; request: ApprovalRequest }
  | { t: "testing"; round: number; testRound: number }
  | { t: "done"; reason: "completed" | "max_rounds" | "give_up" }
  | { t: "aborted" }
  | { t: "failed"; error: string };
```

理由：状态机让"中断点""恢复点""审批挂起点"成为**显式**的一等公民，
而不是散落在 await 之间的隐式位置。这也是 checkpoint/resume（ADR-0003）能成立的前提。

### D3 · 第一步**只搬运，不改语义**

轮次 6、测试回路 3 轮独立计数、终止判据（`App.tsx:764`）`file:`/`@@read` 兼容协议、
`toolCalls` 展开成原生协议（`state.ts:94-104`）—— **全部原样保留**。
并行分组、checkpoint 放在 P1-2 / P3-3 做。
理由：这次改动风险最高的部分就是"搬家"，不应同时改语义，否则无法判定回归来源。

### D4 · 工具执行走注册表，不再走 if/else

`App.tsx:437-516` 的五条 `if (call.name === ...)` 改为 `ToolRegistry` dispatch。
理由：每加一个工具现在要改 5 处（`ToolName` / `TOOL_DEFS` / `validateToolArgs` / `executeTool` / `buildToolsPrompt`）。

### D5 · Runtime **不持有** UI 状态

会话列表、drawer 开合、输入框、主题等留在 React；Runtime 只持有"一次 run"的状态。

---

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 留在 `App.tsx`，只做微调 | 不解决可测/可恢复/可复用，Subagents 永远做不了 |
| 引入 Zustand/Redux 管理状态 | 问题是"编排逻辑在组件里"，不是"状态容器不够好"；引入框架不解决根因，还加依赖 |
| 把整个 Runtime 用 Rust 重写 | 现有 TS `lib/` 纯函数层质量好、测试充分；Rust 侧应专注文件/命令/网络边界。重写成本高、收益低 |
| EventBus / 插件微内核 | 当前 5 个工具、单 agent，用不上；过度设计 |
| 引入 LangChain 类框架 | 与"不引入不必要新依赖"冲突，且会夺走对轮次/中断/审批的精确控制 |

---

## 影响

### 正面
- 编排层可单测 → 最危险的代码终于有回归网；
- 解锁：Subagents（P5）、Resume（P3）、并行工具（P1-2）、未来 CLI/后台任务；
- `App.tsx` 从 1340 行降到目标 < 500 行，UI 改动风险下降。

### 负面 / 成本
- **回归风险高**：核心控制流搬家，需保留旧实现做一段对照；
- 事件流抽象会引入一层间接（UI 不再直接读状态）→ 调试路径变长，需配套 devtools 式事件日志；
- `approve` 的异步挂起需要 UI 与 Runtime 的请求 id 对齐（依赖 P0-4 先把审批接口形状定下来）。

### 迁移步骤
1. 先补"行为等价"单测（7 类：无工具 1 轮 / 有工具多轮 / 6 轮上限 / 中断 / 审批挂起 / 测试 3 轮 / 上游错误）；
2. 搬运 `send` 与 `executeTool` 到 `src/orchestration/`，语义不变；
3. `App.tsx` 改为订阅渲染；
4. 旧路径确认等价后删除。

---

## 验收标准

```
[ ] src/orchestration/ 存在，且 grep -rn "from \"react\"" src/orchestration/ 无命中
[ ] 7 类行为用例全绿（vitest，mock provider + mock tools）
[ ] src/App.tsx < 500 行，且不再出现 stateRef.current 的手工双写
[ ] 工具分发的 if/else 消失（grep -c "call.name ===" src/ == 0）
[ ] 迁移前后，tools/workspace-e2e.cjs 的通过项数量不变
```

---

*本 ADR 为 Phase 0 审计产出，未实施、未修改任何业务代码。*
