# R1 独立复核与最小修复方案 — Markdown URL 控制字符绕过

- 阶段：R1-A（只读复核 + 方案设计，未实施任何修复）
- 日期：2026-11-02
- 复核人角色：Application Security Auditor / Rust·TS Security Reviewer / Remediation Planner
- 最终状态：**READY_FOR_R1_IMPLEMENTATION_AUTHORIZATION**

> 标记约定：**【事实】**=有代码/实测/提交证据；**【推断】**=基于事实的合理推论；**【假设】**=待验证前提；**【建议】**=方案性意见。

---

## 1. Git 基线

| 项 | 值 | 证据 |
|---|---|---|
| 分支 | `main` | `git branch --show-current` |
| HEAD | `3349cda07b979f86bedf7edb1ade5f675d25e3d7`（P0-2 提交） | `git log` |
| 工作区 | 无已跟踪文件修改；未跟踪仅审计文档 ×4 + `.tmp-skills/` | `git status --short` |
| 暂存区 | 空 | `git diff HEAD --stat` 无输出 |
| 基线漂移检查 | 无漂移，HEAD 与授权基线一致 | 对比授权书给定 hash |

## 2. 受影响调用链

**【事实】** 完整注入链（静态代码证据）：

```
MessageList.tsx:40  renderMarkdown(body)          → dangerouslySetInnerHTML
MessageList.tsx:57  renderMarkdown(msg.reasoning) → dangerouslySetInnerHTML（同一注入面）
  └─ md.ts:127 renderMarkdown → 块级分行
       └─ md.ts:148/173/208/209 renderInline（文本节点）
            └─ md.ts:42-50  Markdown 链接/图片回调  ← R1 缺陷点
```

**【事实】** R1 影响面**仅** `md.ts:42-50`（`[label](url)` 与 `![alt](url)` 两个分支）：

- md.ts:55 裸链接正则前缀锁死 `https?:\/\/`，字符集 `[^\s<)"']+` 不含空白与引号，无协议混淆面；
- md.ts:15-27 代码块 head 经 `escapeHtml` 纯文本输出，非 URL 上下文；
- `text.ts` 的 `escapeHtml`/`escapeAttr` 只做字符转义，不参与协议判定；
- 未发现其他渲染入口或 URL 判定调用点（全仓 grep `renderMarkdown|renderInline` 已穷尽）。

## 3. 原始漏洞独立复现证据

**【事实】** 现行判定（md.ts:43-46，HEAD 3349cda）：

```ts
const clean = String(rawUrl).trim();
if (/^\s*javascript:/i.test(clean) || /^\s*data:/i.test(clean)) return keep(escapeHtml(label));
```

`^\s*` 只跳过**协议名前**的空白；`\s`（JS）= `[\t\n\v\f\r \u00a0…]`，**不含 C0 控制符 `\x00-\x08` 等，也管不到协议名内部**。

**【事实】** WHATWG URL 解析器（URL Standard §basic URL parser）在解析前做两步剥离：
① 移除输入中**所有** TAB/LF/CR（ anywhere）；② 剥离首尾 C0 控制符与空格。此后才判定 scheme。

**【事实】** 两层剥离集合 ≠ 代码黑名单跳过集合 ⇒ 检查对象与浏览器执行对象不一致。端到端复现（esbuild 内存打包真实 `md.ts` → 提取输出属性值 → 单次 HTML 实体解码模拟浏览器 → Node 22.22.2 Ada WHATWG 解析器定协议；**未写盘**）：

| # | 原始 Markdown 输入 | 代码清洗结果 | 黑名单判定 | 最终属性值（实体解码后） | WHATWG 最终协议 | 可执行 |
|---|---|---|---|---|---|---|
| 1 | `[a](java\tscript:alert(1))` | 原样（内部 TAB 保留） | 放行（漏检） | `java\tscript:alert(1)` | **javascript:** | **是** |
| 2 | `[a](java\nscript:alert(1))` | 原样 | 放行 | `java\nscript:alert(1)` | **javascript:** | **是** |
| 3 | `[a](java\rscript:alert(1))` | 原样 | 放行 | `java\rscript:alert(1)` | **javascript:** | **是** |
| 4 | `[a](JaVa\tScRiPt:x)` | 原样 | 放行 | `JaVa\tScRiPt:x` | **javascript:** | **是** |
| 5 | `[a](da\tta:text/html,x)` | 原样 | 放行 | `da\tta:text/html,x` | **data:** | **是** |
| 6 | `[a](da\ndata:text/html,x)` | 原样 | 放行 | `da\ndata:text/html,x` | **data:** | **是** |
| 7 | `[a](\x01javascript:alert(1))` | 原样（`\x01` 不在 `\s`） | 放行 | `\x01javascript:alert(1)` | **javascript:** | **是** |
| 8 | `[a](\x02javascript:x)` | 原样 | 放行 | `\x02javascript:x` | **javascript:** | **是** |
| 9 | `[a](java\r\nscript:x)` | 原样 | 放行 | `java\r\nscript:x` | **javascript:** | **是** |
| 10 | `[a](\tjava\tscript:x)` | 原样 | 放行（前导 `\t` 被吃，内部 TAB 漏检） | `java\tscript:x` | **javascript:** | **是** |
| 11 | `![a](java\tscript:x)` | 原样 | 放行 | `java\tscript:x` | **javascript:**（img 分支同面） | img 中 js 不执行¹ |
| 12 | `![a](da\ndata:text/html;base64,AA)` | 原样 | 放行 | `da\ndata:…` | **data:** | img 可渲染钓鱼内容 |
| 13 | `[a](\x0bjavascript:x)` | 原样 | **拒绝**（`\v∈\s`） | —（降级为文本） | N/A | 否 |
| 14 | `[a](\x7fjavascript:x)` | 原样 | 放行 | `\x7fjavascript:x` | 相对 URL（不执行） | 否 |
| 15 | `[a](java&#9;script:x)` | 原样 | 放行 | `java&#9;script:x` | 相对 URL（惰性）² | 否 |
| 16 | `[a](java\x0bscript:x)` | 原样 | 放行 | `java\x0bscript:x` | 相对 URL | 否 |
| 17 | `[a](javascript:x)` / `[a](data:text/html,x)` | 原样 | **拒绝** | — | N/A | 否（基线行为保持） |
| 18 | `[a](https://ok.com/x?y=1&z=2)`、`[a](/rel/path)`、`[a](#frag)` | 原样 | 放行 | 原值 | https: / 相对 | 否（合法行为） |

¹ **【事实】** `javascript:` 在 `<img src>` 不执行脚本（现代浏览器），但 `<a href>` 向量 #1-#10 点击即可执行。
² **【事实】** P0-2 删除 `&amp;`→`&` 还原后，实体形态 `&#9;` 只被浏览器解码一次，得到惰性字面串，URL 解析器不做二次实体解码——P0-2 的实体修复在 R1 存在下依然成立。

**验证限制声明【事实】**：本机未做真实浏览器点击实测；协议判定使用 Node 22.22.2 内置 WHATWG URL 解析器（Ada 实现，与 Chromium 同源）。URL 层的控制字符剥离行为跨浏览器高度一致（同一份规范算法），复现结论可信度高，但不伪称已完成浏览器实测。

**历史溯源【事实】**：`git show e87bc17:src/lib/md.ts` 证明 P0-2 之前同一黑名单（且彼时连属性转义都没有）已存在完全相同的控制字符绕过 ⇒ R1 为**存量缺陷，非 P0-2 引入**。

## 4. 控制字符测试矩阵（协议层 ground truth）

**【事实】** Node WHATWG 解析器直测（`new URL(s, "https://base.example/")`）：

| 输入形态 | 最终协议 | 是否危险 |
|---|---|---|
| `java{TAB}script:` / `java{LF}script:` / `java{CR}script:` | javascript: | **危险** |
| `da{TAB}ta:` / `da{LF}ta:` | data: | **危险** |
| 前导 `\x01`-`\x08`、`\x0e`-`\x1f` + `javascript:` | javascript:（前导 C0 被剥离） | **危险** |
| 前导 TAB/空格 + `javascript:` | javascript: | 危险但被现行黑名单拦截 |
| `java{VT}` / `java{FF}` / `java{NUL}` / `java{SP}` + `script:` | 相对 URL（scheme 解析失败） | 否 |
| 前导 DEL `\x7f` | 相对 URL（DEL 不在剥离集） | 否 |
| `java&#9;script:`（实体形态） | 相对 URL | 否 |
| `https:` / `http:` / `/rel` / `#a` | 各自正常 | 否 |

## 5. 最终 URL 解析行为（漏洞机理归纳）

**【推断】** 漏洞机理一句话：代码用「JS `\s` 跳过 + 字面协议名匹配」判定，浏览器用「TAB/LF/CR 全局移除 + 首尾 C0/空格剥离 + RFC 3986 scheme 状态机」解析；两集合不相等，攻击者取差集（协议名内 TAB/LF/CR、前导 C0）即绕过。

**【事实】** 生产缓解层：`tauri.conf.json:28` CSP `script-src 'self'`（无 `'unsafe-inline'`）。按 CSP3 语义，`javascript:` URL 的导航执行受 script-src 管辖，生产构建下点击被 CSP 拦截。
**【推断】** CSP 是纵深防御而非修复：① 开发模式 devCsp 含 `unsafe-inline`（javascript: 可执行）；② `data:text/html` 的顶层导航/内容呈现不受 script-src 保护；③ img-src 显式允许 `data:`。指令明确 CSP 不能替代输入校验，故维持修复立场。

## 6. 修复策略比较

| 维度 | A. 检查前剔除控制字符 | B. `new URL()` 规范化后判定 | C. 协议白名单（以规范化为前置） |
|---|---|---|---|
| 安全覆盖 | 修全部已实测向量，但仍是黑名单：未来新增危险协议（`vbscript:`、`blob:` 等）需人工补 | 取决于判定逻辑；相对 URL 需 base，协议随 base 走，**无法区分「用户给的绝对 http」与「相对路径」**；引入环境依赖（渲染器现为纯字符串零依赖） | 未知协议默认拒绝，覆盖当前与未来所有协议混淆类向量 |
| 合法 URL 兼容 | 高（TAB/LF/CR 在 URL 中本就非法，浏览器亦剥离，删除不改语义） | 中（`java\script:` 反斜杠等 WHATWG 特殊处理会改变字面量；相对/锚点语义复杂化） | 高（白名单 `https?|mailto` + 无 scheme 放行，覆盖项目全部现有用例；`ftp:` 等极冷协议会被降级——见 §10） |
| 编码/实体顺序 | 不受影响（规范化在原始输入上、escapeAttr 在最后，与 P0-2 管线兼容） | 需在实体解码后，插入点微妙 | 同 A |
| 大小写/空白 | 需自行覆盖（前导 C0 不在 `\s`） | URL 解析器处理 | 与 WHATWG 前导剥离对齐：`^[\s\x00-\x20]*` |
| 相对 URL / 锚点 / 查询参数 | 无影响 | base 污染判定 | 无 scheme 形态直接放行，逐字节输出不变 |
| 二次编码风险 | 无 | 无 | 无 |
| 修改范围/回归成本 | md.ts 1 处，~3 行 | md.ts 1 处但语义最重，回归面最大 | md.ts 1 处，~5 行 + 测试 |

**【建议】** 不默认选行数最少的方案。推荐 **C（白名单）+ 规范化前置**：白名单根治「协议混淆」整类问题；规范化（删除 TAB/LF/CR）同时满足指令的核心要求——**写入属性的值与判定的值同源**。A 单独使用仍是黑名单，留下同类复发面；B 语义副作用最大且破坏渲染器零依赖特性。

## 7. 推荐方案及理由

**推荐：规范化 + 协议白名单**，全部变更集中在 `src/lib/md.ts:42-50` 的链接回调内（Additive Only，不动 `escapeHtml`/`escapeAttr` 契约、不动 CSP/SVG/file:、不重构渲染器、不引入依赖）。

设计要点：
1. **规范化**：`clean = String(rawUrl).replace(/[\t\n\r]/g, "").trim()` —— 删除浏览器会无警示剥离的 TAB/LF/CR，使检查对象 = 执行对象；trim 与 P0-2 现行行为一致。
2. **白名单判定**：`scheme = /^[\s\x00-\x20]*([a-z][a-z0-9+.-]*):/i.exec(clean)`（scheme 字符集与 RFC 3986/WHATWG 完全一致；前缀跳过集与 WHATWG 前导剥离对齐，覆盖前导 C0 向量）。命中 scheme 且不在 `^(?:https?|mailto):$` ⇒ 降级为 `keep(escapeHtml(label))`（沿用现行拒绝路径，只丢链接保文字）。
3. **写入同源**：`escapeAttr(clean)` —— 写入值即判定值，不存在「检查副本 ≠ 执行副本」。
4. 实体行为保持：`&` 仍最先转义、不还原，P0-2 的实体修复不被触碰。

**【推断】** 该设计下 §3 矩阵全部 18 行结论：#1-#12 变为「拒绝」；#13-#18 行为逐字节不变。

## 8. 精确修改位置

| 文件 | 位置 | 变更 |
|---|---|---|
| `src/lib/md.ts` | 43-46 行（`clean` 构造 + 黑名单 `if`） | 替换为规范化 + 白名单判定（约 +4/-2 行） |
| `src/lib/md.test.ts` | 文件末尾新增 `describe("URL 协议白名单与控制字符")` | 新增回归测试（见 §9） |

不触碰：`text.ts`、`text.test.ts`、裸链接正则、块级管线、`tauri.conf.json`。

## 9. 回归测试设计（md.test.ts 新增）

| 组 | 用例 | 断言 |
|---|---|---|
| 绕过向量 | `java\tscript:`、`java\nscript:`、`java\rscript:`、`java\r\nscript:`、`JaVa\tScRiPt:` | `not.toContain("href=")` |
| 绕过向量 | `da\tta:`、`da\ndata:`、`da\rdata:` | `not.toContain("href=")` |
| 前导 C0 | `\x01javascript:`、`\x1f\x01javascript:`、`\x02data:` | `not.toContain("href=")` |
| 组合 | `\tjava\tscript:`（前导+内部） | `not.toContain("href=")` |
| img 同面 | `![a](java\tscript:x)`、`![a](da\ndata:…)` | `not.toContain("<img")` |
| 行为保持 | `\x0bjavascript:`（现行拒绝） | `not.toContain("href=")` |
| 行为保持 | `\x7fjavascript:`、`java&#9;script:`、`java script:`（现行放行且安全） | `toContain("href=")` 且属性值为原样惰性串 |
| 合法 URL | `https://ok.com/x?y=1&z=2`、`http://a.b`、`/rel/path`、`#frag`、`mailto:a@b.c`、`[a](https://x/?q=1&amp;b=2)` | `href` 保留且值与现行逐字节一致 |
| 行为变更记录 | `ftp://x` | 由放行变拒绝（显式断言降级为文本，防静默漂移） |

规模约 +15 用例。验收时另跑 §3 同款端到端矩阵：所有 `ATTR_KEPT` 项 WHATWG 协议 ∉ `{javascript:, data:}`。

## 10. 兼容性风险

**【事实】** 项目内 grep 无任何 `mailto|ftp|tel|blob` 用例；现有测试中的链接全部是 `https?://`。
**【事实/变更】** `ftp://` 类极冷协议链接将由「可点」变「纯文本」——项目无此用例，影响可忽略；若未来需要，向白名单加条目即可（一处常量）。
**【推断】** 输入 URL 中字面 TAB/LF/CR 会被删除：这些字符在 RFC 3986 中属禁止字符、在合法 URL 中无用途，浏览器本就剥离，对合法输入零影响；输出仅对病态输入有变化。
**【事实】** `mailto:` 纳入白名单以保持现行放行语义（mailto 无脚本执行能力）。

## 11. 明确不处理的事项

- 不修改 CSP、SVG、`file:` 协议策略（指令禁止，且不在 R1 范围）。
- 不处理裸链接正则（md.ts:55，无绕过面）。
- 不恢复/不改变 `<img src>` 的 `data:` 全禁现状（维持 P0-2 语义）。
- 不处理 DEL `\x7f`（WHATWG 不剥离，实测不可执行）。
- 不改变协议相对 URL `//host` 的现行放行语义。
- 不重构 Markdown 渲染器，不引入依赖，不动 `escapeHtml`/`escapeAttr` 契约。
- `.tmp-skills/` 等未跟踪文件不触碰；本阶段不 add/commit/push。

## 12. 实施阶段验收标准

1. 变更仅限 `src/lib/md.ts` + `src/lib/md.test.ts`，`git diff` 行数与 §8 预估一致，无其他文件。
2. `npm test`（vitest run）全绿：现有用例零回归 + §9 新增用例全过。
3. `npm run build` 的 `tsc` 阶段零错误。
4. §3 端到端矩阵在修复后重跑：#1-#12 全部「拒绝」或最终协议 ∉ `{javascript:, data:}`；#13-#18 输出与基线逐字节一致。
5. 实施完成后需独立复审（R1-C）方可进入提交门禁（R1-D），不得直接 commit。

---

### 附：验证方法与副作用确认

- 全部验证经 `node -e` + esbuild JS API（`write:false`）在内存完成，**无任何文件写入、无测试框架运行、无网络访问**；git 状态复核与本阶段开始前一致。
- 证据文件：本报告；关键原始输出见复核会话记录（esbuild 打包真实 `md.ts` 的 22 向量矩阵 + Node WHATWG 15 向量直测）。
