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
[x] src/orchestration/ 存在，且 grep -rn "from \"react\"" src/orchestration/ 无命中
[x] 7 类行为用例全绿（vitest，mock provider + mock tools）—— 2026-11-04 补齐，见下方进度
[ ] src/App.tsx < 500 行，且不再出现 stateRef.current 的手工双写（现 1338 行，搬走了 182 行）
[x] 工具分发的 if/else 消失（grep -c "call.name ===" src/ == 0）
[x] 迁移前后，tools/workspace-e2e.cjs 的通过项数量不变（39 → 39，2026-11-04 实跑）
```

---

## 实施进度（2026-11-03，追加，不改上文）

**已做**

- **B6**：`[x]` 工具分发收敛到 `src/lib/registry.ts`。`grep -c "call.name ===" src/` = 0。
- **B7**：`[~] src/orchestration/` 已存在（`round.ts`，零 import、零 React），
  落地的是**轮末判定**这一个切片：`nextRound` / `stopNotice` / `shouldAutoTest`，
  25 条断言（含"最后一轮无后续请求应判正常收尾而不是轮数用尽"这类顺序断言）。
  `MAX_ROUNDS` 随之导出，不再是 App 里的局部常量。

**没做，别读成做了**

- `[~]` 7 类行为用例：目前是**纯决策层 6 个出口**，不是 ADR 原意的"整轮重放"。
  「中断 / 上游错误 / 测试 3 轮」里真正影响用户的那部分（报错后会不会跑 `npm test`、
  会不会落盘、审批挂起时 UI 与 Runtime 的请求 id 对齐）仍在 `send()` 闭包里，**0 覆盖**。
  项目至今没有 jsdom / mock provider 测试设施（`STATE.md` §4 已记录），
  要做到 7 类用例得先补这套设施。
- `[ ]` `App.tsx` 仍有 1520 行（B10 加了审批 UI 接线，反而更长），`stateRef.current`
  手工双写还在。搬运 `send` 未开始。
- `[ ]` e2e 项数对账属 B8，本批未动。

**结论**：ADR 未完成。B7 只完成"最小可行切片"，其价值在于把最绕的判定逻辑
变成有测试的纯函数，而不是"编排层已拆分"。

---

## 实施进度（2026-11-04，追加，不改上文）

**迁移步骤 1 已完成：7 类行为等价用例落地**

`src/app.test.tsx`（B12-B1，jsdom 夹具）+ `src/app.rounds.test.tsx`（B12-B2，6 条）
用的是 **App 真实的 `send()` / `executeTool()` / `buildMessages()`**，只把上游 fetch 与
Tauri IPC 换成假的——没有为测试在业务代码里开洞。

| # | 类别 | 判据 |
|---|---|---|
| 1 | 无工具 1 轮 | 请求打到 `<baseUrl>/chat/completions`，delta 渲染成回答（`app.test.tsx`） |
| 2 | 有工具多轮 | 第一轮带 `tools`；`read_file` 结果按 `tool_call_id` 回填；第二轮带 `assistant.tool_calls` + `tool` |
| 3 | 6 轮上限 | 每轮都要读文件时**恰好 6 次**请求 + 「已达到本次最多 6 轮读写」 |
| 4 | 中断 | 挂起的流 + 点停止 → 「已停止生成」、不误报「请求失败」、不再发请求 |
| 5 | 审批挂起 | 没答之前请求数仍是 1、`perm_grant` 为 0；点「仅这一次」后记 1 条、命令重试、结果回填 |
| 6 | 测试 3 轮 | 3 次 `run_allowed`、恰好 3 次请求、每轮报错原文回传进下一轮上下文、末轮报人 |
| 7 | 上游错误 | 500 只发 1 次请求；`HTTP 500` + 上游原话都上屏；按钮复位 |

**变异检验**（改坏生产代码 → 对应用例必须变红，逐条单独验过）：
去掉 `!res.ok` 抛错 → 7/2 红；去掉 `tool_calls` 展开 → 2 红；去掉 `AbortError` 分支 → 4 红；
`MAX_ROUNDS` 6→8 → 3 红；`testLoopDecision` 去掉 `give_up` → 6 红；确认框不渲染 → 5 红。

**仍未做**：`send()` 本体还在 `App.tsx`（1520 行），第 2 条 `[~]` 没变成「搬家已完成」。
第 1 步做完意味着**搬运有了回归网**，不等于搬运开始。

---

## 实施进度（2026-11-04，B12-B3：搬运已完成）

**做了什么**：新增 `src/orchestration/session.ts`（321 行），把 `send()` 里的**轮循环**
整段搬过来，导出 `runRounds(deps)`。`App.tsx` 从 **1520 → 1338 行**（−182）。

**只搬运，不改语义**（D3）：轮数上限、测试回路 3 轮独立计数、`file:` / `@@read:` 兼容协议、
工具结果展开成原生协议、`if (aborted || failed) break` 的提前守卫——逐字保留。新增的只有两处
**基础设施**，都不改变浏览器路径：

- `requestAnimationFrame` 在 Node 下不存在，orchestration 要能在无浏览器环境单测，
  于是有一个 `scheduleFrame` 回退到 `setTimeout(cb, 16)`；浏览器仍走 rAF。
- 依赖全部从 `deps` 注入（状态写入、工具执行、落盘、读文件、跑命令、toast），
  因为这些能力各自还连着 UI / IPC / 审批流程，搬不走。

**等价性证据（搬家前后同一套断言）**：

| 类别 | 命令 | 搬家前 | 搬家后 |
|---|---|---|---|
| 前端单测 | `npx vitest run` | 447 / 20 文件 | **447 / 20 文件** |
| 工程模式 e2e | `node tools/workspace-e2e.cjs` | 39/39 | **39/39** |
| 主 e2e | `node tools/e2e.cjs` | 24/24 | **24/24** |
| 技能 e2e | `node tools/skill-e2e.cjs` | 69/69 | **69/69** |

**两组变异，证明新文件真的在跑**（不是"旧路径还在，测试绿的其实还是它"）：

1. `runRounds` 开头插 `return` → 7 条红（6 条整轮 + 1 条 App 发送），说明 `App.tsx`
   确实只剩装配，旧循环已删；
2. `testLoopDecision(r.exit_code, testRounds)` 改成 `…, MAX_TEST_ROUNDS` → 自动测试回路那条
   精确红（`expected 1 to be 3`），说明注入的依赖确实被用到。

**验收变化**：5 条标准现在 **4 条达成**（orchestration 无 React / 7 类用例 / 工具 if-else 消失 /
e2e 项数不变）。剩下一条 `App.tsx < 500 行` 没达成——1338 行里剩的绝大部分是 UI 状态与
会话/技能/撤销/审批面板的接线，不是编排逻辑。ADR 写的 "1340 → 500" 低估了 UI 占比。

**下一步（若继续）**：`stateRef` 手工双写在 App 里仍有多处（`send` 之外的路径），
要消掉它得让 UI 改为订阅式，属于 D1 的后半段，不在"只搬运"范围内。

---

*本 ADR 为 Phase 0 审计产出，未实施、未修改任何业务代码。*
*进度小节为后续批次追加。*

