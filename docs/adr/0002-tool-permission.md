# ADR 0002 · 工具权限模型

- **状态**：提议（Proposed）—— Phase 0 审计产出，**尚未实施**
- **日期**：2026-11-01
- **决策者**：待项目负责人确认
- **相关**：`docs/audit/SECURITY_AUDIT.md`（S2 / S7 / S13）、`docs/audit/AGENT_CAPABILITY_MATRIX.md`（能力 8）、`docs/roadmap/DEVELOPMENT_ROADMAP.md`（P0-1、P0-4）

---

## 背景

当前工具调用**没有统一的权限决策点**。现状是三套互不统辖的机制：

| 工具 | 现有限制 | 位置 |
|---|---|---|
| `read_file` / `list_dir` / `search_files` | 无审批，只有路径校验 | `App.tsx:437-485`、`fsx.rs:220-238` |
| `write_file` | **可选**确认面板，**默认关闭** | `App.tsx:328-354`、`presets.ts:81` `confirmWrites: false` |
| `run_command` | **无审批**，只有 argv 白名单 + npm 脚本首词审计 | `App.tsx:496-515`、`runx.rs:210-277` |

由此产生两个已确认的问题：

1. **SECURITY S7**：`write_file` + `run_command` 组合天然等于任意代码执行 ——
   代理可写恶意测试文件 + `package.json` 的 `"test": "node --test"`（**能通过脚本首词审计**）→ `npm test`。
   全程不违反任何一条白名单规则。
2. **SECURITY S2**：`fs_read` / `fs_write` / `run_allowed` 的 `root` 参数**只要求是绝对路径**
   （`fsx.rs:55-61`），工程根边界靠"前端传对 root"维持 —— 边界在错误的层。

---

## 决策

### D1 · 权限分级：三级 + 三态策略

```
PermissionLevel（工具自带，Rust 侧声明）
  ├─ Read  ：读文件 / 列目录 / 搜索
  ├─ Write ：写文件 / 删除 / 打补丁
  └─ Exec  ：跑命令 / 触发构建 / 任何会执行代码的操作

Policy（用户可配，按 level 分别设定）
  ├─ allow ：总是放行
  ├─ ask   ：每次询问（可附"本会话总是允许"）
  └─ deny  ：总是拒绝
```

**默认策略**（与现状的差异已标出）：

| Level | 默认 | 现状 | 变化 |
|---|---|---|---|
| Read | `allow` | 无审批（等同 allow） | 无体感变化 |
| Write | `ask` | `confirmWrites` 默认 false（等同 allow） | **默认改为询问** |
| Exec | `ask` | 无审批（等同 allow） | **默认改为询问** |

> Write 的默认从"自动落盘"改成"询问"，是**有意的体验变更**。
> README §10 与 §13.2 需要同步更新；若产品上坚持默认自动落盘，应至少对
> **首次接入的工程**默认 `ask`，用户显式选择"总是允许"后转 `allow`。

### D2 · 决策点是单点，且对所有工具生效

```
executeTool(tool, args)
   └─▶ PermissionPolicy.decide(tool.level, args, session.policy, history)
          ├─ Allow → 执行
          ├─ Deny  → 返回结构化错误（回传模型，说明"已被策略拒绝"）
          └─ Ask   → 生成 ApprovalRequest{id, tool, args摘要, 风险说明, 目标路径}
                       → 挂起 → UI 面板 → approve(id, decision)
```

**关键**：`write_file` 现有的 `PendingWrites` 面板（`pending.ts` + `PendingWrites.tsx`）
**复用为通用审批面板**，只是把"文件差异"扩成"任意工具参数摘要 + 风险说明"。

### D3 · 前端判定只做体验，Rust 判定才是边界

延续现有正确纪律（`tools.ts:4-6`："前端校验永远不能代替 Rust 校验"）：
- 前端 `decide()` 负责**提前询问**，避免无谓的 IPC 往返；
- Rust 侧**每次执行前仍重新校验** argv 白名单、脚本内容、路径边界；
- 权限策略的**存储**放在 Rust 侧（防前端被篡改）。

### D4 · 工程根由 `WorkspaceSession` 固定（与 D1 配套）

`fs_read` / `fs_write` / `fs_exists` / `fs_list_in` / `run_allowed` 不再接受任意 `root`，
改为接受 `sessionId`。用户选目录时由 Rust 登记 root 并签发 session。
**这把"工程根边界"从调用方约定升级为契约。**

### D5 · 每次决策写审计日志

`{ ts, runId, tool, args摘要, decision, decidedBy: "user"|"policy"|"auto", result摘要 }`
→ Rust 侧 JSONL，**独立于工程目录**（防止被代理自己改写）。

### D6 · 拒绝必须回传模型

拒绝不是静默失败，而是把"用户拒绝了这次 write_file（原因：…）"作为工具结果回传，
让模型调整策略而不是反复重试。

---

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 维持"白名单即权限" | 白名单挡不住"写测试文件再跑它"这条链（S7） |
| 只对 `run_command` 加审批，写文件维持默认自动 | 写+跑是组合利用，只管一头等于没管 |
| 权限判定全放前端 | 前端不是信任边界；一旦有 XSS（S1）全部失效 |
| 引入成熟的权限 DSL / CEL 表达式引擎 | 当前 3×3 的组合用不上；自实现 `decide()` 约 50 行即可 |
| 每次都弹窗（不提供"总是允许"） | 可用性崩溃；必须提供会话级授权，但**重启后失效** |

---

## 影响

### 正面
- 把 S7 从"固有风险"变成"可见、可控、可审计"的操作；
- 为 P4 的 MCP / Hooks 提供统一的纳管口（**S13 的硬约束：MCP 必须排在权限模型之后**）；
- 与 ADR-0003 的 checkpoint 天然配合（审批挂起成为一个可持久化的 RunState）。

### 负面 / 成本
- **默认体验变更**：写文件与跑命令从"自动"变成"询问"，需要 README/CLAUDE.md 同步；
- 多一次往返（Ask 时挂起）→ 需要 UI 明确展示"等待批准"状态；
- IPC 签名变更（root → sessionId）影响 8 处调用点。

### 风险
- 用户"审批疲劳"导致无脑点允许 → 缓解：面板默认聚焦"拒绝/允许"而非"全部允许"，
  且"本会话总是允许"只对 `Write` 开放，对 `Exec` 要求二次确认。

---

## 验收标准

```
[ ] decide() 的全部组合（3 levels × 3 policies）单测 ≥ 12 条全绿
[ ] 默认配置下，run_command 每次触发审批面板
[ ] 用户拒绝 → 工具返回结构化错误 → 模型能看到"用户拒绝"且不再重试同一操作
[ ] fs_read / fs_write / run_allowed 的签名只接受 sessionId（grep 验证）
[ ] 审批面板复用 PendingWrites 形态，能显示命令与工作目录
[ ] 审计日志落盘（JSONL），位置不在工程目录内
[ ] 会话级"总是允许"在应用重启后失效（有测试）
```

---

*本 ADR 为 Phase 0 审计产出，未实施、未修改任何业务代码。*
