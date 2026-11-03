# 项目状态板（唯一权威）

最后更新：2026-11-03 22:0x　｜　维护者：Project Director（Agent 小队）
状态判定用词：`PASS` `PARTIAL` `FAIL` `ABSENT` `NOT_TESTED` `BLOCKED`

---

## 1. 身份基线（FACT，2026-11-03 实测）

| 项 | 值 |
|---|---|
| 仓库 | `F:/zhuomian/zxz`（product `zxz` / `com.zxz.desktop`） |
| 分支 / HEAD | `main` / `3f6fbba`（`docs(e2e): 全量重测 e2e 项数…`） |
| 远端 | `origin` 内网 Gitea `192.168.3.200:3000/zxzjxx/zxzgpt.git`（与本地同步）；`github` 备用 |
| 版本号 | `package.json` / `tauri.conf.json` / `Cargo.toml` 三处均 `0.3.0`（一致） |
| 技术栈 | Tauri 2 + Rust（fsx / runx / wsx / proxy / api / perms）＋ React 18 + TS + Vite 6 |
| 规模 | 前端 11,850 行（`App.tsx` 1520 行）；Rust 8 文件 / 7 模块（`perms.rs` 为 B10 新增） |
| 工作区 | 已跟踪文件 0 改动；未跟踪：`.refs/`（193MB）、`.tmp-skills/`、`docs/audit/*.md`、`docs/governance/` |

### 1.1 基线命令与实测结果

| 命令 | 结果 |
|---|---|
| `npm test` | **400 passed / 17 files**（本轮起点 328） |
| `npm run build` | 成功；`dist/assets/index-BUPLjQ7F.js` 335.02 kB |
| `cargo test --manifest-path tools/fs-harness/Cargo.toml` | **82 passed / 1 ignored**（GNU 工具链；msvc 必失败） |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过，**0 warning**（B10 收口时实测） |
| e2e（当日实跑） | `e2e.cjs` 24/24、`workspace-e2e` 39/39、`skill-e2e` 69/69、`proxy-e2e` 接口 11/11 + 前端 24/24 |

`[FACT]` 本机 msvc 默认工具链会在链接期被 Git for Windows 的 coreutils `link.exe` 抢占，
报 `link: extra operand`，且后台包装器仍上报 exit 0。**Rust 测试一律用**
`RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`，构建成败必须读日志。

## 2. 阶段进度

| 阶段 | 状态 | 依据 |
|---|---|---|
| Phase 0 接管 | **COMPLETE** | 上表；与 `C1D_BASELINE_AND_GATE.md` 的基线差异已核对（HEAD 前移 3 个提交、版本号已统一） |
| Phase 1 诊断 | **COMPLETE** | 三组独立只读审计（安全 / 架构 / 质量），见 §4 |
| Phase 2 规划 | **COMPLETE** | 本文件 §5 队列 |
| Phase 3 研发 | **IN PROGRESS** | P0-3 第一轮 + B4/B5/B6/B10 已落地并验证 |
| Phase 4 独立审查 | IN PROGRESS | B10 一批已做独立复审（11 条发现，逐条验证后 9 条成立、2 条驳回） |
| Phase 5/6 验收交付 | NOT_STARTED | 交付物未重编、未打安装包 |

## 3. 当前结论（不夸大）

- 代码级质量：**良好**。400 条前端单测、82 条 Rust 单测全绿；安全类断言质量高（负向断言 + 解析器级判定 + 「陷阱直发能触发、走加固路径不触发」的对照写法）。
- 安全态势：**PARTIAL → 明显改善**。P0 三条 + 本轮 2 条（npm `pre`/`post` 钩子绕过、`.npmrc` 改脚本 shell）+ 执行授权闸门（P0-4）已落地；其余已登记项见 §5 与 `TECHNICAL_DEBT.md`。
- 交付状态：**NOT_READY**。无安装包；CI 不编译 `src-tauri` 本体；e2e 无法在 CI 复现；release exe 已落后于 HEAD。
- 架构状态：**PARTIAL**。编排仍是 1520 行 `App.tsx` 内的闭包循环；`src/orchestration/` 已存在但只有一个 `round.ts`（B7 切片），`send()` 本体未搬。工具五处手写已收成注册表（B6 完成）。ADR 0001 的 5 条验收标准 1.5 条达成（详见该 ADR 的"实施进度"小节，未勾的不勾）。

## 4. 诊断要点（摘要，证据见各审计文件）

| 维度 | 关键事实 |
|---|---|
| 编排 | `send()` 约 320 行闭包；~~`MAX_ROUNDS=6` 未导出~~ **已导出（B7）**；轮末判定已抽成纯函数 `src/orchestration/round.ts`；run 状态仍散在 12 个局部变量；`AbortController` 只覆盖 `chatStream`，**杀不掉正在跑的 `npm test`** |
| 工具 | ~~新增 1 个工具要改 5 处，无注册表~~ **已修（B6）**：`src/lib/registry.ts` 的 `TOOLS` 是唯一真值源，其余全部派生；`findTool` 精确匹配不归一 |
| 持久化 | 单键 `zxz.state.v1`，**无 schemaVersion**；250ms 全量写，连 `streaming` 中间态一起写；系统消息**完全不计**上下文预算 |
| 计划模式 | 只有布尔开关 + 两处拦截 + 一段提示词；无产物、无审批、无对账 |
| 测试 | `App.tsx` 1520 + `api.ts` 302 + 组件 2300+ 行仍基本 0 覆盖，且无 jsdom/testing-library；`src/orchestration/round.ts` 与 `src/lib/registry.ts` 是仅有的两个"核心逻辑可测"的切片 |
| CI | 仅 `frontend` + `rust-fs`；无 fmt/clippy、无 e2e、无版本一致性、无覆盖率门槛 |

## 5. 执行队列

### 已交付

| 批次 | 内容 | 状态 | 证据 |
|---|---|---|---|
| B1 · P0-3 | npm 脚本审计构造级拒绝 + 全分隔符切段；只读 git 三道加固；`.git/**` 写拒绝 | **PASS** | `docs/audit/P0-3_HARDENING_20261103.md`；327/327 + 58/58 |
| B3 · 写入前置 | `fsExists` 不再吞错；存在性校验失败 / 备份失败均中止写入 | **PASS** | 328/328；提交 `6edb112` |
| B4 · 撤销隔离 | `.zxz/undo` 专用写入通道；`fsx::read`/`list_in` 对撤销区关闭；模型不可写不可读 | **PASS** | 提交 `d4b1d83`；前端 332 + Rust 61 |
| B5 · 输出与环境 | 输出保留上限 256 KB（管道仍读空，不死锁）；`env_clear()` + 19 项白名单；`truncated` 显式回传 | **PASS** | 提交 `554dc1d`；前端 335 + Rust 65 |
| B6 · 工具注册表 | 五份清单收成 `src/lib/registry.ts` 的 `TOOLS`，`findTool` 精确匹配不归一 | **PASS** | 提交 `449b3a5`；前端 351；`grep -c "call.name ==="` = 0 |
| B10 · 执行授权闸门 | `perms::decide` 三态闸门（`Deny`/`Ask`/`Allow`）；scope = 命令+子命令；会话内有效、不落盘；前端确认框 + 授权列表可逐条撤销 | **PASS** | 前端 366 + Rust 79；`cargo check` 0 warning；`docs/audit/P0-4_EXEC_GATE_20261103.md` |
| B7 · 轮末判定抽取 | `src/orchestration/round.ts`：`nextRound` / `stopNotice` / `shouldAutoTest` 三个纯函数；`MAX_ROUNDS` 导出；App 只剩执行 | **PASS**（切片） | 前端 **396**（25 条新断言）；已过独立复审（4 条 P2 + 4 条 P3，全部处置）；`docs/adr/0001` 进度小节 |
| B8 · 证据对账 | README 全部 e2e 数字按当日实测重写；7 个未跑脚本标 `NOT_TESTED`；修掉假 IPC 落后与过期断言 | **PASS** | 24/39/69/11+24 全过；`docs/audit/B8_EVIDENCE_RECONCILIATION_20261103.md` |
| B15 · 代理鉴权前置 | `read_request` 拆成 `read_head` + `read_body`；Host / token 校验全部前移到读 body 之前 | **PASS** | 新增裸 socket 断言（不发 body 也必须立刻 401）；接口 11/11 + 前端 24/24 |
| B13 · 停止真的停 | `run_cancel` + 会话级取消位；`RunResult.cancelled` 与 `timed_out` 分开；测试断言**耗时**而非标志位 | **PASS** | Rust **82**（新增 3 条取消用例，含真起 60 秒 npm test 再取消）；前端 400 |

### 下一批（按优先级，已排定，不再请示）

完整清单见 **`docs/audit/TECH_DEBT_REGISTER_20261103.md`**（P0–P3，带证据/影响/状态）。
队列只列"要动手"的那几条：

| # | 任务 | 为什么现在 | 验收 |
|---|---|---|---|
| B12 | `send()` 整轮重放测试设施（D-02） | 唯一的 P1 级质量缺口：1520 行编排零覆盖，400 条绿灯照不到那片区域 | 至少 1 类（上游错误）在 CI 跑 |
| B11 | undo 子目录列举失败静默跳过（D-04） | 会产出"看起来完整"的快照 | 打不开时快照带 `incomplete` 标记 |
| B14 | e2e 进 CI 的三个前置（D-08） | R3 三个成因已逐个实测确认，都可修 | CI 上 `e2e.cjs` 能跑 |

## 6. 风险与阻断

| # | 项 | 级别 | 说明 |
|---|---|---|---|
| R1 | release exe 落后于 HEAD | 高 | `src-tauri/target/release/zxz.exe` 内嵌的仍是 `index-CQlZK13B.js`，而当前构建产物是 `index-BUPLjQ7F.js`（相差 B3–B8 共 6 批改动）。**未重编前不得声称交付物含任何本轮修复** |
| R2 | 无安装包 | 高 | `bundle.targets: "all"` 配置存在但从未产出；`WebView2` 走 `downloadBootstrapper`，离线不可用 |
| R3 | e2e 不可复现 | 中 | 三个成因 2026-11-03 全部实测确认：playwright 未入依赖（`npm ci` 后消失）、硬编码 `channel:"msedge"`、默认端口 5173 与 vite 1420 冲突（`proxy-e2e.cjs` 拉起子进程时不传 `ZXZ_BASE`，会退回 5173 并报 `waiting for locator('#btnNew')`，看着像前端崩了）。修法见 B14 |
| R4 | release 无条件带 devtools | 中 | `tauri/Cargo.toml` 的 `features=["devtools"]` 无 `cfg(debug_assertions)` 门控 |
| R5 | 推送/发布未授权 | — | 按宪章 §3，push / 打安装包需业主显式授权 |

## 7. 决策记录（ADR 级，追加式）

| # | 决策 | 理由 | 回滚 |
|---|---|---|---|
| DEC-001 | Rust 侧为唯一权威，前端镜像只做提前拦截 | 既有设计；前端可被绕过 | 不适用 |
| DEC-002 | `.git/**` 整目录拒绝写入，而非只挡 `config` | 半开的口子会被 hooks / info/attributes 绕过 | 删除 `fsx::is_repo_metadata` 调用 |
| DEC-003 | git 加固参数强制注入、用户不可关闭 | 依赖"用户没配置"不是安全设计 | 移除 `effective_argv` |
| DEC-004 | 先修 RCE 链，再抽 Runtime | 抽取不改攻击面，修复直接降风险 | 调整 §5 顺序即可 |
| DEC-005 | **撤回**"运行器配置文件构成独立 RCE 链"这一判断 | 复核后：`vite.config.*` 会被加载执行，但 `src/**/*.test.ts` 同样会被 vitest 执行——"执行模型写的代码"是编码 Agent 的既定能力，不是可被 blocklist 关闭的漏洞。真正的闸门是执行前的权限审批（P0-4），拿配置文件黑名单当安全边界只会制造虚假安全感 | 无需回滚；B2 从队列移除，改为 B10 |
| DEC-006 | 撤销快照区对模型**读也关闭**，撤销面板改走 `undo_read` / `undo_list` 专用 IPC | 原设计只堵了写。但快照里留着"用户删掉的密钥、改过的旧内容"，可读就是泄漏；能列举全量快照还额外泄漏操作轨迹（何时改过哪些文件）。只堵写等于把敏感数据放在模型读得到的路径上 | 恢复 `read`/`list_in` 对 `.zxz/undo` 的放行即可（不推荐） |
| DEC-007 | 执行授权 scope = 命令 + 子命令，只在内存、按会话记账 | 按"整个 `git` 允许"太粗（`git diff` 与 `git push` 天差地别）；按"完整 argv"太细，模型换个 `--stat` 就要再问一次，用户会训练成无脑点同意。落盘会把一次性批准变成永久后门 | 删除 `perms::grant` 的调用点，退回"每次必问" |
| DEC-008 | 授权粒度实际是**工程目录级**，对话级隔离由前端主动撤回补偿 | `wsx::open` 对同一目录复用会话号，Rust 侧只有一个桶。前端在切/新建/删除/清空对话时撤销，能把粒度收回到对话级；但这是补偿不是隔离，一旦出现绕过前端的调用路径就退回工程级 | 让 `perms` 带上 convId 记账（需要新的会话维度，本版未做） |
| DEC-009 | npm 脚本审计必须覆盖 `pre<name>` / `post<name>` | 实测可绕过：`{"pretest":"node evil.js","test":"node --test emit.js"}` 能过审并写出文件，因为只审了 `scripts.test`。`npm test` 实际跑三步，审一步等于没审 | 去掉钩子遍历（不推荐） |
| DEC-010 | `.npmrc` / `.yarnrc` / `.yarnrc.yml` / `.pnpmfile.cjs` 与 `.git/**` 同级，写入一律拒绝 | 实测 `script-shell=C:/nonexistent/zzz-shell.exe` 会让 `npm run build` 去 spawn 那个路径——工程文件能改 npm 的脚本 shell，等于绕开"argv 里没有 shell"这条前提 | 移除 `fsx::is_toolchain_config` 的判定 |
