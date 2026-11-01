# ADR 0003 · 会话与任务状态的持久化及恢复

- **状态**：提议（Proposed）—— Phase 0 审计产出，**尚未实施**
- **日期**：2026-11-01
- **决策者**：待项目负责人确认
- **相关**：`docs/audit/AGENT_CAPABILITY_MATRIX.md`（能力 8 / 11 / 21）、`docs/audit/SECURITY_AUDIT.md`（S5 / S12）、`docs/audit/TECHNICAL_DEBT.md`（D8）、`docs/roadmap/DEVELOPMENT_ROADMAP.md`（P3-3）

---

## 背景

### 现状

| 数据 | 存储 | 位置 | 问题 |
|---|---|---|---|
| 会话消息 + 设置 + **API Key** | WebView localStorage `zxz.state.v1` | `state.ts:14,31-33` | 明文、无版本、无迁移、随 WebView 数据目录 |
| 一次 run 的状态 | **无** | 闭包局部（`App.tsx:597-610`） | 进程退出即丢，**不可恢复** |
| undo 快照 | 工程内 `.zxz/undo/<时间戳>/` | `files.ts:165-169` | 明文长期留存、无保留上限 |
| 审计日志 | **无** | — | 不可追溯 |

### 具体证据

```ts
// src/App.tsx:597-610 —— run 的全部运行时状态，从不落盘
let testRounds = 0;
for (let round = 0; round < MAX_ROUNDS; round++) {
   const assist: Message = {...};
   let baseMessages = [...];
   ...
}
```

```ts
// src/state.ts:31-33 —— 只存消息与设置，且无版本迁移
export function persist(state: AppState): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}
```

**后果**：
- 能力 8（Session Persistence and Resume）判定为**未实现** —— 消息能恢复，但**run 不能续跑**；
- 能力 11（任务状态持久化）判定为**未实现**；
- `loadState`（`state.ts:16-29`）用浅合并兜底，嵌套对象（`workspace`）不校验 → 结构演进即产生畸形状态。

---

## 决策

### D1 · 分离三类数据，各自选存储

| 类别 | 内容 | 存储方案 | 理由 |
|---|---|---|---|
| **持久化资产** | 会话、设置、项目记忆索引 | Rust 侧存储（JSONL 起步，必要时 SQLite）+ `schemaVersion` 迁移链 | 需要迁移与容量，不该放 localStorage |
| **运行时状态** | run checkpoint | Rust 侧，按 `runId` 存，**独立于工程目录** | 必须防被代理自己改写 |
| **凭据** | API Key | OS keyring（Windows 凭据管理器 / Keychain / libsecret） | SECURITY S5 |
| **UI 瞬时状态** | drawer 开合、输入框草稿、滚动位置 | 保留 localStorage | 丢得起 |

### D2 · 存储格式：JSONL 起步，不引入数据库

- 一个会话一个 `.jsonl`，每行一条消息（追加写，天然抗崩溃）；
- 全量改写仅在压缩/删除时发生；
- **不引入 SQLite** —— 当前规模（单机、单用户、数百会话）JSONL 足够，
  且避免了新依赖与迁移工具链。若未来需要全文检索再评估。

### D3 · schemaVersion + 迁移链

```ts
interface Persisted { schemaVersion: number; /* ... */ }
const MIGRATIONS: Record<number, (s: any) => any> = { 1: v1_to_v2, 2: v2_to_v3 };
```

- 从 localStorage 迁移到 Rust 存储时，用一次性迁移函数读取 `zxz.state.v1` 并写入新存储；
- 迁移失败 → 保留原文件备份并提示用户，**不静默丢弃数据**。

### D4 · Checkpoint 的形状与时机

```ts
interface RunCheckpoint {
  runId: string;
  conversationId: string;
  schemaVersion: number;
  state: RunState;              // 见 ADR-0001 的状态机
  round: number;
  testRound: number;
  messages: Message[];          // 含 hidden 工具消息
  pendingApproval?: ApprovalRequest;
  updatedAt: number;
}
```

**写时机**（不是每帧，而是每次状态转换）：
`awaiting_model` / `executing_tools` / `awaiting_approval` / `testing` / 每轮结束。
理由：转换点是天然的恢复边界；每帧写会带来 IO 压力与损坏面。

### D5 · 恢复策略：**默认不自动续跑，先问用户**

启动时若发现未完成的 run：
```
上次有个任务在第 3 轮中断（已写 2 个文件，等 1 项审批）。
   [ 继续 ]  [ 放弃并保留记录 ]
```
理由：自动续跑会在用户不在场时执行写/命令操作 —— 与 ADR-0002 的"Exec 默认询问"冲突。

### D6 · 损坏时安全降级

- checkpoint 校验失败（JSON 解析错、schemaVersion 过高、conversationId 不存在）
  → **放弃恢复**，保留损坏文件到 `.corrupt-<ts>`，UI 提示，应用正常启动；
- 绝不允许损坏的持久化数据导致启动失败。

### D7 · 审计日志独立且只读于代理

- 路径：应用数据目录（**不在工程目录内**）；
- 格式：JSONL 追加；
- 内容：`{ts, runId, tool, args摘要, decision, decidedBy, result摘要}`；
- `write_file` 工具的路径校验应**拒绝**指向审计日志目录（当前 `fsx.rs` 无此限制，但 root 已被 session 固定）。

---

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 继续全部用 localStorage | 无版本迁移、Key 明文、容量受限（通常 5-10MB）、随 WebView 数据目录易被清理 |
| 直接上 SQLite | 当前规模用不上；引入依赖与迁移工具链；JSONL 的追加写在崩溃安全上更简单 |
| 每个 event 都写 checkpoint | IO 压力大、损坏面大；状态转换点已足够 |
| 启动时自动续跑 | 与 ADR-0002 的 Exec 默认询问冲突，会在无人值守时执行写/命令 |
| 把 checkpoint 写到工程目录（`.zxz/`） | 代理可以 `write_file` 改写自己的 checkpoint → 状态可被伪造 |
| 引入 ORM / 迁移框架 | 手写 `MIGRATIONS` 表足够，当前版本数是个位数 |

---

## 影响

### 正面
- 能力 8 / 11 / 21 从"未实现"变为可实现；
- 顺便解决 SECURITY S5（Key 入 keyring）与 S12（审计日志）；
- 长任务（大量文件改动）不再怕崩溃/误关窗口。

### 负面 / 成本
- 数据迁移风险：**用户已有会话必须无损迁移**，需写一次性迁移 + 双读回退期；
- 多一处存储就要多一套备份/清理策略（会话删除、checkpoint GC、undo 上限）；
- `Settings` 的读取路径从"同步 localStorage"变成"异步 IPC" → 首屏需处理加载态
  （`App.tsx:982-984` 的注释已经暴露过一次类似的"首帧读空"问题，需一并解决）。

### 风险
- **最高风险是数据迁移**。缓解：① 迁移前自动备份 `zxz.state.v1`；② 保留双读能力一个版本；
  ③ 提供"导出全部会话 JSON"作为兜底（现有 `exportConversations` 已具备，`App.tsx:1069`）。

---

## 验收标准

```
[ ] 会话数据有 schemaVersion，且存在 v1 → v2 的迁移函数与单测
[ ] 从 localStorage 的一次性迁移：原有会话数量与内容无损（测试用 fixture 对话比对）
[ ] 模拟"跑到第 3 轮崩溃"→ 重启 → 提示恢复 → 继续 → 从第 3 轮接上
[ ] checkpoint 损坏（手动写入半截 JSON）→ 应用正常启动，损坏文件被保留备份
[ ] API Key 不再出现在 localStorage（grep localStorage 内容验证）
[ ] 审计日志落到应用数据目录，且 write_file 无法写到该目录
[ ] checkpoint 目录不在工程目录内（避免被代理改写）
```

---

*本 ADR 为 Phase 0 审计产出，未实施、未修改任何业务代码。*
