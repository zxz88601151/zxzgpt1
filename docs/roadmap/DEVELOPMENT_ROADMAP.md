# ZXZGPT1 — 开发路线图（P0 → P6）

> Phase 0 READ-ONLY 审计产出。本文件只做规划，不实施。
> 每项任务含：目标 / 现有代码位置 / 需新增或修改的模块 / 技术方案 / 依赖任务 / 风险 / 测试要求 / 验收标准。
> **执行纪律**：阶段间 STOP，完成一个阶段的验收后再进入下一阶段（沿用项目既有的 Milestone + Gate 习惯）。

---

## 0. 阶段总览

| 阶段 | 主题 | 核心交付 | 前置 |
|---|---|---|---|
| **P0** | 安全与核心基础设施 | 边界（session 化 root、XSS、git 加固、符号链接）+ 权限模型骨架 | — |
| **P1** | Agent Runtime | 编排层从 React 抽出，可测/可中断/可恢复 | P0 |
| **P2** | Coding Agent 核心工具 | 工具注册表、Patch 引擎、项目探索增强、测试回路强化 | P1 |
| **P3** | 上下文、计划与任务恢复 | token 预算 + 压缩、Plan 产物与审批、checkpoint/resume | P1 |
| **P4** | Skills / Hooks / MCP | 技能标准化、生命周期钩子、MCP 客户端（**权限模型之后**） | P2 + P3 |
| **P5** | Subagents | 子代理与任务分解 | P1 + P2（Runtime 可实例化） |
| **P6** | 稳定性与产品化 | 覆盖率门禁、e2e 入 CI、日志/遥测、安装与更新 | P0-P5 |

---

# P0 · 安全与核心基础设施

**阶段目标**：把"边界靠调用方自律"改成"边界由契约保证"，并为所有后续能力装上权限闸门。

---

## P0-1 · 工程会话化（WorkspaceSession）

- **目标**：消除任意 `root` 带来的全盘读写原语（SECURITY S2）。
- **现有代码位置**：`src-tauri/src/lib.rs:60,65,70,79`；`src-tauri/src/fsx.rs:55-61`；`src/lib/fsapi.ts:81-99,114-120`。
- **需新增/修改**：
  - 新增 `src-tauri/src/session.rs`：`WorkspaceSession { id, root: PathBuf, created_at }` + 进程内 `HashMap<String, WorkspaceSession>`；
  - 新增 IPC `ws_open(path) -> sessionId`、`ws_close(sessionId)`、`ws_current() -> Option<SessionInfo>`；
  - 修改 `fs_read/fs_write/fs_exists/fs_list_in/run_allowed` 签名为 `sessionId` + `rel`；
  - `fs_list`（选择器通道）保留绝对路径形态，但标记 `internal`，且**不得被工具路径触达**；
  - 前端 `fsapi.ts` 改为持有 `sessionId`。
- **技术方案**：Rust 侧登记 root 时 canonicalize 一次并缓存；后续每次调用按 id 取 root，找不到即报错。
  不引入新依赖。
- **依赖任务**：无。
- **风险**：
  - IPC 签名变更影响所有调用点（前端 8 处）→ 逐处改 + 契约测试；
  - 会话与 `settings.workspace` 双份状态 → 以 Rust 为准，前端只存展示用的 name/tree。
- **测试要求**：
  - fs-harness：未登记 root → 拒绝；过期 sessionId → 拒绝；`ws_open` 后再 `fs_read` 成功；
  - vitest：`fsapi.ts` 传错 sessionId 抛错。
- **验收标准**：
  1. 前端**没有任何路径**能传任意绝对路径给 `fs_read`/`fs_write`/`run_allowed`；
  2. `grep -rn "fs_write\(" src/` 中所有调用的第二参都是 rel 而非 root；
  3. fs-harness 新增 ≥ 6 条用例全绿。

---

## P0-2 · Markdown 转义与 CSP

- **目标**：关闭存储型 XSS 通道（SECURITY S1、S10）。
- **现有代码位置**：`src/lib/text.ts:7-9`；`src/lib/md.ts:40-46`；`src/components/MessageList.tsx:57,87`；`src-tauri/tauri.conf.json:28`。
- **需新增/修改**：
  - `escapeHtml` 补 `"` → `&quot;`、`'` → `&#39;`；
  - 新增 `escapeAttr()`，**属性插值专用**（URL / alt）；
  - 移除 `md.ts:41` 的 `.replace(/&amp;/g, "&")`（它是绕过转义的后门）；
  - 链接 URL 改为协议白名单 `^(https?:)?//` 或相对路径，其余降级为纯文本；
  - `tauri.conf.json` 配 CSP。
- **技术方案**：纯 TS 改动，不引入 sanitizer 依赖。
- **依赖任务**：无（可与 P0-1 并行）。
- **风险**：属性转义可能影响现有 Markdown 显示（如含引号的链接标题）→ 需补渲染快照用例。
- **测试要求**：
  - vitest 新增 `md.test.ts` 用例：`![a](x" onerror="alert(1))` 的输出**不含** `onerror` 属性；
    `&#x22;` 不会被还原成引号；`javascript:` 仍被拦；正常 https 链接仍渲染。
- **验收标准**：
  1. 上述 4 类用例全绿；
  2. `tauri.conf.json` 的 `csp` 非 null，且 `script-src` 不含 `unsafe-inline`；
  3. 人工验证：消息里发 `![x](y" onerror="alert(1))` 只显示一张坏图，无脚本执行。

---

## P0-3 · 受控执行加固（git / 符号链接 / env）

- **目标**：封堵三条已确认或高概率的边界绕过（SECURITY S3、S4、S8）。
- **现有代码位置**：`src-tauri/src/runx.rs:264-269, 305-315`；`src-tauri/src/fsx.rs:247-276, 260-270`。
- **需新增/修改**：
  - `runx.rs`：git 子命令在 spawn 前**强制注入** `--no-textconv --no-ext-diff`（前端不可控）；
    设置 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`-c core.fsmonitor=false`；
  - `fsx.rs`：`write` 增加路径拒绝清单 `.git/**`（至少 `config`、`hooks/**`、`info/**`）；
  - `fsx.rs`：符号链接检查**移出** `if target.exists()`，改为 `symlink_metadata().is_symlink()` → 拒绝；
    父目录 canonicalize 检查扩展到每一级分量；
  - `runx.rs`：`env_clear()` + 最小环境变量白名单。
- **技术方案**：全部在既有模块内改，无新依赖。
- **依赖任务**：P0-1（先有 session 语义，改签名一次到位）。
- **风险**：
  - `--no-textconv` 会改变 `git diff` 对二进制文件的输出（不再走 textconv）→ 可接受，差异更符合预期；
  - `env_clear()` 可能让 `npm`/`npx` 找不到 `PATH` → 白名单必须含 `PATH`/`SystemRoot`/`APPDATA`/`LOCALAPPDATA`/`USERPROFILE`；
  - 拒绝 `.git/**` 写入会影响"让代理改 git 配置"的合理需求 → 应经审批通道而非静默放行。
- **测试要求**（fs-harness 新增）：
  1. **git 加固用例**：临时仓库写 `.gitattributes` + `.git/config` 的 textconv → `run_allowed` 执行 `git diff`
     **不得**产生 textconv 副作用（可用 temp marker 文件判定）；
  2. **悬空符号链接用例**：temp 目录建指向外部的 symlink → `write` 必须返回错误（Windows 无权限时 `#[ignore]` 并注明）；
  3. **env 用例**：spawn `node -p process.env.X`…（受白名单限制，改为断言 `env_clear` 后 `PATH` 存在、`SECRET_TOKEN` 不存在）。
- **验收标准**：
  1. 三类用例全绿；
  2. `grep -n "no-textconv" src-tauri/src/runx.rs` 有命中且位于 spawn 前；
  3. `grep -n "symlink_metadata" src-tauri/src/fsx.rs` 有命中。

---

## P0-4 · 工具权限模型（骨架）

- **目标**：建立"工具级权限决策点"，先覆盖 `write_file` / `run_command`（SECURITY S7，ADR-0002）。
- **现有代码位置**：`src/App.tsx:419-522`（`executeTool`）；`src/lib/pending.ts`；`src/components/PendingWrites.tsx`；`src/presets.ts:81-85`。
- **需新增/修改**：
  - 新增 `src/lib/permission.ts`：`PermissionLevel`（Read/Write/Exec）、`Policy`、`decide(tool, args, policy) -> Allow|Deny|Ask`；
  - `executeTool` 改为在执行前调用 `decide`，`Ask` 时挂起等 UI；
  - 复用 `PendingWrites` 面板形态，扩成通用 `ApprovalPanel`（显示工具名、参数摘要、风险说明、目标路径）；
  - `Settings` 增 `permissions: { write: "always"|"ask"|"deny", exec: "ask"|"always"|"deny" }`，**默认 `exec: "ask"`**；
  - 审批决策写入审计日志（见 P0-5）。
- **技术方案**：纯 TS + 现有 IPC；权限**判定**在前端做体验拦截，但**执行**仍以 Rust 白名单为准（不改信任模型）。
- **依赖任务**：P0-1。
- **风险**：
  - `exec` 默认 `ask` 会改变现有"自动跑测试"体验 → `autoTest` 已默认关，`run_command` 需明确告知用户；
  - 审批挂起时 UI 与 Runtime 的耦合（P1 重构时要保证 `approve(requestId)` 可用）。
- **测试要求**：vitest 覆盖 `decide` 的全部组合（3 levels × 3 policies）+ 会话级"总是允许"的生命周期。
- **验收标准**：
  1. 开箱默认下，`run_command` 每次触发审批面板；
  2. 用户在面板选"拒绝"→ 工具返回错误文本回传给模型，模型能看到"用户拒绝"；
  3. `decide` 单测 ≥ 12 条全绿。

---

## P0-5 · 凭据与代理加固（可选并行）

- **目标**：SECURITY S5、S6、S10。
- **现有代码位置**：`src/state.ts:31-33`；`src-tauri/src/proxy.rs:34-46, 129-141, 228-229, 287`。
- **需新增/修改**：
  - token 改用 OS 熵（Rust `getrandom`，或 `std::collections::hash_map::RandomState` 之外的 OS RNG）；
  - `handle_conn` 增加 Host 白名单校验（`127.0.0.1` / `localhost` / `[::1]`，含端口变体）；
  - ACAO 改为按 Origin 回显，默认不返回 `*`；
  - API Key 迁到 OS keyring（新依赖 `keyring`，**需单独论证**）；过渡期先做"导出/日志脱敏 + 文档标注"。
- **依赖任务**：无。
- **风险**：引入 `keyring` 是新依赖 → 若不愿引入，降级方案是把 Key 存 Rust 侧受保护文件并加密。
- **测试要求**：proxy-e2e 增加：无 Host → 403；Host 为 `evil.com` → 403；跨站 Origin → 无 ACAO 头。
- **验收标准**：`tools/proxy-e2e.cjs` 新增 3 条断言全绿；`CLAUDE.md:45-47` 的描述与代码一致。

---

## P0-6 · 文档对齐与 e2e 入 CI

- **目标**：TECHNICAL_DEBT D11 + D9 的一部分。
- **现有代码位置**：`README.md §9.6`（150 条 vs 实测 246）；`CLAUDE.md:45-47`；`.github/workflows/ci.yml`。
- **需新增/修改**：README 数字对齐；`CLAUDE.md` 未实现项改为"计划"；CI 增第三个 job 跑不依赖真模型的 e2e
  （`tools/e2e.cjs`、`tools/workspace-e2e.cjs`、`tools/skill-e2e.cjs`）。
- **依赖任务**：无。
- **风险**：e2e 依赖静态服务器/Playwright → 需先确认可在 ubuntu runner 上跑（否则只入 `npm test` 的契约部分）。
- **测试要求**：CI 绿。
- **验收标准**：README 单测条数 == `npm test` 实际条数；CI 三 job 全绿。

### P0 出口条件（Gate）
```
[ ] fs_read/fs_write/run_allowed 只接受 sessionId
[ ] escapeHtml 补齐引号 + 属性走 escapeAttr + CSP 已配
[ ] git 加固 + 符号链接无条件检查 + env_clear 均有 harness 用例覆盖
[ ] run_command 默认触发审批；decide() 单测 ≥ 12 条
[ ] proxy Host 校验生效
[ ] README/CLAUDE.md 与实现一致
[ ] fs-harness + vitest 全绿，CI 三 job 全绿
```

---

# P1 · Agent Runtime

**阶段目标**：把编排从 React 组件搬进独立的、可测的、可中断的 Runtime（ADR-0001）。
**这是全局关键路径**——它之前，Subagents / Resume / CLI / 后台任务都无法落地。

---

## P1-1 · 抽出 AgentRuntime（原样搬运，不改语义）

- **目标**：TECHNICAL_DEBT D1 / D6 / D15；AGENT 能力 1、9。
- **现有代码位置**：`src/App.tsx:526-796`（`send`）、`App.tsx:419-522`（`executeTool`）、`App.tsx:64-77`（ref 双写）。
- **需新增/修改**：
  - 新增 `src/orchestration/agent-runtime.ts`（**不 import react**）：
    `start(input)` / `abort()` / `approve(requestId, decision)` / `subscribe(fn)` / `getSnapshot()`；
  - 新增 `src/orchestration/types.ts`：RunState 状态机、RunEvent、ToolCall、ApprovalRequest；
  - `App.tsx` 改为订阅 runtime 事件渲染，保留 UI 局部状态（drawer/input/panels）；
  - 删除 `stateRef` 手工双写（改用 `useSyncExternalStore`）。
- **技术方案**：**第一步只搬运、不改语义**（轮次 6、测试回路 3、终止判据全部保留），
  确保行为等价；并行分组 / checkpoint 放 P1-2、P3-3。
- **依赖任务**：P0-4（审批接口形状已定）。
- **风险**：**高**。这是核心控制流搬家，回归面大。
  缓解：① 搬运期间保留 `App.tsx` 旧实现的 e2e 作为对照；② 先补"行为等价"单测再切换。
- **测试要求**（`src/orchestration/*.test.ts`，vitest，mock provider + mock tools）：
  1. 无工具调用 → 1 轮后 `done`；
  2. 工具调用 → 结果回传 → 下一轮；
  3. 达到 6 轮上限 → `done{max_rounds}` 并发 toast 事件；
  4. `abort()` 在 awaiting_model 阶段 → `aborted`；
  5. 审批挂起 → `awaiting_approval` → `approve` 后继续；
  6. 测试回路失败 3 轮 → `done{give_up}`；
  7. 上游 error → `failed`。
- **验收标准**：上述 7 类用例全绿；`App.tsx` < 500 行；`grep -n "from \"react\"" src/orchestration/` 无命中。

---

## P1-2 · 中断与并行分组

- **目标**：AGENT 能力 5、9。
- **现有代码位置**：`src/App.tsx:688-692`（串行 for）；`src/App.tsx:593-594`（AbortController 只给 fetch）。
- **需新增/修改**：
  - Runtime 持 `CancellationToken`，每个阶段转换前检查；
  - 工具按 `permission` 分组：`Read` 组 `Promise.all`，`Write`/`Exec` 组串行；
  - `run_command` 与 `write_file` 互斥（避免"边写边跑"）。
- **依赖任务**：P1-1。
- **风险**：并行会让工具结果的**顺序**与模型期望不一致 → 结果按 tool_call_id 归位，不按完成顺序。
- **测试要求**：3 个只读调用被并发（断言完成顺序与提交顺序无关、结果按 id 归位）；
  写 + 写 仍串行；中断发生在工具执行中时能及时返回。
- **验收标准**：并发用例断言并发度 ≥ 2 且结果归位正确；中断用例在 mock 慢工具下 < 500ms 返回。

---

## P1-3 · 统一工具注册表

- **目标**：TECHNICAL_DEBT D3 / D2；AGENT 能力 6、7。
- **现有代码位置**：`src/lib/tools.ts:28-102`（`TOOL_DEFS`）、`185-214`（`validateToolArgs`）、`App.tsx:437-516`（if/else）。
- **需新增/修改**：
  - 新增 `src/orchestration/tool-registry.ts`：`ToolHandler { name, schema, permission, validate, execute, describe }`；
  - `TOOL_DEFS` / `ToolName` / `validateToolArgs` / `buildToolsPrompt` 全部由注册表**反推**；
  - 校验由 schema 驱动（自实现极简校验器，不引入 zod）。
- **依赖任务**：P1-1。
- **风险**：校验器自实现可能不完整 → 只对现有 5 个工具保证等价，逐步扩展。
- **测试要求**：新增一个 mock 工具只需改一处即可出现在 `TOOL_DEFS`/校验/提示词中（用测试断言这三处同步）。
- **验收标准**：`grep -c "call.name ===" src/` == 0；注册表单测 ≥ 10 条。

---

## P1-4 · 白名单单一权威

- **目标**：TECHNICAL_DEBT D2。
- **现有代码位置**：`src/lib/tools.ts:142-182` vs `src-tauri/src/runx.rs:210-277`；`tools.ts:280` vs `runx.rs:151`。
- **需新增/修改**：
  - 新增共享 fixture：`docs/contracts/command-cases.json`（约 40 条 argv → 期望 allow/deny）；
  - vitest 与 fs-harness **各读同一份 fixture** 跑一遍；
  - 前端不再做最终裁决，只做"提前提示"（注释同步修改）。
- **依赖任务**：P1-3。
- **风险**：两边解析器都要能读 JSON → fs-harness 侧用 `serde_json` 读文件（已有依赖）。
- **测试要求**：fixture ≥ 40 条，两边断言一致；故意改错一边 → 该侧测试变红。
- **验收标准**：fixture 存在且两侧测试均引用；`tools.ts` 注释改为"以 Rust 为准"。

### P1 出口条件（Gate）
```
[ ] src/orchestration/ 存在且不 import react
[ ] 7 类编排行为用例 + 并发/中断用例全绿
[ ] App.tsx < 500 行，无 stateRef 手工双写
[ ] 工具注册表生效，if/else 分发消失
[ ] 命令白名单 fixture 双侧共享
```

---

# P2 · Coding Agent 核心工具

**阶段目标**：从"能读写文件"升级为"能像 Coding Agent 一样改代码"。

---

## P2-1 · 工具集扩展（注册表之上）

- **目标**：补齐编辑与探索能力。
- **需新增**：`edit_file`（按 old/new 精确替换，失败即报错，不做模糊匹配）、
  `read_range`（按行范围读）、`glob`（文件名模式匹配）、`grep`（正则搜索）、`delete_file`（**Exec 权限 + 必须审批**）。
- **依赖任务**：P1-3、P0-4。
- **风险**：`edit_file` 的匹配失败回退会导致静默错改 → **明确不做模糊匹配**，失败直接把原文片段回传模型。
- **测试要求**：每个新工具 ≥ 5 条用例（正常/边界/越界/权限/参数错误）。
- **验收标准**：工具数 5 → 10；全工具参数校验由 schema 驱动。

---

## P2-2 · Patch Engine

- **目标**：从"整文件覆盖"升级（当前 `write_file` 语义 = `fs::write` 全量覆盖，`fsx.rs:270`）。
- **现有代码位置**：`src/lib/tools.ts:75-85`；`src-tauri/src/fsx.rs:247-276`；`src/lib/diff.ts`（已有 LCS，可复用）。
- **需新增/修改**：`apply_patch` 工具（统一 diff / search-replace 块），
  落盘前做冲突检测（基线 hash 比对），失败返回精确位置。
- **依赖任务**：P2-1。
- **风险**：patch 格式解析出错会静默写坏文件 → 必须"先 dry-run 生成结果 → 回读校验 → 再提交"。
- **测试要求**：patch 成功/冲突/超出范围/多行/CRLF 各有用例；与 `diff.ts` 的往返一致性。
- **验收标准**：对 200 行以上文件的单行修改，token 消耗相比整文件覆盖下降 ≥ 70%（实测一次）。

---

## P2-3 · 项目探索增强

- **目标**：AGENT 能力 19。
- **现有**：目录树深度 2（`fsapi.ts:123`）、`list_dir` 单层、`search_files` 字面子串深度 3/100 命中（`App.tsx:449-485`）。
- **需新增**：`glob`、`grep`（正则 + 上下文行）、`.gitignore` 感知、敏感文件拒绝清单（SECURITY S9）。
- **依赖任务**：P2-1。
- **风险**：扫描大仓库会拖慢 → 加文件数/时间上限与进度事件。
- **测试要求**：`node_modules`、`.git` 被跳过；`.env` 被拒绝清单拦下。
- **验收标准**：在本仓库自身打开时，搜索 `relPathError` 能在 < 3s 内返回命中且不含 `.env` 类文件。

---

## P2-4 · 测试回路强化

- **目标**：AGENT 能力 20。
- **现有**：`npm test` 最多 3 轮（`App.tsx:717-756`）、`autoTest` 默认关（`presets.ts:85`）、脚本审计在 Rust（`runx.rs:190`）。
- **需新增**：验证链可配置（`test` → `build` → `typecheck`）、覆盖率阈值门禁、失败原因结构化回传（只回传失败用例而非全量日志）。
- **依赖任务**：P1-1、P2-1。
- **风险**：自动改代码循环可能引入回归 → 必须保留"3 轮不过停下报人"的既有纪律。
- **测试要求**：失败回传内容包含失败用例名与断言差异；3 轮上限仍生效。
- **验收标准**：配置 `verifyChain: ["test","build"]` 时，两者按序执行且任一失败即进入修复轮。

### P2 出口条件（Gate）
```
[ ] 工具数 ≥ 10，全部经注册表与权限模型
[ ] apply_patch 可用，大文件修改 token 显著下降
[ ] glob/grep 可用且敏感文件被拦
[ ] 验证链可配置，3 轮上限纪律保留
```

---

# P3 · 上下文、计划与任务恢复

---

## P3-1 · 上下文预算与压缩

- **目标**：AGENT 能力 12（当前"未实现"）。
- **现有**：`state.ts:89-90` 按轮截取；`text.ts:48-53` `sliceContext`；系统消息完全不计入窗口。
- **需新增/修改**：
  - `src/orchestration/context-builder.ts`：预算模型（系统区 / 工具结果区 / 历史区）；
  - token 估算（自实现，按字符数近似，不引入 tokenizer 依赖）；
  - `Compactor`：超预算时对最老的 N 轮做摘要（用一次小请求完成，或本地提取式压缩）；
  - 工具结果按 recency 递减截断。
- **依赖任务**：P1-1。
- **风险**：压缩会丢信息 → 压缩前写 checkpoint（可回溯），并在 UI 标注"已压缩 N 轮"。
- **测试要求**：预算分配用例（系统区超长时如何裁剪）、压缩后仍保留最近 2 轮完整内容。
- **验收标准**：构造 50 轮会话，请求体 token 稳定在预算内且不丢最近 2 轮。

---

## P3-2 · Plan Mode 产物化与审批

- **目标**：AGENT 能力 13（当前"部分实现"：只有开关 + 拦截，无产物、无审批）。
- **现有**：`src/lib/project.ts:33-41` `buildPlanPrompt`；`App.tsx:432-435` 拦截；`App.tsx:680-682` 跳过 file: 块。
- **需新增/修改**：
  - 计划产物：结构化 `Plan { steps: [{file, change, order, risk, unverifiable}] }`；
  - 计划落盘（`<工程>/.zxz/plans/<runId>.md`）与 UI 呈现；
  - "批准这份计划"→ 状态机转入执行态（替代"手动关开关再发一次"）；
  - 计划模式下的工具调用限制白名单化（读放行、写/跑由策略决定，而非硬编码）。
- **依赖任务**：P1-1、P0-4。
- **风险**：计划与执行的对账（模型可能不按计划改）→ 执行后对账并提示偏差。
- **测试要求**：计划模式下 `write_file` 被拒且 UI 显示原因；批准后写入成功。
- **验收标准**：完整走通"提需求 → 出计划 → 人批准 → 执行 → 对账"一次。

---

## P3-3 · Checkpoint 与 Resume（ADR-0003）

- **目标**：AGENT 能力 8、11、21（当前均"未实现"）。
- **现有**：`state.ts:31-33` 只存消息；run 状态全在闭包（`App.tsx:597-610`）。
- **需新增/修改**：
  - `CheckpointStore`：每次状态转换写 `{ runId, state, round, baseMessages, toolRecords, testRounds, pendingApproval }`；
  - 存储位置：Rust 侧（独立于工程目录，防被代理改写）；
  - 启动检测未完成的 run → UI 提示"上次有个任务做到第 N 轮，继续？"；
  - `resume(runId)` 从最近 checkpoint 恢复。
- **依赖任务**：P1-1（Runtime 状态必须外部可读）。
- **风险**：checkpoint 与消息历史不一致 → 以 checkpoint 为准并做校验，冲突时放弃恢复并提示。
- **测试要求**：模拟"做到第 3 轮崩溃"→ restart → resume → 从第 3 轮继续；checkpoint 损坏 → 安全降级。
- **验收标准**：杀掉进程后重开，能恢复并继续；损坏 checkpoint 不导致启动失败。

### P3 出口条件（Gate）
```
[ ] 上下文有预算与压缩，长会话不丢最近内容
[ ] Plan 有产物 + 审批 + 对账
[ ] run 可 checkpoint 与 resume，损坏时安全降级
```

---

# P4 · Skills / Hooks / MCP

> **前置硬约束**：MCP 的接入必须排在 P0-4（权限模型）之后（SECURITY S13）。

---

## P4-1 · Skills 标准化

- **现有**：`src/lib/skill.ts`、`skillstore.ts`、`skillscan.ts`、`src/skills/builtin/*.md`（12 份）；
  触发词匹配、3 个上限、`@@ref` 渐进加载均已可用（AGENT 能力 15 = 部分实现）。
- **需新增**：`allowed-tools` 元数据（技能可声明自己需要的工具权限，交 `PermissionPolicy` 裁决）；
  与 Claude Code Skills 目录布局互认；技能脚本执行（**必须经权限模型**）。
- **测试要求**：技能声明 `allowed-tools: [run_command]` 但策略为 deny → 该技能加载时提示受限。
- **验收标准**：内建 12 份技能全部带 `allowed-tools` 且加载行为不变。

---

## P4-2 · Hooks

- **现有**：无（AGENT 能力 16 = 未实现）。
- **需新增**：`PreToolUse` / `PostToolUse` / `Stop` / `SessionStart` 钩子点；
  配置经审批；钩子运行在**受限环境**（不给予超出工具的权限）。
- **风险**：钩子是新的代码执行面 → 必须经 P0-4 权限模型 + 审计日志。
- **验收标准**：一个示例钩子（如"写文件前打印路径"）可加载、可禁用、失败不阻断主流程。

---

## P4-3 · MCP 客户端

- **现有**：无（AGENT 能力 17 = 未实现）。
- **需新增**：MCP client（stdio + SSE transport）；server 配置与信任分级；
  **MCP 工具必须注册进 `ToolRegistry` 并走同一套 `PermissionPolicy`**。
- **依赖任务**：P0-4、P1-3、P2-1。
- **风险**：**高**。第三方 MCP server 是全新的攻击面：
  ① 必须默认 `Ask`；② server 配置需显式信任；③ 工具描述可能含 prompt injection。
- **测试要求**：未信任 server 的工具不出现在 `TOOL_DEFS`；MCP 工具的越界路径被 session 边界拦下。
- **验收标准**：接入一个只读 MCP server，工具可调用且全部经审批；拒绝未授权 server。

### P4 出口条件（Gate）
```
[ ] Skills 带 allowed-tools 并受策略约束
[ ] Hooks 可用、可禁用、失败不阻断
[ ] MCP 工具经注册表 + 权限模型，默认 Ask
```

---

# P5 · Subagents

- **目标**：AGENT 能力 14。
- **前置**：P1-1（Runtime 必须可实例化多个）。
- **需新增**：`Task` 工具（派生子 Runtime）；子代理上下文隔离（独立消息、可设更小预算）；
  结果汇总；并发上限与取消传播。
- **现有可复用**：`AgentRuntime` 的状态机、`ToolRegistry`、`PermissionPolicy`；
  `src/lib/tools.ts:335` 的 `testLoopDecision` 体现的"轮次预算"思路。
- **风险**：
  - **高**：子代理继承权限 → 必须显式声明子代理权限**小于等于**父级；
  - 并发子代理同时写文件 → 写工具串行化或加文件锁；
  - 成本失控 → 预算上限（轮次 × token）。
- **测试要求**：父级 cancel → 子代理全部停止；子代理越权请求被拒；结果汇总顺序确定。
- **验收标准**：一个"并行探索 3 个目录后汇总"的任务可完成，且子代理无法写文件（当策略为 read-only）。

### P5 出口条件（Gate）
```
[ ] 子代理可派生、可取消、结果可汇总
[ ] 子代理权限 ≤ 父级（有测试证明）
[ ] 并发写冲突被串行化或拒绝
```

---

# P6 · 稳定性与产品化

- **覆盖率门禁**：`vitest.config.ts` 加 `coverage`，关键模块（orchestration / tools / api）设阈值并逐步提高。
- **e2e 入 CI**：把不依赖真模型与真桌面的 e2e 全部接入（P0-6 起步，此处补全）。
- **审计日志与可观测性**：Rust JSONL 审计日志（SECURITY S12）、错误上报开关、性能埋点。
- **契约测试**：Rust ↔ TS 契约类型自动对齐检查（TECHNICAL_DEBT D10）。
- **配置迁移**：`schemaVersion` + 迁移链（D8/D14）。
- **打包与更新**：版本号统一（`package.json` 0.3.0 vs `tauri.conf.json` 0.1.0 **当前不一致**）、
  自动更新通道、卸载清理。
- **文档**：README / CLAUDE.md 与实现的一致性检查进 CI（D11）。

> 【事实】`package.json:4` `"version": "0.3.0"` 与 `src-tauri/tauri.conf.json:4` `"version": "0.1.0"`
> **当前不一致**，应在 P6（或更早）统一。

---

## 附录 · 阶段依赖图

```
P0 ──▶ P1 ──▶ P2 ──▶ P4
 │      │      │
 │      │      └────▶ P5
 │      └────▶ P3 ──▶ P4
 └────────────────────▶ P6（全程穿插）
```

**关键路径**：`P0-1 → P1-1 → P2-1/P3-3 → P4/P5`。
**最应优先投入的单点**：**P1-1（抽出 AgentRuntime）** —— 它解锁的子能力最多，同时风险最高，应尽早开始并配足测试。

---

*本文档为 Phase 0 审计产出的规划，未实施、未修改任何业务代码。*

---

## 2026-11-06 第一轮状态校正（历史留档，数值已被文末第二轮校正覆盖）

> 本路线图的 P3/P4/P5 部分条目已被 11-05 的功能提交超前实现，随后 11-06 又完成
> 队列 ①~⑤。**下表未达成的验收项保持 `[ ]`，已实现项不再重复规划。**
> 当前执行队列与完成度以 `docs/governance/STATE.md` §5 为唯一权威。

| 路线图条目 | 2026-11-06 状态 |
|---|---|
| 上下文压缩 / 并行工具 / Explore 子代理 / 联网搜索 / `glob` / `todo_write` | **已实现**（11-05 批次，独立复审见 `BATCH_20261105_INDEPENDENT_REVIEW.md`） |
| MCP 客户端 + 工具纳管 | **已实现且已收敛权限**：ADR 0004 统一策略视图 + 默认 `Ask` + Rust `guard_mcp` |
| P4-3「MCP 必须注册进 ToolRegistry + 默认 Ask」 | **已达成**（以统一策略视图 `lib/toolpolicy.ts` 的形式，而非把动态工具塞进静态数组，理由见 ADR 0004 D1） |
| P5「父级 cancel → 子代理全部停止」 | **已达成**：`mainSignalRef` + 双重 abort 检查 |
| P1-2「结果按 `tool_call_id` 归位且异常不留空洞」 | **已达成**：`toolFailure` 兜底 + 波内二次补洞 |
| `[ ] App.tsx < 500 行，无 stateRef 手工双写` | **仍为 `[ ]`**：第一轮降到 1296 行、第二轮降到 **1283 行**，手工双写仍在；见台账 D-06 |
| 预览窗口真机 CSP 验证 | **BLOCKED / NOT_TESTED**：`PREVIEW_CSP_HOST_VERIFICATION_20261106.md` |

后续批次建议：① 本轮代码改动的非实施者独立复审（D-27）→ ② 继续拆 `App.tsx` 接线层
→ ③ `schemaVersion` 迁移链（D-07）→ ④ Windows 宿主执行 CSP 清单。

---

## 2026-11-06 第二轮校正（追加，覆盖上文与第一轮校正）

> 执行队列与完成度以 `docs/governance/STATE.md` §5 为唯一权威。

| 路线图条目 | 第二轮状态 |
|---|---|
| P5「父级 cancel → 子代理全部停止」 | **已达成并扩展**：取消贯穿工具批、MCP 审批（call/ask/grant）、压缩请求、轮内落盘与读取；已发起 IO 不可中断属已知边界（D-31） |
| P1-2「结果按 `tool_call_id` 归位且异常不留空洞」 | **已达成并加严**：取消时 `cancelRest()` 补齐回执；serial 层 `undefined` 也兜底；逐 idx 对齐有单测 |
| P4-3「MCP 注册 + 默认 Ask」 | **已达成**（ADR 0004 统一策略视图）；复审 §2 P2-4 的「闸门与执行目标绑定」仍 `HYPOTHESIS`，属待裁定的 Rust 信任模型变更（D-29） |
| 上下文压缩 / 并行工具 / 正则防护 | 已实现；正则防护经三轮独立复核加固至 `PASS` |
| `[ ] App.tsx < 500 行，无 stateRef 手工双写` | **仍为 `[ ]`**：1283 行，手工双写仍在；DEC-020 要求先补组件层 DOM 单测 |
| 存档 `schemaVersion` / 迁移链 | **已实现主体**（D-07 → `PARTIAL`）：v2 + 备份；250ms 写节流未动 |
| 预览窗口真机 CSP 验证 | **BLOCKED / NOT_TESTED**：`PREVIEW_CSP_HOST_VERIFICATION_20261106.md` |

后续批次建议（2026-11-06 第三轮后刷新）：① 在组件层 DOM 回归网上继续拆 JSX（R9）→
② D-25 / D-07 写节流 → ③ D-29 信任模型裁定 → ④ Windows 宿主执行 CSP 清单 →
⑤ 复核归档 §5 的 11 条 P3 → ⑥ ~~推送 16 笔~~ **已完成**（第四轮 17 笔）；打包 / 发布仍需授权。

## 2026-11-06 第三轮校正（追加，覆盖上文与第二轮校正）

| 路线图条目 | 第三轮状态 |
|---|---|
| R15「②③ 代码改动独立复核」 | **已解除（代码级）**：六轮独立复核，第 6 轮 `PASS`；归档 `QUEUE_0203_RECHECK_ROUNDS_2_6_20261106.md` |
| 组件层 DOM 单测（DEC-020 前置） | **已补第一步**：`Welcome` 4 条 + `SkillChips` 5 条，累计 5 个 jsdom 文件 / 23 条 |
| `[ ] App.tsx < 500 行` | **仍为 `[ ]`**：1283 行；本轮未硬拆，下一步可在这张回归网上继续 |
| 存档 `schemaVersion` / 迁移链 | 主体已实现；备份进一步收敛为脱敏二分策略（D-33），250ms 写节流仍未动 |
| 预览窗口真机 CSP / D-29 信任模型 / D-25 | 仍 `BLOCKED` / 待裁定 / 登记下批，均未动代码 |

## 2026-11-06 第四轮校正（追加，覆盖上文与第三轮校正）

| 路线图条目 | 第四轮状态 |
|---|---|
| ⑥ 推送累积提交 | **已完成**：`2083011..cf7cc0e` 共 17 笔推至 `origin/main`，未推送 0 笔；宪章 §3.1 授权已履行 |
| CI 覆盖新提交 | **已覆盖**：CI #24 / `cf7cc0e` = `success`（Actions API 实查）；产品验收签字仍 `ABSENT` |
| 打包 / 发布 | **仍 `NOT_TESTED` / 未授权**，未执行 |
| `[ ] App.tsx < 500 行` / D-25 / D-29 / 真机 CSP / 11 条 P3 | **状态不变**，见第三轮校正与 §5.4 |
