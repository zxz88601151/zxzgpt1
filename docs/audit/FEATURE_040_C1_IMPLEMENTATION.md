# Phase 0.4.0-C1 应用内斜杠命令实施报告

- 阶段：C1 独立实施（未提交，等待独立复审）
- 日期：2026-11-02
- 基线：`main` @ `3349cda07b979f86bedf7edb1ade5f675d25e3d7`（P0-2 提交）
- 最终状态：**READY_FOR_C1_REVIEW**

> 依据：`zxzgpt1-0.4.0-batch1.patch` 的 C1 模块 + `docs/audit/FEATURE_040_PATCH_REVIEW.md` 审查结论。**未应用整份补丁**；A2 探索模式、V1 语音听写均未实施。

---

## 1. 基线确认【事实】

- HEAD `3349cda`，工作区实施前无已跟踪修改。
- 实施前测试基线 268/268（本报告 §5 复测）。

## 2. 实际修改文件与理由

| 文件 | 变更 | 理由 |
|---|---|---|
| `src/lib/appcontrol.ts` | **新增**（109 行） | C1 核心：补丁 `appcontrol.ts` 定义 + 两处整改（见 §4）+ 可测试分层（`planAppCommand` 计划层、`withToggleApplied`/`appendAssistantMessage` 纯状态变换，App 与测试用同一份实现） |
| `src/lib/appcontrol.test.ts` | **新增**（18 条用例） | 补丁 6 条解析测试为底，按 C1-3 扩到状态级实测（见 §5） |
| `src/App.tsx` | +34/−1 | `send()` 头部接入命令计划分发（先于 busy/模型检查）；import 一行。busy 语义与原行为逐点等价（见 §6） |
| `src/types.ts` | +3 | `Settings.exploreMode?: boolean` 惰性字段（**依赖说明见 §7**） |
| `src/presets.ts` | +2 | `DEFAULT_SETTINGS.exploreMode: false`（同上） |

未触碰：Markdown 渲染器（md.ts/text.ts）、CSP/URL 过滤、Rust IPC/会话化（fsapi 调用链零改动，`git diff` 证实）、package.json（版本仍 0.3.0）、A2/V1 任何文件（explore.ts / dictation.ts / DictationButton.tsx 均不存在）。

## 3. 命令结构（C1-1 范围确认）

- **命令类型**：`toggle`（五个开关：planMode / toolCalls / autoTest / confirmWrites / exploreMode）、`new_session`、`help`。
- **解析入口**：`parseAppCommand(text)` — 纯函数，只解析不执行；trim 后以 `/` 开头才认。
- **执行入口**：`planAppCommand(text, {busy, active})` → App `send()` 按 plan.kind 分发。
- **状态更新**：toggle 走 `update()` → 与设置抽屉同一份 settings、同一持久化通道（App.tsx:118-127 persist effect）；`/new` 复用既有 `createConv()`；`/help` 经 `appendAssistantMessage` 追加助手消息。
- **busy 防护**：busy 时命令计划为 `reject_busy`，输入框原样保留——与原 `if (busyRef.current) return` 行为等价。
- **C1 对 A2/V1 的依赖核查**：V1 无依赖；A2 仅有 `exploreMode` 设置字段一项 schema 依赖，已按 §7 处理，未引入 A2 任何行为代码。

## 4. 命令解析规则（C1-2）

1. 空白：App 入口 `text` 已 `input.trim()`，解析器内部再 trim 兜底，前后空白不影响判定。**审查报告 A3 的"入口 trim 不对称"结论经本次实施期复核为误报**（证据：补丁基线 blob `ec59a46` 第 518 行即 `const text = input.trim();`，`git cat-file -p` 可查），已在原审查报告对应结论作废，仅此一处。
2. 只识别合法命令；未知命令（含 `/PLAN` 大写形式）返回错误，不误执行——大小写策略锁定为"只认小写英文 + 中英别名"，测试固化。
3. 缺参数：`/plan` → "后面要跟 开 或 关"。
4. 多参数：`/plan 开 关`、`/new xxx` 明确拒绝。
5. **整改**：`/help foo` 原补丁静默接受，现与 `/new` 一致报"不带参数"。
6. 普通聊天文本返回 null/passthrough，零拦截。
7. busy 期间命令不执行、输入保留；斜杠路径无法绕过（active 入口 + busy 双重判定）。
8. 解析失败只 toast 错误，settings/会话零变更（测试断言）。
9. 抽屉与斜杠命令写同一份 settings（测试 `withToggleApplied` 与抽屉字段一一对应）。

## 5. 测试矩阵与结果（C1-3 / C1-4）

| 组 | 覆盖 | 用例数 |
|---|---|---|
| parseAppCommand | 普通文本/空串、合法命令全量（中英别名、on/off/开启/关闭）、未知命令、缺参、多参、`/new`/`/help` 带参拒绝、大小写锁定、前后空白、清单-解析一致性 | 7 |
| appActionLabel | 开关人话 | 1 |
| planAppCommand | 直通、busy 拒绝（命令）、busy 直通（普通文本）、错误/帮助/新建/开关计划 | 4 |
| 状态变化 | 五开关落 settings、不可变性、连续快速执行幂等、失败零变更、`/help` 消息追加（多会话隔离、原数组不改）、无会话不落 | 6 |
| **合计** | | **18** |

结果【事实】：

- C1 目标测试：**18/18 PASS**
- 全量 vitest：**286/286 PASS**（268 基线 + 18 新增，零回归）
- `tsc --noEmit`：0 错误
- `npm run build`（tsc + vite）：通过，`✓ built in 2.99s`

## 6. busy 语义等价性说明【事实】

原 `send()` 顶层 `if (busyRef.current) return` 对消息和（补丁语境下的）命令统一生效。本次改为：命令计划 `reject_busy` → return（输入保留）；普通消息走原有 busy 门 → return（输入保留）。三条路径（busy+消息、busy+命令、reuse 重生成+busy）行为与原版逐点一致，测试固化。

## 7. 发现的跨模块依赖及处理【事实】

补丁 C1 的 `TOGGLE_KEYS` 含 `explore → exploreMode`，而 `exploreMode` 字段属 A2 的 types/presets hunk。**处理**：仅纳入惰性 schema 字段（`Settings.exploreMode?: boolean` + 默认 false），注释明确"A2 未实施前无行为效果"；A2 的执行层门、提示词、抽屉 UI 一律未引入。`/explore 开|关` 当前只翻转一个无消费方的设置位——产品语义与补丁定义一致，不视为擅自改变行为。

## 8. 兼容性核对（C1-4 逐项）

| 项 | 结果 |
|---|---|
| P0-1 会话化接口 | ✅ 未变（App.tsx diff 仅 send() 头部 + import；fsRead/fsListIn/runAllowed 等 sessionId 链路零接触） |
| P0-2 安全修复 | ✅ 未回退（md.ts/text.ts 无 diff，286 全量中含 P0-2 新增 14 条全过） |
| Markdown 渲染器 | ✅ 未修改 |
| A2/V1 文件 | ✅ 未创建、未修改 |
| package.json 版本 | ✅ 保持 0.3.0 |
| 依赖安装/升级 | ✅ 无 |

## 9. 剩余风险

1. App 分发路径（send() 接线）无组件级测试——受限于未装 testing-library 且禁装依赖；逻辑已下沉到 appcontrol.ts 纯函数全量覆盖，接线部分经 tsc + 人工 diff 复核。
2. `/explore` 开关当前无行为消费方，用户开启后无可见效果（仅 toast）——属 A2 实施前的预期状态，建议 A2 落地前 README 不写该命令。
3. README/CLAUDE.md 未随本批更新（补丁对应段落混有 A2/V1 描述）——留待相关批次完成后统一修订，避免文档先行宣称未实施能力。

## 10. Git diff 摘要【事实】

```
 src/App.tsx    | 34 +++++++++++++++++++++++++++++++++-
 src/presets.ts |  2 ++
 src/types.ts   |  3 +++
 3 files changed, 38 insertions(+), 1 deletion(+)
 新增未跟踪：src/lib/appcontrol.ts、src/lib/appcontrol.test.ts
```

未执行 git add / commit / push。STOP，等待 C1 独立复审授权。
