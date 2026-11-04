# 项目状态板（唯一权威）

最后更新：2026-11-04 09:40　｜　维护者：Project Director（Agent 小队）
状态判定用词：`PASS` `PARTIAL` `FAIL` `ABSENT` `NOT_TESTED` `BLOCKED`

---

## 1. 身份基线（FACT，2026-11-03 实测）

| 项 | 值 |
|---|---|
| 仓库 | `F:/zhuomian/zxz`（product `zxz` / `com.zxz.desktop`） |
| 分支 / HEAD | `main` / `6d1cf46` + 本轮未提交的 B12-B3 |
| 远端 | `origin` 内网 Gitea `192.168.3.200:3000/zxzjxx/zxzgpt.git`（与本地同步）；`github` 备用 |
| 版本号 | `package.json` / `tauri.conf.json` / `Cargo.toml` 三处均 `0.3.0`（一致） |
| 技术栈 | Tauri 2 + Rust（fsx / runx / wsx / proxy / api / perms）＋ React 18 + TS + Vite 6；测试用 vitest（node 环境为主，DOM 用文件头 `@vitest-environment jsdom` 单文件声明） |
| 规模 | 前端生产代码 8,975 行（`App.tsx` **1338** 行 + `orchestration/session.ts` 321 行），测试 4,534 行；Rust 8 文件 / 7 模块 |
| 工作区 | B12-B3 改动待提交（`App.tsx` / `orchestration/session.ts` / 文档）；`.refs/`（193MB）、`.tmp-skills/` 仍为未跟踪 |

### 1.1 基线命令与实测结果

| 命令 | 结果 |
|---|---|
| `npm test` | **447 passed / 20 files**（本轮起点 441；B12-B2 新增 `src/app.rounds.test.tsx` 6 条） |
| `npm run build` | 成功；`dist/assets/index-C_jjb0nX.js` 335.51 kB（2026-11-03 23:34 实测） |
| `cargo test --manifest-path tools/fs-harness/Cargo.toml` | **82 passed / 1 ignored**（GNU 工具链；msvc 必失败） |
| `cargo test --manifest-path tools/proxy-harness/Cargo.toml` | **3 passed**（D-16 的错误分类表；同一套 GNU 工具链） |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过，**0 warning**（`--all-targets` 亦 0，2026-11-03 23:36 实测） |
| e2e（2026-11-04 B12-B3 搬家后实跑） | `e2e.cjs` **24/24**、`workspace-e2e` **39/39**、`skill-e2e` **69/69**；`proxy-e2e` 本轮未跑（Rust 代理另有 D-16 单测与对照实验） |
| CI 是否跑到新测试 | **是**：`.github/workflows/ci.yml:18` 的 `npm test` 走 vitest，`include: src/**/*.test.ts` |

`[FACT]` 本机 msvc 默认工具链会在链接期被 Git for Windows 的 coreutils `link.exe` 抢占，
报 `link: extra operand`，且后台包装器仍上报 exit 0。**Rust 测试一律用**
`RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`，构建成败必须读日志。

## 2. 阶段进度

| 阶段 | 状态 | 依据 |
|---|---|---|
| Phase 0 接管 | **COMPLETE** | 上表；与 `C1D_BASELINE_AND_GATE.md` 的基线差异已核对（HEAD 前移 3 个提交、版本号已统一） |
| Phase 1 诊断 | **COMPLETE** | 三组独立只读审计（安全 / 架构 / 质量），见 §4 |
| Phase 2 规划 | **COMPLETE** | 本文件 §5 队列 |
| Phase 3 研发 | **IN PROGRESS** | B1/B3/B4/B5/B6/B7/B8/B10/B11/B13/B15/B16 已落地并验证 |
| Phase 4 独立审查 | IN PROGRESS | B10 一批已做独立复审（11 条发现，逐条验证后 9 条成立、2 条驳回）；B7 一批 8 条；B12-A 待审 |
| Phase 5/6 验收交付 | NOT_STARTED | 交付物未重编、未打安装包 |

## 3. 当前结论（不夸大）

- 代码级质量：**良好**。447 条前端单测、85 条 Rust 单测（fs-harness 82 + proxy-harness 3）全绿；安全类断言质量高（负向断言 + 解析器级判定 + 「陷阱直发能触发、走加固路径不触发」的对照写法）。新增的传输层、接线层与代理错误分类用例做过变异检验（改坏生产代码 → 对应用例必须变红），不是只看绿灯。
- 安全态势：**PARTIAL → 明显改善**。P0 三条 + 本轮 2 条（npm `pre`/`post` 钩子绕过、`.npmrc` 改脚本 shell）+ 执行授权闸门（P0-4）已落地；其余已登记项见 §5 与 `TECHNICAL_DEBT.md`。
- 交付状态：**NOT_READY**。无安装包；CI 不编译 `src-tauri` 本体；e2e 无法在 CI 复现；release exe 已落后于 HEAD。
- 架构状态：**PARTIAL（明显改善）**。轮循环已搬进 `src/orchestration/session.ts`（B12-B3，321 行），`App.tsx` 1520 → **1338 行**，编排层不再 import react；工具五处手写已收成注册表（B6）。ADR 0001 的 5 条验收标准 **4 条达成**，剩「`App.tsx` < 500 行」——那 1338 行里剩的主要是 UI 状态与各面板接线，不是编排。

## 4. 诊断要点（摘要，证据见各审计文件）

| 维度 | 关键事实 |
|---|---|
| 编排 | ~~`send()` 约 320 行闭包~~ **已搬（B12-B3）**：轮循环在 `orchestration/session.ts` 的 `runRounds(deps)`，App 只装配依赖；`MAX_ROUNDS` 已导出（B7）；轮末判定是纯函数 `round.ts`；`AbortController` 已能杀 `npm test`（B13 `run_cancel`）。**仍欠**：run 状态散在 `deps` 与闭包之间，未做成显式状态机（ADR D2）；`stateRef` 手工双写仍在 |
| 工具 | ~~新增 1 个工具要改 5 处，无注册表~~ **已修（B6）**：`src/lib/registry.ts` 的 `TOOLS` 是唯一真值源，其余全部派生；`findTool` 精确匹配不归一 |
| 持久化 | 单键 `zxz.state.v1`，**无 schemaVersion**；250ms 全量写，连 `streaming` 中间态一起写；系统消息**完全不计**上下文预算 |
| 计划模式 | 只有布尔开关 + 两处拦截 + 一段提示词；无产物、无审批、无对账 |
| 测试 | ~~`api.ts` 零覆盖~~ **已覆盖（B12-A）**；**接线层已有 10 条整轮用例**（B12-B1 4 条 + B12-B2 6 条，jsdom + 假上游 + 假 IPC），7 类行为等价场景全齐；组件层（`Sidebar`/`SettingsDrawer` 等 2300+ 行）仍靠 e2e 兜着，无组件单测 |
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
| B11 · 清单不完整要说出来 | `listUndo` 的 `walk()` 返回 `boolean`；子目录抛错 / 撞 400 条 / 超 8 层 → `snapshot.incomplete`；界面标「清单不完整」 | **PASS** | 提交 `8919e3f`；前端 **400**（新增 3 条：抛错 / 撞上限 / 全可读） |
| B16 · devtools 只给 debug | `tauri` 依赖去掉 `features=["devtools"]`，改为可选特性；release 不再带右键检查元素 | **PASS** | 源码门控 `#[cfg(any(debug_assertions, feature="devtools"))]`；`cargo tree -e features` 中 devtools 边为空；`cargo check --all-targets` 0 warning；Rust 82 全绿 |
| B12-A · 传输层判据 | 新增 `src/api.test.ts` 37 条：上游错误 / SSE 分帧 / 断流 / 工具增量 / Key 不进 URL 与请求头；独立复审后补 JSON 兜底与 `done` 唯一性两组 | **PASS** | 前端 **437**；8 次变异检验各自精确变红一条；CI `ci.yml:18` 直接覆盖；e2e 24/39/69 + 代理接口 11 全绿 |
| B14-A · e2e 可复现 | `tools/browser.cjs` 逐级回落（env → msedge → chrome → 自带 chromium）；五个脚本去掉写死的 `channel`；默认 BASE 统一 `localhost:1420`；`proxy-e2e` 显式把 `ZXZ_BASE` 传给子进程 | **PASS** | 不传任何环境变量实测：`e2e` 24/24、`proxy-e2e` 11+24、`workspace` 39/39、`skill` 69/69；`ZXZ_BROWSER_CHANNEL="nope,msedge"` 真走进回落分支 |
| B12-B1 · 渲染夹具 | 业主批准后装 `jsdom@25`；`vitest.config.ts` 收 `*.test.tsx`（环境仍是 node，DOM 按文件声明）；新增 `src/app.test.tsx`：jsdom 里能挂载、空输入不发请求、有输入点发送真的打到 `/chat/completions` 且流回的 delta 渲染成回答 | **PASS** | 前端 **441**（19 文件）；3 次变异检验各自变红一条（去掉空输入守卫 / 改错上游路径 / 断掉 delta 追加） |
| B14-B · e2e 进 CI | 业主批准把 `playwright@1.64.1` 写进 `devDependencies`；`ci.yml` 新增独立 `e2e` job（`npm ci` → `playwright install chromium` → 起 vite + 假上游 → `node tools/e2e.cjs`） | **NOT_TESTED** | `npm ci --dry-run` 通过（锁文件一致）；YAML 结构自检通过（3 个 job、0 制表符）；job 内的命令与本地实跑的命令逐条一致。**但 job 本身从未在 GitHub 上执行过**——本地跑不了 Actions，不给 PASS |
| B12-B2 · 整轮重放 | 新增 `src/app.rounds.test.tsx` 6 条：① 上游 500 → 只发 1 次请求、`HTTP 500` 与上游原话都上屏、按钮复位；② 工具轮（假 IPC + 假上游）→ 第一轮带 `tools`、`read_file` 的结果按 `tool_call_id` 回填、第二轮带 `assistant.tool_calls` + `tool` 消息、随后 502 即收摊（恰好 2 次请求）；③ 挂起的流 + 点停止 → 显示「已停止生成」、无「请求失败」、不再发请求；④ 每轮都要读文件 → 恰好 6 次请求 + 「已达到本次最多 6 轮读写」；⑤ 自动测试 3 轮不过 → 恰好 3 次请求、3 次 `run_allowed`、每轮报错原文回传进下一轮上下文 + 「测试 3 轮仍未通过」；⑥ exec 审批 → 没回答前请求数仍是 1、`perm_grant` 为 0，点「仅这一次」后记 1 条一次性授权、命令重试、结果回填并继续下一轮 | **PASS** | 前端 **447**（20 文件）；6 次变异检验各自精确变红：去掉 `!res.ok` 抛错 → ①② 红；去掉 `buildMessages` 的 tool_calls 展开 → ② 红；去掉 `AbortError` 分支 → ③ 红；`MAX_ROUNDS` 6→8 → ④ 红（`expected 8 to be 6`）；`testLoopDecision` 去掉 `give_up` → ⑤ 红（`expected 6 to be 3`）；确认框不渲染 → ⑥ 红。`npm run build` 通过 |
| D-16 · 中断不再记故障 | `proxy.rs` 引入 `ConnError::{PeerGone,Fatal}`：写路径的 `BrokenPipe` / `ConnectionReset` / `ConnectionAborted` 归 `PeerGone` 并静默，其余照旧打日志；读路径的畸形请求仍是 `Fatal`（不改语义） | **PASS** | proxy-harness **3 passed**（分类表）；变异「BrokenPipe 归 Fatal」→ 精确红一条；端到端对照实验：旧行为 stderr 打出 `os error 10053`（FAIL），新行为 stderr 为空（PASS）。`cargo check` 通过；`docs/audit/D16_INTERRUPT_LOG_20261104.md` |
| B12-B3 · 轮循环搬家 | 新增 `src/orchestration/session.ts`（321 行）导出 `runRounds(deps)`；`App.tsx` 只保留装配（1520 → **1338** 行）；依赖注入：`chat` / `tools()` / `commitMessages` / `patchMessage` / `executeTool` / `writeFiles` / `readFiles` / `readRefs` / `runTest` / `currentWorkspace`。只搬运不改语义（ADR D3）；rAF 在 Node 下回退 setTimeout(16)，浏览器路径不变 | **PASS** | 前端 **447** 不变；e2e 搬家后实跑 24/24 + 39/39 + 69/69；变异①`runRounds` 开头 return → 7 条红（证明 App 走新路径）；变异②测试回路计数传错 → 精确红一条。`grep -rn "from \"react\"" src/orchestration/` 无命中 |

### 下一批（按优先级）

完整清单见 **`docs/audit/TECH_DEBT_REGISTER_20261103.md`**（P0–P3，带证据/影响/状态）。
队列只列"要动手"的那几条：

| # | 任务 | 为什么现在 | 验收 |
|---|---|---|---|
| 首次 CI 运行 | 看 `e2e` job 到底能不能跑通（B14-B 标的是 `NOT_TESTED`） | job 已写好，但从没在 GitHub 上执行过。首次推送后需据此改成 PASS 或按真实报错修 | 截图/日志中 `e2e` job 为绿 |

> **B12-B 路线已定**：业主选了「先装 jsdom 拿判据，再拆 `send()`」。
> B12-B1 已完成（`jsdom@25` 已装，App 能在 jsdom 里挂载并被驱动，4 条用例 + 3 次变异检验）；
> B12-B2 已完成（整轮边界 6 条，ADR 0001 要求的 7 类行为用例全齐，6 次变异检验）。
> 顺序是刻意的：先有回归网，再动全仓最热的那段代码——反过来就是把"没判据"升级成"没判据且刚大改过"。
> B12-B3 已完成（2026-11-04，业主当面批准）：轮循环搬进 `orchestration/session.ts`，
> 搬家前后 447 条单测与 24/39/69 项 e2e 全部同数通过。
> ADR 第 2 条据此变「已搬」，但第 3 条「`App.tsx` < 500 行」仍未达成（现 1338）。

## 6. 风险与阻断

| # | 项 | 级别 | 说明 |
|---|---|---|---|
| R1 | release exe 落后于 HEAD | 高 | `src-tauri/target/release/zxz.exe` 内嵌的仍是 `index-CQlZK13B.js`，当前构建产物是 `index-CI0qq08X.js`（相差 B3–B16 + 接线层测试 + B12-B3 搬家）。**未重编前不得声称交付物含任何本轮修复** |
| R2 | 无安装包 | 高 | `bundle.targets: "all"` 配置存在但从未产出；`WebView2` 走 `downloadBootstrapper`，离线不可用 |
| R3 | e2e 不可复现 | ~~中~~ 低 | 三个成因全部处理（B14-A + 业主批准加依赖）：`msedge` 硬编码 → `tools/browser.cjs` 逐级回落；端口 → `localhost:1420` 且子进程继承 `ZXZ_BASE`；`playwright` 入 `devDependencies`。`ci.yml` 已加 `e2e` job。**但该 job 从未在 GitHub 上实际跑过**（本地跑不了 Actions），只能标 `NOT_TESTED`；首次推送后需要看一次运行结果 |
| R4 | ~~release 无条件带 devtools~~ | ~~中~~ | **已解除**（B16）：`tauri` 依赖不再带 devtools 特性；debug 构建行为不变 |
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
