# ZXZGPT1 — Phase 0 项目结构审计

> 阶段性质：**READ-ONLY / AUDIT-ONLY**。本文档只做阅读、搜索、分析与记录，未修改任何业务代码。
> 审计时间：2026-11-01。代码基线：`main` @ `bd8c37a`（工作区另有 16 个文件未提交改动，审计期间未触碰）。
> 结论标注规范：**【事实】**= 可在源码中直接验证；**【推测】**= 基于事实的推断；**【建议】**= 改进方案；**【待验证】**= 证据不足，需实测。

---

## 0. 一句话结论

当前项目是一个**功能相当完整、工程质量中上的"AI 对话外壳 + 初具雏形的 Coding Agent"**，而不是一个 Agent 平台：
它已经打通了「模型流式输出 → 原生 tool_calls → 真实读写磁盘 → 受控跑命令 → 结果回传 → 下一轮」这条主链路，
但**这条链路是写死在 `App.tsx` 一个 React 组件的 `useCallback` 里的 6 次 for 循环**，
缺少独立编排层、权限模型、会话恢复与上下文工程，安全边界存在数个可被链式利用的缺口。

---

## 1. 前端目录结构

【事实】`src/` 共 36 个源文件 + 13 个测试文件，合计 9,485 行 TS/TSX。

| 层 | 文件 | 行数 | 职责 | 证据 |
|---|---|---:|---|---|
| 入口 | `src/main.tsx` | — | 挂载 React | — |
| **编排** | `src/App.tsx` | **1340** | 状态、会话、发送循环、工具执行、工程模式、技能库、导入导出、快捷键、面板渲染 | `App.tsx:63` |
| 类型 | `src/types.ts` | 169 | `Message` / `Settings` / `WireMessage` / `StreamEvent` 等 | `types.ts:18-148` |
| 常量 | `src/presets.ts` | 98 | 8 家服务商预设 + `DEFAULT_SETTINGS` + 欢迎卡片 | `presets.ts:4-86` |
| 存储 | `src/state.ts` | 132 | localStorage 读写、上下文窗口、会话过滤 | `state.ts:14-132` |
| 传输 | `src/api.ts` | 302 | 双通道探测、SSE 手写解析、连接测试、拉模型 | `api.ts:23-302` |
| 渲染 | `src/lib/md.ts` | 228 | 自实现 Markdown → HTML | `md.ts:121` |
| 渲染 | `src/lib/hl.ts` | — | 自实现代码高亮 | — |
| 工具 | `src/lib/text.ts` | 54 | `escapeHtml` / `clamp` / `uid` / `sliceContext` | `text.ts:7-53` |
| 协议 | `src/lib/files.ts` | 217 | `file:` 块 / `@@read:` 解析、`relPathError`、目录树、undo 路径 | `files.ts:32-169` |
| 差异 | `src/lib/diff.ts` | 152 | 行级 LCS diff | — |
| 回滚 | `src/lib/undo.ts` | 130 | 撤销栈快照 / 恢复 | — |
| **工具层** | `src/lib/tools.ts` | 353 | 工具定义 `TOOL_DEFS`、命令白名单、参数校验、流式合并、测试回路决策 | `tools.ts:28-353` |
| 门禁 | `src/lib/pending.ts` | 28 | 写入前确认的待批清单（纯函数） | `pending.ts:18-27` |
| IPC | `src/lib/fsapi.ts` | 146 | Tauri IPC 封装 + `buildTree` | `fsapi.ts:35-146` |
| 技能 | `src/lib/skill.ts` | 396 | SKILL.md 解析、触发词匹配、`@@ref` | — |
| 技能 | `src/lib/skillstore.ts` | 95 | 外部技能目录扫描与合并 | — |
| 技能 | `src/lib/skillscan.ts` | 316 | 危险模式扫描（10 条，只给行号不给分） | — |
| 记忆 | `src/lib/project.ts` | 68 | CLAUDE.md/AGENTS.md 项目记忆 + 计划模式提示词 | `project.ts:11-41` |
| 技能库 | `src/skills/*` | 1049+ | `index.ts`（`?raw` 导入）、`sources.ts`(627)、`audit.ts`(422)、`builtin/*.md` 12 份 | — |
| UI | `src/components/*.tsx` | 14 个 | Sidebar / TopBar / MessageList / Composer / SettingsDrawer / FolderPicker / FileWrites / DiffModal / UndoPanel / SkillChips / SkillPanel / PendingWrites / Welcome / ui | — |
| 样式 | `src/styles.css` | — | 深/浅双主题 | — |

**观察**：`src/lib/` 是干净的一层（纯函数、可单测、不依赖 React），**`App.tsx` 是唯一的编排层且是上帝组件**。

---

## 2. Rust 目录结构

【事实】`src-tauri/src/` 共 6 个文件。

| 文件 | 行数 | 职责 | 关键设计 |
|---|---:|---|---|
| `main.rs` | — | 入口 | — |
| `lib.rs` | 103 | 应用装配 + IPC 命令注册 | `lib.rs:84-103` |
| `fsx.rs` | 481 | 本机文件读写（路径三道校验），**不依赖 tauri**，含 15 个 `#[cfg(test)]` 单测 | `fsx.rs:35-267` |
| `runx.rs` | 552 | 受控命令执行（白名单/超时/进程树），**不依赖 tauri**，含 10 个单测 | `runx.rs:210-552` |
| `proxy.rs` | 383 | 127.0.0.1 回环 HTTP/SSE 代理 + 一次性 token | `proxy.rs:60-302` |
| `api.rs` | 462 | OpenAI 兼容客户端：流式/非流式/连接测试/模型列表 | `api.rs:109-446` |

`Cargo.toml`(1046B) + `tauri.conf.json` + `capabilities/default.json` + `examples/smoke.rs` + `tools/fs-harness/`（用 `#[path]` 复用 `fsx.rs`/`runx.rs` 原文做无窗口单测）。

**这个"核心逻辑不依赖 tauri、可被 harness 直接单测"的切法是正确的架构决策，目标架构应保留。**

---

## 3. Tauri Commands（IPC 面）

【事实】`lib.rs:86-96` 注册 9 条命令，这是前端唯一能触达本机资源的能力面：

| 命令 | 位置 | 参数 | 能力 | 边界 |
|---|---|---|---|---|
| `proxy_info` | `lib.rs:19` | — | 取代理 port + token | 进程内 `OnceLock` |
| `fs_roots` | `lib.rs:38` | — | 列盘符 | — |
| `fs_list` | `lib.rs:43` | `path` | 列**任意绝对路径**一层 | 仅要求绝对路径 |
| `fs_list_in` | `lib.rs:49` | `root, rel` | 工程内列目录 | canonicalize 后须在 root 内 |
| `fs_mkdir` | `lib.rs:55` | `dir, name` | 在任意绝对路径下建一层 | `check_dir_name` |
| `fs_read` | `lib.rs:60` | `root, rel` | 读文件 | **root 任意绝对路径** |
| `fs_exists` | `lib.rs:65` | `root, rel` | 是否存在 | **root 任意** |
| `fs_write` | `lib.rs:70` | `root, rel, content` | 写文件 | **root 任意** |
| `run_allowed` | `lib.rs:79` | `root, argv` | 白名单命令 | **root 任意** + argv 白名单 |

> 【事实】`fs_read` / `fs_write` / `fs_exists` / `run_allowed` 的 `root` 参数**只要求是绝对路径且真实存在**（`fsx.rs:55-61`），
> **没有任何机制把它约束到"用户选中的工程目录"**。工程根边界是**前端调用方的约定**（`App.tsx` 传 `ws.root`），不是 IPC 契约。
> → 详见 `SECURITY_AUDIT.md` S2。

`capabilities/default.json` 只声明 `core:default`；`tauri.conf.json:30` `withGlobalTauri: false`；`tauri.conf.json:28` **`csp: null`**。

---

## 4. 状态管理

【事实】无 Redux/Zustand/Jotai。全部状态在 `App.tsx`：

- 单一 `AppState = { settings, conversations, activeId }`（`types.ts:115`）存 localStorage；
- `useState` + `useRef` 手工双写：`commit()` 同时更新 `stateRef.current` 与 `setState`（`App.tsx:68-77`），
  注释说明动机是"异步流程读不到过期快照"——**这是手写解决 React 闭包陈旧状态的补丁**；
- 另有 **20+ 个独立 `useState`**（transport / ready / keyword / drawerOpen / wsOpen / undoOpen / skillOpen / pending / input / busy / toasts / scrollSignal / focusSignal / skills / skillErrors / skillLoading / collapsed …），`App.tsx:79-103`；
- 持久化：`useEffect` 250ms 防抖 `persist(state)`（`App.tsx:118-127`）。

**问题**：`send()` 在开头把 `settings` 快照到局部 `s`（`App.tsx:534`），循环内不再跟随用户中途改设置；
`send` 的 `useCallback` 依赖数组（`App.tsx:795`）不包含 `state.settings`，只含 `input`/`transport` 等。
【推测】这会导致"发送过程中改设置不生效"的行为不一致，且易产生遗漏依赖的 bug。

---

## 5. 模型 Provider

【事实】**没有 Provider 抽象层**。

- 全部请求走"OpenAI 兼容"单一协议：Rust `api.rs:115` 拼 `{base}/chat/completions`，`api.rs:411` 拼 `{base}/models`；
- `presets.ts:4-63` 的 8 家预设**只是 base URL + 模型名常量**，不含任何协议差异处理；
- `api.rs:290-358` 的事件归一化（`delta` / `reasoning` / `usage` / `error` / `done` / `tool_calls` / `tool_call_delta`）是**事实上的内部协议**，但只被 Rust 与 TS 各实现一遍，无 trait/schema 约束。

【建议】目标架构需引入 `Provider` trait（`chat_stream` / `list_models` / `test`）+ 统一事件枚举，
但**不要替换现有 reqwest + 手写 SSE**，只在上面加一层分发。

---

## 6. API 请求与流式通信

【事实】双通道（`src/api.ts:23-39`）：

```
桌面端：React --fetch SSE--> 127.0.0.1:<19527+> --reqwest--> 上游
浏览器直开：React --fetch--> 上游（降级，受 CORS 限制）
```

- 端口：`BASE_PORT=19527`，向后探测 64 个（`proxy.rs:20-57`）；
- token：`gen_token()` = 纳秒时间 ^ pid 的 xorshift（`proxy.rs:34-46`），**非密码学随机**；
- 鉴权：只校验 `x-zxz-token` 头（`proxy.rs:130-141`），**不校验 Host**；
- 请求体上限 32MB、请求头 64KB（`proxy.rs:23-26`，`read_request` 在读 body 前卡 Content-Length）；
- SSE 解析：**两套独立实现** —— Rust `parse_sse_line`（`api.rs:290`）与 TS `handleLine`（`api.ts:150`）；
- 工具调用：流式 `tool_call_delta` 由 TS 侧 `accumulateToolCallDeltas` 累计（`api.ts:182-189, 237-240`），
  非流式 `tool_calls` 一次下发（`api.rs:248-275`）；Rust 侧只转发片、不拼 JSON（`api.rs:289` 注释）。

**评价【建议】**：双通道是为"浏览器直开也能用"做的合理妥协，但它带来了**两份请求构造 + 两份错误翻译 + 两份 SSE 解析**。
目标架构应保留通道抽象，但把"事件归一化"收敛为一处 schema。

---

## 7. 文件操作

【事实】两条通道，且注释明确要求**不许混用**（`fsapi.ts:63-70`，`CLAUDE.md:27-29`）：

| 通道 | IPC | 参数 | 使用者 | 边界 |
|---|---|---|---|---|
| 选择器通道 | `fs_list` | 任意绝对路径 | 人（FolderPicker） | 无工程限制（设计如此） |
| 工程内通道 | `fs_list_in` | `root + rel` | 模型工具 `list_dir` / `search_files` | canonicalize 后须在 root 内 |

`fsx.rs` 的三道校验（`fsx.rs:35-53, 55-61, 220-276`）：
1. `safe_rel`：拒绝绝对路径、`..`、盘符/根前缀；
2. `canon_root`：root 必须绝对路径且 canonicalize 成功；
3. 落盘前 canonicalize 父目录，确认未借符号链接越界。

另有：读取上限 4MB、仅 UTF-8（`fsx.rs:15, 220-238`）；覆盖前备份到 `.zxz/undo/<时间戳>/`（`files.ts:165-169`，`App.tsx:274-283`）；落盘后回读校验（`App.tsx:287-292`）；目录树深度 2、忽略 9 类目录、上限 300 条（`fsapi.ts:123-146`，`files.ts:136-147`）。

**这一层的设计质量是本项目最强的部分**，但存在悬空符号链接缺口（见 SECURITY S4）。

---

## 8. 命令执行

【事实】`runx.rs`，白名单：`npm test` / `npm run build` / `npm run lint` / `npx vitest run` / `git status` / `git diff` / `git diff --stat` / `--version` 类（`runx.rs:224-276`）。

四层防护：
1. argv 白名单（`is_allowed`，`runx.rs:210`）—— 不走 shell，元字符黑名单（`runx.rs:45-68`）；
2. **package.json 脚本内容审计**（`check_npm_script` / `is_safe_npm_script`，`runx.rs:144-207`）—— 这是本项目最有价值的一处防御，挡住"模型写恶意 package.json 再 npm test"；
3. 60 秒超时 + Windows `taskkill /T /F` 收进程树（`runx.rs:387-427`）；
4. stdout/stderr 各截断 20000 字符（`runx.rs:27, 279-285`）。

**白名单在 `src/lib/tools.ts:142-182` 有一份 TS 镜像**，注释（`tools.ts:4-6`）明确"改一边就要改另一边"。

缺口：`git diff` 可被工程内 `.git/config` + `.gitattributes` 劫持执行任意命令（**已实测确认**，见 SECURITY S3）。

---

## 9. 数据持久化

| 数据 | 位置 | 形式 | 证据 |
|---|---|---|---|
| 会话 / 设置 / **API Key** | WebView localStorage `zxz.state.v1` | 明文 JSON | `state.ts:14, 31-33` |
| undo 快照 | `<工程>/.zxz/undo/<时间戳>/<rel>` | 明文文件 | `files.ts:165-169` |
| 审计清单 / 扫描结果 | `<工程>/.zxz/audit/*.md` 或浏览器下载 | Markdown | `App.tsx:979-1010` |
| 目录树快照 | `settings.workspace.tree`（在 localStorage 里） | 字符串 | `types.ts:78` |

【事实】**无数据库、无 schema 版本、无迁移**。`loadState` 用 `{...DEFAULT_SETTINGS, ...parsed.settings}` 兜底（`state.ts:22`），
但嵌套对象（如 `workspace`）不做字段校验；导入的对话只校验 `Array.isArray(conv.messages)`（`App.tsx:1096`）。

---

## 10. 测试与 CI

【事实】实测 `npm test`（vitest 2.1.9）：**13 个测试文件，246 条，全 PASS**，耗时 9.88s。

覆盖到的模块（`src/**/*.test.ts`）：skillscan(34) / skill(37) / tools(19) / audit(32) / files(28) / state(18) / sources(17) / md(16) / diff(13) / project(7) / text(10) / undo(8) / hl(7)。

**0 覆盖的关键模块**：`App.tsx`(1340 行，含 agent loop 与工具执行)、`api.ts`(SSE 解析)、`lib/fsapi.ts`(IPC)、`lib/pending.ts`、`lib/skillstore.ts`、全部 14 个组件。

`vitest.config.ts`：`environment: "node"`、`include: ["src/**/*.test.ts"]`、`fileParallelism: false`；**无覆盖率阈值**。

CI（`.github/workflows/ci.yml`）两个 job：
- `frontend`：`npm ci` → `npm test` → `npm run build`；
- `rust-fs`：`cargo test --manifest-path tools/fs-harness/Cargo.toml`。

【事实】`tools/` 下 15 个 e2e `.cjs`（直连/代理/工程/技能/真机/护栏边界）**均未接入 CI**，只在人工执行时运行。

**文档与实测不一致**：README §9.6 称"纯逻辑单测 150 条"，实测 246 条。

---

## 11. 依赖方向与循环依赖

【事实】基于 import 语句人工核对（`lib/` 层为 DAG）：

```
App.tsx ──▶ api.ts ──▶ lib/{text, tools}, types
   │
   ├──▶ state.ts ──▶ lib/{files, project, tools, text}, presets
   ├──▶ lib/tools.ts ──▶ lib/files.ts
   ├──▶ lib/fsapi.ts ──▶ lib/files.ts
   ├──▶ lib/{md, hl, diff, undo, pending, skill, skillstore, skillscan, project}
   ├──▶ skills/{index, sources, audit} ──▶ lib/skill
   └──▶ components/* ──▶ lib/*, types
```

**未发现循环依赖。** `lib/` 内部仅两条边：`tools → files`、`fsapi → files`；`skills/ → lib/skill` 单向。

【推测】真正的结构风险不是循环依赖，而是**极度不平衡的扇出**：`App.tsx` 一个文件扇出到 20+ 个模块、扇入为 0，
是唯一的事实编排中心，任何新能力都只能往它里面塞——这正是当前 Agent 能力无法独立测试/复用的根因。

---

## 12. 结构层面的结论

| 项 | 评价 | 依据 |
|---|---|---|
| lib 层纯函数化 + 可单测 | **优秀** | 13 个 `.test.ts` 246 条 |
| fsx/runx 不依赖 tauri + harness 单测 | **优秀，应保留** | `fsx.rs:8`、`runx.rs:14` |
| 命令白名单 + npm 脚本内容审计 | **超出同类项目水位** | `runx.rs:144-207` |
| 双通道抽象 | 合理妥协，但带来双份实现 | `api.ts:79-97` |
| 编排层 | **最大短板**：1340 行 React 组件内的 for 循环 | `App.tsx:601` |
| Provider 抽象 | 缺失 | 仅 OpenAI 兼容一档 |
| IPC 契约 | **安全边界错位**：root 参数不受约束 | `fsx.rs:55-61` |
| 持久化 | 无版本、无迁移、Key 明文 | `state.ts:31` |
| 测试 | 纯逻辑覆盖好，编排/传输/组件 0 覆盖，e2e 不在 CI | `vitest.config.ts` |

---

*本文档为 Phase 0 审计产出，不修改任何业务代码。所有结论均附源码路径，无法验证的部分已标注【待验证】。*
