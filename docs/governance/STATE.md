# 项目状态板（唯一权威）

最后更新：2026-11-06（第三轮队列 ① ②③ 独立复核 / ② R9 第一步完成后）　｜　维护者：Project Director（实施方）+ 独立只读复审归档
状态判定用词：`PASS` `PARTIAL` `FAIL` `ABSENT` `NOT_TESTED` `BLOCKED`

> **本次更新缘由**：业主「根据下一步建议继续做」→ 按上轮 §8 建议队列推进。
> ① 由宪章 §1 要求的**独立只读子 Agent** 对第二轮 ②③ 代码改动做独立复核，首轮
> `PARTIAL` 抓到 2 条 P1 + 1 条 P2；随后 **五轮「复审 → 根因修复 → 再复审」**，逐层
> 剥掉「局部脱敏」的结构性缺口，第 6 轮 `PASS`，**R15 / D-32 解除（代码级）**。
> ② 补组件层 DOM 单测（`Welcome` / `SkillChips`，9 条）作为 R9 第一步，未硬拆 JSX。
> ③/⑥（Rust 信任模型裁定、推送打包）需业主显式授权，④（Windows 宿主 CSP）`BLOCKED`，
> ⑤（D-25 / D-07 写节流）登记下一批，均**未动代码**。
> 证据：`docs/audit/QUEUE_0203_CODE_INDEPENDENT_REVIEW_20261106.md`、
> `docs/audit/QUEUE_0203_RECHECK_ROUNDS_2_6_20261106.md`、`git log`、本文件 §1.1 实测。
> 提交数统一锚定到 `1ef427d` 计数（16 笔），避免「文档提交自身又让数字过期」的自指失真。

---

## 1. 身份基线（FACT，2026-11-06 复核）

| 项 | 值 |
|---|---|
| 仓库 | 公开仓库 `zxz88601151/zxzgpt1`；本轮工作副本 `/workspace/zxzgpt1` |
| 分支 / HEAD | `main` / **`1ef427d`**（本地，2026-11-06）；工作区**干净** |
| 远端 | `origin` 仍停在 `2083011`。**自 2083011 起 16 笔（截至 `1ef427d`）本地提交全部未推送**（宪章 §3.1，push 需业主显式授权） |
| 版本号 | `package.json` / `tauri.conf.json` / `Cargo.toml` 三处均 `0.3.0`，一致 |
| 技术栈 | Tauri 2 + Rust（fsx / runx / wsx / proxy / api / perms / mcp）＋ React 18 + TS + Vite 6；vitest |
| 规模 | `App.tsx` **1283 行**（1570 → 1296 → 1283，累计 -287）；新增 `lib/abort.ts`、`lib/conversations.ts`、`lib/exports.ts`、`lib/migration.ts`、`lib/regexsafe.ts`、`lib/toolpolicy.ts`、`orchestration/budget.ts`、`orchestration/summarize.ts`、`hooks/` |
| 单测 | **42 文件 / 764 条（758 passed + 6 skipped）**；`perf` 6 条按设计 skipped |
| 内置工具 | **11 个**（`registry.ts` 的 `TOOLS` 唯一权威）＋ MCP 动态工具；后者由 `lib/toolpolicy.ts` 统一解析并默认 `Ask`（ADR 0004） |
| 存档 | 单键 `zxz.state.v1`，**`schemaVersion = 2`**（本轮落地）；旧版 / 未来版本 / 损坏存档迁移前备份到 `zxz.state.v1.backup.*` |

### 1.1 基线命令与实测结果

| 命令 / 检查 | 2026-11-06 最终实测（Ubuntu 沙箱） |
|---|---|
| `npm ci` | PASS（队列开始前） |
| `npm test` | **758 passed / 6 skipped（42 文件）**，每步复跑全绿 |
| `npm run build` | **PASS**；97 modules；`index-CcDdMh0e.js` **375.53 kB** / gzip 135.54 kB |
| Rust `tools/fs-harness` `cargo test` | MCP 闸门 6 条**全 PASS**；全量 **76 passed / 6 failed / 1 ignored**。6 条失败为**预存平台性失败**（Windows 路径语义 `\\?\`、反斜杠、宿主 `PWD`），已用 HEAD 版 `perms.rs` 基线对照排除 |
| `src-tauri` 全量 `cargo test` / `cargo check` | **`NOT_TESTED`**：Ubuntu 无 WebView2 导入库，宪章 §5.6 要求 Windows + GNU 工具链 |
| 本地 e2e（4 套）/ 真模型 | **`NOT_TESTED`**：需 Playwright 浏览器本体与桌面宿主 |
| CI（GitHub Actions 宿主） | **PASS**：23 次运行，最新 `CI #23 / 2083011` = `passing`（三 job 全绿）；**新提交未推送，CI 未覆盖** |
| 打包 / 安装包 | **`NOT_TESTED`**（本轮未授权；宪章 §3） |
| 真机 CSP（含预览窗口 External URL） | **`NOT_TESTED` / `BLOCKED`**：见 §5.1 #7 与 `PREVIEW_CSP_HOST_VERIFICATION_20261106.md` |

> `[FACT]` 构建成功必须读日志、不信退出码；Rust 侧只跑了不依赖 tauri 的 harness，
> 未把「harness 通过」冒充「`src-tauri` 全量编译通过」。

## 2. 阶段进度

| 阶段 | 状态 | 依据 |
|---|---|---|
| Phase 0 接管 | **COMPLETE** | 见 §1.1 |
| Phase 1 诊断 | **COMPLETE** | 三组独立只读审计 + `HEAD_2083011_INDEPENDENT_AUDIT_20261105.md` |
| Phase 2 规划 | **PARTIAL** | ROADMAP 部分条目被 11-05 代码超前实现；两轮均补了校正章节，仍未整体重排 |
| Phase 3 研发 | **IN PROGRESS** | 第一轮 ①~⑥ + 第二轮 ①′②③ 已落地；⑥ BLOCKED |
| Phase 4 独立审查 | **PASS（代码级）** | ①~⑤ 三轮复核 `PASS`（`QUEUE_0105_...` §5）；②③ 经**六轮**独立复核，第 6 轮 `PASS`（`QUEUE_0203_RECHECK_ROUNDS_2_6_20261106.md`）；**产品验收签字仍 `ABSENT`** |
| Phase 5/6 验收交付 | **PARTIAL** | 构建物可产出、CI 绿；产品级验收签字仍 `ABSENT`，未推送 / 未打包 |

## 3. 当前结论（不夸大）

- **代码级质量：PASS**。758 条前端单测全绿、构建通过；新增模块均有同名单测；Rust 闸门逻辑由 harness 真实覆盖。
- **安全态势：PASS（代码级）**。P1 三项（D-17 / D-18 / D-20）与独立复审新增两条 P1 均已修并复核；预览窗口 D-23 仍 `NOT_TESTED`。
- **控制面：PASS**。主链路 signal 贯穿 chat / 子代理 / 压缩 / 工具批 / MCP 审批（call / ask / grant）/ 轮内落盘与读取；`stop()` 结算挂起授权框；`finally` 清 `mainSignalRef`。三项不可中断的**已发起** IO 属架构限制（R13）。
- **MCP 信任模型：已裁定并落地**（ADR 0004）。Rust `guard_mcp` 唯一入口、scope 隔离、fail-closed。
- **架构状态：PARTIAL**。`App.tsx` 1283 行；组件层已补 2 个 jsdom 测试文件 / 9 条断言（累计 5 个 jsdom 文件 / 23 条）；ADR 0001「`< 500 行`」**仍为 `[ ]`**，DEC-020 要求先有回归网再拆 JSX，本轮未硬拆。
- **持久化：PARTIAL**。`schemaVersion = 2` + 迁移链 + 备份已落地（D-07 主体收口）；写放大 / 250ms 节流未动。
- **交付状态：NOT_READY**。16 笔（截至 `1ef427d`）本地提交未推送、未打包、未产生费用、未新增依赖。

## 4. 诊断要点（当前）

| 维度 | 关键事实 |
|---|---|
| 编排 | `runRounds(deps)` 在 `orchestration/session.ts`；`runToolBatch(calls, execute, signal)` 经 `budget.planToolBatch` 分波，取消时 `cancelRest()` 补 `CANCELLED_TOOL_ERROR` 回执 |
| 取消 | `stopped()` 在轮内每个新副作用前复查；`lib/abort.ts::waitAbortable` 让审批与 IO 等待可被 signal 结算 |
| 正则 | `regexsafe.ts` 逐字符扫描 + **风险向父组传播**；第三轮复核 10430 候选 fuzz → 0 SLOW / 0 HANG |
| 工具 | `TOOLS` 11 个内置；MCP 动态工具经 `resolveToolPolicy` 纳入统一策略视图 |
| 存档 | `lib/migration.ts` 的 `decodeState` / `encodeState` 为纯函数；`state.ts::loadState` 负责备份副作用；键名不变 |
| 上下文 | 压缩引擎 `orchestration/compact.ts`；prompt 拼装 `orchestration/summarize.ts` |
| 计划模式 | 布尔开关 + 拦截 + 提示词；无产物、无审批、无对账（P3-2 未做） |
| 测试 | 758 条 / 42 文件；组件层 DOM 单测已补 `Welcome` / `SkillChips`（更正 D-13「`ABSENT`」口径：此前已有 3 个 jsdom 文件，现为 5 个）；`App.tsx` 本体仍无直接 DOM 断言 |
| CI | 三 job 全绿（宿主实测）；无 fmt/clippy、无覆盖率门槛、无版本一致性检查 |

## 5. 执行队列（两轮）

### 5.1 第一轮（业主 2026-11-06 确认的顺序，已完成）

| # | 任务 | 级别 | 状态 | 证据 |
|---|---|---|---|---|
| 1 | 治理基线对齐到 `2083011` | P1 | **已完成** | `f24f51c` |
| 2 | 归档 11-05 批次独立复审 | P1 | **已完成** | `6dac044`；结论 `PARTIAL` |
| 3 | 子代理取消传播 + 并行批次异常处理 | P1 | **已完成** | `d5515a8`（注：提交消息里的 D-18 应为 D-20，见台账 §7） |
| 4 | MCP 工具纳入注册表 + 默认 `Ask` | P1 | **已完成（业主裁定）** | `851c990` + ADR 0004 |
| 5 | 并发成本闸门 + 正则 ReDoS 防护 | P2 | **已完成** | `3935880` |
| 6 | `App.tsx` 拆分 | P2 | **部分完成** | `50c21ea`；1570 → 1296 行 |
| 7 | 预览窗口真机 CSP 验证 | P2 | **BLOCKED** | `PREVIEW_CSP_HOST_VERIFICATION_20261106.md` |

### 5.2 第二轮（本轮）

| # | 任务 | 级别 | 状态 | 证据 |
|---|---|---|---|---|
| ① | 独立只读子 Agent 复审 ①~⑤ 代码改动 | P1 | **已完成**：第 1 轮 `PARTIAL`，抓到两条真实 P1 | `QUEUE_0105_CODE_INDEPENDENT_REVIEW_20261106.md` §2 |
| ①′ | 收敛复审发现的 P1（取消贯穿 + 正则嵌套组） | P1 | **已完成**：三轮复核 `PARTIAL` → **`FAIL`** → **`PASS`** | `2761391`；归档 §5；659 → 692 全绿 |
| ② | 继续分批拆 `App.tsx` | P2 | **部分完成**：1296 → 1283 行，4 个纯模块 + 34 条断言；`< 500 行` 仍 `[ ]` | `576407f` |
| ③ | `schemaVersion` 迁移链（D-07） | P2 | **已完成主体**：v2 + 迁移 + 备份 + 18 条断言；节流未动 | `8091709` |
| ④ | CSP 状态确认 + 全轮验收与文档同步 | — | CSP **BLOCKED / NOT_TESTED**（无改动）；验收与同步**完成** | `PREVIEW_CSP_HOST_VERIFICATION_20261106.md`；本笔提交 |

> **顺序纪律已遵守**：先独立复审（①）→ 依复审结论收敛 P1（①′）→ 再动架构（②）与数据主链路（③）→ 最后验收（④）。
> 未跳阶段、未逐条孤立修 bug、未把实施方自测当验收结论；P1 的 `FAIL` 结论未被粉饰，修复后重新复核至 `PASS`。

### 5.3 第三轮（本轮，业主「根据下一步建议继续做」）

| # | 任务 | 级别 | 状态 | 证据 |
|---|---|---|---|---|
| ① | ②③ 代码改动独立复核（关掉 R15 / D-32） | P1 | **已完成**：第 1 轮 `PARTIAL` → 第 2~5 轮均 `PARTIAL` → **第 6 轮 `PASS`**（代码级） | `QUEUE_0203_RECHECK_ROUNDS_2_6_20261106.md` |
| ①′ | 依复审结论收敛 P1 / P2 | P1 | **已完成**：导出装配假 PASS 补断言；备份脱敏收敛为「合法 JSON → reviver 重建 / 异常 → 零原文摘要」二分策略 | `a13bf53` |
| ② | 补组件层 DOM 单测（R9 第一步） | P2 | **已完成第一步**：`Welcome.test.tsx` 4 条 + `SkillChips.test.tsx` 5 条；未硬拆 JSX（DEC-020） | `1ef427d` |
| ③ | D-29 / R14 Rust 信任模型变更 | — | **待业主裁定**，未动代码 | 本文件 R14 |
| ④ | Windows + WebView2 宿主 CSP 验证 | — | **`BLOCKED` / `NOT_TESTED`**，未改任何 CSP | `PREVIEW_CSP_HOST_VERIFICATION_20261106.md` |
| ⑤ | D-25 / D-07 写节流 | P3 | **登记下一批**，未动代码（避免 scope creep） | 台账 §9 |
| ⑥ | 推送 16 笔提交 / 打包 | — | **需业主显式授权**，未执行 | 宪章 §3.1 |

> ① 由非实施者独立只读子 Agent 执行，实施方未自审自签；五轮 `PARTIAL` 均对应可复现的
> 实测缺陷，未被粉饰为 `PASS`；①′ 每次修复都先做变异检验自验，再交回非实施者复核。

## 6. 风险与阻断

| # | 项 | 级别 | 说明 |
|---|---|---|---|
| R1 | release exe / 安装包落后于 HEAD | 中 | 16 笔（截至 `1ef427d`）本地提交未打包；宪章 §3 需业主显式授权 |
| R2 | 推送 / 发布未授权 | — | `origin` 仍 `2083011`；本轮未推送、未打包、未产生费用 |
| R3 | e2e 不可复现 | 已解除 | GitHub Actions 23 次运行，`CI #23` `passing`；但新提交未推送 |
| R4 | 治理基线失真 | 已修 | 本笔同步；D-24 / D-26 收口 |
| R5 | MCP 权限旁路 | 已修 | ADR 0004；Rust 闸门 fail-closed |
| R6 | 子代理不响应停止 | 已修 | 主 signal 贯穿 |
| R7 | 11-05 批次无独立复审 | 已修 | 批次级复审归档；产品验收签字仍 `ABSENT` |
| R8 | ①~⑤ 代码改动尚无独立复审 | **已解除** | 独立只读子 Agent 三轮复核，第三轮 `PASS`（归档 §5） |
| R9 | ADR 0001 `App.tsx < 500 行` 未达成 | P2 | 1283 行；**组件层 DOM 单测已补 2 文件 / 9 条**（本轮），下一步可在这张回归网上继续拆 JSX |
| R10 | 预览窗口 CSP 无宿主证据 | P2 / BLOCKED | D-23；验证清单已交付，结论仍 `NOT_TESTED` |
| R11 | Rust 全量编译 / 真机行为未验证 | — | Ubuntu 沙箱；harness 只能覆盖纯逻辑 |
| R12 | `todo_write` 不持久化 | P3 | D-25 仍在册 |
| **R13** | 三项不可中断的**已发起** IO | 已知边界 | Rust `mcp_call_tool` 60s、波内已启动的 `execute`、已发起的 `writeFiles`/`readFiles`/`readRefs`/`runTest`；前端已不等待，非未修 bug（归档 §5.1 / D-31） |
| **R14** | MCP 闸门与执行目标未绑定 / `perm_grant` 自授权 | P2 / `HYPOTHESIS` | 复审 §2 P2-4；沿用 exec 既有信任模型、非本轮新增；改 Rust 信任模型属架构裁定，**待业主明确授权**（D-29） |
| **R16** | 复核归档 §5 的 11 条 P3 遗留 | P3 | 畸形输入语义漂移 / 畸形 `schemaVersion` / 顶层未知字段 / `repairs` 无消费点 / 备份键不清理 / `hasApiKeyName` 启发式漏判 / 非 `apiKey` 字段同字节等，**如实登记未修** |
| **R15** | 第二轮 ②③ 代码改动尚无独立复审 | **已解除（代码级）** | 独立只读子 Agent **六轮复核，第 6 轮 `PASS`**（`QUEUE_0203_RECHECK_ROUNDS_2_6_20261106.md`）；`a13bf53` |

## 7. 决策记录（ADR 级，追加式）

| # | 决策 | 理由 | 回滚 |
|---|---|---|---|
| DEC-001 ~ DEC-017 | 见上一版（Rust 权威、先修 RCE 再抽 Runtime、撤回「配置文件即 RCE」、MCP 待业主裁定、只审计不改码、e2e 改判、MCP 权限收敛、⑤ 不冒进、⑥ 标 BLOCKED、不推送等） | 沿用 | 见原文 |
| **DEC-018** | ① 由**独立只读子 Agent** 执行，实施方不得自审自签；复审发现必须如实归档 | 宪章 §1「开发结论不构成验收结论」 | — |
| **DEC-019** | ①′ 按「复审 → 根因修复 → 再复审」闭环；**第 2 轮 `FAIL` 不标 PASS**，继续修到第三轮 `PASS` | 复审实测抓到嵌套组穿透与 IO 挂起，首轮修复不彻底 | 若真机发现误拒过多，按模式白名单收敛，不回退到无防护 |
| **DEC-020** | ② 本轮只抽纯逻辑，**不硬拆 30+ props 的 JSX 大组件** | 组件层 DOM 单测仍 `ABSENT`，硬拆扩大回归面；DEC-015「不冒进」 | 下一批先补组件单测再拆 JSX |
| **DEC-021** | ③ **键名 `zxz.state.v1` 不变**、只加 `schemaVersion`、迁移前备份、不丢未知字段 | 宪章 §3.5 不做不可逆迁移；改键名会丢老用户历史与 API Key | 备份键保留原始 raw，可人工恢复 |
| **DEC-022** | ④ 仍标 `BLOCKED` / `NOT_TESTED`，**不改任何 CSP 配置** | 宪章 §3.7 / §3.8；无宿主级证据时改 CSP 等于把未验证配置写进产品 | 业主提供 Windows 宿主后按清单执行并回填证据 |

| **DEC-023** | ②③ 独立复核由非实施者执行；`PARTIAL` / `FAIL` 一律如实登记，逐轮闭环到 `PASS` 才解除 R15 | 宪章 §1 / §7；沿用 DEC-019 | — |
| **DEC-024** | 备份脱敏定为二分策略：合法 JSON → reviver 按解析后真实键名重建；结构化异常 → 零原文安全摘要；畸形深嵌套备份降级为摘要（原始存档仍在主键，不删数据） | 六轮复实测，局部正则脱敏有结构性缺口 | 有真机证据后按清单复核 |
| **DEC-025** | 本轮不修畸形输入类 P3、不硬拆 JSX、不动 D-25 / 写节流 | 宪章 §5.1「一次提交只做一件事」；DEC-015 / DEC-020 不冒进 | 下批单独推进 |
| **DEC-026** | R9 先补组件层 DOM 回归网，再谈拆 JSX | 组件层此前覆盖稀疏，硬拆扩大回归面 | 拆后按同名单测守住 |

## 8. 下一步建议（待业主裁定）

1. 在新增的组件层 DOM 回归网上继续拆 `App.tsx` 的 JSX 装配层（R9 / ADR 0001「< 500 行」）。
2. D-25（`todo_write` 持久化）与 D-07 剩余部分（250ms 写节流 / 写放大）。
3. D-29 / R14：MCP 闸门与执行目标绑定属 Rust 信任模型变更，**需业主明确裁定**后才动代码。
4. 在 Windows + WebView2 宿主执行 `PREVIEW_CSP_HOST_VERIFICATION_20261106.md` 并回填证据（R10）。
5. 复核归档 §5 的 11 条 P3（含备份键生命周期清理、`repairs` 消费点）按优先级收敛。
6. 业主授权后单独推送 **16 笔（截至 `1ef427d`）**提交并打包。
