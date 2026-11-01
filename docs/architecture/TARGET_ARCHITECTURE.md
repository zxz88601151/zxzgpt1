# ZXZGPT1 — 目标架构（To-Be）

> Phase 0 READ-ONLY 审计产出。本文件只做设计，不实施。
> **设计原则：优先复用现有架构，不引入不必要的新依赖，不为架构先进而过度设计。**

---

## 0. 设计的三条硬约束

1. **复用现有资产**：`fsx.rs` / `runx.rs` / `proxy.rs` / `api.rs` 的形状是对的，只做增强不做替换；
   继续保留"核心逻辑不依赖 tauri、可被 harness 单测"的优良特性。
2. **不引入新依赖**：不加 Redux/Zustand/zod/EventBus 框架；不加运行时 Markdown 库；
   Rust 侧新增依赖需逐条论证（候选：`keyring`、`git2`、`getrandom`，均属"不做就得自己写错"的类型）。
3. **最小改动路径**：目标架构的第一原则是把 `App.tsx` 里**已经能跑的逻辑搬出去**，
   而不是重写一个新的 Agent 框架。

---

## 1. 分层总览

```
┌───────────────────────────────────────────────────────────────────────────┐
│ L1  Desktop UI Layer（React 18 + TS，现有 components/ 增强）               │
│     · 只做展示与意图采集；不含任何编排逻辑                                │
│     · 订阅 L2 的事件流渲染                                                │
└───────────────────────────────────────────────────────────────────────────┘
                    │ 命令（send / abort / approve）   ▲ 事件（StreamEvent / RunEvent）
┌───────────────────────────────────────────────────────────────────────────┐
│ L2  Agent Orchestration Layer（新增，纯 TS，不依赖 React）                 │
│     · AgentLoop 状态机：idle → planning → awaiting_model →                │
│       executing_tools → awaiting_approval → {done | aborted | failed}     │
│     · 轮次预算、并行分组、中断、重试、checkpoint                          │
│     · 现有位置：App.tsx:601 的 for 循环 + executeTool（419）              │
└───────────────────────────────────────────────────────────────────────────┘
        │                    │                       │
        ▼                    ▼                       ▼
┌──────────────────┐ ┌────────────────────┐ ┌──────────────────────────────┐
│ L3 Agent Runtime │ │ L5 Security Layer  │ │ L6 Model Provider Layer      │
│  · ContextBuilder│ │  · PermissionPolicy│ │  · Provider trait            │
│  · 压缩/预算     │ │  · WorkspaceSession│ │    OpenAICompatible          │
│  · 工具注册表    │ │  · 路径权威校验    │ │    （未来 Anthropic/Ollama） │
│  · checkpoint    │ │  · 审计日志        │ │  · 统一 StreamEvent          │
│                  │ │  · 凭据存储        │ │  · 现有 api.rs 增强          │
└──────────────────┘ └────────────────────┘ └──────────────────────────────┘
        │                    │                       │
        └────────────────────┼───────────────────────┘
                             ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ L4  Tool Execution Layer（Rust，现有 fsx/runx 增强）                       │
│     · ToolRegistry：声明即注册（schema + permission + handler）            │
│     · 每次执行前经 L5 授权决策；工作目录/工程根由 session 固定            │
│     · 资源上限（超时、输出、并发）                                        │
└───────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ L7  Persistence Layer（Rust 为主 + 前端 UI 状态）                          │
│     · 会话库（JSONL / SQLite）· settings（带 schemaVersion 迁移）          │
│     · 凭据（OS keyring）· undo 快照 · 审计日志 · run checkpoint           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 各层设计

### L1 · Desktop UI Layer

**现状**：`src/components/*.tsx`（14 个）+ `App.tsx` 兜底一切。
**目标**：`App.tsx` 缩减到 ~300 行，只做三件事：装配 runtime、把事件映射成 UI 状态、渲染。

| 职责 | 现在 | 目标 |
|---|---|---|
| 会话 CRUD | `App.tsx:157-210` | 下沉到 Persistence，UI 只发命令 |
| 发送循环 | `App.tsx:526-796` | **迁到 L2** |
| 工具执行 | `App.tsx:419-522` | **迁到 L2/L4** |
| 工程模式 | `App.tsx:834-898` | 迁到 WorkspaceSession（Rust） |
| 技能库 | `App.tsx:900-1047` | 保留在 UI + `lib/skill*`，仅取数据 |
| 面板/快捷键 | `App.tsx:1130-1340` | 保留（纯 UI） |

**接口**：
```ts
interface AgentRuntime {
  start(input: SendInput): Promise<void>;
  abort(reason: string): void;
  approve(requestId: string, decision: ApprovalDecision): void;
  subscribe(fn: (e: RunEvent) => void): () => void;
  getSnapshot(): RunSnapshot;     // 供 UI 渲染与刷新后恢复
}
```
UI 用 `useSyncExternalStore` 订阅，**取消 `stateRef` 手工双写**（债务 D6/D15）。

---

### L2 · Agent Orchestration Layer（**本阶段最关键的增量**）

**来源**：把 `App.tsx:601-787` 的循环与 `App.tsx:419-522` 的 `executeTool` 原样搬出，改成显式状态机。

```ts
type RunState =
  | { t: "idle" }
  | { t: "awaiting_model"; round: number }
  | { t: "executing_tools"; round: number; pending: ToolCall[] }
  | { t: "awaiting_approval"; round: number; request: ApprovalRequest }
  | { t: "testing"; round: number; testRound: number }
  | { t: "done"; reason: "completed" | "max_rounds" | "give_up" }
  | { t: "aborted" }
  | { t: "failed"; error: string };
```

**相比现状的四个增量**：
1. **可中断**：每个阶段转换前检查 `abortSignal`；工具执行支持取消令牌（现状只在 fetch 层）；
2. **可恢复**：每次状态转换写 checkpoint（L7），重启后可 `resume(runId)`（ADR-0003）；
3. **可并行**：工具按冲突分组，只读组 `Promise.all`，写组串行（现状一律串行）；
4. **可测试**：不依赖 React，可在 vitest 里用 mock provider + mock tool 跑完整循环。

**保留**：轮次上限 6（改名为 `maxRounds` 可配）、测试回路 3 轮独立计数的语义不变。

---

### L3 · Agent Runtime Layer

| 组件 | 职责 | 现状对应 |
|---|---|---|
| `ContextBuilder` | 按 token 预算装配 system + 历史 + 工具结果；负责压缩 | `state.ts:57-108`（现按"轮"截取，无预算） |
| `ToolRegistry` | 声明即注册；schema 同时用于下发与校验 | `tools.ts:28` + `App.tsx:437-516` 分散 |
| `Compactor` | 超预算时对历史做摘要压缩 | **不存在**（新增） |
| `CheckpointStore` | run 状态读写 | **不存在**（新增） |

**Context 预算模型（建议）**：
```
总预算 = 模型上下文 × 0.75
  ├─ 系统区（固定，优先）：人设 + 工程目录树 + 项目记忆 + 工具说明
  ├─ 工具结果区（可截断）：每条结果按 recency 递减保留
  └─ 历史区（可压缩）：超出则对最老的 N 轮做摘要
```
现状的问题：系统区完全不计入窗口、历史区按"轮"不按 token —— 二者都要改。

---

### L4 · Tool Execution Layer

**边界**：所有工具执行必须在 Rust 侧完成，且**工作根由 session 固定**。

```rust
// 目标形态（示意，非实现）
pub struct ToolContext {
    pub session: WorkspaceSession,   // 已登记的工程根，不接受任意 root
    pub run_id: String,
    pub cancel: CancellationToken,
}

pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn schema(&self) -> serde_json::Value;      // 下发给模型
    fn permission(&self) -> PermissionLevel;    // Read | Write | Exec
    fn validate(&self, args: &Value) -> Result<(), ToolError>;
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError>;
}
```

**现有基础可直接复用**：`fsx.rs`（读/写/列/建目录）、`runx.rs`（白名单/超时/进程树）。
**必须补的**：
- 拒绝 `.git/**` 写入（`fsx.rs:247`）；
- 符号链接**无条件**检查（`fsx.rs:261`，现被 `exists()` 包住）；
- git 子命令强制 `--no-textconv --no-ext-diff`（`runx.rs:264`）；
- `env_clear()` + 最小环境白名单（`runx.rs:305`）；
- 敏感文件拒绝清单（新增，配合 `read_file`/`search_files`）。

---

### L5 · Security Layer

```
PermissionPolicy
  ├─ 决策输入：工具名 + permission level + 参数摘要 + 会话策略 + 用户历史选择
  ├─ 决策输出：Allow | Deny | Ask(requestId)
  └─ 决策记录：写入审计日志（L7）
```

- **WorkspaceSession**：用户选目录 → Rust 登记 → 返回 `sessionId`；
  后续 `fs_*`/`run_*` 只接受 `sessionId`。**这是 SECURITY S2 的正解。**
- **权限分级**：`Read`（自动）/ `Write`（可配：总是 / 每次问 / 拒绝）/ `Exec`（默认每次问）—— 见 ADR-0002。
- **凭据**：API Key 存 OS keyring，前端不再持有明文（SECURITY S5）。
- **代理**：token 用 OS 熵 + 校验 Host（SECURITY S6）；CSP 与 Origin 校验（S10）。

---

### L6 · Model Provider Layer

**现状**：只有 OpenAI 兼容一档，逻辑散在 `api.rs` 与 `api.ts`。
**目标**：Rust 侧定义 trait，保留现有实现作为第一个 impl。

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;                              // "openai-compatible" | "anthropic" | ...
    async fn chat(&self, req: ChatRequest, tx: EventSink) -> Result<(), ProviderError>;
    async fn list_models(&self) -> Result<Vec<String>, ProviderError>;
    async fn test(&self) -> Result<TestResult, ProviderError>;
}
```
`ChatRequest` / `StreamEvent` 复用现有结构（`api.rs:16-34`、`types.ts:131-140`），
**不替换 reqwest + 手写 SSE**。

---

### L7 · Persistence Layer

| 数据 | 现状 | 目标 |
|---|---|---|
| 会话 | localStorage `zxz.state.v1`（无版本） | Rust 侧 JSONL/SQLite + `schemaVersion` 迁移（ADR-0003） |
| 设置 | 同上 | 同上（含迁移） |
| API Key | localStorage 明文 | OS keyring |
| run checkpoint | 无 | Rust 侧，按 runId 存（ADR-0003） |
| undo 快照 | 工程内 `.zxz/undo/` | 保留，加保留上限与敏感文件排除 |
| 审计日志 | 无 | Rust 侧 JSONL，**独立目录**（不落在工程内，防被代理改写） |

---

## 3. 目标数据流（一次带工具与审批的发送）

```
UI ──start()──▶ L2 AgentLoop
                  │
                  ├─▶ L3 ContextBuilder ──▶ L6 Provider ──▶ 上游
                  │                              │
                  │◀────── StreamEvent ◀─────────┘
                  │
                  ├─(tool_calls)─▶ L5 PermissionPolicy ──Ask──▶ UI 审批面板
                  │                       │ Allow
                  │                       ▼
                  │                L4 ToolRegistry.execute(ctx)
                  │                       │  ToolContext{session, runId, cancel}
                  │                       ▼
                  │                 fsx / runx（工程根由 session 固定）
                  │                       │
                  │◀────────── ToolOutput ─┘
                  │
                  ├─(每轮)─▶ L7 CheckpointStore 写 run 状态
                  └─(事件)─▶ UI 渲染
```

**关键变化**：工具执行路径上多了一个 **L5 授权决策点**（现状没有），
且 `root` 不再由调用方传入（现状是）。

---

## 4. 依赖关系（目标）

```
L1 UI ──────▶ L2 Orchestration ──────▶ L3 Runtime ──────▶ L6 Provider
                     │                      │
                     │                      ├──────────▶ L4 Tool Execution ──▶ L5 Security
                     └──────────────────────┴──────────▶ L7 Persistence
                                                              ▲
                                              L5 Security ────┘（审计日志）
```

**规则**：
- 依赖**单向向下**，L1 不直接调 L4/L5/L6/L7（现状 `App.tsx` 直接调 `fsapi`/`runAllowed`，需收敛）；
- L5 是**横切**，被 L4 调用，但不反向依赖 L4；
- L3 不依赖 L1（这是可测试性的关键）；
- L2 与 L3 可以合并为同一个包的不同模块，但**状态机与上下文装配应分离**。

---

## 5. 迁移路径（现状 → 目标）

| 步 | 动作 | 风险 | 对应债务/安全问题 |
|---|---|---|---|
| 0 | 修文档与实现不一致、修 XSS 转义、配 CSP | 极低 | D11、S1 |
| 1 | `fsx`/`runx` 加固（session 化 root、git 加固、符号链接、env） | 低（有 harness 单测保护） | S2、S3、S4、S8 |
| 2 | 建立 `PermissionPolicy` + 审批面板（复用 PendingWrites 形态） | 中（改变交互） | S7、ADR-0002 |
| 3 | 抽出 L2 `AgentRuntime`（**原样搬运** send/executeTool 逻辑，不改语义） | **中高**（核心控制流搬家） | D1、D6、ADR-0001 |
| 4 | 建 `ToolRegistry`，消灭 if/else 与双份校验 | 低 | D3、D2 |
| 5 | `ContextBuilder` + token 预算 + 压缩 | 中 | 上下文工程 |
| 6 | Checkpoint + resume | 中 | ADR-0003 |
| 7 | Provider trait 化 | 低 | L6 |
| 8 | Skills 标准化 / Hooks / MCP / Subagents | 中～高 | P4/P5 |

**第 3 步是全局关键路径**：它之前的所有能力都受限于"不可测、不可恢复、不可复用"。

---

## 6. 明确不做的事（避免过度设计）

- ❌ 不引入微内核/插件总线/事件溯源 —— 当前规模用不上；
- ❌ 不把整个应用 Rust 化 —— React UI 与 `lib/` 的纯函数层工作良好；
- ❌ 不替换 Tauri IPC 为 gRPC/WebSocket —— 现有 invoke 够用，问题在契约不在传输；
- ❌ 不引入向量数据库做项目索引 —— P2 阶段先用 glob + 字面/正则搜索即可；
- ❌ 不在 P0-P1 引入 MCP —— 必须先有权限模型（S13 约束）。

---

*本文档为 Phase 0 审计产出的设计方案，未实施、未修改任何业务代码。*
