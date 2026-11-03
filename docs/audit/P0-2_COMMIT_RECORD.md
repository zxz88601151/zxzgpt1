# P0-2 提交执行记录

> 阶段：P0-2-D（Git Release Engineer / 安全复审 / 范围审计）
> 当前状态：**COMMITTED_LOCAL**（已获业主授权语句，已完成提交；未 push、未发布）

---

## 1. D1 提交前基线核验（逐项重新采集）

| 项 | 结果 |
|---|---|
| 提交前 HEAD | `7ea1eb302544251f3e390e8369f5574ecf2072c5`（与 P0-2-C 复审时一致） |
| 分支 | `main` |
| `git status --short` | 4 个已修改文件 + 4 个未跟踪项（`.tmp-skills/`、3 份审计文档），无意外 |
| `git diff --stat` | 4 文件，+106/−9，与复审报告一致 |
| `git diff --name-only` | 恰好：`src/lib/text.ts`、`src/lib/md.ts`、`src/lib/md.test.ts`、`src/lib/text.test.ts` |
| `git diff --check` | 无空白错误 |
| 暂存区 | 空（无意外暂存） |
| 复审后漂移 | **零**（四文件 mtime 均早于复审完成时刻；08:52 后全源码树无改动） |

## 2. D2 提交范围预演

准备提交的精确清单（仅此 4 文件，`git add` 逐个指定，不使用任何全量暂存命令）：

| 文件 | 内容核验 |
|---|---|
| `src/lib/text.ts` | 仅新增 `escapeAttr()`；`escapeHtml()` 函数体与契约零改动 |
| `src/lib/md.ts` | 链接/img 的 href/src/alt 插值统一 `escapeAttr`（在原始输入阶段执行）；移除实体还原与死代码；黑名单保留；引擎结构未重构 |
| `src/lib/md.test.ts` | 新增 **11 条**属性注入回归用例（原 16 条全部保留） |
| `src/lib/text.test.ts` | 新增 **3 条** `escapeAttr` 用例（原 10 条全部保留） |

范围外内容核验：CSP / devCsp / img-src / SVG / 协议白名单 / `file:` 过滤 / `package.json` / P0-1 会话代码——**均未触碰**（不在 diff 中）。

## 3. D3/D4 提交执行与提交后核验（已完成）

**授权语句（08:59 收到）**：`授权 Phase P0-2-D：仅提交 P0-2 的 4 个代码文件，不包含任何其他文件。`

执行过程：

1. 逐个 `git add` 指定 4 文件 → 暂存区核验：恰好 4 文件、+106/−9，无额外文件；
2. 执行 commit；
3. 提交后核验全部通过。

| 项 | 结果 |
|---|---|
| 提交 hash | `3349cda07b979f86bedf7edb1ade5f675d25e3d7` |
| `git show --stat --oneline HEAD` | `3349cda fix(security): escape Markdown HTML attributes`，4 文件 +106/−9 |
| 提交后 `git status --short` | 仅剩未跟踪项（`.tmp-skills/` + 4 份审计文档），**无任何已跟踪改动残留** |
| 提交内容 | 仅 4 个代码文件，未夹带审计报告/临时目录/其他 |
| push | **未执行**（预期） |
| 发布 | **未执行**（预期） |
| 异常 | 无 |

实际 commit message：

```
fix(security): escape Markdown HTML attributes

- 修复 Markdown 链接/图片的属性注入：URL 与 label 中的裸双引号不再突破 href/src/alt
- 新增 escapeAttr()（escapeHtml + 引号编码），escapeHtml() 行为契约完全保持
- 移除 md.ts 的实体还原逻辑与死代码（&amp; 还原曾允许 &#115; 实体绕过 javascript: 黑名单）
- 链接正则改在原始输入上先于 escapeHtml 执行，合法 & 参数链接保持单次编码
- 测试：md.test.ts 新增 11 条、text.test.ts 新增 3 条回归用例，全量 268/268
```

（commit message 使用真实数字 11/3，未沿用实施报告中 12 的错误计数。）

## 4. R1 强制后续事项登记（不属于本次提交）

| 项 | 内容 |
|---|---|
| 问题 | Markdown URL 协议黑名单未处理部分 ASCII 控制字符 |
| 已确认向量 | `java\tscript:`、`java\nscript:`（`\r` 同属此类，待测） |
| 风险机制 | 协议检查不匹配含控制字符变体 → escapeAttr 不编码控制字符 → href 原样输出 → WHATWG URL 解析器剥离 tab/LF/CR → 协议解析为 `javascript:`；dev 态（devCsp 含 unsafe-inline）可执行，生产态由 `script-src 'self'` 兜底 |
| 性质 | 修复前即存在的既有缺陷（P0-2-C 复审 R1，非 P0-2 引入） |
| 处理要求 | 建立独立修复任务；优先评估协议白名单（`https?:|mailto:`）或对 `clean` 先做控制字符剔除/归一化再检查；回归测试必须覆盖 `\t` `\n` `\r` 及 `String.fromCharCode(1-31)` 相关字符；**验收以"最终解析协议"为准，不得仅凭字符串过滤结果宣称修复**；未经授权不得修改 |

## 5. 偏差与未解决问题

1. 无基线漂移、无范围偏差；提交一次成功，未触发 hook 失败。
2. `.tmp-skills/` 未跟踪临时目录仍在原地（历史遗留，安全删除机制 fail-closed，未纳入提交）。
3. 4 份未跟踪审计文档（P0-1-F 复审、P0-2-A 计划、P0-2-C 复审、本提交记录）未纳入本次提交，**待业主决定是否单独 docs commit**。
4. R1 见上，强制后续。

---

**STOP。提交已完成（COMMITTED_LOCAL）。不自动进入 R1 修复，不自动推送，不自动发布。**
