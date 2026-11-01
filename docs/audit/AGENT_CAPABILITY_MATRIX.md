# ZXZGPT1 — Phase 0 Agent 能力矩阵

> 阶段性质：**READ-ONLY / AUDIT-ONLY**。未修改任何业务代码。
> 判定口径：**不凭函数名判断功能已实现**，只看运行时是否真的存在对应的控制流、状态与持久化。
> 四档：`已实现` / `部分实现` / `未实现` / `无法确认`。

---

## 1. 总览

| # | 能力 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | Agent Loop | 部分实现 | 存在 6 轮循环，但嵌在 React 组件闭包内，不可测、不可恢复、不可复用 |
| 2 | 多轮模型调用 | 已实现 | `for (round < 6)`，读文件/工具结果/测试失败均触发下一轮 |
| 3 | Tool Calling | 已实现 | 5 个工具、原生 `tool_calls` 协议、流式 delta 累计、Rust 转发 |
| 4 | 多工具连续执行 | 部分实现 | 单轮内多调用顺序执行；跨轮依赖模型再次返回，受 6 轮上限约束 |
| 5 | 并行工具调用 | 未实现 | 显式 `for ... await`，注释写明"顺序执行、不并行" |
| 6 | 统一工具注册机制 | 部分实现 | 有 `TOOL_DEFS` 声明，但执行是 if/else 链，无 registry |
| 7 | 工具参数 Schema 验证 | 部分实现 | 手写 `validateToolArgs`，与 JSON Schema 双份，非 schema 驱动 |
| 8 | 权限审批机制 | 部分实现 | 仅写文件有确认面板（默认关）+ 计划模式拦截；命令无逐次审批 |
| 9 | 任务中断机制 | 部分实现 | `AbortController` 只覆盖 fetch；工具执行期间不可中断 |
| 10 | 错误重试机制 | 部分实现 | 仅测试回路 3 轮；网络/上游/工具失败无重试与退避 |
| 11 | 任务状态持久化 | 未实现 | 仅消息历史落盘；run 的运行时状态全在闭包，退出即丢 |
| 12 | 上下文压缩 | 未实现 | 只有"最近 N 轮"窗口，按轮不按 token；无摘要/压缩 |
| 13 | Plan Mode | 部分实现 | 有开关 + 提示词 + 运行时拦截；无计划产物与计划审批 |
| 14 | Subagents | 未实现 | 无任何子代理/任务分解代码 |
| 15 | Skills | 部分实现 | 自有 SKILL.md 机制已可用；非 Anthropic Skills 标准，无脚本执行 |
| 16 | Hooks | 未实现 | 无生命周期钩子 |
| 17 | MCP | 未实现 | 无 MCP 客户端/服务端 |
| 18 | Git Integration | 部分实现 | 仅 3 条只读 git 命令进白名单；无分支/提交/PR 能力 |
| 19 | Project Exploration | 部分实现 | 目录树(深度2) + `list_dir` + 字面子串 `search_files` |
| 20 | 自动化测试与调试 | 部分实现 | 写完自动跑 `npm test` 最多 3 轮；无构建验证、无断点调试 |
| 21 | Session Resume | 未实现 | 会话消息可恢复，agent run 不可续跑 |

**汇总**：已实现 3 / 部分实现 11 / 未实现 6 / 无法确认 1。

---

## 2. 逐项证据

### 1) Agent Loop — `部分实现`

【事实】循环体在 `src/App.tsx:601`：

```ts
for (let round = 0; round < MAX_ROUNDS; round++) {   // MAX_ROUNDS = 6, App.tsx:215
   ... await chatStream(...)                          // 一轮模型调用
   ... await requestApplyFiles(blocks)                // file: 块落盘
   ... for (const call of roundToolCalls) {           // 工具执行
          toolRecords.push(await executeTool(call));
       }
   ... 测试回路 / @@read 回传 → 继续下一轮
}
```

成立的部分：确实存在「模型 → 工具 → 结果回传 → 再调模型」的闭环，`App.tsx:764` 的
`if (!toolRecords.length && !reads.length && !refs.length) break;` 是正确的终止判据。

不成立的部分（判定为"部分"的四条理由）：
1. **位置错误**：循环写在 React 组件的 `useCallback`（`App.tsx:526-796`）里，生命周期绑定在 UI 组件上，
   组件卸载即中断，无法在组件外驱动。
2. **不可单测**：`vitest.config.ts` 的 `include: ["src/**/*.test.ts"]` 且不加载 React 环境；
   `App.tsx` 无任何测试文件 → **这条最核心的控制流测试覆盖为 0**。
3. **不可恢复**：循环状态（`round`、`baseMessages`、`testRounds`）是闭包局部变量，从未持久化。
4. **不可复用**：没有第二个入口能用这条循环（无 CLI、无后台任务、无子代理可调用）。

### 2) 多轮模型调用 — `已实现`

【事实】`App.tsx:601` 循环上限 6 轮；三类触发源：
- 工具结果（`App.tsx:764`）；
- `@@read` / `@@ref` 回传（`App.tsx:772-786`）；
- 测试回路失败回传（`App.tsx:735-741`，最多 3 轮，与读写轮独立计数，`App.tsx:107`）。

### 3) Tool Calling — `已实现`

【事实】完整链路已打通：
- 声明：`TOOL_DEFS`（`tools.ts:28-102`），5 个工具 `read_file` / `list_dir` / `search_files` / `write_file` / `run_command`；
- 下发：`api.ts:71` 带 `tools + tool_choice:"auto"`；Rust `api.rs:126-129` 转发；
- 流式：`api.rs:337-355` 产出 `tool_call_delta`；`api.ts:182-189` 累计；`api.ts:237-240` 合成 `tool_calls`；
- 非流式：`api.rs:248-275` 一次下发；
- 执行：`App.tsx:688-692`；
- 回填：`state.ts:94-104` 展开成 `assistant tool_calls` + `tool` 消息（带 `tool_call_id`）—— **这一步做对了，模型能对上号**。

### 4) 多工具连续执行 — `部分实现`

【事实】单轮内多个 `tool_calls` 会全部执行（`App.tsx:689` for 循环逐个 `await`）。
判"部分"的理由：跨轮连续执行完全依赖模型在下一轮再次返回 `tool_calls`，
而轮数硬上限 6（`App.tsx:215`），且**没有任何"工具结果触发同类工具再次执行"的编排策略**——
例如模型一次只能搜一个目录时，剩余工作会被 6 轮上限截断并 toast 报错（`App.tsx:766`）。

### 5) 并行工具调用 — `未实现`

【事实】`App.tsx:414-418` 注释与实现一致：

```ts
/** 执行一次模型发起的工具调用。顺序执行、不并行，避免两个写操作互相覆盖。 */
...
for (const call of roundToolCalls) { toolRecords.push(await executeTool(call)); }
```

【建议】正确做法是**按冲突关系分组**：只读工具（`read_file`/`list_dir`/`search_files`）可并发，
写类工具（`write_file`/`run_command`）串行。当前一律串行，长任务（如 `search_files` 遍历）会显著拖慢。

### 6) 统一工具注册机制 — `部分实现`

【事实】`TOOL_DEFS`（`tools.ts:28`）是**声明**的唯一来源，但**执行**是 `App.tsx:437-516` 的 if/else 链：

```ts
if (call.name === "read_file") { ... }
if (call.name === "list_dir") { ... }
if (call.name === "search_files") { ... }
if (call.name === "write_file") { ... }
if (call.name === "run_command") { ... }
return { ...base, error: `未知工具：${call.name}` };
```

每新增一个工具需改动 **5 处**：`ToolName` 类型(`tools.ts:17`)、`TOOL_DEFS`、`validateToolArgs`、
`executeTool` 的 if 分支、`buildToolsPrompt` 的自然语言说明。
【建议】改为 `Record<ToolName, ToolHandler>` 注册表 + 统一 dispatch，声明即注册。

### 7) 工具参数 Schema 验证 — `部分实现`

【事实】`validateToolArgs`（`tools.ts:185-214`）逐工具手写校验：
- 类型检查（`typeof args.path !== "string"`）✅；
- 路径检查（复用 `relPathError`）✅；
- `search_files` 的 query 长度上限 200 ✅；
- `run_command` 走白名单 ✅。

但：
1. **非 schema 驱动**：`TOOL_DEFS` 里的 JSON Schema 只发给模型看，运行时**不用于校验**；
2. **双份真相**：Schema 写了 `additionalProperties: false`，运行时**不拒绝多余字段**；
3. 无大小上限（`write_file` 的 `content` 无长度限制；`read_file` 无路径长度限制）；
4. 无必需字段的机器化校验（靠手写，易漏）。

【建议】引入 Schema → 运行时校验的单一来源（可用极简自实现，不建议引入 zod 依赖）。

### 8) 权限审批机制 — `部分实现`

| 工具 | 审批 | 证据 |
|---|---|---|
| `write_file` | 有，**默认关闭** | `App.tsx:328-354` `requestApplyFiles`；`presets.ts:81` `confirmWrites: false` |
| `run_command` | **无逐次审批**，仅白名单 | `App.tsx:496-515` 直接执行 |
| `read_file`/`list_dir`/`search_files` | 无审批 | `App.tsx:437-485` |
| 计划模式 | 拦截写+命令 | `App.tsx:432-435` |

【事实】审批只有一个形态：写文件的差异确认面板（`PendingWrites.tsx` + `pending.ts`），
且**默认关闭**（`presets.ts:81`），README 也承认"默认仍是自动落盘"。
没有「本次会话总是允许」「按工具粒度授权」「命令逐次确认」「拒绝并告知模型」这四类产品必备能力。

### 9) 任务中断机制 — `部分实现`

【事实】
- 有：`AbortController` → `chatStream` 的 `fetch signal`（`App.tsx:593-594`、`api.ts:101`）；
  `stop()` 还能取消挂起的写入批复（`App.tsx:800-805`）；Esc 快捷键（`App.tsx:1141` 只关面板，`Composer` 的 `onStop`）；
- 缺：
  1. `controller.signal` **只传给 fetch**，工具执行 `await executeTool(call)`（`App.tsx:690`）期间**不检查中断**；
  2. 工具之间的循环没有 `if (controller.signal.aborted) break;`；
  3. 中断后不产生"已完成到第 N 轮、已写哪些文件"的可恢复记录。

### 10) 错误重试机制 — `部分实现`

【事实】唯一的重试是测试回路：`testLoopDecision`（`tools.ts:335-339`）+ `App.tsx:731-751`（最多 3 轮后 `give_up`）。
以下场景**均无重试**：网络请求失败（`api.ts:105` 直接 throw）、上游 HTTP 5xx/429（`api.ts:108-110`）、
SSE 中断（`api.ts:149`）、工具执行抛异常（`App.tsx:517-519` 只记录 error 并回传模型）。
无指数退避、无重试预算、无可重试错误分类。

### 11) 任务状态持久化 — `未实现`

【事实】`persist(state)`（`state.ts:31-33`）写的是 `AppState`（会话消息 + 设置）。
Agent run 的运行时状态——`round`、`baseMessages`、`testRounds`、`wroteSomething`、正在执行的工具、
挂起的 `pending` 批复——**全部是 `send()` 的局部变量**（`App.tsx:597-610`），从不落盘。
【事实】进程重启后：消息能恢复（`loadState`），但**运行中的任务不能续跑**，只能靠用户重新发一条消息。

### 12) 上下文压缩 — `未实现`

【事实】唯一的上下文管理是轮数窗口：

```ts
const turns = clamp(Number(settings.contextTurns) || 0, 0, 100);   // state.ts:89
for (const m of sliceContext(usage, turns)) { ... }                  // state.ts:90
```

`sliceContext`（`text.ts:48-53`）按"轮"（每轮 2 条消息）截取，**不做 token 计数**。
【事实】以下系统消息**完全不计入窗口、也无上限**：
- 目录树（最多 300 行，`fsapi.ts:128`）；
- 项目记忆（截断到 8000 字符，`project.ts:14-23`）；
- 技能正文 + 目录清单（`App.tsx:564-566`）；
- 工具说明 `buildToolsPrompt`、计划模式指令（`state.ts:75-86`）。

无摘要、无压缩、无溢出裁剪、无 token 预算。**长会话只会静默丢历史，不会压缩。**

### 13) Plan Mode — `部分实现`

【事实】三层实现都存在：
- 提示词 `buildPlanPrompt()`（`project.ts:33-41`），放在所有系统消息最后（`state.ts:86`）；
- 运行时拦截 `write_file` / `run_command`（`App.tsx:432-435`）；
- 跳过 `file:` 块落盘（`App.tsx:680-682`）。

缺的三件：
1. **无计划产物**：不产出可审阅的 plan 文件/结构化计划对象，只是"这一轮不许写"；
2. **无计划审批**：没有"批准这份计划 → 转入执行"的状态迁移，靠用户手动关掉开关重发（`README §13.1` 承认这一点）；
3. **无持久化**：计划不落盘、不进会话历史的结构化字段。

### 14) Subagents — `未实现`

【事实】全仓搜索无 subagent / delegate / child task 相关代码。工具集中无 `Task` 工具。
【建议】P5 阶段实现前必须先完成 P1 的 Agent Runtime 抽象——没有独立可实例化的 runtime，子代理无从落地。

### 15) Skills — `部分实现`

【事实】自有机制完整可用：
- `SKILL.md` frontmatter 解析（`skill.ts`）、12 份内建技能（`src/skills/builtin/*.md`，`?raw` 导入）；
- 外部目录扫描 + 内建合并 + 同名覆盖（`skillstore.ts`）；
- 触发词自动匹配，上限 3 个、自动匹配上限 2 个（`App.tsx:558-560`）；
- 渐进加载三级：L0 不花 token / L1 正文 + 目录 / L2 `@@ref:` 按需取附件（`App.tsx:388-412`）；
- 危险模式扫描（10 条，只给行号不给分，`skillscan.ts`）。

判"部分"：这是**本项目自定义的规范**，与 Anthropic/Claude Code 的 Skills 规范（含脚本、allowed-tools 元数据）不兼容；
技能**只能注入提示词，不能声明自己的工具权限、不能执行脚本**。

### 16) Hooks — `未实现`

【事实】无 `PreToolUse` / `PostToolUse` / `Stop` 等生命周期钩子；`tools/` 下的 `.cjs` 是外部 e2e 脚本，不是运行时钩子。

### 17) MCP — `未实现`

【事实】无 MCP 客户端、无 server 配置、无 stdio/SSE transport。
【建议】P4 引入时**必须先建立 ADR-0002 的工具权限模型**，否则 MCP 工具会绕过现有白名单（见 SECURITY S13）。

### 18) Git Integration — `部分实现`

【事实】白名单内有 `git status` / `git diff` / `git diff --stat` / `git --version`（`runx.rs:255-274`）。
无提交、分支、stash、PR、blame 等任何写操作或结构化能力，无 diff 解析与 UI 呈现（只在工具日志里截断 500 字符，`MessageList.tsx:73`）。
**且 `git diff` 存在被工程内配置劫持执行任意命令的风险（已实测，见 SECURITY S3）。**

### 19) Project Exploration — `部分实现`

| 手段 | 现状 | 证据 |
|---|---|---|
| 目录树 | 深度 2、忽略 9 类目录、上限 300 行，随每轮请求发送 | `fsapi.ts:123-146`，`files.ts:136-147` |
| `list_dir` | 单层，走 `fs_list_in` 受工程根约束 | `App.tsx:441-448` |
| `search_files` | **字面子串**，深度 3、最多访问 100 个文件、100 条命中 | `App.tsx:449-485` |
| glob / 正则 / 语义搜索 | 无 | — |
| 文件行范围读取 | 无（只能整文件读，4MB 上限） | `fsx.rs:220-238` |

### 20) 自动化测试与调试 — `部分实现`

【事实】写完文件后自动跑 `npm test`，失败回传，最多 3 轮（`App.tsx:717-756`）。
防护到位的地方：`autoTest` **默认关闭**且写成 `=== true`（`App.tsx:719`、`presets.ts:85`），
Rust 侧还会审计 package.json 脚本内容（`runx.rs:190-207`）。
缺：`npm run build` 不进自动回路、无类型检查、无 lint、无测试覆盖率门禁、无断点/单步调试能力。

### 21) Session Resume — `未实现`

【事实】会话（消息数组）可从 localStorage 恢复（`state.ts:16-29`），用户可手动"重新生成"（`App.tsx:808-832`）。
但**运行中的 agent run 无法恢复**——没有 run 记录、没有 checkpoint、没有"上次做到第几步"的呈现。

---

## 3. 能力矩阵与 Claude Code 的差距（面向 14 项目标）

| 目标 | 现状 | 差距性质 |
|---|---|---|
| 1 Autonomous Agent Loop | 部分 | **架构性**：需从 React 组件抽出独立 Runtime |
| 2 Multi-turn Tool Calling | 已实现 | 小：补并行与轮次策略 |
| 3 Project Exploration | 部分 | 中：缺 glob/正则/行范围读取 |
| 4 File Editing and Patch Engine | 部分 | **大**：现在只有"整文件覆盖"，无 diff/patch/搜索替换/多行编辑 |
| 5 Permission and Security System | 部分 | **大**：无工具级权限模型（见 ADR-0002） |
| 6 Context Engineering | 未实现 | **大**：无 token 预算、无压缩、无优先级装配 |
| 7 Plan Mode | 部分 | 中：缺计划产物与审批流 |
| 8 Session Persistence and Resume | 未实现 | **大**：无 run checkpoint（见 ADR-0003） |
| 9 Skills | 部分 | 中：机制可用，需对齐标准与工具权限声明 |
| 10 Hooks | 未实现 | 中 |
| 11 MCP | 未实现 | 中（依赖权限模型先行） |
| 12 Subagents | 未实现 | 大（依赖 Runtime 先行） |
| 13 Git Integration | 部分 | 中（先修 S3 安全缺口） |
| 14 Automated Testing and Debugging | 部分 | 中：回路已通，缺构建验证与覆盖率门禁 |

> 注：第 4 项「Patch Engine」值得单独强调——当前 `write_file` 的语义是**整文件覆盖**（`tools.ts:75`，`fsx.rs:270` `fs::write`），
> 模型必须输出完整文件内容。这对大文件是显著的 token 浪费与出错面，也是与成熟 Coding Agent 最大的体感差距之一。

---

*本文档为 Phase 0 审计产出。所有判定均附源码位置；无证据支撑的结论已标注【待验证】。*
