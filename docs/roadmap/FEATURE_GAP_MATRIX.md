# ZXZGPT1 — 能力缺口矩阵（现状 vs 目标）

> Phase 0 READ-ONLY 审计产出。
> 用途：把 14 项产品目标拆成可验收的条目，标明**现状、缺口、落在哪个阶段、如何验证**。
> 现状判定引自 `docs/audit/AGENT_CAPABILITY_MATRIX.md`，此处不重复论证。

---

## 1. 一页总表

| # | 目标能力 | 现状 | 目标 | 阶段 | 缺口性质 |
|---|---|---|---|---|---|
| 1 | Autonomous Agent Loop | 部分 | 独立状态机 Runtime，可测/可中断/可恢复 | **P1** | 架构性 |
| 2 | Multi-turn Tool Calling | 已实现 | 轮次可调 + 并行分组 | P1-P2 | 增量 |
| 3 | Project Exploration | 部分 | glob / grep / gitignore 感知 / 敏感文件拦截 | P2 | 增量 |
| 4 | File Editing and Patch Engine | 部分 | `edit_file` / `apply_patch` / 冲突检测 | **P2** | 能力性 |
| 5 | Permission and Security System | 部分 | 工具级权限模型 + 审批 + 审计 | **P0** | 架构性 |
| 6 | Context Engineering | 未实现 | token 预算 + 压缩 + 优先级装配 | **P3** | 能力性 |
| 7 | Plan Mode | 部分 | 计划产物 + 审批 + 对账 | P3 | 增量 |
| 8 | Session Persistence and Resume | 未实现 | checkpoint + resume | **P3** | 能力性 |
| 9 | Skills | 部分 | 标准化 + allowed-tools | P4 | 增量 |
| 10 | Hooks | 未实现 | 生命周期钩子（受限执行） | P4 | 能力性 |
| 11 | MCP | 未实现 | MCP 客户端，工具统一纳管 | P4 | 能力性 |
| 12 | Subagents | 未实现 | 子 Runtime + 权限收敛 | **P5** | 架构性 |
| 13 | Git Integration | 部分 | 安全加固后扩展只读能力 | P0 → P2 | 安全优先 |
| 14 | Automated Testing and Debugging | 部分 | 可配置验证链 + 覆盖率门禁 | P2 → P6 | 增量 |

---

## 2. 逐项缺口明细

### 1 · Autonomous Agent Loop

| 维度 | 现状 | 目标 | 验证方式 |
|---|---|---|---|
| 位置 | `App.tsx:601` 的 for 循环（React 组件内） | `src/orchestration/agent-runtime.ts`（不依赖 React） | `grep react src/orchestration/` 为空 |
| 状态可见性 | 闭包局部变量 | 显式 `RunState` 状态机 + `getSnapshot()` | 单测断言状态序列 |
| 可测性 | 0（无法单测） | ≥ 7 类行为用例 | vitest |
| 可中断 | 仅 fetch 阶段 | 全阶段 + 工具执行中 | mock 慢工具下 < 500ms 返回 |
| 可恢复 | 否 | checkpoint + resume | P3-3 验收 |
| 轮次策略 | 硬编码 6（`App.tsx:215`） | 可配置，按任务类型调 | 配置生效测试 |

---

### 2 · Multi-turn Tool Calling

| 维度 | 现状 | 目标 |
|---|---|---|
| 轮次上限 | 6（`App.tsx:215`） | 可配置（默认保持 6） |
| 触发下一轮的条件 | 工具结果 / `@@read` / `@@ref` / 测试失败（`App.tsx:764`） | 保留 + 增加"模型显式请求继续" |
| 并行 | **一律串行**（`App.tsx:689`） | 只读并发、写串行（P1-2） |
| 协议正确性 | 已展开为 `assistant.tool_calls` + `tool` 消息（`state.ts:94-104`） | 保持（这块做对了） |

---

### 3 · Project Exploration

| 能力 | 现状 | 目标 | 现状证据 |
|---|---|---|---|
| 目录树 | 深度 2、上限 300 行 | 保持 + 可按配置加深 | `fsapi.ts:123-146` |
| 列目录 | 单层 `list_dir` | 保持 | `App.tsx:441-448` |
| 内容搜索 | **字面子串**、深度 3、100 文件/100 命中 | 正则 + 上下文行 + 更快 | `App.tsx:449-485` |
| 文件名匹配 | 无 | `glob` | 新增 |
| 行范围读取 | 无（只能整文件，4MB 上限） | `read_range` | `fsx.rs:220-238` |
| gitignore 感知 | 无（只有 9 类硬编码忽略） | 读取 `.gitignore` | `files.ts:136-147` |
| 敏感文件拦截 | **无** | 拒绝清单 + 脱敏（SECURITY S9） | — |

---

### 4 · File Editing and Patch Engine

**这是与成熟 Coding Agent 体感差距最大的一项。**

| 能力 | 现状 | 目标 |
|---|---|---|
| 写文件 | `write_file` = **整文件覆盖**（`tools.ts:75`，`fsx.rs:270`） | 保留（新建/小文件仍最快） |
| 精确编辑 | 无 | `edit_file`（old→new 精确替换，失败即报错，**不做模糊匹配**） |
| 补丁 | 无 | `apply_patch`（可复用 `diff.ts` 的 LCS） |
| 冲突检测 | 无 | 基线 hash 比对 |
| 备份/回滚 | 有（`.zxz/undo/<时间戳>/`，`files.ts:165`） | 保留 + 上限与敏感排除 |
| 回读校验 | 有（`App.tsx:287-292`） | 保留（这是好设计） |
| 删除 | 无 | `delete_file`（Exec 权限，**必须审批**） |

---

### 5 · Permission and Security System

| 能力 | 现状 | 目标 | 阶段 |
|---|---|---|---|
| 写审批 | 有，**默认关闭**（`presets.ts:81`） | 三档策略 + 默认按场景 | P0-4 |
| 命令审批 | **无**（白名单即全部） | 默认 `Ask` | P0-4 |
| 读审批 | 无 | 敏感文件触发 | P2 |
| 会话级授权 | 无 | "本会话总是允许"，重启失效 | P0-4 |
| 拒绝回传模型 | 无（拒绝是字符串 error） | 结构化"用户拒绝"+ 原因 | P0-4 |
| 工程根边界 | **靠调用方自律**（SECURITY S2） | `WorkspaceSession` 契约 | P0-1 |
| 审计日志 | 无 | Rust JSONL | P0/P6 |
| 凭据存储 | localStorage 明文 | OS keyring | P0-5 |

---

### 6 · Context Engineering

| 能力 | 现状 | 目标 |
|---|---|---|
| 窗口策略 | 按"轮"截取（`state.ts:89` + `text.ts:48`） | 按 token 预算 |
| 系统消息计量 | **完全不计**（目录树/项目记忆/技能/工具说明/计划指令） | 纳入预算并按优先级裁剪 |
| 压缩 | 无 | 摘要压缩最老的 N 轮（P3-1） |
| 工具结果管理 | 拼接进 hidden user 消息，无上限管理 | 按 recency 递减截断 |
| 项目记忆 | 有（`CLAUDE.md`/`AGENTS.md`，8000 字符截断） | 保持 + 可多文件 |
| 提示注入防护 | 无 | 区分"用户指令"与"检索到的内容"（P3/P4） |

---

### 7 · Plan Mode

| 能力 | 现状 | 目标 |
|---|---|---|
| 提示词 | 有（`project.ts:33-41`，放在系统消息最后） | 保持 |
| 运行时拦截 | 有（写/命令，`App.tsx:432-435`） | 改为策略白名单化 |
| 计划产物 | **无** | 结构化 Plan + 落盘 |
| 审批流转 | 无（手动关开关再发一次） | "批准计划"→ 执行态 |
| 对账 | 无 | 执行后比对计划与实际改动 |

---

### 8 · Session Persistence and Resume

| 能力 | 现状 | 目标 |
|---|---|---|
| 消息持久化 | 有（localStorage `zxz.state.v1`） | Rust 侧存储 + schemaVersion |
| **run 状态持久化** | **无** | checkpoint（ADR-0003） |
| resume | 无（只能重新发消息） | `resume(runId)` |
| 启动检测 | 无 | 提示"上次做到第 N 轮" |
| 损坏降级 | 无 | 校验失败 → 放弃恢复并提示 |

---

### 9 · Skills

| 能力 | 现状 | 目标 |
|---|---|---|
| SKILL.md 解析 | 有（`skill.ts`） | 保持 |
| 内建 12 份 | 有（`src/skills/builtin/*.md`） | 保持 |
| 外部目录 + 覆盖 | 有（`skillstore.ts`） | 保持 |
| 触发词匹配 + 上限 | 有（3 个 / 自动 2 个，`App.tsx:558-560`） | 保持 |
| 渐进加载 L0/L1/L2 | 有（`@@ref`） | 保持 |
| 危险模式扫描 | 有（`skillscan.ts`，只给行号） | 保持（这是好设计） |
| **`allowed-tools` 元数据** | 无 | 新增，交 `PermissionPolicy` |
| 脚本执行 | 无 | 新增，**必须经权限模型** |

---

### 10-11 · Hooks / MCP

| 能力 | 现状 | 目标 | 前置 |
|---|---|---|---|
| Hooks | 未实现 | Pre/PostToolUse、Stop、SessionStart | P1 |
| MCP 客户端 | 未实现 | stdio + SSE transport | **P0-4 权限模型** |
| MCP 工具纳管 | — | 进 `ToolRegistry`，同一 `PermissionPolicy` | P1-3 |
| MCP server 信任 | — | 显式信任，默认 `Ask` | P0-4 |

---

### 12 · Subagents

| 能力 | 现状 | 目标 | 前置 |
|---|---|---|---|
| 派生子 Runtime | 无 | `Task` 工具 | **P1-1** |
| 上下文隔离 | 无 | 独立消息 + 更小预算 | P3-1 |
| 权限收敛 | — | 子代理权限 ≤ 父级（**有测试证明**） | P0-4 |
| 并发写冲突 | — | 串行化或文件锁 | P1-2 |
| 成本上限 | — | 轮次 × token 预算 | P3-1 |

---

### 13 · Git Integration

| 能力 | 现状 | 目标 |
|---|---|---|
| 只读 git | `status` / `diff` / `diff --stat`（`runx.rs:255-274`） | **先加固**（P0-3），再扩展 |
| **安全缺口** | `git diff` 可被仓库内配置劫持（**已实测**，SECURITY S3） | 强制 `--no-textconv --no-ext-diff` + 隔离 config |
| 写操作 | 无 | P2 之后按需（commit 需审批） |
| 结构化 diff | 无（工具日志截断 500 字符，`MessageList.tsx:73`） | UI 呈现 diff |

---

### 14 · Automated Testing and Debugging

| 能力 | 现状 | 目标 |
|---|---|---|
| 自动跑测试 | 有，`npm test` 最多 3 轮（`App.tsx:717-756`） | 保持 3 轮纪律 |
| 默认关闭且 `=== true` | 有（`presets.ts:85`，**正确**） | 保持 |
| 脚本内容审计 | 有（Rust `runx.rs:190-207`，**优秀**） | 保持 |
| 验证链 | 只有 test | 可配 `test → build → typecheck` |
| 覆盖率门禁 | 无 | P6 |
| 失败回传 | 全量输出截断 20000 字符 | 只回传失败用例与断言差异 |
| 调试（断点/单步） | 无 | 不在近中期目标 |

---

## 3. 按"缺口性质"排序的投入建议

| 性质 | 条目 | 为什么优先 |
|---|---|---|
| **安全/边界（先修）** | 5（部分）、13（git 加固） | 不修就扩展能力 = 扩大攻击面 |
| **架构性（解锁最多）** | 1（Runtime）、5（权限）、12（Subagents 的前置） | 后续所有能力都依赖它们 |
| **能力性（体感差距最大）** | 4（Patch Engine）、6（上下文）、8（resume） | 用户能直接感知 |
| **增量（性价比高）** | 2、3、7、9、14 | 在地基之上快速补齐 |

**一句话**：先花 P0 把边界与闸门装好，再花 P1 把 Runtime 抽出来，
之后 P2 的 Patch Engine 与 P3 的上下文/resume 会同时带来最大的体感提升。

---

*本文档为 Phase 0 审计产出，未修改任何业务代码。*
