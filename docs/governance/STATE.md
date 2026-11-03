# 项目状态板（唯一权威）

最后更新：2026-11-03 22:0x　｜　维护者：Project Director（Agent 小队）
状态判定用词：`PASS` `PARTIAL` `FAIL` `ABSENT` `NOT_TESTED` `BLOCKED`

---

## 1. 身份基线（FACT，2026-11-03 实测）

| 项 | 值 |
|---|---|
| 仓库 | `F:/zhuomian/zxz`（product `zxz` / `com.zxz.desktop`） |
| 分支 / HEAD | `main` / `c351694`（`docs(audit): O1 重编宿主真机实测…`） |
| 远端 | `origin` 内网 Gitea `192.168.3.200:3000/zxzjxx/zxzgpt.git`（与本地同步）；`github` 备用 |
| 版本号 | `package.json` / `tauri.conf.json` / `Cargo.toml` 三处均 `0.3.0`（一致） |
| 技术栈 | Tauri 2 + Rust（fsx / runx / wsx / proxy / api）＋ React 18 + TS + Vite 6 |
| 规模 | 前端 10,462 行（`App.tsx` 1405 行）；Rust 6 模块 |
| 工作区 | 已跟踪文件 0 改动；未跟踪：`.refs/`（193MB）、`.tmp-skills/`、`docs/audit/*.md`、`docs/governance/` |

### 1.1 基线命令与实测结果

| 命令 | 结果 |
|---|---|
| `npm test` | **327 passed / 15 files**（改动前 326） |
| `npm run build` | 成功；`dist/assets/index-BFrjgvmk.js` 327.98 kB |
| `cargo test --manifest-path tools/fs-harness/Cargo.toml` | **58 passed / 1 ignored**（GNU 工具链；msvc 必失败） |

`[FACT]` 本机 msvc 默认工具链会在链接期被 Git for Windows 的 coreutils `link.exe` 抢占，
报 `link: extra operand`，且后台包装器仍上报 exit 0。**Rust 测试一律用**
`RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`，构建成败必须读日志。

## 2. 阶段进度

| 阶段 | 状态 | 依据 |
|---|---|---|
| Phase 0 接管 | **COMPLETE** | 上表；与 `C1D_BASELINE_AND_GATE.md` 的基线差异已核对（HEAD 前移 3 个提交、版本号已统一） |
| Phase 1 诊断 | **COMPLETE** | 三组独立只读审计（安全 / 架构 / 质量），见 §4 |
| Phase 2 规划 | **COMPLETE** | 本文件 §5 队列 |
| Phase 3 研发 | **IN PROGRESS** | P0-3 第一轮已落地并验证 |
| Phase 4 独立审查 | IN PROGRESS | 每批改动配一次独立复审（本轮已完成安全复审） |
| Phase 5/6 验收交付 | NOT_STARTED | 交付物未重编、未打安装包 |

## 3. 当前结论（不夸大）

- 代码级质量：**良好**。326→327 条前端单测、58 条 Rust 单测全绿；安全类断言质量高（负向断言 + 解析器级判定）。
- 安全态势：**PARTIAL**。P0 三条高危已堵（见 §5 批次 B1），仍有 8 条已登记未修。
- 交付状态：**NOT_READY**。无安装包；CI 不编译 `src-tauri` 本体；e2e 无法在 CI 复现；release exe 已落后于 HEAD。
- 架构状态：**PARTIAL**。编排仍是 1405 行 `App.tsx` 内的闭包循环，`src/orchestration/` 不存在。

## 4. 诊断要点（摘要，证据见各审计文件）

| 维度 | 关键事实 |
|---|---|
| 编排 | `send()` 300 行闭包；`MAX_ROUNDS=6` 未导出；run 状态散在 12 个局部变量；`AbortController` 只覆盖 `chatStream`，**杀不掉正在跑的 `npm test`** |
| 工具 | 新增 1 个工具要改 5 处（`ToolName` / `TOOL_DEFS` / `validateToolArgs` / `executeTool` / `buildToolsPrompt`），无注册表；漏改无编译错误，只在运行时"未知工具" |
| 持久化 | 单键 `zxz.state.v1`，**无 schemaVersion**；250ms 全量写，连 `streaming` 中间态一起写；系统消息**完全不计**上下文预算 |
| 计划模式 | 只有布尔开关 + 两处拦截 + 一段提示词；无产物、无审批、无对账 |
| 测试 | `App.tsx` 1405 + `api.ts` 302 + 组件 2284 = **3991 行 0 覆盖**，且无 jsdom/testing-library，想补也补不了 |
| CI | 仅 `frontend` + `rust-fs`；无 fmt/clippy、无 e2e、无版本一致性、无覆盖率门槛 |

## 5. 执行队列

### 已交付

| 批次 | 内容 | 状态 | 证据 |
|---|---|---|---|
| B1 · P0-3 | npm 脚本审计构造级拒绝 + 全分隔符切段；只读 git 三道加固；`.git/**` 写拒绝 | **PASS** | `docs/audit/P0-3_HARDENING_20261103.md`；327/327 + 58/58 |

### 下一批（按优先级，已排定，不再请示）

| # | 任务 | 为什么现在 | 验收 |
|---|---|---|---|
| B2 | 运行器配置文件闸门：`vite.config.*` / `vitest.config.*` / `eslint.config.*` 由模型可写即等于任意执行 | 与 B1 同源，是当前唯一剩下的 RCE 链 | 写配置 + `npm run build` 被拒；有对照组用例 |
| B3 | `fsExists` 错误语义 + 备份失败必须阻断写入（`fsapi.ts:152`、`App.tsx:281`） | 备份静默失效 = 撤销功能假存在 | 校验失败/备份失败均中止写入，用例覆盖 |
| B4 | `.zxz/undo/**` 专用内部通道（模型不可写） | 撤销快照可被模型覆盖 | 模型写 `.zxz/undo/**` 被拒 |
| B5 | 输出缓冲硬上限 + `env_clear()` + 最小环境白名单 | 本机 DoS 面 + 环境注入面 | 输出超限即停读；`SECRET_TOKEN` 不可见 |
| B6 | 工具注册表（消除 5 处手写） | P1 抽取 Runtime 的前置 | `grep -c "call.name ===" src/` = 0 |
| B7 | 抽 `src/orchestration/round.ts`（只搬轮末判定） | 最小可行切片，风险最低 | 5 条出口用例 + 现有 327 条不回退 |
| B8 | README e2e 项数重测并订正（D-DOC-1） | 现有多处自相矛盾 | 数字 = 实测 |
| B9 | `.gitignore` 补 `.refs/`、`.tmp-skills/`、`.tmp-audit/`、`.tmp-live`、`.tmp-ws` | 193MB 第三方源码会被 `git add -A` 卷进库 | `git status --porcelain` 干净 |

## 6. 风险与阻断

| # | 项 | 级别 | 说明 |
|---|---|---|---|
| R1 | release exe 落后于 HEAD | 高 | 本轮改了 `tools.ts`，exe 内嵌 `index-CQlZK13B.js` ≠ 当前 `index-BFrjgvmk.js`。**未重编前不得声称交付物含本次修复** |
| R2 | 无安装包 | 高 | `bundle.targets: "all"` 配置存在但从未产出；`WebView2` 走 `downloadBootstrapper`，离线不可用 |
| R3 | e2e 不可复现 | 中 | playwright 未入依赖（`npm ci` 后消失）、硬编码 `channel:"msedge"`、默认端口 5173 与 vite 1420 冲突 |
| R4 | release 无条件带 devtools | 中 | `tauri/Cargo.toml` 的 `features=["devtools"]` 无 `cfg(debug_assertions)` 门控 |
| R5 | 推送/发布未授权 | — | 按宪章 §3，push / 打安装包需业主显式授权 |

## 7. 决策记录（ADR 级，追加式）

| # | 决策 | 理由 | 回滚 |
|---|---|---|---|
| DEC-001 | Rust 侧为唯一权威，前端镜像只做提前拦截 | 既有设计；前端可被绕过 | 不适用 |
| DEC-002 | `.git/**` 整目录拒绝写入，而非只挡 `config` | 半开的口子会被 hooks / info/attributes 绕过 | 删除 `fsx::is_repo_metadata` 调用 |
| DEC-003 | git 加固参数强制注入、用户不可关闭 | 依赖"用户没配置"不是安全设计 | 移除 `effective_argv` |
| DEC-004 | 先修 RCE 链，再抽 Runtime | 抽取不改攻击面，修复直接降风险 | 调整 §5 顺序即可 |
