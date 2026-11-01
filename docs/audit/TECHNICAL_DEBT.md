# ZXZGPT1 — Phase 0 技术债务审计

> 阶段性质：**READ-ONLY / AUDIT-ONLY**。只记录，不重构、不删文件、不改代码。
> 每项债务给出：证据位置 → 为什么是债 → 影响 → 建议（含"是否值得现在还"）。
> 严重度口径：**高** = 阻塞后续架构演进 / 有正确性或安全风险；**中** = 显著影响效率与可维护性；**低** = 可延后。

---

## 0. 总览

| ID | 债务 | 严重度 | 是否已产生实际后果 |
|---|---|---|---|
| D1 | `App.tsx` 上帝组件（1340 行 / 20+ useState / 内含 agent loop） | **高** | 是：核心控制流 0 测试覆盖 |
| D2 | 命令白名单与 npm 脚本清单双份实现（TS + Rust） | **高** | 潜在：两份已存在漂移风险 |
| D3 | 工具无注册表，if/else 分发，新增工具改 5 处 | **高** | 是：工具集扩展成本线性上升 |
| D4 | SSE 解析与事件归一化两套实现 | 中 | 潜在：协议演化需改两处 |
| D5 | 双通道（proxy/direct）导致请求构造与错误翻译各两份 | 中 | 是：`api.ts:79-97` 分支复杂 |
| D6 | 状态管理：useState + useRef 手工双写，异步快照补丁 | **高** | 是：注释自认"读不到过期快照" |
| D7 | 错误处理风格不统一（中文 Err / 归一化 / 静默 catch 混用） | 中 | 潜在 |
| D8 | 缺运行时类型校验与 schema 版本迁移 | 中 | 潜在：localStorage 结构无演进路径 |
| D9 | 测试覆盖结构失衡（纯 lib 246 条，编排/传输/组件 0） | **高** | 是：e2e 也未接入 CI |
| D10 | 前后端接口契约手工同步（FsEntry / WriteResult / RunResult 各两份） | 中 | 潜在 |
| D11 | 文档与实现不一致（单测条数、token 生成、Host 校验） | 中 | 是：README 150 vs 实测 246 |
| D12 | 工作区混有测试产物目录 | 低 | 否（已 gitignore） |
| D13 | 组件层与 React 模型割裂（dangerouslySetInnerHTML + 事件委托） | 中 | 是：与安全 S1 同源 |
| D14 | 无 i18n / 无配置迁移路径 | 低 | 否 |
| D15 | `settings` 渲染值与 `stateRef` 混用，靠补丁修一致性 | 中 | 是：`App.tsx:982-984` 注释自认 |

---

## D1 · `App.tsx` 上帝组件 【高】

### 证据
- `src/App.tsx` **1340 行**，占前端总行数 14%（1340 / 9485）；
- `App.tsx:79-103`：**20+ 个独立 `useState`**（transport / ready / keyword / drawerOpen / wsOpen / undoOpen /
  skillOpen / skillDirPick / skills / skillErrors / skillLoading / collapsed / pending / input / busy /
  toasts / scrollSignal / focusSignal / state）+ 6 个 `useRef`；
- `App.tsx:63-796` 一个组件内包含：Toast、持久化、主题、通道探测、会话 CRUD、**发送循环（601-787）**、
  **`executeTool`（419-522）**、工程模式、技能库、审计导出、设置、导入导出、快捷键、面板渲染。

### 为什么是债
1. **`send()` 与 `executeTool()` 是本项目最重要的业务逻辑，却在 React 组件闭包里**，
   `vitest.config.ts:8` 的 `include: ["src/**/*.test.ts"]` + `environment: "node"` 使它们**不可能被单测**；
2. 组件卸载即中断 agent run（`useEffect` 清理不涉及循环）；
3. 任何新能力（Plan Mode 增强、Subagent、Hook）都只能继续往这一个文件里塞。

### 影响
- Agent Runtime 无法独立实例化 → 直接阻塞 Subagents（P5）、Session Resume（P3）、CLI/后台任务；
- 改动 `App.tsx` 的回归风险极高，只能靠人工 e2e（且 e2e 不在 CI）。

### 建议
**现在还，且必须在 P1 之前還**（它是后续所有架构演进的前置）：
把 `send()` / `executeTool()` / 测试回路 / 读写轮次 抽成**不依赖 React 的 AgentRuntime 类**，
对外只暴露事件流（`onEvent`）与控制方法（`start` / `abort` / `approve`）。
组件只做"把事件映射成 UI 状态"。详见 `docs/adr/0001-agent-runtime.md`。

---

## D2 · 命令白名单与 npm 脚本清单双份实现 【高】

### 证据
- TS：`src/lib/tools.ts:142-182` `isAllowedCommand`；`tools.ts:280` `SAFE_SCRIPT_SEGMENT`；`tools.ts:294-327` `npmScriptName` / `checkNpmCommandScript`；
- Rust：`src-tauri/src/runx.rs:210-277` `is_allowed`；`runx.rs:151` `ALLOWED`；`runx.rs:167-207` `npm_script_name` / `check_npm_script`；
- 双方注释均明说必须同步：
  - `tools.ts:4-6`："两边的白名单必须保持一致，改一边就要改另一边"；
  - `runx.rs:3`："与前端 `src/lib/tools.ts` 的白名单必须保持一致，改一边就要改另一边"。

### 为什么是债
两份真相 + 靠注释约束 = 迟早漂移。而且**两边的切分逻辑已经不完全等价**：
- `runx.rs:160` 的切分是 `split("&&")` + `split("||")` + `split(';')` 三个独立 `all()`；
- `tools.ts:286` 的切分是 `split(/&&|\|\|[;]/)`（**字符类里放 `;` 是笔误级别的写法**，实际仍按三个字符切，但可读性差且易错）。

### 影响
- 前端"提前拦截"放行、Rust "拒绝" ⇒ 用户体验割裂（前端没报错，用户以为能跑）；
- 反之更危险：前端拒绝、Rust 放行 ⇒ 前端不是安全边界，实际不影响安全，但会造成行为不一致。

### 建议
**P1 还**：确立 Rust 为**唯一权威**；前端不再复制判定逻辑，改为：
- 从 Rust 暴露一个 `tool_policy_check(argv) -> Result<(), String>` IPC 做预检（或启动时下发策略摘要）；
- 或至少补一条**契约测试**：把同一组 argv 用例（约 40 条）在 vitest 与 fs-harness 各跑一遍，
  用 fixture 文件共享断言，漂移即红。

---

## D3 · 工具无注册表，if/else 分发 【高】

### 证据
- 声明：`src/lib/tools.ts:28-102` `TOOL_DEFS`（唯一声明源）；
- 分发：`src/App.tsx:437-516` 五条 `if (call.name === "...")`；
- 校验：`src/lib/tools.ts:185-214` `validateToolArgs` 又一份 if/else；
- 提示词：`src/lib/tools.ts:342-353` `buildToolsPrompt` 用自然语言**再描述一遍**工具与白名单。

新增一个工具要改 **5 处**：`ToolName` 联合类型（`tools.ts:17`）、`TOOL_DEFS`、`validateToolArgs`、
`executeTool` 分支、`buildToolsPrompt` 文案。

### 影响
工具集从 5 个扩到 15 个（路线图 P2/P4 目标）时，遗漏一处即产生"模型能看到但执行不了"或
"能执行但参数没校验"的隐蔽 bug。

### 建议
**P1 还**：改为注册表 ——

```ts
interface ToolHandler {
  name: ToolName;
  schema: JSONSchema;          // 同时用于下发给模型与运行时校验
  permission: PermissionLevel; // read | write | exec
  validate(args: unknown): string | null;
  execute(args, ctx: ToolContext): Promise<ToolResult>;
  describe(): string;          // 由 schema 生成，不再手写自然语言
}
```
`ToolName` 与 `TOOL_DEFS` 从注册表反推，消除重复。

---

## D4 · SSE 解析与事件归一化两套实现 【中】

### 证据
- Rust：`src-tauri/src/api.rs:290-359` `parse_sse_line`，产出 `{delta|reasoning|usage|error|tool_call_delta}`；
- TS：`src/api.ts:150-217` `handleLine`，两套分支（proxy 模式消费 Rust 事件 / direct 模式自己解析上游 delta）；
- 非流式路径又各有一份：`api.rs:248-275` vs `api.ts:132-137`。

### 影响
新增事件类型（如 `tool_progress`、压缩标记、中断信号）要改两处；两边对异常行的容错不一致
（Rust `parse_sse_line` 对解析失败直接返回空 `Vec::new()`，静默丢弃）。

### 建议
**P2 还**：定义唯一事件 schema（TS 侧 `StreamEvent` 已有，见 `types.ts:131-140`），
Rust 侧用 `serde` 枚举对齐并加一条"未知事件"分支显式报错而非静默丢弃；
direct 通道改为"本地也走一遍同一归一化函数"（可把归一化逻辑抽到 TS 一处，proxy 与 direct 共用）。

---

## D5 · 双通道带来的双份实现 【中】

### 证据
`src/api.ts:79-97` 一次请求构造里 `if (transport.mode === "proxy") { ... } else { ... }`；
`testConnection`（`api.ts:248-280`）与 `fetchModels`（`api.ts:282-302`）同样是双分支；
错误翻译：`api.rs:74-95` `describe_upstream` vs `api.ts:46-51` `describeError`。

### 影响
新增请求字段（如 `top_p`、`response_format`、provider 特有参数）要在两条路径各加一次，
极易遗漏 ⇒ 表现为"桌面端能用、浏览器直开不行"或反之。

### 建议
**P2 还，且不应删除双通道**：
- 把"构造请求"抽成单一函数 `buildChatPayload(settings, messages, tools)`，两条通道只负责**发到哪**；
- 错误翻译统一在 Rust 侧完成，direct 通道改为把上游错误映射成同一结构。

---

## D6 · 状态管理手工双写 【高】

### 证据
```ts
// src/App.tsx:67-71
/** 所有写状态都走 commit：ref 与 state 同步更新，异步流程读不到过期快照 */
const commit = useCallback((next: AppState) => {
  stateRef.current = next;
  setState(next);
}, []);
```
另有 `App.tsx:103` `skillsRef`、`App.tsx:101` `busyRef`、`App.tsx:93` `pendingResolveRef`——
**四个 ref 与对应 state 手工同步**。

### 为什么是债
这是**用 ref 手工解决 React 闭包陈旧值问题**的模式。它有效，但：
1. 每加一个异步流程就要加一个 ref，遗漏即产生"读到旧值"的 bug；
2. `send()` 的依赖数组（`App.tsx:795`）不含 `state.settings`，函数内却在开头快照
   `const s = stateRef.current.settings`（`App.tsx:534`）并在整个循环里使用 ——
   **循环中途用户改设置不会生效**，而这是隐式行为，没有注释说明。

### 影响
难以推理的时序 bug；重构时极易破坏。

### 建议
**P1 随 D1 一起还**：AgentRuntime 持有自己的可变状态并对外发事件，
React 侧用 `useSyncExternalStore` 或 `useReducer` 订阅，**不再手工维护 ref 镜像**。
UI 局部状态（drawer 开合、输入框）保留 `useState` 即可。

---

## D7 · 错误处理风格不统一 【中】

### 证据（同一项目内四种风格并存）
1. Rust `Result<T, String>`，错误是**中文面向用户的句子**：`fsx.rs:38,46,58,229,234`；
2. 前端归一化：`fsapi.ts:41-45` `errText`，但 `fsListIn`（`fsapi.ts:68-70`）**没包**，直接抛原始值；
3. 静默吞掉：`App.tsx:247-249` `refreshTree` 的 `catch {}（目录树刷新失败不影响主流程）`；
   `App.tsx:280-282` 备份失败静默；`fsx.rs:99` 权限不足条目直接跳过；
4. 转为用户提示：`App.tsx:313-316` toast 汇总成功/失败/回读不一致三种结果。

### 影响
- 静默失败会导致"以为写了实际没备份"这类可观测性缺口；
- 中文错误串不能被程序分类（无法做"这是权限错误还是路径错误"的分支处理）。

### 建议
**P2 还**：Rust 侧改为结构化错误（`enum FsError { NotFound, Permission, OutsideRoot, TooLarge }` + 展示文案映射）；
前端按 code 分支处理。静默 catch 至少要落到审计日志（S12）。

---

## D8 · 缺运行时类型校验与 schema 版本迁移 【中】

### 证据
- `src/state.ts:16-29` `loadState`：`JSON.parse(raw) as Partial<AppState>`，
  仅 `{...DEFAULT_SETTINGS, ...parsed.settings}` 浅合并，**嵌套对象（`workspace`、`workspace.tree`）不校验**；
- `src/App.tsx:1092-1108` 导入：只判 `Array.isArray(conv.messages)`，消息字段逐个 `String(m.content || "")` 兜底；
- 存储键 `zxz.state.v1`（`state.ts:14`）—— **版本号写死在键名里，没有迁移函数**；
- 前后端契约类型各定义一份：`fsx.rs:18-32` `FsEntry`/`WriteResult` vs `fsapi.ts:8-19`；
  `runx.rs:31-38` `RunResult` vs `fsapi.ts:101-107`。

### 影响
未来给 `Settings` 加必填字段、改 `Workspace` 结构时，老用户的 localStorage 会产出畸形状态；
Rust 改 `FsEntry` 字段而 TS 没跟上 ⇒ 运行时 `undefined`，编译期不报错。

### 建议
**P1-P2 还**：
1. 引入 `schemaVersion` 字段 + 迁移函数链（`v1 -> v2`）；
2. `loadState` 对 `workspace` 等嵌套结构做逐字段校验，失败则降级为 `null` 并提示；
3. 前后端契约改为**从一处生成**（Rust 侧用 `ts-rs`，或在 fs-harness 里加一条"字段对齐"测试）。

---

## D9 · 测试覆盖结构失衡 【高】

### 证据（实测 `npm test`：**13 文件 / 246 条 / 全 PASS**）
覆盖：`skillscan(34)` `skill(37)` `tools(19)` `audit(32)` `files(28)` `state(18)` `sources(17)` `md(16)` `diff(13)` `project(7)` `text(10)` `undo(8)` `hl(7)`。

**0 覆盖**：
| 模块 | 行数 | 说明 |
|---|---:|---|
| `src/App.tsx` | 1340 | **含 agent loop、工具执行、测试回路** |
| `src/api.ts` | 302 | SSE 解析、双通道 |
| `src/lib/fsapi.ts` | 146 | IPC 封装 |
| `src/lib/pending.ts` | 28 | 写入审批清单 |
| `src/lib/skillstore.ts` | 95 | 外部技能扫描 |
| `src/components/*.tsx` | 14 个 | 全部 UI |

- `vitest.config.ts:5-13`：`environment: "node"`、`include: ["src/**/*.test.ts"]`（**不含 `.tsx`**）、无 `coverage` 配置；
- CI（`.github/workflows/ci.yml`）只有 `npm test` + `npm run build` + `cargo test fs-harness`；
  **`tools/` 下 15 个 e2e `.cjs`（含护栏边界用例 `live-tools-edge.cjs`）全部未接入 CI**。

### 影响
最危险的代码（agent loop、工具执行、权限门禁）**恰恰是唯一没有自动化回归网的代码**。
README §14.6 声称护栏"用真模型实跑过 28/28"，但这依赖人工执行，改动后不会自动重跑。

### 建议
**P0-P1 还，优先级很高**：
1. 随 D1 重构，让 agent runtime 可测 → 补编排层单测（轮次终止、中断、审批挂起、测试回路 3 轮上限）；
2. `api.ts` 的 SSE 解析抽成纯函数（`parseSseChunk`），补单测（含半包、跨 chunk、`[DONE]`、malformed）；
3. `vitest.config.ts` 加 `coverage` 与**关键模块阈值**（先设 `App.tsx` 排除，重构后纳入）；
4. 把不依赖真模型的 e2e（`workspace-e2e.cjs`/`skill-e2e.cjs`/`e2e.cjs`）接入 CI 的第三个 job。

---

## D10 · 前后端接口契约手工同步 【中】

### 证据
| 结构 | Rust | TS |
|---|---|---|
| 目录条目 | `fsx.rs:18-24` `FsEntry{name,path,dir,size}` | `fsapi.ts:8-13` `FsEntry{name,path,dir,size}` |
| 写入结果 | `fsx.rs:26-32` `WriteResult{path,bytes,created}` | `fsapi.ts:15-19` `WriteResult{path,bytes,created}` |
| 执行结果 | `runx.rs:31-38` `RunResult{exit_code,stdout,stderr,timed_out,truncated}` | `fsapi.ts:101-107` 同名同构 |

IPC 调用是**位置参数 + 字符串命令名**（`fsapi.ts:57` `invoke("fs_list", {path})`），无版本号、无契约测试。

### 影响
Rust 加字段而 TS 漏 ⇒ `undefined` 静默传播；命令名拼错 ⇒ 运行时才报错。

### 建议
**P2 还**：命令名与参数改为常量表集中定义；加一条"契约测试"：
Rust 侧序列化一个 fixture，TS 侧反序列化并断言字段齐全（或反向）。

---

## D11 · 文档与实现不一致 【中】

### 证据（三处，均为实测可查）
1. **单测条数**：README §9.6 写"纯逻辑单测 150 条"；实测 **246 条**（`npm test` 输出）。
   `CLAUDE.md:58` 明确要求"README 里的数字必须与实际跑出来的结果一致"。
2. **token 生成**：`CLAUDE.md:45-46` 要求"用 OS 熵初始化的 `RandomState` 生成 256 位，
   别退回「时间 ^ pid」那种可预测写法"；`proxy.rs:34-46` **正是时间 ^ pid + xorshift**。
3. **Host 校验**：`CLAUDE.md:46-47` 要求"校验 Host 是回环名，挡 DNS rebinding"；
   `proxy.rs:129-141` **只校验 token，不校验 Host**。

另外 README §14.4 自承"`src-tauri` 本体在本机没有编译过"，§14.5 又记录"已由本机补上"——
同一文档内存在时间线冲突（不影响功能，但说明文档维护节奏跟不上）。

### 影响
`CLAUDE.md` 是本项目的**项目记忆**，会被注入每一轮模型请求（`App.tsx:874`、`state.ts:78-79`）。
**文档声称已实现而代码未实现，会让模型基于错误前提做决策** —— 这在本项目里是功能性影响，不只是文档问题。

### 建议
**P0 立即还（成本极低）**：
1. 把 `CLAUDE.md:45-47` 中未被实现的两条改为"待实现/计划"表述，或直接实现（见 SECURITY S6）；
2. README 的 150 → 246；
3. 在 CI 里加一条断言：README/CLAUDE.md 中出现的单测条数与 `npm test` 实际值一致（简易 grep + vitest json reporter）。

---

## D12 · 工作区混有测试产物目录 【低】

### 证据
根目录存在 5 组测试产物目录：`edgetest-1101-2110/`、`edgetest-1101-2112/`、`tooltest-1101-2031/`、
`webtest-1101-1935|1942|1946|1950/`、`skilltest-1101-1750/`，另有 `.tmp-live/`、`.tmp-ws/`、`.vite/`、`.zxz/`、`.workbuddy/`。
`.gitignore` 已覆盖（`skilltest-*/`、`webtest-*/`、`tooltest-*/`、`edgetest-*`、`tmp-*`）。

### 影响
不入库，但污染工作区视野，且这些目录**会被 `fs_list`/`buildTree` 看到**（未被 `IGNORED_DIRS` 覆盖的是 `skilltest-*` 等），
若把仓库自身作为工程目录打开，代理探索时会扫到测试产物。

### 建议
**低优先级**：约定测试产物统一落在 `.tmp/` 下并加入 `IGNORED_DIRS`（`files.ts:136-147`）。

---

## D13 · 组件层与 React 模型割裂 【中】

### 证据
- `src/components/MessageList.tsx:57, 87` 用 `dangerouslySetInnerHTML` 渲染 Markdown；
- `MessageList.tsx:140-150` 代码块复制按钮**不在 React 树里**，靠 `document.getElementById` + 事件委托实现；
- `md.ts:17` 用 `uid()` 生成 DOM id 来串联按钮与目标。

### 影响
- 与安全 S1 同源（无转义 + 无 CSP）；
- 复制功能依赖 DOM 查询，重构或 SSR/测试环境（node）不可用；
- 无法对消息渲染做组件级单测。

### 建议
**P1-P2 随 S1 一起还**：改为 React 元素渲染（Markdown → React 节点），
复制用受控组件 + `ref`；这同时消除 XSS 面。若保留 HTML 渲染，必须配 sanitizer + CSP。

---

## D14 · 无 i18n / 无配置迁移路径 【低】

### 证据
全部 UI 文案硬编码中文（`App.tsx`、`components/*`）；错误文案也是中文（`fsx.rs`、`runx.rs`）。
`Settings` 无 `schemaVersion`（`types.ts:86-113`）。

### 影响
产品化/出海时需全量替换；结构演进无迁移。

### 建议
**低优先级，P6 处理**：先加 `schemaVersion`（P1 顺手做），文案集中化可放到 P6。

---

## D15 · `settings` 渲染值与 `stateRef` 混用 【中】

### 证据
`src/App.tsx:979-984`，注释自认这是一次补丁：
```ts
// 用渲染时的 settings，而不是 stateRef：界面显示哪个工程，就导到哪个工程，
// 避免首帧（state 还没从本地恢复完）读到空 workspace 而误走下载分支
const ws = settings.workspace;
```
同一组件内其他位置（`App.tsx:236, 422, 678, 874`）用的都是 `stateRef.current.settings.workspace`。

### 影响
**同一份数据两条读取路径**，靠注释区分，极易在后续改动中选错；这正是 D6 的具体表现。

### 建议
**P1 随 D6 一起还**：状态读取统一走单一来源（runtime 快照或 store），消除"渲染值 vs ref"二选一。

---

## 3. 还债顺序建议

| 时机 | 债务 | 理由 |
|---|---|---|
| **P0**（立刻） | D11（文档对齐）、D9 的一部分（e2e 入 CI） | 成本极低，且 D11 会误导模型 |
| **P1** | **D1**（抽 AgentRuntime）、D6、D15、D3（工具注册表）、D2（白名单单一权威）、D8（schema 版本）、D13（随 XSS 修复） | 这几项互为前置，做完才有"可测、可扩展"的地基 |
| **P2** | D4、D5、D7、D10、D9 剩余（覆盖率阈值 + 契约测试） | 提升工程质量，不阻塞功能 |
| **P6** | D12、D14 | 产品化收尾 |

**不要现在还的**：不要为了"架构先进"引入 Redux/Zustand/EventBus 框架——
D1/D6 的正确解法是把**编排**移出 React，UI 局部状态用 `useState` 完全够用；
也不建议引入 zod 等新依赖（D8 可用自实现校验解决）。

---

*本文档为 Phase 0 审计产出。所有债务均附源码位置，未做任何代码修改。*
