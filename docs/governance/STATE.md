# 项目状态板（唯一权威）

最后更新：2026-11-05（独立只读审计复核）　｜　维护者：独立只读审计（对齐真实 HEAD `2083011`）
状态判定用词：`PASS` `PARTIAL` `FAIL` `ABSENT` `NOT_TESTED` `BLOCKED`

> **本次更新缘由**：本文件上一版停在 2026-11-04 10:20 / HEAD `8142815`，
> 而公开仓库真实 HEAD 已是 `2083011`（11-05 14:29），中间 20 个提交落地了 6 类新能力。
> 过期状态板会导致后续所有优先级判断基于错误前提，故先对齐基线，再谈推进。
> 完整证据见 `docs/audit/HEAD_2083011_INDEPENDENT_AUDIT_20261105.md`。
> **上一版的历史实测数据（Windows 宿主）保留在 §1.1 作为对照，不删除、不冒充今日实测。**

---

## 1. 身份基线（FACT，2026-11-05 独立审计复核）

| 项 | 值 |
|---|---|
| 仓库 | 公开仓库 `zxz88601151/zxzgpt1`（product `zxz` / `com.zxz.desktop`）；本轮工作副本 `/workspace/zxzgpt1` |
| 分支 / HEAD | `main` / **`2083011`**（2026-11-05 14:29 +0800），工作区**干净** |
| 远端 | `origin` = 公开 GitHub `zxz88601151/zxzgpt1`（CI 只认它，已同步到 `2083011`）；另有一路内网 Gitea `<内网地址>/<user>/zxzgpt.git`（历史记录，认证状态未复核）。2026-11-04 推送前已对公开可见内容做内网信息占位处理 |
| 版本号 | `package.json` / `tauri.conf.json` / `Cargo.toml` 三处均 `0.3.0`（**一致**；ROADMAP §P6 记的 0.1.0 已修） |
| 技术栈 | Tauri 2 + Rust（fsx / runx / wsx / proxy / api / perms / **mcp**）＋ React 18 + TS + Vite 6；vitest |
| 规模 | 生产代码 15,807 行；`App.tsx` **1550 行**、`orchestration/session.ts` 390 行、`registry.ts` 688 行、`mcp.rs` 936 行；单测 **29 文件 / 551 条（545 passed + 6 skipped）** |
| 内置工具 | **11 个**：`read_file` `list_dir` `search_files` `write_file` `edit_file` `apply_patch` `run_command` `web_search` `todo_write` `glob` `explore`（`registry.ts:586` 唯一权威）＋ MCP 动态工具（独立于注册表） |
| 11-05 新增能力 | 内置预览窗口、`web_search`、`todo_write`、正则搜索 + `glob`、同步 Explore 子代理、工具并行执行、上下文压缩与预算、MCP 客户端、预设更新、听写 V1、补丁编辑与探索模式 |

### 1.1 基线命令与实测结果

| 命令 / 检查 | 2026-11-05 本轮实测（Ubuntu 沙箱） | 2026-11-04 Windows 宿主实测（历史对照） |
|---|---|---|
| `npm ci` | **PASS** | — |
| `npm test` | **545 passed / 6 skipped（551）**；28 文件通过 + 1 跳过；6.16s | 447 / 20 文件（25.4s） |
| `npm run build` | **PASS**；86 modules；`index-BNUoWb_l.js` 365,04 kB / gzip 131,82 kB | 336,162 B（`index-CI0qq08X.js`） |
| `cargo test` / `cargo check` | **`NOT_TESTED`**：本沙箱 Ubuntu；fs-harness 11 条按 Windows 语义设计，宪章 §5 固定 `windows-latest` + GNU 工具链 | 82 passed / 1 ignored（fs-harness）、3 passed（proxy-harness）、`cargo check` 通过 |
| 本地 e2e（4 套） | **`NOT_TESTED`**：需 Playwright 浏览器本体与 Rust harness 编译 | 24/24、39/39、69/69、11+24 全绿 |
| **CI（GitHub Actions 宿主）** | **PASS**：共 **23 次运行**，最新 `CI #23 / 2083011` badge = `passing`；`ci.yml` 三 job 无 `continue-on-error` → `frontend` / `rust-fs` / `e2e` 全绿。**B14-B「首次 CI 运行」据此关闭**（宿主实测，非本地自证） | job 已写但从未跑过 → 当时标 `NOT_TESTED` |
| 打包 / 安装包 | **`NOT_TESTED`**（本轮未授权构建；宪章 §3 需业主显式授权） | B12-B6 NSIS 安装包 PASS，业主实测安装成功、可写回代码；未签名、未测卸载、未测无 WebView2 机器 |
| 真机 CSP（含预览窗口 External URL） | **`NOT_TESTED`**：`CLAUDE.md` 要求宿主级 DevTools 证据 | 主窗口 CSP 已配 |

`[FACT]` 本机 msvc 默认工具链会在链接期被 Git for Windows 的 coreutils `link.exe` 抢占，
报 `link: extra operand`，且后台包装器仍上报 exit 0。**Rust 测试一律用**
`RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`，构建成败必须读日志。

## 2. 阶段进度

| 阶段 | 状态 | 依据 |
|---|---|---|
| Phase 0 接管 | **COMPLETE** | 见 §1.1 |
| Phase 1 诊断 | **COMPLETE**（11-05 追加一轮） | 三组独立只读审计（安全 / 架构 / 质量）+ 本轮 `HEAD_2083011_INDEPENDENT_AUDIT_20261105.md` |
| Phase 2 规划 | **PARTIAL** | ROADMAP 的 P3/P4/P5 条目已被 11-05 代码超前实现，规划文档未同步；§5 队列已按新证据重排 |
| Phase 3 研发 | **IN PROGRESS** | B1–B16、B12-A/B、D-16 已落地；11-05 又落地 20 个功能提交（见 §1） |
| Phase 4 独立审查 | **PARTIAL** | 11-03/11-04 批次有独立复审；**11-05 的 20 个提交此前 `ABSENT`，本轮补首次独立复审（审计报告 §3）** |
| Phase 5/6 验收交付 | **PARTIAL** | 安装包 B12-B6 已 PASS 并业主实测；CI `e2e` job 首次运行 PASS；产品级验收签字仍缺 |

## 3. 当前结论（不夸大）

- **代码级质量：良好**。545 条前端单测全绿、构建通过、CI 三 job 全绿；新增能力（压缩 / 并行 / MCP / 子代理 / 预览命令）都有对应单测文件。
- **治理状态：PARTIAL（本轮已对齐）**。状态板曾落后 HEAD 20 个提交；`README` / `CLAUDE.md` / `CURRENT_ARCHITECTURE.md` / `ROADMAP` 仍有多处过期口径，已在审计报告 §2 逐条列出，本轮同步了 `STATE.md` / `TECH_DEBT_REGISTER` / `CLAUDE.md` / `README.md` 的关键事实，`CURRENT_ARCHITECTURE.md` 与 `ROADMAP.md` 待下批。
- **安全态势：PARTIAL（出现新旁路）**。P0 三条 + 执行授权闸门（P0-4）仍在；但 11-05 合入的 **MCP 工具未接入权限模型**（无 `Ask`、不在注册表内），与 `MCP_PREREQUISITE_AUDIT.md` §4 的前置约束冲突。已核实「模型改写工程内 `mcp.json` → RCE」**不成立**（配置在工程根之外且有校验）。
- **控制面：PARTIAL**。**子代理不受主「停止」信号控制**（`App.tsx:639` 新建独立 controller），与已修的 D-01 同类回归，且伴随真实模型费用。
- **架构状态：PARTIAL（本轮恶化）**。轮循环已在 `orchestration/session.ts` 且该目录不 import react；但 `App.tsx` 从 1338 行回升到 **1550 行**，ADR 0001「< 500 行」更远了。
- **交付状态：NOT_READY（指产品验收，非构建物）**。构建物历史上已产出并业主实测；本轮未重编、未推送、未打包。

## 4. 诊断要点（摘要，证据见审计报告 §3）

| 维度 | 关键事实 |
|---|---|
| 编排 | 轮循环在 `session.ts` 的 `runRounds(deps)`，依赖注入完整；新增 `runToolBatch` 并发调度（只读扇出 / 写执行串行），但 `Promise.allSettled` 未处理 rejected，异常时可能留下 `undefined` 记录导致整轮崩溃 |
| 工具 | `registry.ts` 的 `TOOLS` 仍是内置工具唯一真值源，但**扩到 11 个**；MCP 工具是独立动态清单，未纳入注册表与权限模型 |
| 持久化 | 单键 `zxz.state.v1`，**无 `schemaVersion`**（D-07 仍在）；新增 `compactSummary` / `compactAfterIndex` 字段，仍无迁移链 |
| 计划模式 | 仍是布尔开关 + 拦截 + 提示词；无产物、无审批、无对账（P3-2 未做） |
| 停止/取消 | 主链路 `AbortController` + `run_cancel` 已能停；**子代理链路未接主 signal**（P1-1） |
| 上下文 | 压缩引擎已落地（token 预算 + 增量摘要 + 结构化兜底），`perf` 6 条按设计 skipped；系统消息已计入预算 |
| 测试 | 545 条，覆盖 `lib` / `api` / `orchestration` / 少量组件；`App.tsx` 与各面板组件仍基本 0 组件单测（D-13 仍在） |
| CI | 三 job 全绿（宿主实测）；无 fmt/clippy、无覆盖率门槛、无版本一致性检查 |

## 5. 执行队列

### 已交付（批次索引，完整证据见各审计文件与 `git log`）

| 批次 | 内容 | 状态 |
|---|---|---|
| B1–B6 / B10 / B13 / B15 / B16 | P0-3 加固、写入前置、撤销隔离、输出与环境、工具注册表、执行授权闸门、停止真的停、鉴权前置、撤销清单完整性、devtools 门控 | **PASS** |
| B7 / B8 / B11 | 轮末判定抽取、证据对账、清单不完整要说出来 | **PASS** |
| B12-A / B12-B1 / B12-B2 / B12-B3 | 传输层 37 条、渲染夹具、整轮重放 7 类、轮循环搬家 | **PASS** |
| B14-A / **B14-B** | e2e 可复现；**e2e 进 CI → 本轮据 GitHub Actions `CI #23 passing` 转 PASS** | **PASS** |
| B12-B5 / B12-B6 / D-16 | release 重编、NSIS 安装包（业主实测）、中断不再记故障 | **PASS** |
| 11-05 批次（20 提交） | 预览 / 联网搜索 / 任务清单 / 正则+glob / 子代理 / 并行 / 压缩 / MCP / 预设 / 真机 e2e | **代码已合入、单测与 CI 全绿；独立复审本轮补做，产品验收签字 `ABSENT`** |

### 下一批（按优先级，来源：审计报告 §5）

完整清单见 **`docs/audit/TECH_DEBT_REGISTER_20261103.md` §6**（P0–P3，带证据/影响/状态）。

| # | 任务 | 级别 | 为什么现在 | 验收 |
|---|---|---|---|---|
| 1 | 治理基线对齐到 `2083011` | P1 | 过期权威状态板比没有更危险 | **本轮已执行**：本文件 + 技术债台账 + `CLAUDE.md` + `README.md` |
| 2 | 归档 11-05 批次独立复审记录 | P1 | 宪章 §1 要求非实施者复核 | **本轮已执行**（审计报告落盘） |
| 3 | 子代理取消传播 + `runToolBatch` 异常处理 | P1 | 「停止」再次说谎且产生费用 | 审计报告 P1-1 / P2-2 测试点全绿 + 变异检验 |
| 4 | MCP 工具纳入注册表 + 默认 `Ask` | P1 | 执行授权闸门被名义绕过 | 启用 server 后模型调用必弹授权，拒绝可回传错误 |
| 5 | 并发成本闸门 + 正则 ReDoS 防护 | P2 | 成本无上限、恶意正则可卡死渲染进程 | 恶意正则限时返回；`explore` 并发有上限 |
| 6 | `App.tsx` 拆分（ADR 0001 第 5 项） | P2 | 1550 行，回归面持续变大 | < 500 行，接线层有回归网 |
| 7 | 预览窗口真机 CSP 验证 | P2 | 宪章 §3.7 要求宿主级证据 | Windows DevTools 无 CSP 报错（**本沙箱 BLOCKED**） |

> **顺序纪律**：先 1→2 把判据与基线立住，再动 3/4 这两处控制面代码；4 涉及 MCP 信任模型，
> 属宪章 §4「重大架构决策」，需业主明确裁定后再动代码。不逐条孤立修 bug，不跳阶段。

## 6. 风险与阻断

| # | 项 | 级别 | 说明 |
|---|---|---|---|
| R1 | release exe 落后于 HEAD | 已解除 | B12-B5 重编；但 11-05 又有 20 个提交，**当前发布物再次落后于 HEAD**（本轮未授权重编） |
| R2 | 无安装包 | 已解除（安装已验证） | B12-B6；残留：未签名、未测卸载、未测无 WebView2 机器；11-05 新功能未进任何安装包 |
| R3 | e2e 不可复现 | **已解除** | B14-A + B14-B；**2026-11-05 查证 GitHub Actions 已跑 23 次，最新 `#23` `passing`**，三 job 全绿 |
| R4 | release 无条件带 devtools | 已解除 | B16 |
| R5 | 推送 / 发布未授权 | — | 宪章 §3：push / 打安装包需业主显式授权。本轮未推送、未打包 |
| **R6** | 治理基线失真 | 已修（本轮） | 状态板曾落后 20 个提交；`CURRENT_ARCHITECTURE.md` / `ROADMAP.md` 仍待同步 |
| **R7** | MCP 权限旁路 | **P1** | `executeMcpToolCall` 无 `Ask`、不在 `TOOLS` 内；默认 `enabled:false` 缓解触发前提；需业主裁定信任模型 |
| **R8** | 子代理不响应停止 | **P1** | `App.tsx:639` 独立 controller；点停止后子代理仍跑最多 4 轮模型请求 |
| **R9** | 11-05 批次无独立复审 | P1 | 20 个提交、6 类新攻击面；本轮补首次独立复审，产品验收签字仍 `ABSENT` |
| **R10** | 本轮审计环境限制 | — | Ubuntu 沙箱：Rust 测试 / 本地 e2e / 真机 CSP / 打包均为 `NOT_TESTED`，不标 PASS |

## 7. 决策记录（ADR 级，追加式）

| # | 决策 | 理由 | 回滚 |
|---|---|---|---|
| DEC-001 ~ DEC-010 | 见上一版（Rust 权威、`.git/**` 拒绝、git 参数强制注入、先修 RCE 再抽 Runtime、撤回「配置文件即 RCE」、撤销区读写全关、授权 scope=命令+子命令、授权粒度工程级、npm `pre`/`post` 钩子、工具链配置拒绝） | 沿用 | 见原文 |
| **DEC-011** | 本轮只做审计与治理文档对齐，**不改业务代码** | 宪章 §1：独立只读角色不得修改被测代码；且用户既定纪律是「先审计再修复」「先立数据主链路」 | 不适用 |
| **DEC-012** | B14-B 从 `NOT_TESTED` 改判 `PASS`，依据为 GitHub Actions 宿主 `CI #23 passing` | 宿主实测属于外部证据，非本地自证；`ci.yml` 三 job 无 `continue-on-error`，整体绿即 e2e job 绿 | 若发现 job 被跳过，回退为 `NOT_TESTED` 并附日志 |
| **DEC-013** | MCP 权限收敛（队列 #4）列为需业主裁定的重大架构决策，不擅自实施 | `MCP_PREREQUISITE_AUDIT.md` §4 与 ROADMAP P4-3 的前置约束涉及信任模型变更，宪章 §4 要求分歧由业主消解 | 业主裁定后按 ADR 追加新决策 |
