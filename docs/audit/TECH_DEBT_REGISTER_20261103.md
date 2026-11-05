# 统一技术债清单（P0–P3）

日期：2026-11-03　｜　维护者：Project Director（Agent 小队）
口径：只收**当前 HEAD 上仍然成立**的项。已修项在 §4 列出，避免"修复了但清单还在"。

> **2026-11-05 复核**：本清单 §2 的数字（单测条数、`App.tsx` 行数、CI 状态）已按
> HEAD `2083011` 校正；新增条目见 **§6**。完整证据见
> `docs/audit/HEAD_2083011_INDEPENDENT_AUDIT_20261105.md`。

级别定义（按真实风险，不按历史标签）：

| 级别 | 含义 |
|---|---|
| **P0** | 可导致任意代码执行、越界读写、不可撤销的数据损失 |
| **P1** | 控制面失真（用户以为发生了 A，实际发生了 B），或会产生"看起来通过"的假结论 |
| **P2** | 安全边界薄弱但需要额外前提，或架构性回归风险 |
| **P3** | 可维护性 / 文档口径 / 体验 |

---

## 1. 对 P0-3 遗留 8 条的重新评级

这 8 条是 11-03 早间的结论。经过 B4/B5/B10 和本轮重审，**只有 3 条还成立**，
其中 2 条改了级别。

| 原编号 | 原结论 | 重新评级 | 依据 |
|---|---|---|---|
| 1 | 受信任运行器会加载工程内配置文件（`vite.config.*`） | **撤回**（DEC-005） | "执行模型写的代码"是编码 Agent 的既定能力，`src/**/*.test.ts` 同样会被 vitest 执行，堵 `vite.config.*` 只制造虚假安全感。真正的闸门是执行前授权，已由 B10 落地 |
| 2 | `fsExists` 吞错 → 备份静默跳过 | **已修**（`6edb112`） | 校验失败与备份失败均中止写入 |
| 3 | `.zxz/undo/**` 对模型可写 | **已修**（`d4b1d83`） | 写走专用通道；随后 B10 复审进一步把**读**也关掉 |
| 4 | 输出缓冲无上限 | **已修**（`554dc1d`） | 保留上限 256 KB，管道仍读空 |
| 5 | 未 `env_clear()` | **已修**（`554dc1d`） | `env_clear()` + 19 项白名单 |
| 6 | `fs_mkdir` 接受任意绝对路径，WebView 内可达 | **降为 P2**（见 D-05） | 重审后：模型侧**够不到**这条命令（`TOOLS` 里没有 mkdir，B6 已锁）；能调用它的是渲染进程。而它只能建**空目录**、名字经 `check_dir_name` 校验、不能写内容、不能覆盖。最坏结果是骚扰性目录，不是数据面损失 |
| 7 | proxy 鉴权在读完 body 之后，单连接可先提交 32MB | **已修**（本轮） | 拆成 `read_head` + `read_body`，Host/token 校验全部前移到读 body 之前；新增一条裸 socket 断言证明"不发 body 也能立刻拿到 401" |
| 8 | 熵口径 `RandomState` 128 位 vs 注释 256 位 | **降为 P3**（见 D-12） | 128 位对本机一次性 token 的安全裕度足够（爆破不可行），属注释口径问题 |

## 2. 当前在册（按风险排序）

| # | 级别 | 项 | 证据 | 影响 | 状态 |
|---|---|---|---|---|---|
| D-02 | **P2**（原 P1） | 编排层**接线**仍无自动化验证 | 传输层已补 `src/api.test.ts`（31 条：上游错误 / SSE 分帧 / 断流 / 工具增量）；轮末判定已有 `round.ts`；剩下的是 `send()` 对这些纯函数的调用与状态回写 | 「什么时候停」「失败怎么报」两类现在都有判据；剩下「纯函数算得对不对」已能测、「有没有被正确调用」仍靠人眼。降级理由见 §2.1 | 部分修复（B12-A） |
| D-03 | P2 | 执行授权按**工程目录**记账，不是按对话 | `wsx::open` 对同一目录复用会话号，Rust 只有一个桶（DEC-008） | 前端在切/新建/删除/清空对话时主动撤回，把粒度**补偿**回对话级；一旦有绕过前端的调用路径就退回工程级 | 已知取舍，已写入 README 14.2.1 |
| D-04 | ~~P2~~ | ~~`.zxz/undo` 子目录列举失败时静默跳过~~ | `listUndo` 的 `walk()` 逐层 `catch { return }` | 会产出**看起来完整**的快照列表。不导致数据丢失（恢复时 `undo_read` 会明确报错），但用户可能据此判断"这版没改过某文件" | **已修（B11）**，见 §4 第 18 条 |
| D-05 | P2 | 渲染进程可对任意绝对路径 `fs_list` / `fs_mkdir` | `lib.rs` 的 `fs_cmds::fs_list` / `fs_mkdir` 是无状态命令，不校验会话 | 选择器天生要能浏览（设计如此），但一旦渲染进程被攻破（XSS/恶意依赖），可枚举全盘目录、在全盘建空目录。写入/读取内容仍被会话通道挡住 | 设计取舍，未修 |
| D-06 | P2 | `App.tsx` **1550 行**上帝组件 + `stateRef` 手工双写（11-05 复核：B12-B3 曾降到 1338，之后新增 MCP 装配/压缩/子代理/预览接线又回升 212 行） | ADR 0001 验收项 `App.tsx < 500 行` 仍为 `[ ]`，且**反向恶化** | 任何 UI 改动的回归面都很大 | 未修（ADR 0001 未完成） |
| D-07 | P2 | 存档单键、无 `schemaVersion` | `zxz.state.v1` 一把梭；`250ms` 全量写，含 `streaming` 中间态 | 字段语义变更无法迁移；写放大 | 未修 |
| D-08 | P2 | e2e 进不了 CI | R3 三个成因全部处理：`msedge` 硬编码 → `tools/browser.cjs` 逐级回落；端口 5173 vs 1420 → 默认 `localhost:1420` + 子进程显式继承 `ZXZ_BASE`；`playwright` 已入 `devDependencies`（业主批准）。`ci.yml` 新增 `e2e` job | 本地四套脚本零环境变量可跑；**2026-11-05 复核：GitHub Actions 已跑 23 次，最新 `CI #23 / 2083011` badge `passing`，三 job 无 `continue-on-error` → `e2e` job 首次运行 PASS**（DEC-012） | **已修（宿主实测，非本地自证）** |
| D-09 | ~~P2~~ | ~~release 无条件带 devtools~~ | `tauri/Cargo.toml` 的 `features=["devtools"]` 无 `cfg(debug_assertions)` 门控 | 发布物给用户附赠一个调试接口 | **已修**，见 §4 第 19 条 |
| D-10 | P3 | 一次性授权在闸门处即扣，spawn 失败也扣 | `perms::decide` 在 `runx` 之前扣 `uses_left` | 用户要再批一次。失败方向是**更严**，不是更松 | 取舍，已写入 README 14.2.1 |
| D-11 | P3 | `GIT_CONFIG_GLOBAL=<空设备>` 同时丢掉用户的 `safe.directory` | `runx.rs` 的 git 隔离项 | 仓库属主不同时报 `dubious ownership`。报错明确，不是静默错误结果；保留用户配置等于重新打开 `textconv` 那扇门 | 取舍（DEC-003 的直接后果） |
| D-12 | P3 | 熵注释口径不一致（128 vs 256 位） | `proxy.rs` 的 `RandomState` | 纯注释问题 | 未修 |
| D-13 | P3 | 测试覆盖结构失衡 | **545 条**（11-05 复核）集中在 `src/lib` + `src/skills` + `src/api.ts` + `orchestration`；`App.tsx` 与组件层仍基本 0 | 与 D-02 同源（组件层没有 DOM 就没法测） | 未修 |
| D-14 | P3 | e2e 假 IPC 需手工跟随真 IPC | `tools/workspace-e2e.cjs` 的 `__TAURI_INTERNALS__` 桩本轮才补齐 `undo_*` / `perm_*` | 新增一条 IPC 就忘一次，失效方式是**误导性超时**而不是报错 | 机制性风险，未根治 |
| D-15 | P3 | 样式变量 `--warn` 被引用 4 次、从未定义 | `src/styles.css` 全文无 `--warn:` 声明；4 处引用各带不同 fallback（`#e3b341` / `#d08a2a` / `#b8860b`） | 每个 `var(--warn, X)` 都在用自己的 X，同一个语义在不同位置是三种颜色。改主题时改不动 | 未修（B11 只做记录，不动别人的颜色） |
| D-16 | P3 | ~~用户点「停止」会让代理日志报"连接处理失败"~~ **已修（2026-11-04）** | `proxy.rs` 现在用 `ConnError::{PeerGone,Fatal}` 区分：`BrokenPipe` / `ConnectionReset` / `ConnectionAborted` 归 `PeerGone` 并静默，其余照旧打日志；读路径的畸形请求仍是 `Fatal` | 日志在说谎的方向是"平时天天报错"，真出故障时反而分不出来 | **已修**：`docs/audit/D16_INTERRUPT_LOG_20261104.md`；3 条 Rust 单测 + 端到端对照（旧行为打到 `os error 10053`，新行为 stderr 为空） |

### 2.1 为什么 D-02 从 P1 降到 P2（而不是「已修」）

D-02 原本的理由是「编排层任何回归只能靠人眼」。拆开看，编排层出错只有三种方式：

| 出错方式 | 现在有判据吗 | 判据在哪 |
|---|---|---|
| 纯函数的判断本身错了（什么时候停、提示文案是什么、要不要自动测试） | **有** | `src/orchestration/round.test.ts`（30 条） |
| 上游出错时报出来的话不对（401 说什么、流断在半路怎么办、用户点停止和网络断了分不分得清） | **有**（本轮新增） | `src/api.test.ts`（31 条） |
| 上面这些函数**有没有被正确调用**、状态有没有正确回写 | **没有** | — |

第三种才是剩下的缺口。它需要 DOM（要真渲染 `App`）或把 `send()` 改成注入式副作用后整体搬家；
前者要装 `jsdom`，后者要动全仓最热且零覆盖的 320 行闭包。两条都落在甲方保留权限/高风险改动上，
**没有擅自开工**，等业主选。

所以这条**不是已修**，是从「完全没判据」变成「两层有判据、接线层没有」。
本轮结束时在册 P1 为 **0 条**——但这是「原来的 P1 被拆开看清楚」的结果，不是「问题消失了」。

## 3. 排序理由（以及现在该排第一的是谁）

D-01（停止按钮）和 D-02（编排零覆盖）曾是仅有的两条"用户看到的事实与实际不符"的项：

- D-01 里，用户点了停止、界面显示已停止，但子进程还在跑。这不是"功能没做好"，
  是**界面在说谎**。而"停止"恰好是用户在怀疑出问题时按的那个键。
  → **已修**（B13），见 §4 第 17 条。
- D-02 里，编排层没有回归网，任何一次改动都可能悄悄改掉"什么时候停、失败怎么报"，
  而测试全绿——绿灯覆盖不到那片区域。
  → **部分修复**（B12-A），两层已补判据，接线层仍空白，见 §2.1。

安全类项（D-03/D-05）当初排在后面，是因为它们需要"渲染进程已被攻破"或"绕过前端"这类前提，
而 D-02 不需要任何前提、天天都在发生。

**D-02 降级之后，在册里没有 P1 了。** 现在优先级最高的三条都是 P2，且性质不同：

| 顺序 | 项 | 为什么轮到它 |
|---|---|---|
| 1 | D-06（`App.tsx` 1520 行） | 它是 D-02 剩下那半的**根因**：接线层之所以测不了，就是因为接线和 UI 长在同一个组件里。拆它就等于同时解决 D-02 和 D-13 |
| 2 | D-08（e2e 进不了 CI） | 唯一能覆盖真实 WebView 的手段，现在只能人工跑；三个成因都已实测确认、都可修 |
| 3 | D-05（`fs_list`/`fs_mkdir` 收绝对路径） | 需要"渲染进程被攻破"的前提，但一旦成立就是全盘目录枚举 |

D-06 排第一不代表马上动手：它要动全仓最热、零覆盖的 320 行闭包，属于**高风险重构**。
在没有接线层回归网的前提下动它，等于把"没判据"升级成"没判据且刚大改过"。
这不是本次授权的执行顺序问题，是需要业主在「先装 jsdom 拿判据，再拆组件」和「先拆再补测」
之间做选择——两条路的回滚成本差别很大，所以没替业主决定。

## 4. 已修（避免清单虚高）

| # | 项 | 证据 |
|---|---|---|
| 1 | npm 脚本审计构造级拒绝 + 全分隔符切段 | `a0fa179` |
| 2 | 只读 git 三道强制加固（`core.fsmonitor` / `--no-textconv` / `--no-ext-diff` + env 隔离） | `a0fa179` |
| 3 | `.git/**` 整目录拒绝写入（含 `./.git` 点号绕过） | `a0fa179` / `d4b1d83` |
| 4 | `fsExists` 吞错 → 写入中止 | `6edb112` |
| 5 | `.zxz/undo` 专用通道 + 读写全关 | `d4b1d83` / `7b26b67` |
| 6 | 输出保留上限 + `env_clear()` + 白名单 + `truncated` 回传 | `554dc1d` |
| 7 | 工具定义五处手写 → 单一注册表 | `449b3a5` |
| 8 | 执行授权闸门（`Deny`/`Ask`/`Allow`） | `7b26b67` |
| 9 | npm `pre`/`post` 钩子绕过脚本审计 | `7b26b67` |
| 10 | 工程 `.npmrc` 可改 npm 脚本 shell | `7b26b67` |
| 11 | 撤销快照可被模型读取（信息 + 操作轨迹泄漏） | `7b26b67` |
| 12 | 删/清空对话不撤销执行授权 | `7b26b67` |
| 13 | 秒级时间戳同秒撞目录；时间显示差一个时区 | `7b26b67` |
| 14 | `JSON.parse("null")` 让 validate 抛在 try 外 | `7b26b67` |
| 15 | `.zxz` 自身可被当文件写入（自伤 DoS） | `7b26b67` |
| 16 | proxy 鉴权在读 body 之后 | 本轮（见 §1 第 7 条） |
| 17 | 点"停止"杀不掉正在跑的 `npm test` | 本轮（B13）：`run_cancel` + 会话级取消位 + 进程树终止；端到端测试断言的是**耗时**而不只是标志位 |
| 18 | 撤销快照"打不开"被吞成"就这几个文件" | 本轮（B11）：`walk()` 返回 `boolean`，失败即置 `incomplete`；界面显式标「清单不完整」。这是**结论正确性**修复而非数据安全修复（恢复本身会报错）——所以标记必须出现在界面上，不能只存在类型里 |
| 19 | release 无条件带 devtools | `tauri` 依赖去掉 `features=["devtools"]`，改为可选 `devtools` 特性。源码门控是 `#[cfg(any(debug_assertions, feature="devtools"))]`（`tauri-2.12.5/src/webview/mod.rs:2263`、`tauri-runtime-wry-2.12.3/src/lib.rs:3937`），故 debug 构建不受影响。证据：`cargo tree -e features` 中已无 devtools 边 |
| 20 | 编排层零覆盖（B12-A） | `src/api.test.ts` 31 条，覆盖四类：①上游错误（401/503/body 读不出/网络层/AbortError 直抛/非流式 error 字段/非 JSON/流内 error）②SSE 分帧（注释行、半截 JSON、无换行收尾、中文被字节切开、最后一行）③断流（保留已收内容、断在半路不许发 `done`、cancel 抛错不掩盖原错）④Key 不进 URL（直连走头、代理走体）。**4 次变异检验**（撤 AbortError 直抛 / 撤 `{stream:true}` / 撤 cancel 的 try / 把 Key 塞回代理头）各自精确变红一条 |
| 21 | **要了流式、上游返回整段 JSON → 静默空回答**（独立复审揪出） | `api.ts:115` 的条件只判 `!wantStream`，注释却写着"或代理返回一次性 JSON"。`stream` 默认 true，于是 JSON 被当 SSE 逐行解析、一行都不以 `data:` 开头 → 零 delta、零报错，用户看到空回答。改成 `isJson = contentType.includes("json")` 参与判定：上游明确说是 JSON 就走一次性分支。**复现**：先加用例（红：`[{"type":"done"}]`）→ 再改代码（绿）。变异检验：撤掉 `isJson` → 恰好 1 条红 |
| 22 | **代理模式下 `done` 发两条、且第一条排在 `tool_calls` 之前**（独立复审揪出） | `proxy.rs:295` 无条件发 `done`，`api.ts:191` 原样转发，`api.ts:242` 再补一条。断言它"就是两条"等于把缺陷固化成契约。现改为 `if (json.type === "done") return;`，统一由 `api.ts` 在流末发唯一一条。**当前对 App 无可见后果**（`grep '"done"' src/App.tsx` 为 0，没有消费者），属预防性修复——但顺序错误会让将来任何按 `done` 收尾的消费者整轮丢掉工具调用，所以不留 |
| 23 | e2e 脚本写死 `msedge`、默认端口 5173（B14-A） | 新建 `tools/browser.cjs`：按 `ZXZ_BROWSER_CHANNEL`（支持逗号列表）→ `msedge` → `chrome` → 无 channel 逐级回落，全失败时列出每次真实原因；5 个脚本改为调用它。`e2e/skill-e2e/workspace-e2e/shot-*` 的默认 BASE 改成 `localhost:1420`（与 `vite.config.ts` 的端口一致）；`proxy-e2e` 显式把 `ZXZ_BASE` 传给子进程。**实测**：不传任何变量下 `e2e` 24/24、`proxy-e2e` 11+24、`workspace` 39/39、`skill` 69/69；`ZXZ_BROWSER_CHANNEL="nope,msedge"` 真实走进回落分支并打印 `[browser] 用 msedge 启动` |
| 24 | e2e 进 CI（B14-B） | `playwright@1.64.1` 入 `devDependencies`；`ci.yml` 新增独立 `e2e` job：`npm ci` → `npx playwright install --with-deps chromium` → 起 vite(1420) + 假上游(19888) 并用 curl 轮询就绪（不引 `wait-on`）→ `node tools/e2e.cjs` → 失败时打印服务日志。**证据到哪一步**：`npm ci --dry-run` 通过（锁文件一致）、YAML 结构自检通过（3 job / 0 制表符）、job 内命令与本地实跑逐条一致。**没到哪一步**：job 从未在 GitHub 上执行过 → 标 `NOT_TESTED`，不标 PASS |

## 5. 维护规则

1. 新增条目必须带**代码位置或实测命令**。写不出证据的不进清单。
2. 级别按"真实风险"定，不按"看起来严重"定。降级和撤回都要写理由（§1 就是模板）。
3. 修完的项**从 §2 移到 §4**，并在 §4 记提交号。清单里同时出现"已修"和"在册"是清单失效的开始。
4. 每次批量交付后重扫一遍 §2：有些项会因为别的改动而消失（这次 proxy 那条就是顺路修的）。

---

## 6. 2026-11-05 复核新增（HEAD `2083011`）

证据与修复方案见 `HEAD_2083011_INDEPENDENT_AUDIT_20261105.md` §3 / §5。
级别沿用 §0 定义；**本轮为独立只读审计，下列代码项均未修**。

| # | 级别 | 项 | 证据 | 影响 | 状态 |
|---|---|---|---|---|---|
| **D-17** | **P1** | 子代理不响应「停止」 | `App.tsx:639` 传 `new AbortController().signal`；`App.tsx:893,962` 的 `stop()` 只 abort 主 controller；`session.ts:138` 的 `allSettled` 还会等整批只读工具 | 界面显示「已停止生成」，子代理仍跑最多 4 轮模型请求；与已修 D-01 同类回归，且产生真实费用（宪章 §3）；ROADMAP P5「父级 cancel → 子代理全部停止」未达成 | 未修 |
| **D-18** | **P1** | MCP 工具未接入权限模型 | `mcp.ts:245` 描述自承「不受本程序受控执行白名单约束」；`mcp.ts:311-333` 只拦 plan/explore、无 `Ask`；`App.tsx:917` 动态清单不在 `registry.ts` 的 `TOOLS` 内；`App.tsx:649` 子代理侧靠 `startsWith("mcp_")` 硬拦 | 与 `MCP_PREREQUISITE_AUDIT.md` §4「先做 MCP 等于先把闸门拆了再装门」、ROADMAP P4-3「必须注册进 ToolRegistry + 默认 Ask」冲突；用户认知里「所有执行都要批准」被打破。缓解：默认 `enabled:false`、配置在工程根之外且有校验 | 未修，**需业主裁定信任模型**（DEC-013） |
| **D-19** | **P1** | 11-05 批次无独立复审 | `git log --since=2026-11-05 -- docs/audit/` 为空；`docs/audit/` 最新为 11-04 `D16_*` | 20 个提交引入 6 类新攻击面（MCP stdio 子进程 / 联网搜索 / 预览窗口 / 正则 / 子代理 / 并行扇出）全部无独立复核；违反宪章 §1 与 ROADMAP 阶段间 STOP | 本轮补首次独立复审；**产品验收签字仍 `ABSENT`** |
| **D-20** | P2 | `runToolBatch` 吞异常留下空洞记录 | `session.ts:138-142` 用 `Promise.allSettled` 且不检查 rejected，`records[i]` 可能为 `undefined`；随后 `session.ts:281` 的 `findTool(r.name)` 与 `buildMessages` 展开会 `TypeError` | 整轮崩溃而非降级为错误文本；ROADMAP P1-2「结果按 `tool_call_id` 归位」未达成 | 未修 |
| **D-21** | P2 | 正则搜索无 ReDoS 防护 | `registry.ts:183-189` 只验语法；`:197` 用 `new RegExp(query,"i")` 逐行 `test()`；query 上限 200 字符但 `(a+)+$` 20 字符即可灾难性回溯 | 可卡死渲染进程；`c692df5` 新增、无复审 | 未修 |
| **D-22** | P2 | 只读并发判定过宽、成本无上限 | `isParallelSafeTool = access === "read"`（`registry.ts:54`）把 `web_search` / `explore` / `todo_write` 一律判为可并发 | 一批 N 个 `explore` → N 个子代理并发 → 成本 ×N；无并发上限、无预算闸门（宪章 §3） | 未修 |
| **D-23** | P2 | 预览窗口边界未纳入治理 | `lib.rs:312-355` 接受任意 http(s) 或任意存在本地文件（不限工程根、不限扩展名），`WebviewUrl::External` 建窗；`docs/audit/` 与 README 无记录 | External URL 的 CSP 是否生效**未真机验证**（宪章 §3.7）；触发口目前仅用户 `/preview` 与文件回执按钮，模型不可直达 | 未修；真机验证在本沙箱 `BLOCKED` |
| **D-24** | P2 | 治理文档基线失真 | `STATE.md` 停在 `8142815` / 447 单测；`CURRENT_ARCHITECTURE.md`（11-02）写 `App.tsx 1340 行`、`send()` 在 App、9 条 IPC；`ROADMAP`（11-02）把压缩 / MCP / 子代理标为「未实现」 | 后续优先级基于错误前提 | **部分已修**：本轮对齐 `STATE.md` / 本清单 / `CLAUDE.md` / `README.md`；`CURRENT_ARCHITECTURE.md`、`ROADMAP.md` 待下批 |
| **D-25** | P3 | `todo_write` 不持久化任何状态 | `registry.ts:508-516` 的 `run()` 只把模型传来的清单格式化回显，无 `ctx` 副作用、无 UI 状态 | 描述宣称「维护任务清单、跟踪进度」，实际没有跨轮存储 | 未修 |
| **D-26** | P3 | 文档数字与工具清单失真 | README §9.6「447 / 20 文件」、§14.1「七个工具」；`CLAUDE.md`「七个工具」 | 与实测 545/29、11 个工具不符；`CLAUDE.md` 明确要求 README 数字等于实测 | **部分已修**：本轮同步 README 与 `CLAUDE.md` 的关键口径 |

### 6.1 已复核为「不成立」的猜测（避免清单虚高）

| 猜测 | 结论 | 依据 |
|---|---|---|
| 模型改写工程内 `mcp.json` → 自动拉起任意命令 → RCE | **不成立** | `config_path()` 用 `app.path().app_config_dir()`（工程根之外），`fsx` 会话边界不可达；`validate_server_config` 拒路径 / shell 元字符 / 凭据键；`save_config` 原子写 |
| 版本号 0.3.0 vs 0.1.0 不一致 | **已修** | 三处均 0.3.0 |
| e2e 进 CI 从未跑过（D-08 / B14-B） | **已 PASS** | GitHub Actions 23 次运行，最新 `#23` `passing` |
| 11-05 新增能力无测试 | **不成立** | 545 条里含 `compact` 16、`mcp` 27、`appcontrol` 26、`session.parallel` 5、`subagent` 2、`session.explore` 2；`perf` 6 条按设计 skipped |

### 6.2 复核后仍在册的旧项

D-03（授权按工程目录）、D-05（`fs_list` / `fs_mkdir` 绝对路径）、D-07（无 `schemaVersion`）、
D-15（`--warn` 未定义）、D-11 / D-12 / D-14 均未见改动；D-06 恶化（见 §2 修订行）。

## 7. 2026-11-06 队列 ①~⑥ 修复登记（本轮最新，覆盖 §2 / §6 的状态列）

> 依据：业主 2026-11-06 确认的执行队列；证据见 `git log`、`docs/governance/STATE.md`、
> `docs/adr/0004-mcp-permission.md`、`docs/audit/BATCH_20261105_INDEPENDENT_REVIEW.md`。
> 判定：已修项标提交号，**未验证项仍标 `NOT_TESTED`**，不冒充 PASS。

| # | 原状态 | 本轮动作 | 新状态 | 提交 / 证据 |
|---|---|---|---|---|
| D-06 | `App.tsx` 1550 行，反向恶化 | 抽出 `lib/workspace.ts`、`orchestration/summarize.ts`、`hooks/useMcpServers.ts`、`hooks/useExecApproval.ts` | **PARTIAL**：**1296 行**（-274），ADR 0001「< 500 行」仍 `[ ]` | `50c21ea`；新增 8 条纯逻辑断言 |
| D-13 | 545 条，组件层仍 0 | 接线层纯逻辑可单测 | **PARTIAL**：609 条 / 34 文件；组件层 DOM 单测仍 `ABSENT` | 每步 `npm test` 全绿 |
| D-17 | P1 子代理不响应停止 | `mainSignalRef` 复用主 signal + `runRounds` 轮前检查 + `runSubagent` 请求前检查 | **已修** | `d5515a8`；`subagent.test.ts` 2 条新断言 |
| D-18 | P1 MCP 未接入权限模型 | 统一策略视图 + 默认 `Ask` + Rust `guard_mcp` 闸门 | **已修（业主裁定 / ADR 0004）** | `851c990`；前端 27 条新断言、harness 6 条 MCP 测试全 PASS |
| D-19 | P1 批次无独立复审 | 批次级独立复审归档 | **已修** | `6dac044`；`BATCH_20261105_INDEPENDENT_REVIEW.md`（结论 `PARTIAL`） |
| D-20 | P2 `allSettled` 留空洞 | `toolFailure` 兜底 + 波内二次补洞 | **已修** | `d5515a8`；`session.parallel.test.ts` 3 条新断言 |
| D-21 | P2 正则无 ReDoS 防护 | `lib/regexsafe.ts` 静态拒绝 + 行长截断 + `run` 二次校验 | **已修** | `3935880`；22 条断言 |
| D-22 | P2 并发成本无上限 | `orchestration/budget.ts` 三类分波 + expensive 每批上限 1 | **已修** | `3935880`；11 条断言 |
| D-23 | P2 预览窗口 CSP 无真机证据 | 交付可复现宿主验证清单 | **BLOCKED / NOT_TESTED**（未改任何 CSP） | `PREVIEW_CSP_HOST_VERIFICATION_20261106.md` |
| D-24 | P2 治理文档基线失真 | `STATE.md` / 台账 / README / CLAUDE 同步，`CURRENT_ARCHITECTURE.md` / `ROADMAP.md` 补校正章节 | **已修** | 本轮文档提交 |
| D-25 / D-26 | P3 `todo_write` 不持久化 / 文档数字失真 | 数字已同步；`todo_write` 未动 | D-26 **已修**；D-25 **仍在册** | — |
| **D-27** | — | 本轮 ①~⑤ 的代码改动尚未经非实施者独立复审 | **P1 新增** | 宪章 §1：开发结论不构成验收结论；`STATE.md` R8 |

> **编号更正**：`d5515a8` 提交消息里写的 `D-17/D-18` 中，后者应为 **D-20**
> （`runToolBatch` 异常空洞）；D-18 是 MCP 权限，由 `851c990` 修复。按「一次提交只做一件事」
> 不用 amend 改历史，在此登记以免后续对不上号。
>
> **复核后仍在册**：D-03（授权按工程目录）、D-05（绝对路径）、D-07（无 `schemaVersion`）、
> D-15（`--warn` 未定义）、D-25（`todo_write` 不持久化）。
