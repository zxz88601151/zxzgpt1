# 独立审计：HEAD `2083011` 的治理与代码现状

> 日期：2026-11-05　｜　性质：**AUDIT-ONLY**（独立只读审计，未修改任何业务代码）
> 依据：`docs/governance/CHARTER.md` §1（独立复核）、§5（变更纪律）、§6（强制标签）
> 审计对象：公开仓库 `zxz88601151/zxzgpt1`，`main` / `2083011`（2026-11-05 14:29 +0800）
> 审计环境：Ubuntu 22.04 / Node 22 / Rust 未启用 Windows GNU runner

---

## 0. 一句话结论

代码本身**可编译、单测全绿、CI 全绿**，但**项目的治理基线已经失真**：

`STATE.md` 自称「唯一权威」，却停在 11-04 的 `8142815`；真实 HEAD 已前移 20 个提交，
11-05 一天内落地了 MCP 客户端、上下文压缩、并行工具、探索子代理、联网搜索、预览窗口
等 6 类新能力，**没有一份对应的独立复审、ADR 或状态板更新**。其中两处接线绕过了项目
自己写下的硬约束（MCP 权限前置、父级取消传播），属于必须先纠正的控制面问题，而不是
"文档没跟上"这种小事。

按宪章 §1，本报告只做诊断与建议；**修复由开发角色在业主裁定后执行**，本报告不充当验收结论。

---

## 1. 实测基线 `[FACT]`

| 项 | 实测值 | 获取方式 |
|---|---|---|
| HEAD | `2083011` / 2026-11-05 14:29 +0800 | `git log -1` |
| 工作区 | 干净（`git status --porcelain` 为空） | `git status` |
| 版本一致性 | `package.json` / `tauri.conf.json` / `Cargo.toml` **均 0.3.0** | 逐文件读取 |
| `npm ci` | **PASS** | 实跑 |
| `npm test` | **545 passed / 6 skipped（551）**；28 文件通过 + 1 跳过；6.16s | 实跑 |
| `npm run build` | **PASS**；86 modules；`index-BNUoWb_l.js` 365,04 kB（gzip 131,82 kB） | 实跑 |
| 内置工具数 | **11**（`src/lib/registry.ts:586`） | 读源码 |
| `App.tsx` | **1550 行** | `wc -l` |
| 单测文件 | 29（含 1 个按 `RUN_PERF=1` 手动跑、6 条 skipped） | `find` + 实跑 |
| CI | **23 次运行**，最新 `CI #23 / commit 2083011` badge = `passing` | GitHub Actions 宿主页面 |

`[FACT]` `ci.yml` 无 `continue-on-error`，`frontend` / `rust-fs` / `e2e` 三 job 任一失败都会让
workflow 变红。因此 `CI #23 passing` 可判定 **B14-B「首次 CI 运行」已 PASS**（宿主实测，
非本地自证），`STATE.md` §5 队列里唯一那条待办可以关闭。

### 本轮明确未验证 `NOT_TESTED` / `BLOCKED`

| 项 | 原因 |
|---|---|
| `cargo test` / `cargo check` | 本沙箱为 Ubuntu；`tools/fs-harness` 有 11 条按 Windows 语义设计，宪章 §5 固定 `windows-latest` + GNU 工具链 |
| 本地 e2e / 代理 e2e | 需 Playwright 浏览器本体与 Rust harness 编译；未跑，不标 PASS |
| 真机 CSP（尤其预览窗口 External URL） | `CLAUDE.md` 明确 CSP 只能在 `tauri dev`/打包后 DevTools 验证 |
| 真模型 / 联网搜索 / 子代理实跑 | 宪章 §3「不产生任何费用」，本轮未跑任何计费请求 |

---

## 2. 治理偏差矩阵 `[FACT]`

| 治理文件 | 最后更新 | 声称 | 真实（HEAD `2083011`） |
|---|---|---|---|
| `STATE.md` | 11-04 `acbed99` | HEAD `8142815`、447 单测 / 20 文件、Phase 5/6 `NOT_STARTED`、无安装包 | HEAD `2083011`、**545/29**；B12-B6 安装包早已 PASS；§2 与 §5 自相矛盾 |
| `README.md` §9.6 | 11-04 | `447 / 20 文件` | **545 / 29 文件** |
| `README.md` §14.1 | 11-04 | 「七个工具」 | **11 个** |
| `CLAUDE.md` | 11-04 | 「七个工具」、轮循环 321 行 | **11 个工具**；`session.ts` 390 行 |
| `CURRENT_ARCHITECTURE.md` | 11-02 | `App.tsx 1340 行`、`send()` 在 App、`lib.rs` 9 条 IPC、root 不受约束 | **1550 行**、轮循环在 `orchestration/session.ts`、20+ IPC、会话化 root 已落地 |
| `DEVELOPMENT_ROADMAP.md` | 11-02 | P3-1 压缩 / P4-3 MCP / P5 子代理「未实现」 | 三者**均已落地**（`a0e2163` / `9e713f5` / `a327ad0`） |
| `docs/audit/` 全部 | 最新 11-04 `D16_*` | 每批交付都有独立复审 | **11-05 的 20 个提交，0 份复审文档** |

`[RISK]` 宪章 §6 要求「禁止混淆四种状态」，`STATE.md` 自称唯一权威。一个过期的权威状态板
比没有状态板更危险：后续所有优先级判断都会基于「P3/P4/P5 还没做」这个错误前提。

`[FACT]` ROADMAP §0 写「阶段间 STOP，完成一个阶段的验收后再进入下一阶段」。11-05 的提交序列
是连续 14 个 `feat`/`test` 直接推到公开仓库，中间没有 Gate 记录，也没有 §4 要求的独立审查。

---

## 3. 分级发现

### P1-1　子代理不响应「停止」 `[FACT]`

- `src/App.tsx:639`：`runSubagent` 收到的是 `signal: new AbortController().signal` —— 一个新建、
  永不 abort 的 controller。
- `src/App.tsx:893,962`：主发送持有 `abortRef.current`，`stop()` 只 abort 主 controller。
- `src/orchestration/session.ts:125-148`：`runToolBatch` 把 `explore` 判为并行安全
  （`isParallelSafeTool = access === "read"`），用 `Promise.allSettled` 等整批完成。

**后果**：用户点「停止」后界面显示「已停止生成」，但已扇出的子代理仍会跑完最多 4 轮模型请求；
主轮次也因 `allSettled` 等待而无法及时收摊。这与 B13 已修复的 D-01「停止按钮在说谎」是同一类
回归，并额外产生真实模型费用（宪章 §3）。ROADMAP P5 的验收项「父级 cancel → 子代理全部停止」
**未达成**。

**建议**（伪代码，`App.tsx` 装配处）：
```ts
// 现在：signal: new AbortController().signal
// 改为运行时读取主发送的信号，而不是渲染时新建一个
signal: () => abortRef.current?.signal ?? new AbortController().signal,
```
`SubagentDeps.signal` 改为 `() => AbortSignal`，`runSubagent` 在调用 `runRounds` 前求值一次；
`runToolBatch` 增加 `signal` 参数，中止时不再等待剩余并行槽位。
**测试点**：① 主 signal 已 abort 时，子代理 `chat` 收到的 `opts.signal.aborted === true`；
② 两个并行 `explore` 中一个被中止时，整批返回时间 < 阈值且不留悬空请求；
③ 断言子代理不产生额外的 `tool_calls` 请求。

### P1-2　MCP 工具没有接入权限模型 `[FACT]`

- `src/lib/mcp.ts:245`：工具描述原文「**不受本程序受控执行白名单约束**；计划模式与探索模式下不可用」。
- `src/lib/mcp.ts:311-333`：`executeMcpToolCall` 只拦 `planMode` / `exploreMode` + 浅层参数校验，
  **不经过 `perms::decide`，不弹授权面板，没有默认 `Ask`**。
- `src/App.tsx:917`：MCP 工具是独立动态清单 `mcpToolDefs(mcpSpecsRef.current)` 拼到 `TOOL_DEFS`
  后面，**不在 `src/lib/registry.ts` 的 `TOOLS` 注册表内**，`planModeBlocks` / `isParallelSafeTool`
  对它全部失效（后者返回 false 使其串行，属偶然正确）。
- `src/App.tsx:649-650`：子代理侧靠 `call.name.startsWith("mcp_")` 字符串前缀硬拦，属于补丁式防护。

与项目自身文档的冲突：

| 文档 | 原文要求 | 现状 |
|---|---|---|
| `MCP_PREREQUISITE_AUDIT.md:104` | 「MCP 是权限面的扩张，不是能力的解锁……**先做 MCP 等于先把闸门拆了再装门**」 | 已接入 |
| 同上 §4 | 顺序 `2. P0-4 权限模型 → 4. MCP 客户端 + 工具纳管（前置 2）→ 5. 子代理权限收敛` | 权限模型 11-03 已落地，但接线时未接；子代理先于 MCP 落地 |
| `DEVELOPMENT_ROADMAP.md` P4-3 | 「MCP 工具**必须注册进 `ToolRegistry` 并走同一套 `PermissionPolicy`**」「必须默认 `Ask`」「server 配置需显式信任」 | 三条均未达成 |

`[FACT]` **缓解事实**：`mcp.rs:243-251` 缺省配置 `context-mode` 为 `enabled: false`，需用户显式启用；
且 `config_path` 用 `app.path().app_config_dir()`（应用配置目录，**工程根之外**），
`save_config` 有 `validate_config_file`（裸命令、shell 元字符、凭据键、数量上限）与原子写。
所以「模型改写工程内 `mcp.json` → 自动拉起任意命令」这条链**不成立**，本报告不虚报 P0。

`[RISK]` 但一旦用户启用 context-mode（其 `ctx_execute` 可执行任意代码），用户看到的「执行授权闸门」
覆盖不到 MCP 工具：B10 建立的三态闸门被名义上绕过，属于**控制面失真**，评 P1。

**建议**：把 `McpToolSpec` 提升为 `ToolSpec`（`access: "exec"`）注册进 `TOOLS`，或至少在
`executeMcpToolCall` 前复用 `perms::decide` 的 `Ask` 分支；`mcp_start` 前增加一次显式信任确认。
**验收**：启用一台 MCP server 后，模型调其工具必弹授权面板；选「拒绝」时工具返回错误文本；
`TOOL_DEFS` 与注册表逐字段一致性断言覆盖 MCP 工具。

### P1-3　独立复审缺口 `[FACT]`

`git log --since=2026-11-05 -- docs/audit/` 为空。宪章 §1「凡标 `PASS` 的行为结论，必须有一条由
非实施者执行的独立复核记录」；ROADMAP §0 要求阶段间 STOP。这 20 个提交里包含 6 类新攻击面
（MCP stdio 子进程、联网搜索、预览窗口、正则搜索、子代理模型调用、并行扇出），**均未经独立复审**。
本报告即为这批提交的首次独立只读复审，但按宪章不能替代开发方之外的验收签字。

### P2-1　架构回归：`App.tsx` 反向变胖 `[FACT]`

`STATE.md` 记录 B12-B3 把 `App.tsx` 从 1520 降到 1338 行，ADR 0001 五项验收达成 4 项，
仅剩「< 500 行」。**现在实测 1550 行**，比 11-04 又多 212 行：MCP 装配（`App.tsx:149-190`）、
压缩摘要（`:726-785`）、子代理接线（`:634-658`）、预览命令分发（`:822-827`）全部塞回 App。
`orchestration/` 不 import react 这条守住了，但 App 成为更胖的装配中心，D-06 恶化。

### P2-2　并行批次吞异常，可能留下空洞记录 `[FACT]`

`session.ts:138-142` 用 `Promise.allSettled` 且不检查每个 `PromiseResult`：
```
await Promise.allSettled(parallelIdx.map(async (i) => { records[i] = await execute(calls[i]); }));
```
若 `execute` 抛异常（MCP 路径自身 catch 了，但 `ctxRef.current!` 空值、IPC 层未捕获错误等仍可能），
`records[i]` 保持 `undefined`。随后 `session.ts:281` 的 `toolRecords.some(r => findTool(r.name))`
与 `buildMessages` 的 `toolCalls` 展开会抛 `TypeError`，**整轮崩溃而不是降级为错误文本**。
ROADMAP P1-2 要求「结果按 `tool_call_id` 归位」，这里既没归位也没报错，属于「看起来通过」的假结论。
**建议**：`allSettled` 后遍历 `rejected` 分支，回填 `{ error: ... }` 的 `ToolCallRecord`；
补一条变异检验（让 `execute` 抛错 → 用例必须变红）。

### P2-3　正则搜索无 ReDoS 防护 `[FACT]`

`registry.ts:183-189` 只做语法校验 `new RegExp(args.query)`；`registry.ts:197` 用
`new RegExp(query, "i")` 对每行 `test()`。query 上限 200 字符，但 `(a+)+$` 这类 20 字符模式即可
灾难性回溯，卡住渲染进程。该能力由 `c692df5` 新增，无复审记录。
**建议**：限制嵌套量词/长度，或改用逐行字面搜索 + 有限状态正则；补一条「恶意正则在 ≤ N ms 返回」断言。

### P2-4　只读并发判定过宽，成本无上限 `[FACT]`

`isParallelSafeTool(name) = findTool(name)?.access === "read"`（`registry.ts:54`），把
`web_search`（外网请求）、`explore`（子代理最多 4 轮模型请求）、`todo_write` 一律判为可并发。
模型一批返回 N 个 `explore` → N 个子代理并发 → 成本 ×N，且无并发上限、无预算闸门。
宪章 §3「不产生任何费用」在真模型下无强制约束。
**建议**：并发判据拆成 `parallelSafe && costSafe`；`explore` / `web_search` 设并发上限（如 2）并串行排队。

### P2-5　预览窗口边界未纳入治理 `[FACT]`

`lib.rs:312-355`：`open_preview` 接受任意 `http(s)` 或任意**存在的本地文件**
（`is_file()` + `canonicalize`，不限工程根、不限扩展名），用 `WebviewUrl::External(url)` 建
独立 WebView 窗口。触发口目前只有用户 `/preview` 与文件回执按钮，模型不可直达，故未评更高；
但：① CSP 是否作用于 External URL **未做真机验证**（`CLAUDE.md` 明确要求宿主级证据）；
② 宪章 §3.7 要求改 CSP/安全配置必须真机验证；③ 该窗口完全没有文档或审计记录。
**建议**：真机 DevTools 看预览窗口的 CSP 报错；对本地文件补扩展名白名单与工程根限制。

### P2-6　在册技术债复核后仍在 `[FACT]`

| 编号 | 项 | 复核结果 |
|---|---|---|
| D-07 | 存档单键、无 `schemaVersion` | `state.ts:14` 仍为 `zxz.state.v1`，无版本字段 |
| D-15 | `--warn` 引用 4 次从未定义 | `styles.css` 全文无 `--warn:` 声明 |
| D-03 | 授权按工程目录记账 | 未变（`DEC-008` 的已知取舍） |
| D-05 | `fs_list` / `fs_mkdir` 收绝对路径 | 未变（设计取舍） |
| D-06 | `App.tsx` 上帝组件 | **恶化**，见 P2-1 |

### P3　文档与能力宣称失真 `[FACT]`

1. README §9.6「447 / 20 文件」、§14.1「七个工具」；`CLAUDE.md`「七个工具」；
   `CURRENT_ARCHITECTURE.md` 的 1340 行 / 9 条 IPC / root 不受约束；ROADMAP 把三项已落地能力
   标为「未实现」——详见 §2。
2. `todo_write`（`registry.ts:464-517`）的 `run()` **不持久化任何状态**，只把模型传来的清单
   格式化回显；描述宣称「维护本次任务的分步清单，跟踪进度」，实际没有 UI 状态、没有跨轮存储。
   属于能力宣称与实现不符（影响小，评 P3）。
3. `subagent.ts:53-60` 的 `subSettings` 未显式关 `autoCompact`，继承主设置后在短上下文里
   每轮多跑一次 `buildMessages` 预算估算（无压缩空间时返回 null，属无害开销）。

---

## 4. 已复核为「不成立」的猜测（避免虚报）

| 猜测 | 结论 | 依据 |
|---|---|---|
| 模型写工程内 `mcp.json` → 自动拉起任意命令 → RCE | **不成立** | 配置在 `app_config_dir()`（工程根外），`fsx` 会话边界不可达；`validate_server_config` 拒路径/shell 元字符/凭据键 |
| 版本号 0.3.0 vs 0.1.0 不一致（ROADMAP §P6） | **已修** | 三处均 0.3.0 |
| e2e 进 CI 从未跑过（B14-B `NOT_TESTED`） | **已 PASS** | GitHub Actions 23 次运行，最新 `#23` badge `passing`，三 job 无 `continue-on-error` |
| 11-05 新增能力全部没测试 | **不成立** | 545 条单测里含 `compact` 16、`mcp` 27、`appcontrol` 26、`session.parallel` 5、`subagent` 2、`session.explore` 2；`perf` 6 条按设计 skipped |

---

## 5. 建议的推进顺序 `[DECISION]`（待业主裁定，本报告不实施）

| # | 任务 | 级别 | 验收 | 前置 |
|---|---|---|---|---|
| 1 | 治理基线对齐到 `2083011`（STATUS / 技术债 / README / CLAUDE / ARCH） | P1 | `STATE.md` 的 HEAD、单测数、工具数与实测完全一致 | 无 —— **本轮已执行** |
| 2 | 补 11-05 批次的独立复审记录并归档本报告 | P1 | `docs/audit/` 有对应复审文件，结论逐条可追溯 | 1 |
| 3 | 子代理取消传播 + `runToolBatch` 异常处理 | P1 | P1-1 / P2-2 的测试点全绿，含变异检验 | 2 |
| 4 | MCP 工具纳入注册表 + 默认 `Ask` | P1 | 启用 server 后模型调用必弹授权，拒绝能回传错误 | 2，且需业主裁定信任模型 |
| 5 | 并发成本闸门 + 正则 ReDoS 防护 | P2 | 恶意正则限时返回；`explore` 并发有上限 | 3 |
| 6 | `App.tsx` 拆分（ADR 0001 第 5 项） | P2 | < 500 行，接线层有回归网 | 3、4 |
| 7 | 预览窗口真机 CSP 验证 + 本地文件白名单 | P2 | 宿主 DevTools 无 CSP 报错 | 需 Windows 真机 |

`[BLOCKER]` 第 7 项需要 Windows 真机与 WebView2；本沙箱为 Ubuntu，无法执行。
`[RISK]` 第 4 项涉及 MCP 信任模型，属宪章 §4「重大架构决策」，应由业主明确裁定后再动代码。

---

## 6. 本轮产物与边界

- 本文件：`docs/audit/HEAD_2083011_INDEPENDENT_AUDIT_20261105.md`（独立只读审计）。
- 同步推进的治理文档：`STATE.md`、`TECH_DEBT_REGISTER_20261103.md`、`CLAUDE.md`、`README.md`。
- **未修改任何业务代码**（宪章 §1：独立只读角色不得修改被测代码）。
- **未推送远端、未打包、未新增依赖、未产生任何费用**（宪章 §3）。
- 本报告的所有 `PASS` 均为「命令/宿主实测」口径，**不是产品验收结论**；产品验收需业主或非实施者复核。

---

*审计报告结束。判定用词：`PASS` / `PARTIAL` / `FAIL` / `ABSENT` / `NOT_TESTED` / `BLOCKED`。*
