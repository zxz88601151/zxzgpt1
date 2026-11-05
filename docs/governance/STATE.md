# 项目状态板（唯一权威）

最后更新：2026-11-06（队列 ①~⑥ 全轮推进后）　｜　维护者：Project Director（实施方）+ 独立复审归档
状态判定用词：`PASS` `PARTIAL` `FAIL` `ABSENT` `NOT_TESTED` `BLOCKED`

> **本次更新缘由**：2026-11-05 的独立只读审计对齐了真实 HEAD `2083011`，随后业主于
> 11-06 确认执行队列「① 归档复审 → ② 取消传播 → ③ MCP 默认 Ask → ④ 成本闸门 →
> ⑤ App.tsx 拆分 → ⑥ CSP 真机验证」。本轮按序推进 ①~⑤，⑥ 因无 Windows WebView2
> 宿主而 `BLOCKED`，交付可复现验证清单。本文件据此更新为当前唯一权威基线。
> 证据：`docs/audit/HEAD_2083011_INDEPENDENT_AUDIT_20261105.md`、
> `docs/audit/BATCH_20261105_INDEPENDENT_REVIEW.md`、`docs/adr/0004-mcp-permission.md`、
> `docs/audit/PREVIEW_CSP_HOST_VERIFICATION_20261106.md` 与 `git log`。

---

## 1. 身份基线（FACT，2026-11-06 复核）

| 项 | 值 |
|---|---|
| 仓库 | 公开仓库 `zxz88601151/zxzgpt1`；本轮工作副本 `/workspace/zxzgpt1` |
| 分支 / HEAD | `main` / **`50c21ea`**（本地，2026-11-06）；工作区**干净** |
| 远端 | `origin` 仍停在 `2083011`。**本轮 6 笔本地提交均未推送**（宪章 §3.1，push 需业主显式授权） |
| 版本号 | `package.json` / `tauri.conf.json` / `Cargo.toml` 三处均 `0.3.0`，一致 |
| 技术栈 | Tauri 2 + Rust（fsx / runx / wsx / proxy / api / perms / mcp）＋ React 18 + TS + Vite 6；vitest |
| 规模 | `App.tsx` **1296 行**（本轮 1570 → 1296，-274）；`orchestration/session.ts`、`registry.ts`、`mcp.rs` 未大改；新增 `lib/workspace.ts`、`lib/toolpolicy.ts`、`lib/regexsafe.ts`、`orchestration/budget.ts`、`orchestration/summarize.ts`、`hooks/useMcpServers.ts`、`hooks/useExecApproval.ts` |
| 单测 | **34 文件 / 615 条（609 passed + 6 skipped）**；`perf` 6 条按设计 skipped |
| 内置工具 | **11 个**（`registry.ts` 的 `TOOLS` 唯一权威）＋ MCP 动态工具；后者已由 `lib/toolpolicy.ts` 统一解析并默认 `Ask`（ADR 0004） |
| 11-05 新增能力 | 预览窗口、`web_search`、`todo_write`、正则 + `glob`、Explore 子代理、工具并行、上下文压缩、MCP 客户端、预设更新等 |

### 1.1 基线命令与实测结果

| 命令 / 检查 | 2026-11-06 本轮实测（Ubuntu 沙箱） | 2026-11-05 对照 |
|---|---|---|
| `npm ci` | PASS（队列开始前） | PASS |
| `npm test` | **609 passed / 6 skipped（34 文件）**，每步复跑全绿 | 545 / 29 文件 |
| `npm run build` | **PASS**；93 modules；`index-DzmQ_Dpb.js` **369.72 kB** / gzip 133.42 kB | 365.04 kB / 86 modules |
| Rust `tools/fs-harness` `cargo test` | **76 passed / 6 failed / 1 ignored**。6 条失败为**预存平台性失败**（Windows 路径语义 `\\?\`、反斜杠、宿主 `PWD` 环境变量），已用 HEAD 版 `perms.rs` 做基线对照：基线 **70 passed / 6 failed**，失败项完全相同 → 与本轮改动无关。新增 6 条 `perms::mcp_*` 测试**全 PASS** | 未跑（当时标 `NOT_TESTED`） |
| `src-tauri` 全量 `cargo test` / `cargo check` | **`NOT_TESTED`**：Ubuntu 无 WebView2 导入库，宪章 §5.6 要求 Windows + GNU 工具链 | `NOT_TESTED` |
| 本地 e2e（4 套）/ 真模型 | **`NOT_TESTED`**：需 Playwright 浏览器本体与桌面宿主 | 历史 Windows 宿主 24/24、39/39、69/69、11+24 全绿 |
| CI（GitHub Actions 宿主） | **PASS**：23 次运行，最新 `CI #23 / 2083011` = `passing`（三 job 全绿）。**本轮提交未推送，故 CI 未覆盖新提交** | 同 |
| 打包 / 安装包 | **`NOT_TESTED`**（本轮未授权；宪章 §3） | 历史 NSIS 安装包业主实测 PASS |
| 真机 CSP（含预览窗口 External URL） | **`NOT_TESTED` / `BLOCKED`**：见 §5 队列 #7 与 `PREVIEW_CSP_HOST_VERIFICATION_20261106.md` | 主窗口 CSP 已配 |

> `[FACT]` 构建成功必须读日志、不信退出码；Rust 侧只跑了不依赖 tauri 的 harness，
> 未把「harness 通过」冒充「`src-tauri` 全量编译通过」。

## 2. 阶段进度

| 阶段 | 状态 | 依据 |
|---|---|---|
| Phase 0 接管 | **COMPLETE** | 见 §1.1 |
| Phase 1 诊断 | **COMPLETE** | 三组独立只读审计 + `HEAD_2083011_INDEPENDENT_AUDIT_20261105.md` |
| Phase 2 规划 | **PARTIAL** | ROADMAP 部分条目被 11-05 代码超前实现；本轮补了校正章节，仍未整体重排 |
| Phase 3 研发 | **IN PROGRESS** | 队列 ①~⑤ 已落地；⑥ BLOCKED |
| Phase 4 独立审查 | **PARTIAL** | 11-05 批次独立复审已归档（`BATCH_20261105_INDEPENDENT_REVIEW.md`，结论 `PARTIAL`）；**本轮 ①~⑤ 的代码改动尚未做非实施者独立复审**，见 R11 |
| Phase 5/6 验收交付 | **PARTIAL** | 构建物可产出、CI 绿；产品级验收签字仍 `ABSENT`，未推送/未打包 |

## 3. 当前结论（不夸大）

- **代码级质量：良好**。609 条前端单测全绿、构建通过；新增模块均有同名单测；Rust 闸门逻辑由 harness 真实覆盖。
- **安全态势：PARTIAL（P1 三项已修，独立复审待补）**。D-17（子代理不响应停止）、D-18（MCP 无 `Ask`）、D-20（批次异常空洞）已修；D-21/D-22（正则与成本）已修；预览窗口 D-23 仍 `NOT_TESTED`。
- **控制面：PASS（本轮修复）**。停止信号经 `mainSignalRef` 传到子代理，`runRounds` 每轮前查 `signal.aborted`，`runSubagent` 每轮请求前再查一次；`runToolBatch` 任何异常都补成 `error` 记录。
- **MCP 信任模型：已裁定并落地**。`lib/toolpolicy.ts` 统一解析内置 / MCP / 未知工具；`mcp_call_tool` IPC 必带 `session_id`，Rust `perms::guard_mcp` 为权威闸门，`need_grant` → `askExec` → `perm_grant` → 重试；审批通道缺失时 fail-closed。详见 ADR 0004。
- **架构状态：PARTIAL（本轮改善但未达标）**。`App.tsx` 1570 → **1296 行**，抽出 4 个可单测模块 + 2 个 hook；ADR 0001 验收项「`App.tsx` < 500 行」**仍为 `[ ]`**，剩余为 JSX 装配与状态接线层，需后续分批，不在本轮冒进。
- **交付状态：NOT_READY**。未推送、未打包、未产生费用、未新增依赖；6 笔本地提交可追溯。

## 4. 诊断要点（当前）

| 维度 | 关键事实 |
|---|---|
| 编排 | `runRounds(deps)` 在 `orchestration/session.ts`（不 import react）；`runToolBatch` 由 `budget.planToolBatch` 分波：cheap 按 4 并发、expensive 每批最多 1、gated 串行 |
| 工具 | `TOOLS` 11 个内置工具；MCP 动态工具经 `resolveToolPolicy` 纳入统一策略视图（`exec` / `ask` / `expensive`） |
| 停止/取消 | 主链路 signal 贯穿子代理；`run_cancel` 终止子进程；`runToolBatch` 不再吞 rejected |
| 正则 | `regexsafe.ts` 静态拒绝嵌套量词 / 量词化分支 / 大重复，单行匹配上限 2000 字符，`run` 入口二次校验 |
| 上下文 | 压缩引擎在 `orchestration/compact.ts`；prompt 拼装抽到 `orchestration/summarize.ts` |
| 持久化 | 单键 `zxz.state.v1`，**无 `schemaVersion`**（D-07 仍在）；`compactSummary` / `compactAfterIndex` 无迁移链 |
| 计划模式 | 布尔开关 + 拦截 + 提示词；无产物、无审批、无对账（P3-2 未做） |
| 测试 | 609 条；`App.tsx` 与组件层仍基本 0 组件单测（D-13 仍在），但接线层纯逻辑已可单测 |
| CI | 三 job 全绿（宿主实测）；无 fmt/clippy、无覆盖率门槛、无版本一致性检查 |

## 5. 执行队列（业主 2026-11-06 确认的顺序）

| # | 任务 | 级别 | 状态 | 证据 / 验收 |
|---|---|---|---|---|
| 1 | 治理基线对齐到 `2083011` | P1 | **已完成**（11-05 前置） | `f24f51c` |
| 2 | 归档 11-05 批次独立复审 | P1 | **已完成** | `6dac044`；`BATCH_20261105_INDEPENDENT_REVIEW.md`，结论 `PARTIAL` |
| 3 | 子代理取消传播 + 并行批次异常处理 | P1 | **已完成** | `d5515a8`；550 → 609 全绿；新增 5 条断言（注：提交消息里的 D-18 应为 D-20，见台账 §7） |
| 4 | MCP 工具纳入注册表 + 默认 `Ask` | P1 | **已完成（业主裁定）** | `851c990` + ADR 0004；前端 9+18 条新断言、Rust harness 6 条 MCP 闸门测试全 PASS |
| 5 | 并发成本闸门 + 正则 ReDoS 防护 | P2 | **已完成** | `3935880`；`budget.ts` / `regexsafe.ts` + 30 条断言 |
| 6 | `App.tsx` 拆分（ADR 0001 第 5 项） | P2 | **部分完成** | `50c21ea`；1570 → 1296 行，4 模块 + 2 hook + 8 条新断言；**`< 500 行` 仍未达成** |
| 7 | 预览窗口真机 CSP 验证 | P2 | **BLOCKED** | `PREVIEW_CSP_HOST_VERIFICATION_20261106.md`；需 Windows + WebView2 宿主，本沙箱 `NOT_TESTED` |

> **顺序纪律已遵守**：先立基线与判据（1→2），再动控制面代码（3/4），再动成本与架构（5/6）；
> 4 的信任模型变更由业主在队列中点名裁定，先落 ADR 后改代码。未逐条孤立修 bug，未跳阶段。

## 6. 风险与阻断

| # | 项 | 级别 | 说明 |
|---|---|---|---|
| R1 | release exe / 安装包落后于 HEAD | 中 | 本轮 6 笔本地提交未打包；宪章 §3 需业主显式授权 |
| R2 | 推送 / 发布未授权 | — | `origin` 仍 `2083011`；本轮未推送、未打包、未产生费用 |
| R3 | e2e 不可复现 | **已解除** | GitHub Actions 23 次运行，`CI #23` `passing`；但新提交未推送，CI 未覆盖 |
| R4 | 治理基线失真 | 已修 | `STATE.md` / 台账 / README / CLAUDE / 架构 / 路线图本轮同步；D-24 收口 |
| R5 | MCP 权限旁路 | **已修** | ADR 0004；Rust 闸门 fail-closed |
| R6 | 子代理不响应停止 | **已修** | `mainSignalRef` + 双重 abort 检查 |
| R7 | 11-05 批次无独立复审 | 已修 | 批次级复审归档完成；产品验收签字仍 `ABSENT` |
| **R8** | 本轮 ①~⑤ 代码改动尚无独立复审 | **P1（新增）** | 实施方自测不构成验收结论（宪章 §1）；需非实施者复核后才能把相关项从 `PARTIAL` 升 `PASS` |
| **R9** | ADR 0001 `App.tsx < 500 行` 未达成 | P2 | 1296 行；剩余为 JSX 装配与状态接线，需分批继续抽，不冒进 |
| **R10** | 预览窗口 CSP 无宿主证据 | P2 / BLOCKED | D-23；验证清单已交付，结论仍 `NOT_TESTED` |
| **R11** | Rust 全量编译 / 真机行为未验证 | — | Ubuntu 沙箱；harness 只能覆盖纯逻辑，6 条预存平台性失败已基线对照排除 |
| **R12** | `todo_write` 不持久化、`schemaVersion` 缺失 | P3 | D-25 / D-07 仍在册，本轮未动 |

## 7. 决策记录（ADR 级，追加式）

| # | 决策 | 理由 | 回滚 |
|---|---|---|---|
| DEC-001 ~ DEC-013 | 见上一版（Rust 权威、`.git/**` 拒绝、git 参数强制注入、先修 RCE 再抽 Runtime、撤回「配置文件即 RCE」、撤销区读写全关、授权 scope=命令+子命令、授权粒度工程级、npm `pre`/`post` 钩子、工具链配置拒绝、只审计不改码、e2e 改判、MCP 待业主裁定） | 沿用 | 见原文 |
| **DEC-014** | **MCP 权限收敛按 ADR 0004 实施**：统一策略视图 + 默认 `Ask` + Rust `guard_mcp` 权威闸门 | 业主 2026-11-06 在队列中点名第 ③ 项，构成宪章 §4 要求的裁定；先落 ADR 再改代码 | 若真机发现授权框体验不可接受，回退到「默认禁用所有 MCP 服务器」，不回退到无 `Ask` |
| **DEC-015** | ⑤ 拆分采用「纯逻辑优先抽成可单测模块 + 2 个 hook」，**不强行把 `App.tsx` 压到 500 行以下** | 601→609 条测试中有 App 层回归网；一次性拆 JSX 会大范围破坏接线，违反「先审计再修复、架构收敛」原则。本轮留下可量化的推进（1570→1296）与明确缺口 | 若后续出现接线回归，按模块逐个回滚 |
| **DEC-016** | ⑥ 在本沙箱标 `BLOCKED` / `NOT_TESTED`，只交付可复现验证清单，**不改任何 CSP 配置** | 宪章 §3.7 / §3.8；没有宿主级证据时改 CSP 等于把未验证配置写进产品 | 业主提供 Windows 宿主后按清单执行并回填证据 |
| **DEC-017** | 本轮 6 笔提交全部**本地提交、不推送远端** | 宪章 §3.1；CI 未覆盖新提交的事实必须如实写进 §1.1 | 业主授权后单独推送 |
