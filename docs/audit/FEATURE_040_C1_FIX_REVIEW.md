# C1-F 独立复审报告 — 输入保留整改准入判定

- 阶段：C1-F-R（独立复审，**严格只读**）
- 日期：2026-11-02
- 角色：Independent Reviewer（代码安全 + TS/Rust 复核 + 准入判定）
- 审查对象：`docs/audit/FEATURE_040_C1_FIX_REPORT.md` 所述的 C1-F 最小整改
- 最终状态：**PASS_WITH_CONDITIONS** ／ 提交门禁结论：**READY_FOR_C1_LOCAL_COMMIT（附条件）**

> 标记约定：**【事实】**=本次实测/读码证据；**【推断】**=基于事实的推论；**【结论】**=判定。
> 本报告所有行号均以当前源码为准重新核对，未沿用被审报告的读数。

## 0. 审查范围与只读声明【事实】

本阶段执行的动作：Read/Grep/Glob 读取；只读 git 命令（`status` `diff` `show` `rev-parse` `rev-list` `cat-file` `log`）；`vitest`、`tsc --noEmit`、`npm run build`（项目自带脚本）；一次**项目外**临时目录内的 esbuild 内存探针。

本阶段**未执行**：任何源文件/测试/配置/文档修改、`git add`/`commit`/`push`、远端与分支/tag 变更、`tauri.conf.json` 改动、重编启动真机流程、F2 残留与 F4 的顺手修复、R1/A2/C2/P0-4/P1-1 实施、产物清理。

唯一新增文件＝本报告本身（授权 §10 要求交付物）。源码/配置类工作区条目在审查前后**完全同一集合**（3 改 + 2 新代码 + `.tmp-skills/` + 8 份文档）；porcelain 总条目因本报告落盘由 14 → 15。暂存区恒为空，`HEAD` 与两个远端 ref 恒未变。

## 1. 独立基线确认【事实】

| 项 | 复核值 | 与报告是否一致 |
|---|---|---|
| `git rev-parse HEAD` | `3349cda07b979f86bedf7edb1ade5f675d25e3d7` | 一致 |
| 分支 | `main` | 一致 |
| `git diff --cached --stat` | 空（暂存区无内容） | 一致 |
| `git diff --stat` | `App.tsx 41`、`presets.ts 2`、`types.ts 3` ＝ **45 insertions / 1 deletion** | 一致（`--stat` 的 41 是 40+1 的合计，报告写 40+/1−，口径相同） |
| 唯一删除行 | `      if (busyRef.current) return;` | 一致 |
| 改动块位置 | `git diff -U0` hunk 头仅三处：`@@ -24,0 +25,7 @@`（import）、`@@ -528 +534,0 @@`、`@@ -533,0 +540,33 @@`（send 头部） | **一致，且据此证明工程层/IPC 层零接触** |
| R1 文件 | `git diff --stat -- md.ts text.ts md.test.ts text.test.ts` 空 | 一致，R1 仍未修（`md.ts:46` 实读为 `^\s*javascript:` 黑名单） |
| 依赖与版本 | `git diff -- package.json package-lock.json src-tauri/tauri.conf.json` 空；两处 version 实读均 `0.3.0` | 一致 |
| 远端 | `github/main = bd8c37a`、`origin/main = bd8c37a`，本地领先 4 | 一致，未推送 |
| 工作区条目 | 14（3 改 + 2 新代码 + **8 份未跟踪文档** + `.tmp-skills/`） | **报告计数口径有误，见 §9 D1** |
| `git lfs ls-files` | 空；src/ 无 LFS 指针 | 一致（status 提示源于全局 `filter.lfs.*` 与 `core.autocrlf=input`） |

**基线判定：一致，无未报告改动，无暂存内容，功能复审继续进行。** 唯二偏差是报告自身的文档计数（D1）与 `git rev-parse --short <两个ref>` 的命令用法（非仓库异常，逐个 `rev-parse` 正常）。

审查时源码指纹（供 C1-C 提交时证明「复审后未再改动」）：
```
20eb4c1f7be50922c1642b24a251bb0e  src/App.tsx
f33a2a7034ab2a83b997e6caf4ee801b  src/lib/appcontrol.ts
7045c4f2fe15cf979438bba32ae4ca57  src/lib/appcontrol.test.ts
```

## 2. F1-A 输入决策函数逐项【事实】

函数现位 [src/lib/appcontrol.ts:95-103](file:///F:/zhuomian/zxz/src/lib/appcontrol.ts#L95)（注释 95-99，函数体 100-103；整改报告 §2 引用的即此区间，已核对一致）。

| 检查点 | 结论 | 证据 |
|---|---|---|
| 是否完整保留原始输入 | 是。`return prevInput` 原样返回，无 `trim`、无 `replace`、无大小写或空白规范化 | 函数体仅两行 |
| 是否意外 trim | 否。**[App.tsx:547](file:///F:/zhuomian/zxz/src/App.tsx#L547) 传的是 `input`（未 trim），不是第 536 行的 `text`** | 读码 |
| 解析失败/未知命令是否保留 | 是，穷尽验证见 §2.1 | 内存探针 |
| help/toggle 是否清空 | 是，二者返回 `""` | L101 |
| `new_session` 是否避免重复清空 | 是，返回 `prevInput`；清空归 `createConv()`（[App.tsx:167](file:///F:/zhuomian/zxz/src/App.tsx#L167) `setInput("")`） | 读码 |
| passthrough 语义 | 返回原值；且 App 以 `plan.kind !== "passthrough"` 为门，普通消息根本不调用此函数，原有 627 行清空路径不变 | 读码 |
| 未覆盖 plan 类型/默认分支 | `AppCommandPlan` 共 6 个 kind（L73-79）。函数显式处理 2 个，其余 4 个（`error`/`new_session`/`passthrough`/`reject_busy`）落入返回原值的兜底。**兜底方向是「保留用户输入」，未来新增 kind 默认为安全侧** | 类型定义 + 函数体 |
| `reject_busy` 是否经此函数 | 不经：[App.tsx:543](file:///F:/zhuomian/zxz/src/App.tsx#L543) 先于分发返回，语义同为保留原文，与注释 L99 声明一致 | 读码 |

### 2.1 超出被审报告用例集的穷尽验证【事实】

被审报告只有 2 条 error 用例。本复审在**项目外临时目录**（`/tmp/tmp.*`，运行后已删除）用 esbuild 把 `appcontrol.ts` 内存打包后实测 11 条错误路径 × （带首尾空白的同一输入）：

```
输入："/", "/   ", "/plan", "/plan yes", "/plan 开 关", "/rm -rf",
      "/help foo", "/new foo", "/PLAN 开", "/写入确认", "/explore 随便"
结果：11/11 plan.kind === "error" 且 nextInputAfterCommand(带空白原文) === 该原文（逐字符，失败 0）
执行路径：/help → ""；/plan 开 → ""；/工具 关 → ""；"  /new  " → 原样
busy 语义 → reject_busy ；reuse 语义(active=false) → passthrough
appActionLabel({kind:"new_session"}) → "已新建会话"
probe exit=0；临时目录已 rm -rf；项目文件与 package-lock 探针后零变更（已复验）
```

**【结论】F1-A 通过。** 决策函数无输入篡改路径，错误兜底覆盖全部错误类别。

## 3. F1-B 调用接线逐项【事实】

| 检查点 | 结论 | 证据 |
|---|---|---|
| `setInput` 是否只在需要时执行 | 命令分发段仅 [App.tsx:547](file:///F:/zhuomian/zxz/src/App.tsx#L547) 一处 `setInput`，其值由决策函数给出；error/new_session 传入同值，React 对同值 `setState` bail out，不改状态 | 读码 + hunk 位置 |
| 是否存在其他无条件清空路径 | 全文件 `setInput` 共 5 处：L101（声明）、L167（createConv 清空，命令依赖它）、L547（本批决策）、L627（**普通消息路径**，passthrough 才可达，原有行为）、L867（regenerate 回填原文）；另有 L1284 `onChip` 是**赋值**不是清空 | grep 全量清点 |
| 闭包/异步/重渲染覆盖风险 | 【推断，可接受】`send` 为 `useCallback`，`input` 取本次渲染闭包值。error 路径在 `setInput` 前无任何改 `input` 的动作，故「同值写回」等价于不写；不存在被异步覆盖的窗口。`regenerate()` 里 `setInput(prevUser.content)` 后紧接 `await send({reuseUser:true})` 时闭包 `text` 仍是旧值——这是 §4 残留观察的根源，与本批无关 | 读码：App.tsx:847-871 与 534-547 |
| 是否改变普通消息发送行为 | 否。`active` 谓词与 `passthrough` 分支未动，L627 清空、L628 滚动、L629-630 busy 置位均在原位置 | hunk 仅三处 |
| Composer 是否配合（**关键**） | **[src/components/Composer.tsx](file:///F:/zhuomian/zxz/src/components/Composer.tsx) 是完全受控组件**：props `value`/`onChange`（L5-7、L48-49），提交只调 `onSend()`（L39、L53），组件内**无任何本地文本 state、无自清空**。故「App 不清空 ⇒ 输入框原样留着」在结构上成立 | 读码 71 行全文关键段 |

**【结论】F1-B 通过。** 报告 §8 风险 1 所述「接线未实测」的缺口，被「受控组件 + 同值 setState」两层静态证据大幅压缩（裁定见 §8）。

## 4. F2 撤回结论复核【事实】

独立还原 reuse 链路，逐点核到当前源码：

1. `regenerate()`（[App.tsx:847-871](file:///F:/zhuomian/zxz/src/App.tsx#L847)）：校验 `visible.length>=2`、末条 assistant、倒数第二条 user；截断消息；`setInput(prevUser.content)`（L867）；`await send({ reuseUser: true })`（L870）。
2. `send()` 内 `active = !reuse && ...` ⇒ reuse 时 `planAppCommand` 返回 `passthrough`（探针实测 `active:false → passthrough`），命令层不拦截。
3. **决定性证据**：送给模型的用户消息内容**不取自 `text`**——[App.tsx:608-611](file:///F:/zhuomian/zxz/src/App.tsx#L608)：
   `userMsg = reuse ? (current as Message) : { role:"user", content: text, ... }`，`current` 即会话末尾用户消息（L588）；`baseMessages = reuse ? target.messages.slice() : [...]`。
4. 该形状**并非本批引入**：`git show HEAD:src/App.tsx` 第 569-571 行为同一表达式，`probe`（HEAD:556）与 `titleFrom`（HEAD:580）同样存在于 HEAD。

`text` 在 send() 内的全部消费点（awk 穷尽 L534-845）：536 定义、538 空值守卫、542 命令入口、595 `probe`、610 非 reuse 分支、619 `titleFrom`、687/690 是 SSE `evt.text`（同名不同物）。

**新发现（本复审补充，报告 §3 未列）**：`text` 的第二处 reuse 路径消费是 [App.tsx:619](file:///F:/zhuomian/zxz/src/App.tsx#L619) `title: c.title === "新对话" || !c.title ? titleFrom(text) : c.title`——残留输入可能参与**会话标题**推导。可达性【推断】：需同时满足「标题仍为 新对话/空」＋「该会话已有 ≥2 可见消息」＋「重新生成时输入框有残留」，而首条消息发送即已定标题，条件极窄，且只影响一个显示用字符串。

**分级：OBSERVATION / PRE-EXISTING / NON-BLOCKING，不要求修改。**
【结论】F2 撤回成立：斜杠命令不会作为消息内容发给模型；`probe`（技能匹配）与 `titleFrom`（标题）**均未与最终模型消息混淆**。未发现可复现的权限绕过或消息内容污染，不升级阻塞项。

## 5. F3 逐项【事实】

| 检查点 | 结论 |
|---|---|
| `appActionLabel` 覆盖新建会话 | 是，L145 分支返回 `"已新建会话"`；探针直接打印实测值与整改前硬编码字符串**逐字符相同** ⇒ Toast 文案等价 |
| 单一来源 | [App.tsx:564](file:///F:/zhuomian/zxz/src/App.tsx#L564) 走 `appActionLabel({kind:"new_session"})`，与 toggle 路径的 `plan.label`（由同一函数生成，L92）同源；测试 L62 锁定该字符串，防再次分叉 |
| `createConv()` 内部清空仍在 | 是，[App.tsx:167](file:///F:/zhuomian/zxz/src/App.tsx#L167) `setInput("")`（整改前该行为 L161，本批因 import 展开下移 6 行，非新增逻辑） |
| 删除冗余清空是否引入行为差异 | 无。顺序为 L547 `setInput(同值)` →（no-op）→ L563 `createConv()` → 其内部 L167 清空；净效果与整改前「外层清一次 + 内层清一次」相同 |
| `new_session` 返回原值是否符合状态机 | 符合。计划层只决定「命令执行后文本框归属」，会话创建副作用归 `createConv`，职责单点，注释 L98 已写明 |
| 是否影响其他分支 | 未影响：help 仍走 `appendAssistantMessage` + `plan.message`；toggle 仍 `withToggleApplied` + `plan.label`；两者仍清空输入 |
| 是否越界改动 | 未越界：本批 F3 相关仅 1 行 toast 来源 + import 展开，无风格性重构 |

**【结论】F3 通过。**

## 6. F4 保留理由核验【事实/推断】

- 分支仍在：[appcontrol.ts:86](file:///F:/zhuomian/zxz/src/lib/appcontrol.ts#L86) `if (!parsed) return { kind: "passthrough" }`，未被删除。
- 不可达性核验：App 的 `active` 谓词是 `text.startsWith("/")` 且 `text` 已 trim；`parseAppCommand` 对**同一字符串**再 trim 后判断，trim 幂等 ⇒ `active=true` 时不可能返回 `null`。报告论断成立【事实】。
- 保留理由核验：`planAppCommand` 是导出 API，独立调用方传未 trim/非命令文本时该分支即必要兜底；缺它则 L88 `"error" in parsed` 对 `null` 取属性会抛运行时异常。成本 1 行，方向为安全侧。**合理，不要求删除，不要求为此造测试。**

## 7. P0-1 安全边界核验【事实】

前端 IPC 通道穷尽清点（[src/lib/fsapi.ts](file:///F:/zhuomian/zxz/src/lib/fsapi.ts)）：

| 通道 | 参数 | 性质 |
|---|---|---|
| `fs_list_in` L136 / `fs_read` L149 / `fs_exists` L154 / `fs_write` L162 / `run_allowed` L184 | **`sessionId` + `rel`** | 模型工具通道，P0-1 语义完整 |
| `ws_open` L71 | `root`（登记一次，返回 session） | 注册通道 |
| `fs_list` L124 / `fs_mkdir` L142 / `fs_roots` L116 | 绝对 `path`/`dir` | 文件夹选择器通道，非工具路径；本批未触碰 |

Rust 侧注册命令（[lib.rs:128-141](file:///F:/zhuomian/zxz/src-tauri/src/lib.rs#L128)）与上表一一对应，无新增。

- `ws.root` 全仓命中仅 4 处：`App.tsx:889`（`openSession(ws.root)` 登记）、`894`/`942`（前端展示态字段）、`state.ts:67`（`buildWorkspacePrompt` 提示词文本）——**无一进入读/写 IPC**。
- `fsRead(ws.root` / `fsWrite(root` 零命中；`ws.sessionId` 在 App.tsx 命中 17 处，与整改前一致。
- 本批 diff hunk 仅位于 `App.tsx:25`（import）与 `528-573`（send 头部），**工程层与 IPC 层无一行改动**。

**【结论】P0-1 边界完整保留，未通过任何其他路径恢复任意绝对路径访问能力。**（`fs_mkdir` 的绝对 `dir` 属 P0-1 既有设计面，本批未变，不在本次审查范围，也不构成回退。）

## 8. 真机证据缺口裁定【结论】

| 问题 | 裁定 |
|---|---|
| 纯函数测试是否足以验证**输入决策逻辑** | **足够**。逻辑本身是纯函数，且本复审用 §2.1 探针把覆盖从 2 条扩到 11 条错误路径 + 4 条执行路径，逐字符断言，无外部依赖 |
| 源码审查是否足以验证**调用接线** | **基本足够**，理由具体：Composer 是完全受控组件（`value={value}`、提交只 `onSend()`、无本地 state、无自清空），故输入框显示值恒等于 App 的 `input`；全仓 `setInput` 5 处已穷尽清点并归类；error 路径写入同值由 React bail out 保证零状态变更。**这不是「靠单测代替真机」，而是 UI 状态单点可控下的结构推断** |
| 缺口具体剩什么 | ① 真实 WebView2 中经键盘/输入法（IME 组合态）敲入 `/plan 也许吧` 后的可见行为；② 同值 `setInput` 在真实渲染中的无副作用表现；③ Toast 与输入框同时出现的视觉结果 |
| 是否构成本地提交的阻塞 | **不阻塞**。本地 commit 可逆、不外发，且上述结构证据已覆盖失败模式的主体；把它设为阻塞会让「改 5 行」的批次无限期挂起 |
| 是否应保留为发布前条件 | **应当**。真机验证需要临时改 `tauri.conf.json` 的 `additionalBrowserArgs` + 重编（README §9 流程），属配置变更，须单独授权。**建议记为：C1 所在版本发布/推送前必须完成一次真机验证**，与「远端未推送」门禁并列 |

措辞纪律：本报告未将「未实测」写作「实测失败」，也未将「单测通过」表述为「真机通过」。

## 9. 问题分级与修复建议

| 编号 | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| **D1** | MINOR（拟提交文档事实性错误） | FIX_REPORT §1 基线表「8 未跟踪文档」与 §7「由 8 份增至 9 份」 | 实际：本批整改**前**未跟踪审计文档为 **7 份**，含 FIX_REPORT 本身为 **8 份**；`13 条 porcelain = 3 改 + 2 新代码 + 7 文档 + .tmp-skills/`，报告把 `.tmp-skills/` 计入文档数导致口径差 1（授权书 §2「8 个未跟踪审计文档」沿用了同一误读） | 提交前用 2 行改回 7/8 两处计数。**本阶段只读，未自行修改**；请业主在提交授权中一并带上该文档修正，或明确接受先提交后单独修订 |
| O1 | OBSERVATION / PRE-EXISTING / NON-BLOCKING | [App.tsx:595](file:///F:/zhuomian/zxz/src/App.tsx#L595) `probe = text \|\| lastUser?.content` | reuse 时技能触发词用残留输入匹配（HEAD:556 即存在） | 不要求修改；若要整改应单独批次 |
| O2 | OBSERVATION / PRE-EXISTING / NON-BLOCKING（本复审新增） | [App.tsx:619](file:///F:/zhuomian/zxz/src/App.tsx#L619) `titleFrom(text)` | reuse 时残留输入可参与会话标题推导，条件极窄（HEAD:580 即存在） | 不要求修改；建议 O1/O2 合并为一个「reuse 路径 stale text」技术债条目 |
| O3 | OBSERVATION / TEST-DESIGN | [appcontrol.test.ts:90](file:///F:/zhuomian/zxz/src/lib/appcontrol.test.ts#L90) `passthrough 保留原文` | 该用例在 App 实际流程中不可达（被 `kind !== "passthrough"` 门挡住），属契约文档型测试 | 保留即可，无副作用；与 F4 同类处理 |
| O4 | **RETRACTED（本复审误判）** | FIX_REPORT 行号引用 | 我初判整改报告三处引用已漂移，复核后**不成立**：报告现值为 `appcontrol.ts:95-103`、`App.tsx 第 167 行`、`appcontrol.ts:86`，与当前源码逐一对齐（被整改批在写完后已自查修正过） | 无需处理；记录误判过程，避免后续复审沿用「行号漂移」的错误结论 |

**无阻塞项**：未发现新增高风险问题、无权限绕过、无回归、无越界改动。

## 10. 独立验证结果【事实】

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npx vitest run src/lib/appcontrol.test.ts` | 0 | **24 passed (24)**，1 文件，772ms（09:46:47） |
| 2 | `npm test` | 0 | **292 passed (292)**，15 文件，9.94s（09:46:55），零失败零跳过 |
| 3 | `npx tsc --noEmit` | **0** | 无输出，0 错误 |
| 4 | `npm run build` | 0 | `✓ built in 2.11s`；`index-Bepq0bfk.js` 327.80 kB / gzip 118.72 kB；CSS 36.49 kB |
| 5 | `md5sum dist/assets/index-*.js` | — | `404564022baa6b93e8edef76e1117f30` **与审查前基线逐字节相同** ⇒ 构建确定性复现，且 `dist/` 与本批源码一致（非陈旧产物） |

工作区副作用记录（未清理，按要求保留）：`npm run build` 重写 `dist/`（gitignore 内，产物 md5 未变，仅 mtime）；`npx vitest` 未落盘；esbuild 探针输出写在**项目外** `/tmp/tmp.l5ZJZAXbbF`，探针结束后已 `rm -rf`，`package.json`/`package-lock.json` 在探针后复验为空 diff。审查结束时 `git status --short` ＝ 15 条（14 条原集合 + 本报告），暂存区仍空、`HEAD=3349cda`、`github/main=origin/main=bd8c37a`。

## 11. 最终准入结论

```
C1-F 复审判定        ：PASS_WITH_CONDITIONS
F1（A/B/C）          ：通过
F2                   ：撤回成立，残留 2 项 OBSERVATION（均为既有，不要求修改）
F3                   ：通过
F4                   ：保持不动，理由核验通过
P0-1 安全边界        ：完整保留
改动范围与授权        ：一致（未越界、未实施 A2/C2/P0-4/P1-1/R1，未触碰依赖与版本）
全量测试 / tsc / 构建 ：292/292、exit 0、build 0
真机证据缺失          ：不阻塞本地提交；设为该版本发布/推送前的强制条件
提交门禁              ：READY_FOR_C1_LOCAL_COMMIT（附条件）
```

**准入条件（唯一一条）**：提交前处理 D1 —— 修正 FIX_REPORT §1/§7 的未跟踪文档计数（7 份/8 份，并把 `.tmp-skills/` 单列）。该修正属文档行、不改代码，若业主选择先提交后修，需接受被提交的证据文档带有一处已记录的口径错误（本报告已完整记载，可追溯）。

**本阶段未执行、也不会执行 `git add` / `git commit` / `git push`。** 提交白名单核对结果见下。

## 12. C1-C 提交白名单核对（逐份已开）【事实】

拟随 C1 代码同批入库（10 项）：

```
代码：src/App.tsx (M)  src/presets.ts (M)  src/types.ts (M)
新增：src/lib/appcontrol.ts  src/lib/appcontrol.test.ts
文档：docs/audit/FEATURE_040_C1_IMPLEMENTATION.md   (102 行, 状态 READY_FOR_C1_REVIEW)
      docs/audit/FEATURE_040_C1_FIX_REPORT.md       (132 行, 状态 READY_FOR_C1_FIX_REVIEW → 本报告即其复审)
      docs/audit/FEATURE_040_C1_FIX_REVIEW.md       (本报告)
      docs/audit/FEATURE_040_PATCH_REVIEW.md        (168 行, 状态 PASS_WITH_CONDITIONS)
      docs/audit/P0-1_INDEPENDENT_REVIEW.md         (134 行)
      docs/audit/P0-2_IMPLEMENTATION_PLAN.md        (252 行)
      docs/audit/P0-2_INDEPENDENT_REVIEW.md         (136 行)
      docs/audit/P0-2_COMMIT_RECORD.md              ( 87 行)
      docs/audit/R1_IMPLEMENTATION_PLAN.md          (188 行, 状态 READY_FOR_R1_IMPLEMENTATION_AUTHORIZATION)
```

**排除项【事实】**：`.tmp-skills/`（5 个测试用 SKILL.md 夹具，属测试残渣，且暴露 `.gitignore` 缺 `.tmp-skills/`、`.tmp-audit/` 两行——清理与补 ignore 均未获授权，本阶段不动）；`dist/`、`.vite/`、`src-tauri/target*/`、`.zxz/`、`.workbuddy/` 均已被 ignore；无临时文件、无未复审的第三方文件混入。

【推断】若业主要求「一个 commit 只装 C1 代码」，可拆为「C1 代码」+「审计文档」两个 commit；本复审不代作决定，仅证明两种拆法所需的清单都已核过。
