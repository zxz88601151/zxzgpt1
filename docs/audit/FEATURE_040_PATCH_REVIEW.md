# Phase 0.4.0-A 功能补丁独立审查与基线兼容性评估

- 阶段：0.4.0-A（只读审查，未应用补丁、未改任何代码）
- 日期：2026-11-02
- 审查对象：`/f/zhuomian/zxzgpt1-0.4.0-batch1.patch`（779 行；与 `(1).patch` 副本逐字节一致，`diff -q` 证实）
- 审查角色：Software Architect / Application Security Auditor / Patch Integration Reviewer / Test Strategy Reviewer
- 最终状态：**PASS_WITH_CONDITIONS**（三个模块都值得纳入，但 A2 必须整改后方可纳入；A6 给出分阶段顺序）

> 标记：**【事实】**=代码/实测/git 证据；**【推断】**=基于事实的推论；**【建议】**=整改/集成意见。

---

## A1｜补丁基线与完整性

### 基线【事实】

| 项 | 值 |
|---|---|
| 分支 / HEAD | `main` @ `3349cda`（P0-2 提交） |
| 工作区 | 无已跟踪修改；未跟踪仅审计文档 ×6 + `.tmp-skills/` |
| 补丁规模 | 18 文件：+555 / −4；其中新文件 7、修改 11 |

### Blob 比对【事实】（补丁基线 blob vs HEAD 短 hash）

- **MATCH**：package.json、Composer.tsx、SettingsDrawer.tsx、ui.tsx、presets.ts、state.ts、styles.css（7 个）
- **MISMATCH**：CLAUDE.md、README.md、src/App.tsx、src/types.ts（4 个）
- **NEWFILE**：DictationButton.tsx、appcontrol.ts/test、dictation.ts/test、explore.ts/test（7 个）

### 适用性检查【事实】

- `git apply --check`（不落盘）：**REAL_EXIT=1**，唯一硬失败 `src/App.tsx:432` hunk。
- 失败原因：补丁上下文含 `await fsRead(ws.root, ...)`（P0-1 之前写法），HEAD 为 `fsRead(ws.sessionId, ...)`（App.tsx:438，P0-1 会话化产物，`git log` 证实 a280051 改过 App.tsx）。**语义无冲突**：补丁要插入的探索第二道门位于 planMode 护栏之后、`try {` 之前，该锚点在 HEAD 中原样存在（App.tsx:433-436），手工适配重放即可，不涉及任何 P0-1 逻辑覆盖。
- README/CLAUDE.md/types.ts blob 不匹配但 hunks 按上下文可应用（README/CLAUDE 均为文末追加；types.ts 为接口追加字段）。

### 覆盖风险核对【事实】

| 核对项 | 结论 |
|---|---|
| P0-2 测试/安全修复是否会被旧补丁覆盖 | **不会**。补丁不触碰 `src/lib/md.ts`、`text.ts` 及任何 P0-2 文件；App.tsx 唯一失败 hunk 需手工适配而非盲放。补丁基线早于 P0-1/P0-2（README 自称基线 244 条测试），属于**基于 P0-2 之前的旧版本**制作 |
| README 265/265 是否过时 | **是**。当前基线 268/268（P0-1 +8、P0-2 +14）。补丁按 244+21=265 撰写，集成后正确预期为 **289/289** |
| package.json 版本 0.3.0→0.4.0 | **与发布策略冲突**。0.3.0 由安全发布提交 e87bc17 定版；功能补丁夹带版本号 bump 会把"未经验证的功能批次"标记为已发布版本。**建议集成时剥离版本变更，版本号留待发布门禁单独决定** |

## A2｜探索模式安全审查

### 两道门结构【事实】

1. 第一道门：发给模型的工具定义 `exploreToolDefs()`（explore.ts:19-21）= TOOL_DEFS 过滤出 `read_file/list_dir/search_files` 三件套；
2. 第二道门：执行层（补丁 App.tsx 432 后插入）`if (live exploreMode && !isExploreTool(name)) return error`；
3. `file:` 块：`!planMode && !exploreMode` 才 `requestApplyFiles`；
4. 提示词：`state.ts` 在工具提示词后追加 `buildExplorePrompt()`。

### `isExploreTool` 默认拒绝【事实】

explore.ts:15-17：白名单仅含三件套，未知工具（含未来新增）返回 false ⇒ 第二道门对一切非只读工具默认拒绝 ✅。执行层 `executeTool` 尾部原有 `未知工具` 拒绝（App.tsx:516）保持不变 ✅。

### ⚠️ 核心问题：请求期状态来源不一致【事实】

- `s = stateRef.current.settings`（App.tsx:534）在 send() 开始时取值；因 settings 不可变替换，`s` 即**请求级快照**——工具定义（补丁行 166 `s.exploreMode`）、`file:` 块（补丁行 181）、autotest（App.tsx:719-721 `s.autoTest`/`planMode`）都消费快照 ✅；
- **但** `executeTool` 内 planMode（App.tsx:432，存量）与补丁新增 explore 门都读**活体** `stateRef.current.settings`。
- 时序分析【推断】：
  - 斜杠命令路径：`send()` 开头 `if (busyRef.current) return`（App.tsx:528）⇒ 生成期间 `/explore` 无法执行 ✅（README 该声明成立）。
  - **但设置抽屉在生成期间仍可保存**（App.tsx:118-127 的持久化 effect 无 busy 门；抽屉 onSave → commit 不受 busy 限制）⇒ 在途请求可被抽屉切换改权：
    - 方向一（开→关）：第二道门活体读数消失；该请求发给模型的虽是三件套，若模型仍吐出未声明的 `write_file` tool_call（部分 OpenAI 兼容实现不校验声明集），执行层将放行落盘 ⇒ **在途权限放宽，违反验收标准"探索请求启动后只读约束不能被普通设置切换意外解除"**。
    - 方向二（关→开）：模型握着全量工具定义，执行层中途开始拒写，而 `file:` 块按快照仍会落盘——同一请求内三门状态互相矛盾，模型收到误导性错误。
- **整改要求【建议】**：请求级权限锁——send() 开始时将 `exploreMode`（连同存量 `planMode`，同一行相邻、同一缺陷模式）固化进 `useRef`，`executeTool` 只读该锁；请求结束复位。改动 ≤5 行，且顺手消除存量 planMode 活体读数缺陷。

### 其余核查项【事实/推断】

| 项 | 结论 |
|---|---|
| 未知工具默认拒绝 | ✅ 见上 |
| 自动测试回路绕过 | **架构性缺口（条件性安全）**：autotest 直调 `runAllowed`（App.tsx:728），**不经 executeTool**，第二道门管不到它。当前不可达（explore 下 `files` 恒空 ⇒ `wroteSomething` 假 ⇒ 不触发），但这是传递性不变量而非显式门禁，后续重构易破。**建议 autotest 条件显式加 `!exploreMode`** |
| 其他写入口 | `requestApplyFiles` 被快照门覆盖 ✅；设置持久化写 localStorage 属用户自身 UI 动作，不在"模型权限"语义内，可接受；`run_command` 全量走 executeTool ✅ |
| 请求级快照 | 见核心问题，**当前缺失** |

### A2 验收标准逐条【事实】

| 标准 | 现状 |
|---|---|
| 探索请求启动后只读约束不可被设置切换解除 | **不满足**（活体读数 + 抽屉在途可改） |
| 写入/命令/文件块路径全覆盖 | 条件性满足（autotest 依赖传递性） |
| 未知工具默认拒绝 | 满足 |
| 真实执行层拒绝测试 | **缺失**——补丁 21 条测试全部是纯函数级，executeTool 拒绝路径零覆盖 |

## A3｜应用内控制命令审查

| 检查项 | 结论【事实】 |
|---|---|
| 解析入口一致性 | **入口不一致**：App 用 `text.startsWith("/")`（补丁行 126），`parseAppCommand` 内部先 `trim()`。`"  /plan 开"`（前导空格）被入口判为普通消息发给模型。方向是 fail-safe（不产生非预期状态变更），但行为不统一；【建议】入口先 trim 再判，或在帮助里明说"必须行首即 /" |
| 普通消息不受影响 | ✅ 非 `/` 开头返回 null 走原路径；测试覆盖（"普通消息不是命令"） |
| 缺参/多参/未知命令 | ✅ 只返回 error 不改状态，测试覆盖 |
| 生成期间执行命令 | ✅ `busyRef` 门（App.tsx:528）先于命令块，README 声明成立 |
| `/new` 影响在途会话 | 生成期间被 busy 门挡住；空闲时新建会话安全 |
| `/help` 非法参数 | **`/help foo` 静默接受**（cmd==="help" 直接返回，不查 `parts.length`），与 `/new` 的"不带参数"校验不一致；【建议】对齐 `/new` 行为 |
| 设置持久化 | ✅ 斜杠命令与抽屉都走 `commit()` → `persist()`（App.tsx:118-127 effect 对任意 state 变更落盘），同一份状态同一持久化通道 |
| UI 开关同源 | ✅ 抽屉 `patch({exploreMode})` 与命令 `update(settings…)` 写同一 settings 对象 |

命令作用域约束（不读文件/不写文件/不跑命令）在实现上成立：所有 action 只改 settings 或新建会话【事实】。

## A4｜语音听写审查

| 检查项 | 结论 |
|---|---|
| Web Speech API 兼容性 |【事实】Chrome/Edge/WebView2（Chromium 系）可用；`isSpeechRecognitionAvailable()` 有守卫，不支持时明确报错引导手动输入 |
| 云端隐私告知 |【事实】到位：按钮 title、错误文案（"音频发给浏览器厂商转录"）、README 15.1、CLAUDE.md、dictation.ts 头注释五处均明示**云端、非离线**；未发现把云端识别描述为本地识别的表述 ✅。V1b（离线 Whisper） correctly 未混入本批 |
| 权限拒绝/取消 |【事实】not-allowed / service-not-allowed / audio-capture / no-speech / network 均有专属人话文案；`recog.start()` try/catch 兜底 |
| 转录不自动发送 |【事实】`onTranscript` 只 `appendTranscript` 进输入框，发送权完全在用户 ✅ |
| 识别失败保留原文 |【事实】错误路径只 toast，不动输入框 ✅ |
| 卸载资源释放 |【事实】useEffect cleanup 调 `stop()`；【推断】卸载瞬间若 final result 恰在途，`onTranscript` 会在卸载后回调（React 18 无警告、无崩溃，仅当次转录可能丢失或落到新场景），建议改 `abort()` 并置空回调 |
| **交互竞争** |【推断，需真机验证】桌面鼠标路径正确（mousedown 启动 → 重渲染 → mouseup/click 落在录音按钮 → stop，双 stop 幂等）。**触屏路径有双击 bug**：touchstart→start，touchend→stop 回 idle，随后合成 mouse 事件（mousedown→start 再次启动一次无人值守录音，click 被 idle 守卫挡住）——需统一为 Pointer Events 或在 touch 后屏蔽合成事件。【建议】V1 真机验收前按触摸设备列必测项 |

## A5｜测试与文档可信度

| 核对项 | 结论【事实】 |
|---|---|
| 新增测试实数 | 逐条数 `it(` 声明：**appcontrol 6 + dictation 10 + explore 5 = 21**，与 README 自述一致 ✅ |
| 265/265 归属 | 旧基线（244+21），**已过时**；当前 268，集成后预期 289 |
| 缺失测试层 | ① executeTool 探索门/计划门**执行层拒绝测试零覆盖**（安全关键路径，A2 验收强制要求）；② DictationButton 无任何组件/事件级测试（触屏双击 bug 正是测试缺口所在）；③ 斜杠命令只有解析器测试，无 App 分发路径测试 |
| 文档过度声明 | README "前端已验 265/265" 相对当前基线失真；"未验"一节（麦克风、桌面端点击、真模型行为）诚实 ✅。无"未完成能力被描述为已验证"的硬错误（265 属于统计过时而非能力造假） |

## A6｜分阶段集成方案

总原则【建议】：**不建议三模块一次性合并**；且 R1（已 READY_FOR_IMPLEMENTATION）与 P0-3 安全线优先，功能集成不得阻塞安全修复。

### 方案 B｜C1 应用内命令（建议最先纳入，风险最低）

- **修改文件**：appcontrol.ts / appcontrol.test.ts（新增）、App.tsx（命令分发块 ~35 行）、CLAUDE.md、README.md
- **依赖**：无（纯前端状态，不碰 IPC/模型/Rust）
- **安全风险**：极低（只改自身 settings；fail-safe 解析）
- **整改项（纳入前完成）**：入口 trim 对齐（1 行）；`/help` 多余参数报错（2 行）；README 测试数 265→实际
- **测试要求**：现有 6 条 + App 分发级 1-2 条（busy 期间命令被吞、前导空格行为锁定）
- **回滚边界**：`git revert` 单提交即净；无持久化数据结构变化
- **版本号**：不变

### 方案 A｜A2 探索模式（整改后纳入，安全价值最高）

- **修改文件**：explore.ts / explore.test.ts（新增）、App.tsx（执行层门 ~5 行 + toolsForModel 1 行 + file: 块 1 行）、state.ts（提示词 4 行）、types.ts、presets.ts、SettingsDrawer.tsx、CLAUDE.md、README.md
- **依赖**：无硬依赖，但与 R1 同改 App.tsx 邻近区域，建议时序上置于 R1 之后避免冲突
- **安全风险**：若按补丁原样纳入则有在途权限放宽缺口（A2 核心问题）
- **整改项（准入门槛，缺一不可）**：
  1. 请求级权限锁：exploreMode（及同模式存量 planMode）send() 时固化 ref，executeTool 读锁；
  2. autotest 条件显式 `!exploreMode`；
  3. 执行层拒绝测试：探索模式下 write_file/run_command/未知工具/自动测试路径在 executeTool 层被拒的集成级用例（当前为零）；
  4. App.tsx 失败 hunk 按 P0-1 后上下文手工适配，重放后 diff 复核确认不触碰 sessionId 链路
- **回滚边界**：revert 单提交；settings 新增可选字段 `exploreMode` 向后兼容（缺省 false）
- **版本号**：不变

### 方案 C｜V1 语音听写（最后纳入，真机验证门）

- **修改文件**：dictation.ts/test、DictationButton.tsx、Composer.tsx（props）、ui.tsx（图标）、styles.css、App.tsx（注入 dictation 节点）、README/CLAUDE.md
- **依赖**：无代码依赖，但有**环境依赖**：需 Windows WebView2 真机验证麦克风权限与云端连通
- **安全风险**：低（不自动发送、无 IPC），主要风险是体验类（触屏双击）与隐私告知（已到位）
- **整改项（纳入前完成）**：Pointer Events 统一或合成事件屏蔽（修触屏双击）；卸载改 `abort()`；真机必测清单（按住-松手-转录只进输入框、权限拒绝、网络断开、触屏竞争）
- **测试要求**：现有 10 条纯函数 + 至少组件级状态机测试（mock SpeechRecognition）
- **回滚边界**：Composer props 为可选注入，revert 后无残留
- **版本号**：不变（三个模块全部走完后由发布门禁统一定 0.4.0）

## 最终结论

| 模块 | 结论 |
|---|---|
| C1 应用内命令 | **值得纳入，先行**（2 处小整改） |
| A2 探索模式 | **值得纳入，但按补丁原样不合格**——权限锁 + autotest 显式门 + 执行层拒绝测试三项整改完成后准入 |
| V1 语音听写 | **值得纳入，延后**——云端隐私告知到位，触屏竞争修复 + 真机验证完成后准入 |

**最终状态：PASS_WITH_CONDITIONS**

本报告不构成补丁应用、功能实现、Git 提交或发布授权。STOP，等待业主决定集成顺序与 A2 整改授权。
