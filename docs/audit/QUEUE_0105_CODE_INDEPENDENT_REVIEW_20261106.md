# 队列 ①~⑤ 代码改动 · 独立复审意见（归档）

日期：2026-11-06　｜　复审者：**QA / Code Reviewer 独立只读子 Agent**（非实施者，独立上下文）
依据：`docs/governance/CHARTER.md` §1「开发结论不构成验收结论」「独立只读子 Agent 不得修改被测代码」
范围：`git diff f24f51c..432895a -- src/ src-tauri/`（队列 ①~⑤ 的已提交代码改动，含新增文件）
复审方式：取得完整 diff 后逐个核查源码与对应单测；**未修改任何文件、未提交**。

> 本意见是独立复核记录，**不是业主验收签字**。产品级 `READY_FOR_ACCEPTANCE` 仍需业主确认。

---

## 1. 总体结论：`PARTIAL`

| 项 | 判定 |
|---|---|
| 可据本复审从 `PARTIAL` 升 `PASS` | ① MCP 统一策略视图与默认 `Ask` 授权闸门（fail-closed、scope 隔离、前后端一致、唯一入口）；② `runToolBatch` 分波下标对齐 / 异常兜底 / expensive 超额回执；③ 子代理取消信号传播（D-17 子代理部分）；④ `App.tsx` hooks 抽离无回归；⑤ 正则 `run` 入口二次校验「生效性」（**不含防护有效性**）；⑥ `toolpolicy` 统一解析 |
| 不可升（阻断） | 取消贯穿（工具层 / MCP / compact）、ReDoS 防护有效性、关键拒绝路径单测覆盖 |

**P1 修复后须重新独立复核**（宪章 §1）。不接受以「开发自测通过」替代上述阻断项。

---

## 2. 问题清单（原文归档）

### P1

**1. 取消未贯穿工具执行层与 MCP 调用**
【`session.ts:148-185,315-318`；`App.tsx:707-719`；`mcp.ts:386-405`】
【证据】`runToolBatch` 无 signal 参数、批内零检查；`stop()` 仅 `abortRef.abort()` + `runCancel`（后者只管 Rust 命令进程）；`executeMcpToolCall` 的 `await opts.ask(...)` 循环不读 signal，MCP `tools/call` 60s 超时不受取消。
【影响】MCP 审批框等待中停止 → Promise 不 resolve → serial 层挂住 → `runRounds` 不返回 → `finally` 不复位 `busyRef`（`App.tsx:697`），UI 死锁；若用户随后点「允许」，工具在已停止状态下仍执行。
【建议】把 `signal` 透传进 `runToolBatch` / `executeMcpToolCall`，`stop()` 补 `answerExec("deny")`，每轮/每次 ask 前查 `aborted`。

**2. `regexsafe` 静态规则存在可复现绕过**
【`regexsafe.ts:18-38,46-55`；`registry.ts:198-203`】
【证据】`(a?)+$` 与 `(a{1,}){1,}$` 均不含括号内的 `*`/`+`、无 `|`、重复位数为 1，故四条规则与量词计数全部放行，`new RegExp` 语法合法；二者等价于 `(a+)+$`，对长行指数回溯。`MAX_TEST_LINE_CHARS=2000` 对指数回溯无效（约 30 字即卡死）。
【影响】DoS 防护可被绕过，渲染进程卡死；`run` 二次校验用的是**同一套** `safeRegExpError`，同样失守。
【建议】补 `\?` / `{m,n}` 等价量词与嵌套分组规则，或改用带步数上限的匹配。

### P2

**3. compact 摘要不接主 signal**【`App.tsx:486-495`；`session.ts:219-229`】`summarizeWindow` 自建 `new AbortController()` 且从不 abort；`maybeCompact` 在轮首 signal 检查之后调用 → 停止后压缩模型请求仍发出/跑完。建议复用 `mainSignalRef.current`。

**4. 闸门与执行目标未绑定；`perm_grant` 无二次确认**【`lib.rs:213-222,293-302`；`mcp.rs:366-369,742`；`perms.rs:145-175`】`session_id` 仅喂 `guard_mcp`，`call_tool(&name,...)` 按全局 `SERVERS[name]` 取进程、不校验 session；授权表按 `session_id` 索引。【影响】`[HYPOTHESIS]` 若已知另一已授权会话 id，可借其授权驱动当前服务器；且任何能 invoke 的 JS 可直接调 `perm_grant` 自授权（沿用 exec 既有模型，**非本次新增**，本次未改善）。建议 `call_tool` 增加 session 绑定校验；明确记录该信任假设。

**5. 新增单测缺关键拒绝/异常路径**【`workspace.test.ts:42-57`；`subagent.test.ts:62-88`；`regexsafe.test.ts:10-25`；`session.parallel.test.ts:132-185`】`applyFileBlocks` 只测空块/非法路径，备份失败阻断、`fsExists` 抛错分治、回读校验均无测试；子代理只测「一开始就 aborted」，未测中途 abort 的第二道保险；`runRounds` 的 `signal.aborted break`（`session.ts:216`）无直接用例；正则未测 `run` 入口集成与上述绕过；时序断言用 `Date.now()` 脆弱。

**6. serial 层无 `undefined` 兜底**【`session.ts:180-183` vs `175-178`】cheap 层 `settled.forEach` 补 `!records[i]`，serial 层直接赋值 `safe()` 结果；相应测试只覆盖 cheap。【影响】`execute` 违约返回 `undefined`（非抛错）时留空洞，`buildMessages` 崩。当前 App 注入的 `executeTool` 不会返回 `undefined`，故实际不触发。建议复用同一兜底。

### P3

**7.**【`mcp.ts:316-330`；`lib/mcp.ts:462-470`】`mcpCallTool` 走裸 `call`，`refused` 回传原始 JSON 而非像 exec 的 `toExecError` 转可读文本；`parseMcpGrantRequired` 的 `ExecGrantRequired` 形态在真实链路不可达（死分支）。建议统一错误通道。

**8.**【`toolpolicy.ts:60-70` vs `session.ts:140-146`】MCP 标 `cost:"expensive"`，但 `classifyBatchTool` 不传 `mcpSpecs` 将其归 `gated`，不受 `MAX_EXPENSIVE_PER_BATCH` 约束（注释称「不进成本预算」，属刻意）。建议对齐注释或分类。

---

## 3. 确认不成立的疑点（避免误报）

| 疑点 | 结论 |
|---|---|
| expensive 超额缺 tool 回执 | **不成立**。`records[idx]={...calls[idx],error}`（`session.ts:155`），`state.ts:132` 对每个 `toolCalls` 展开 `role:"tool"` 且带 `tool_call_id`；三类 idx（waves / serial / skipped）全覆盖，下标对齐 |
| MCP 前后端不一致 / fail-closed 失效 | **不成立**。scope 以 Rust `need_grant` 回传为准，`gate`→`grant`→重试逐 scope 消耗；`guard_mcp` 在唯一 `tools/call` 入口无条件前置 |
| `mainSignalRef` 竞态拿到过期 signal | **当前不成立**。主链路传值 `controller.signal`；`mainSignalRef` 仅用于 `runSubagent`，且必在 send 生命周期内读取。但 `finally` 从不清空它，属遗留隐患 |
| hooks 抽离回归 | **不成立**。`stateRef` 双写未改；两个 hook 依赖数组与原实现逐项一致；`<ConfirmExec>` / `grants` 仍正常消费返回值 |
| 子代理取消传播 | **成立**（chat 包装 + 轮末检查 + 复用主 signal） |
| `registry.ts` run 入口二次校验生效性 | **生效**（重新编译、拒绝已知危险模式），但对 P1-2 的绕过无效 |

---

## 4. 归档后的处置（实施方，非复审方）

| 发现 | 处置 |
|---|---|
| P1-1 / P1-2 | **本轮修复**（①′，控制面 + 安全边界收敛），修完重新独立复核 |
| P2-3 / P2-6 | 本轮顺手修（同一主链路，低风险） |
| P2-5 | 本轮补关键拒绝路径单测 |
| P2-4 | **登记为新技术债，不改 Rust 信任模型**：属架构级裁定，需业主明确授权（参照 ADR 0004 的处理方式） |
| P3-7 / P3-8 | 登记，不扩大本轮范围 |
| ④（预览窗口 CSP） | 仍 `BLOCKED / NOT_TESTED`，Ubuntu 沙箱无 WebView2 |

> 归档人：Project Director（实施方）。**本文件第 2、3 节为独立子 Agent 原文，未作删改。**

---

## 5. 修复后的三轮独立复核（同一 QA/Code Reviewer 只读子 Agent）

| 轮次 | 结论 | 关键发现 |
|---|---|---|
| 第 1 轮（修复前） | `PARTIAL` | 见 §2：P1-1 取消未贯穿工具层/MCP 审批等待、P1-2 正则静态规则可被 `(a?)+$` / `(a{1,}){1,}$` 绕过 |
| 第 2 轮（首轮修复后） | **`FAIL`** | P1-2 实测未关闭：`((a+))+$`、`(?:(a+))+$`、`(((a+)))+$`、`((a{1,}))+$`、`((a|aa))+$` 全判 ALLOW，n=28 >4s 挂死；根因 `lastClosedRisk` 单槽被外层 `)` 的 null 覆盖。P1-1 仍有 `call` / `grant` 挂起与轮内 IO 未复查；`abort.test.ts` 有一条无效断言 |
| 第 3 轮（根因修复后） | **`PASS`** | 风险向父组传播后，**实测 10430 个候选 / 1589 个 ALLOW / n=28 阈值 20ms → 0 SLOW、0 HANG**；指定嵌套组与转义、字符类、`{m,n}`、惰性、lookahead/lookbehind、命名组、4~5 层嵌套变体全被拒；P1-1 前端死锁全路径关闭；spy 断言有效；692 passed / 6 skipped + `tsc --noEmit` 通过 |

**第 3 轮可升 `PASS` 的项**：P1-2（含 fuzz 无穿透）、P1-1 前端死锁全路径、risk 传播修复、spy 断言、692/6 与 `tsc --noEmit`。**仍阻断项：无。**

### 5.1 如实登记的架构限制（非未修 bug）

1. Rust `mcp_call_tool` 的 60s `spawn_blocking` 不可中断；前端已用 `waitAbortable` 不再等它，Rust 侧进程会自己跑完/超时。
2. `Promise.allSettled` 波内**已启动**的 `execute` 不可取消，会跑完并把结果写进 `records`。
3. 已发起的 `writeFiles` / `readFiles` / `readRefs` / `runTest` 不可中断；`readRefs` 位于 `readFiles` 之后，无二次 `stopped()` 复查（同类限制）。

> 复核者全程未修改任何文件、未提交。`npm run build` 因会写 `dist/` 违反只读约束未由复核者复跑，
> 构建结论由实施方实测给出：**94 modules / 371.74 kB / gzip 134.12 kB**。
> 第 3 轮另指出：`compileSearchRegExp` 的断言只验 `not.toBeNull()`，没有「被拒确会灾难 / 放行不灾难」
> 的计时基准——该基准由复核者 /tmp 实测补足，不入库（避免把平台相关的耗时断言写进 CI）。

