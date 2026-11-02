# Phase C1-F 整改报告 — F1/F3 落地、F2 复现结论、F4 记录

- 阶段：C1-F（应用内命令最小整改），**未提交**
- 日期：2026-11-02
- 基线：`main` @ `3349cda07b979f86bedf7edb1ade5f675d25e3d7`（P0-2 提交），整改前工作区 13 条 porcelain 条目
- 最终状态：**READY_FOR_C1_FIX_REVIEW**（STOP，等待独立复审；复审通过后才允许 Phase C1-C 本地提交）

> 标记约定：**【事实】**=有代码/实测证据；**【推断】**=基于事实的推论；**【结论】**=本批判定。

---

## 1. 开工前基线复核【事实】

授权书要求"不得假设仓库状态没有变化"，逐项重测：

| 项 | 复核值 | 证据 |
|---|---|---|
| HEAD / 分支 | `3349cda` / `main` | `git rev-parse` / `git branch --show-current` |
| 工作区 | 3 改（App.tsx / presets.ts / types.ts）+ 2 新（appcontrol.ts/test）+ 7 份未跟踪审计文档 + `.tmp-skills/` = 13 条 | `git status --porcelain \| wc -l` = 13 |
| 单测 | 286/286（本会话内 09:26、09:34 两次独立跑） | `npm test` |
| `tsc --noEmit` | exit 0 | 实测 |
| 构建 | 成功，产物 `index-BnGw2Xxy.js` 327.72 kB | `npm run build` |
| P0-1 会话化 | 未回退，`fsRead(ws.sessionId, ...)` 等 17 处 | `grep -c "ws.sessionId" src/App.tsx` |
| R1 | **仍未修复**，`md.ts:46` 为 `^\s*javascript:` 黑名单 | `sed -n '46p' src/lib/md.ts` |
| 远端 | `github/main` 与 `origin/main` 均 = `bd8c37a`，本地领先 4 个提交 | `git rev-list --count` |

补充说明：`git rev-parse --short github/main origin/main` 一次报 `Needed a single revision`，系 `--short` 不接受多 revision 的命令用法问题，非仓库异常；逐个 `git rev-parse --short <ref>` 均正常返回 `bd8c37a`。

## 2. F1｜解析失败不得清空用户输入 — 已修

### 缺陷【事实】

整改前 `App.tsx` 命令分发段的第一条语句就是无条件 `setInput("")`，位置在 `plan.kind === "error"` 判断**之前**，因此 `/plan 也许吧`、`/rm -rf` 这类解析失败既弹错误 toast，又把用户原文抹掉，必须重打。这与 appcontrol.ts 头注释「解析失败只返回错误文本，不改任何状态」的精神不符（settings/会话确实没改，但输入框被改了）。

### 修复【事实】

- 新增纯函数 [src/lib/appcontrol.ts:95-103](file:///F:/zhuomian/zxz/src/lib/appcontrol.ts#L95) `nextInputAfterCommand(prevInput, plan)`：`help` / `toggle` 返回 `""`，其余原样返回 `prevInput`。
- [src/App.tsx:547](file:///F:/zhuomian/zxz/src/App.tsx#L547) 无条件清空改为 `setInput(nextInputAfterCommand(input, plan))`。
- 传入的是**未 trim 的 `input`**（不是 `text`），保证保留时逐字符等于用户所敲。error 分支的 `setInput(同值)` 由 React 自行 bail out，不产生额外渲染。
- `reject_busy` 在 [App.tsx:543](file:///F:/zhuomian/zxz/src/App.tsx#L543) 更早返回，本就不触碰输入，语义与 error 一致（保留原文），故不纳入该函数分支。
- 解析失败路径除 toast 外零状态变更（settings / 会话 / busy / 工作区均未触碰）。

### 回归测试【事实】

新增 5 条（`describe("nextInputAfterCommand（F1 回归：解析失败不吞输入）")`）：

| 用例 | 断言 |
|---|---|
| 解析失败逐字符保留，含首尾空白 | `nextInputAfterCommand("  /plan 也许吧  ", plan) === 原串` |
| 未知命令保留原文 | `/rm -rf` → 原样 |
| 已执行 help/toggle 清空 | → `""` |
| new_session 不在此处清空 | 原样返回（清空由 `createConv()` 负责） |
| passthrough 零影响 | 原样返回 |

## 3. F2｜「斜杠命令经重新生成发给模型」— 【结论】不可达，撤回该发现项

按授权要求先完整还原事件与调用链，再判定，未做任何修改。

### 链路还原【事实】

1. 用户在 busy 期间敲 `/plan 开` → [App.tsx:543](file:///F:/zhuomian/zxz/src/App.tsx#L543) `reject_busy` 直接 return，**输入保留**（整改前后一致）。
2. 生成结束，用户点「重新生成」→ `regenerate()`（[App.tsx:847-871](file:///F:/zhuomian/zxz/src/App.tsx#L847)）：`setInput(prevUser.content)` 后 `await send({ reuseUser: true })`。
3. `send()` 内 `active: !reuse && text.startsWith("/")` ⇒ reuse 时 `active=false` ⇒ `planAppCommand` 返回 `passthrough` ⇒ **命令层不拦截**。这一步与初判一致。
4. **决定性证据**：reuse 路径发给模型的消息内容**不取自 `text`**。[App.tsx:608-611](file:///F:/zhuomian/zxz/src/App.tsx#L608)：
   ```ts
   const userMsg: Message = reuse ? (current as Message) : { role: "user", content: text, ... };
   let baseMessages: Message[] = reuse ? target.messages.slice() : [...target.messages, userMsg];
   ```
   `current` = 会话末尾最后一条用户消息（[App.tsx:588](file:///F:/zhuomian/zxz/src/App.tsx#L588)）。因此输入框里残留的 `/plan 开` 不进入请求体。
5. 另一处细节【推断】：`setInput` 是异步 state，`send` 闭包里的 `input` 仍是本次渲染捕获的旧值——即 `text` 实际就是残留的 `/plan 开`。这加重了「若 reuse 消费 `text` 就会泄漏」的条件，但第 4 步已证明该消费不存在。

### 残留观察（**不属本批，不改**）【事实】

`text` 在 reuse 路径仍有**一处**消费：[App.tsx:595](file:///F:/zhuomian/zxz/src/App.tsx#L595) `const probe = text || lastUser?.content || ""`，用于技能触发词自动匹配。因此输入框残留任何文本（斜杠命令只是其中一种）时，重新生成的技能匹配会用残留文本而非被重生成的原消息。**这是 reuse 路径的既有行为，早于 C1、与 C1 无关**，且不产生权限或执行语义偏差（只影响加载哪个技能）。记录待业主决定是否单独整改。

## 4. F3｜Toast 文案来源统一 + 删除冗余清空 — 已修

- [App.tsx:564](file:///F:/zhuomian/zxz/src/App.tsx#L564) `toast("已新建会话", "")` 改为 `toast(appActionLabel({ kind: "new_session" }), "")`，与 toggle 路径（`plan.label` ← `appActionLabel`）同源。
- 冗余清空已证实并删除：`createConv()` 内部第 167 行本就 `setInput("")`，整改前外层 `setInput("")` 对其纯属重复；现由 `nextInputAfterCommand` 对 `new_session` 返回原值，清空职责单点归属 `createConv()`。
- 新建会话行为零变化：仍走 `createConv()`（含 activeId 切换、滚动信号、焦点信号、窄屏收起侧栏）。
- 测试锁定文案来源：新增 1 条 `appActionLabel({ kind: "new_session" }) === "已新建会话"`，App 侧若再另写一份字符串，清单与本函数会脱节（原「清单与解析不脱节」用例同一思路）。

## 5. F4｜保持不动 — 记录

[appcontrol.ts:86](file:///F:/zhuomian/zxz/src/lib/appcontrol.ts#L86) `if (!parsed) return { kind: "passthrough" }`：

- **不可达性【事实】**：App 传入的 `active` 谓词是 `text.startsWith("/")`，`text` 已 trim；`parseAppCommand` 内部对同一字符串再 trim 后 `startsWith("/")` 仍成立，故 `active=true` 时不可能返回 `null`。
- **保留理由**：该函数是导出的纯 API，独立调用方（后续 C2/V1 语音路径、或未来组件测试）可能传入未 trim 或非命令文本；缺了这层，`parsed` 为 `null` 时会把 `{action}` 解构失败变成运行时异常。成本 1 行，收益是把「解析器与入口谓词的一致性」从调用方约束降为函数内部保证。
- 本批未为其新增用例（不为不可达分支造测试）。

## 6. C1-F 验收门禁【实测】

| 门禁 | 要求 | 实测 |
|---|---|---|
| C1 目标测试 | 全过 | **24/24 PASS**（18 原有 + 6 新增）0.8s |
| 全量 vitest | 全过 | **292/292 PASS**（286 + 6）15 文件，零回归 |
| `tsc --noEmit` | 通过 | **exit 0** |
| `npm run build` | 通过 | **✓ built in 2.05s**，产物 `index-Bepq0bfk.js` 327.80 kB |
| 依赖与 lock | 不变 | `git diff -- package.json package-lock.json` **空** |
| 版本号 | 不变 | package.json 与 tauri.conf.json 均 0.3.0，无 diff |
| R1 代码 | 不触碰 | `git diff --stat -- src/lib/md.ts src/lib/text.ts src/lib/md.test.ts` **空** |
| P0-1 边界 | 不回退 | `ws.sessionId` 命中 17 处不变；`fsRead(ws.root...)` 零命中 |
| A2/C2/P0-4/P1-1 | 不实施 | 未新建 explore/dictation/permission/orchestration 任何文件 |
| push / 远端 | 禁止 | **未执行**，remote refs 未变 |

## 7. 变更清单（本批）

```
 src/App.tsx               40 + / 1 −（整改前 33 + / 1 −；本批净增 7 行 = import 展开 6 + F1 注释 1）
 src/lib/appcontrol.ts     154 行（本批 +10：nextInputAfterCommand 函数 4 行 + 注释 5 行 + 空行 1）
 src/lib/appcontrol.test.ts 172 行（本批 +33：6 条新用例 + 1 个 import）
 src/presets.ts             2 + / 本批未动
 src/types.ts               3 + / 本批未动
```

唯一的删除行仍是 C1 原有的 `if (busyRef.current) return;`（被 plan 门取代），**本批未新增删除**。

未跟踪审计文档由 7 份增至 8 份（本份报告），`git status --porcelain` 条目 13 → 14（差值仅本份报告，无其他新增）。

## 8. 剩余风险（供复审判定）

1. **App 接线未经真机验证**【事实】。F1/F3 的行为证明目前只有两层：纯函数单测 + 代码阅读。真实 UI 里「敲错命令后输入框是否原样留着」需要 CDP 前置——临时把 `--remote-debugging-port` 写进 `tauri.conf.json`、重编、起 exe、跑脚本、再改回重编（README §9 记录的流程）。该流程要改动 tauri.conf.json 并重编，超出本批授权范围，故**未执行**。若复审要求真机证据，请单独授权。
2. `probe` 用 stale `text`（§3 残留观察）——既有缺陷，未修。
3. `/explore` 仍无行为消费方（A2 未实施），但已出现在 `/help` 清单对用户可见；`presets.ts:87` 与 `types.ts:118` 保持惰性字段，README 未写该命令。
4. README 单测数字（`:40` 「150 条」、`:365` 「246 条」）与实际 292 不符，路线图 §P6「tauri.conf.json 0.1.0」已失效——留待文档批次统一修订，本批未动（避免文档先行宣称未实施能力）。

## 9. 状态

- C1-F：**DONE，READY_FOR_C1_FIX_REVIEW**
- C1-C（本地提交）：**未执行**，等复审通过
- R1：**未开工**，等 C1 提交后的新 HEAD 作基线
- 远端：**NOT_PUSHED**，未触碰
