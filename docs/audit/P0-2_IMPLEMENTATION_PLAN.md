# P0-2 实施前设计报告 — Markdown 渲染安全修复

> 阶段：P0-2-A（实施前设计与证据锁定，**非实施授权**）
> 角色：安全架构师 / 前端安全审计员 / 修复计划制定者
> 纪律：全程只读；唯一写操作即本报告
> 基线：`7ea1eb3`（docs）→ 工作区干净（仅 `.tmp-skills/` 与 P0-1-F 复审报告为未跟踪项）
> 结论先行：所有攻击向量均已**用现有代码实测复现**（esbuild 打包 + node 执行，纯内存，无写盘），非推演。

---

## 1. 现状与证据

### 1.1 渲染链路全景（用户输入 → DOM）

```
msg.content / msg.reasoning（模型输出，不可信）
  └─ MessageList.tsx:40,57  renderMarkdown(body)
       └─ md.ts:121 renderMarkdown
            ├─ 抽出代码块 → renderCodeBlock（md.ts:15）
            │     └─ escapeHtml(code) → highlight() → <pre><code>（文本上下文，安全）
            ├─ 抽出行内代码 → escapeHtml → <code>（安全）
            └─ 块级分行 → renderInline（每个文本节点）
                   └─ md.ts:37 text = escapeHtml(input)   ← 只转义 & < >，不转义引号
                   └─ md.ts:40-46 链接/图片：URL 与 label 直接插进 href=/src=/alt=   ← 注入点
       └─ MessageList.tsx:87  dangerouslySetInnerHTML={{ __html: md }}   ← DOM 落点
```

其他注入点排查（全部安全，已逐一看过源码）：

| 位置 | 内容来源 | 判定 |
|---|---|---|
| `MessageList.tsx:51` 用户消息 | React 文本节点 `{msg.content}` | 安全（React 自动转义） |
| `MessageList.tsx:57` reasoning | `renderMarkdown` | **与主链路同一注入面**（本次修复覆盖） |
| `ui.tsx:41` Icon | `PATHS[name]` 静态常量（`as const`） | 安全，无用户输入 |
| `md.ts:22,25` `data-copy-target="${id}"` | `id = "cb-" + uid()`，字母数字 | 安全 |
| `md.ts:23` code-head | `escapeHtml(head)` 文本节点 | 安全 |
| `hl.ts:28 highlight()` | 输入契约"必须是已转义的 HTML 文本"（hl.ts:4 注释），调用方 md.ts:16 先 escapeHtml | 安全 |

**全项目 `dangerouslySetInnerHTML` 仅 3 处**（MessageList ×2、ui.tsx ×1），已全部核实。

### 1.2 允许的标签与属性

白名单即"本模块自己生成的标签"（md.ts:5 注释）：`p/h1-6/ul/ol/li/blockquote/table/hr/br/strong/em/del/code/pre/div/span/button/a/img`。
属性仅：`href`（a）、`src`/`alt`/`loading`（img）、`target`/`rel`、`class`、`id`、`data-copy-target`。
**不允许原始 HTML**：用户输入的 `<script>` 等经 escapeHtml 变为文本（md.test.ts:77 已有断言）。
`javascript:` / `data:` 协议有黑名单拦截（md.ts:42，md.test.ts:70-73 已有断言）。

### 1.3 实测复现（esbuild 打包现有源码 + node 执行，输出原文）

| # | 输入 | 实测输出 | 判定 |
|---|---|---|---|
| 1 | `[a](https://x/" onclick="alert(1))` | `<a href="https://x/" onclick="alert(1)" target="_blank" rel="noreferrer noopener">a</a>` | **属性突破成立** |
| 2 | `![x" onerror="alert(1)](https://a/b.png)` | `<img src="https://a/b.png" alt="x" onerror="alert(1)" loading="lazy" />` | **属性突破成立，且 onerror 加载即执行，无需点击** |
| 3 | `[a](https://x/?q=1&amp;b=2)` | `href="https://x/?q=1&amp;b=2"` | md.ts:41 把 `&amp;amp;` 还原回 `&amp;` |
| 4 | `[a](https://x/&#x22; onmouseover=&#x22;alert(1))` | href 内含 `&#x22;` 实体 | **不突破**：实体在属性解析后才解码，无法闭合属性 |
| 5 | `[q](https://x/?a=1&b=2)` | `href="https://x/?a=1&b=2"`（裸 `&` 直出） | 兼容性基线 |
| 6 | `[a](https://x/' onx='y)` | 单引号原样留在属性值内 | **不突破**：属性定界符是双引号 |
| 7 | `[a](https://x/ "title")` | `href="https://x/ "title""` | **标题语法也产生裸引号**（另一个突破路径），且 title 未被剥离 |
| 8 | `[a](JaVaScRiPt:alert(1))` | `a`（拦截，label 直出） | 黑名单有效（大小写不敏感 `/i`） |
| 9 | `[a](file:///etc/passwd)` | `<a href="file:///etc/passwd" …>` | **file: 协议未拦截**（仅 a 标签需点击；img 的 file: 在生产 CSP 下被 img-src 挡住） |

**关键事实**：突破只可能经**裸双引号**完成（#1/#2/#7）；实体形态（#4）与单引号（#6）都不行。

---

## 2. 安全问题清单

| 编号 | 严重度 | 问题 | 证据 | 事实/推测 |
|---|---|---|---|---|
| P0-2-A1 | **High** | 裸双引号经 URL 或 label 注入属性 → `onerror`/`onclick` 等事件属性注入 | 实测 #1/#2/#7；`text.ts:7-9`（不转义引号）+ `md.ts:44-45`（直接插值） | **事实（实测）** |
| P0-2-A2 | **Medium** | `md.ts:41` 的 `.replace(/&amp;/g,"&")` 主动还原转义，使 URL 上下文逃脱 escapeHtml 的保护 | 实测 #3；该行自初始提交 `f5bdc2d` 即存在 | **事实（实测）** |
| P0-2-A3 | Low | `file:` 等协议不在黑名单（仅拦 `javascript:`/`data:`） | 实测 #9 | **事实（实测）**；影响有限：a 需点击，img 被生产 CSP 拦截 |
| P0-2-A4 | Low | `img-src`/`connect-src` 含 `http: https:` 宽放行（远程图片可追踪 IP） | `tauri.conf.json:28` | **事实**；connect-src 宽放行有业务理由（任意模型 API 端点） |

**CSP 缓解现状（重要边界）**：生产 CSP `script-src 'self'`（无 `unsafe-inline`）可拦截内联事件处理器与 `javascript:` 的执行——**打包应用内 A1 当前不可执行**；但 `devCsp` 带 `'unsafe-inline'`，**`tauri dev` 开发态可执行**；且 CSP 是深度防御层，不构成不修转义的理由（malformed HTML 仍在，CSP 一旦放宽立即复活）。

---

## 3. md.ts:41 定性结论

源码（md.ts:40-41）：

```ts
text = text.replace(/!?\[([^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (m, label, rawUrl) => {
    const clean = String(rawUrl).replace(/&amp;/g, "&").split(/\s+&quot;/)[0];
```

逐段判定：

| 片段 | 行为 | 判定 |
|---|---|---|
| `.replace(/&amp;/g, "&")` | 把 escapeHtml 产生的 `&amp;` 还原为裸 `&` 再插进 href | **有实际效力的危险还原**。其初衷推测是"让 `?a=1&b=2` 链接看起来正确"——但浏览器在 href 属性值内会自动解码 `&amp;`→`&`，该还原毫无必要（实测 #5 对照：保留转义输出 `&amp;`，浏览器行为完全一致） |
| `.split(/\s+&quot;/)[0]` | 按"空白+`&quot;`"切掉后半段，疑似想剥离 Markdown 标题语法 `[x](url "title")` 的 title | **死代码**：escapeHtml 从不产生 `&quot;`（引号不被转义），该分隔串永远不会出现。实测 #7 证明 title 既未被剥离、还造成了裸引号 |

**来源**：`git log -S` 与 `--diff-filter=A` 均指向 `f5bdc2d`（首次入库提交），无更早历史可考。

**定性**：**缺陷性兼容逻辑 / 遗留死代码组合，无证据支持"恶意后门"定性**。
`.replace` 部分是"不必要的转义还原"（功能性误解），`.split` 部分是与 escapeHtml 行为不匹配的失效分支（疑似按"escapeHtml 会转义引号"的错误假设编写）。
但**无论动机如何，A1+A2 叠加构成真实注入面，必须修复**；修复方式即删除该行两个有害片段（见 §6），并补回归测试防止再以"兼容性"名义复活。

---

## 4. 回归测试矩阵

现状：`src/lib/md.test.ts`（101 行，15 个用例）+ `src/lib/hl.test.ts` + `text.test.ts`。
已有覆盖：块级元素、列表嵌套、表格、代码块、行内代码优先、标题去尾 `#`、引用/分割线、段落、强调、链接生成、`javascript:`/`data:` 拒绝、`<script>` 文本转义、`<img …>` 整体转义（md.test.ts:75-78）、硬/软换行、file: 信息串。

| 类别 | 用例 | 现状 |
|---|---|---|
| HTML 文本转义 | `<script>`→文本、`<img onerror>`→文本 | ✅ 已有（md.test.ts:75-78） |
| 单/双引号 | `escapeHtml` 引语行为 | ⚠️ text.test.ts:6 **断言了"不转义引号"的现状**（修复方案的关键约束，见 §6） |
| **属性上下文** | URL 裸双引号 → `href` 突破（实测 #1） | ❌ **缺失** |
| **属性上下文** | label 裸双引号 → `alt` 突破（实测 #2） | ❌ **缺失** |
| **属性上下文** | title 语法 `url "title"` 不再产生裸引号（实测 #7） | ❌ **缺失** |
| Markdown 正常渲染 | 链接/列表/表格/标题 | ✅ 已有 |
| 代码块与行内代码 | 代码内 `#` 不变标题、行内代码优先 | ✅ 已有 |
| 原始 HTML 边界 | `<script>` 拒绝 | ✅ 已有（半个边界；`<svg/onload>` 等未测，但同为文本转义路径，风险低） |
| URL 协议边界 | `javascript:`/`data:` 大小写变体 | ✅ 已有（`/i`）；❌ `file:`、前导空白+协议（`java\tscript:` 这类靠 `^\s*` 已拦）未测 |
| **转义还原后门** | 输入含 `&amp;` 不被还原（A2 回归） | ❌ **缺失** |
| **历史兼容性** | `?a=1&b=2` 链接浏览器行为不变（HTML 源变为 `&amp;`） | ❌ **缺失**（新增断言锁定） |

**需新增 8 条**（实施时加入 md.test.ts）：#1 双引号 URL、#2 双引号 label、#7 title 语法、A2 还原后门（`[a](https://x/?q=1&amp;b=2)` 输出须保留 `&amp;amp;` 或不出现裸 `&`）、`&amp;quot;` 输入不复活引号、file: 协议决策用例、合法 `&` 参数链接、大小写 `JaVaScRiPt:` 拦截。
text.test.ts:6 的断言在选定方案 B 下**无需改动**（见下）。

---

## 5. CSP 复核（e87bc17 实际生效内容）

`tauri.conf.json:28-29`（经 `git show e87bc17` 核对，与当前文件一致）：

| 指令 | 生产值 | 评估 |
|---|---|---|
| `script-src` | `'self'` | ✅ 严格，无 `unsafe-inline`；拦截 A1 的内联事件执行 |
| `script-src`（dev） | `'self' 'unsafe-inline'` | ⚠️ 开发态宽松，A1 在 `tauri dev` 可执行（开发机自损风险） |
| `style-src` | `'self' 'unsafe-inline'` | ⚠️ 宽松但属常见妥协（无内联样式开关的 Vite 应用需要）；无脚本风险 |
| `img-src` | `'self' data: blob: http: https:` | ⚠️ 宽放行：`<img src=http…>` 可达任意远程（追踪/钓鱼图床）；`data:` 在 img 上下文不可执行脚本 |
| `connect-src` | `ipc: … http: https:` | ⚠️ 宽放行，业务必需（多模型 API 端点）；保留 |
| `object-src/base-uri/frame-ancestors/form-action` | `'none'`/`'self'`/`'none'`/`'none'` | ✅ 严格 |
| 冲突/重复 | 无 | devCsp 与 csp 并存是 Tauri 标准机制，非冲突 |

**结论**：CSP 已实际生效且生产态合格，是 A1 的**执行层缓解**而非修复；Markdown 转义缺陷（malformed HTML 生成 + dev 态可执行 + 未来 CSP 收紧/放松的脆弱性）仍须修复。CSP 不充当转义的替代品。

---

## 6. 最小修复方案（Addititve Only，不重构渲染引擎）

### 方案 B（推荐）：新增 `escapeAttr`，不动 `escapeHtml`

**约束**：`text.test.ts:6` 明文断言 `escapeHtml('<a href="x">&\'') === '&lt;a href="x"&gt;&amp;\''`——直接给 escapeHtml 加引号转义会破坏现有测试（且 text.test.ts 断言的是纯文本语义，合理）。故走纯新增路径。

**改动 1 — `src/lib/text.ts`（新增导出，约 3 行）**

```ts
/** 属性值转义：在 escapeHtml 基础上加双引号，专用于插值进 "..." 属性 */
export function escapeAttr(s: unknown): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
```

**改动 2 — `src/lib/md.ts:40-46`（精确替换两行片段）**

```ts
// 现状（md.ts:41）
const clean = String(rawUrl).replace(/&amp;/g, "&").split(/\s+&quot;/)[0];
// 目标
const clean = String(rawUrl).trim();
```

```ts
// 现状（md.ts:43-45）
return m.startsWith("!")
  ? keep(`<img src="${clean}" alt="${label}" loading="lazy" />`)
  : keep(`<a href="${clean}" target="_blank" rel="noreferrer noopener">${label}</a>`);
// 目标（label 已转义，仅属性位加 escapeAttr；文本位不变）
return m.startsWith("!")
  ? keep(`<img src="${escapeAttr(clean)}" alt="${escapeAttr(label)}" loading="lazy" />`)
  : keep(`<a href="${escapeAttr(clean)}" target="_blank" rel="noreferrer noopener">${label}</a>`);
```

- `import { escapeHtml, uid } from "./text"` → 补 `escapeAttr`。
- `javascript:`/`data:` 黑名单（md.ts:42）保留不动——协议判定在**未还原**的 clean 上做，行为不变。
- 裸链接分支（md.ts:49-51）：URL 来自 `https?://` 匹配、字符集不含 `"`，理论安全；为一致性可对 `url` 同样套 escapeAttr（1 处，建议做，成本为零）。
- `renderCodeBlock`/`data-copy-target` 等其余插值点维持现状（输入源已证安全），**不扩散改动**。

| 项 | 内容 |
|---|---|
| 原始行为 | 裸 `"` 原样进 href/alt；`&amp;` 被还原；title 语法产出 malformed HTML |
| 目标行为 | 属性内引号一律 `&quot;`；实体不被还原；title 语法产出安全（title 保留在 href 内，浏览器正常跟随） |
| 最小修改范围 | 2 个文件：text.ts（+3 行）、md.ts（改 4 行 + import 1 行） |
| 兼容性影响 | ① 含 `&` 的 URL：HTML 源变为 `&amp;`，浏览器解码后行为**完全一致**（实测 #5 对照）；② 含 `"` 的 URL/label：此前是 malformed/恶意 HTML，无合法用户依赖可言；③ title 语法：此前已坏，修复后变为"title 并入 href"的安全行为——如实记录为行为变化；④ text.test.ts、md.test.ts 现有 15 条断言**预计全部原样通过**（无一断言裸 `&`/裸引号输出） |
| 对应测试 | §4 新增 8 条 |
| 回滚方案 | 单 commit  revert 即恢复现状；无数据结构/接口变化 |

### 备选方案 A（不推荐）：直接给 `escapeHtml` 加 `"` 转义

少一个函数，但需改写 `text.test.ts:6` 的既有断言（把修复成本转嫁为"修改旧测试"），且改变全项目共享函数的语义面。违背本任务 Additive Only 原则，**不推荐**。

### 明确不做（防止范围蔓延）

- 不重构/替换整个 Markdown 引擎（继续零依赖自实现）；
- 不引入 DOMPurify 等依赖；
- 不改黑名单为完整协议白名单（A3 `file:` 影响有限，列入"待决策"而非本次修复；若业主决定拦截，改动是 md.ts:42 一行，随本任务顺带做并加用例）；
- 不动 CSP（已合格；`img-src` 收紧列入 P6 产品化候选）。

---

## 7. 兼容性风险汇总

| 风险 | 等级 | 说明 |
|---|---|---|
| 合法 `&` 参数链接的视觉/行为变化 | **无** | HTML 源 `&`→`&amp;`，浏览器属性解码后等价；补 1 条断言锁定 |
| title 语法 `[x](url "title")` 行为变化 | 低 | 修复前是 malformed HTML（实测 #7），无合法依赖；修复后 title 并入 href 安全输出 |
| 其他模块引用 escapeHtml | 无 | escapeHtml 语义零变化；新增 escapeAttr 无既有调用方 |
| 流式渲染路径 | 无 | renderInline 同源，修复自动覆盖流式与静态 |
| `npm test` / e2e | 低 | md/text 相关断言预计原样通过；全量测试作为实施验收的一部分实跑 |

---

## 8. 修复验收标准（实施阶段执行）

1. 实测 #1/#2/#7 三条 PoC 经修复后输出中**不含**裸双引号属性突破（`onerror=`/`onclick=` 不作为可解析属性出现），以新增 vitest 用例固化；
2. 输入含 `&amp;` / `&quot;` / `&#x22;` 时输出不出现对应实体的还原（A2 回归）；
3. `[q](https://x/?a=1&b=2)` 浏览器跟随行为不变（HTML 源 `&amp;`）；
4. md.test.ts 现有 15 条用例**零修改通过**（若出现失败，禁止通过放宽断言"适配"，必须复盘方案）；
5. 新增 ≥8 条用例全绿；`npm test`、`tsc --noEmit`、`vite build` 全绿；
6. `grep -n "replace(/&amp;/g" src/lib/md.ts` 无命中；
7. 人工抽查：正常对话渲染（链接/图片/代码块/表格）无视觉回归。

---

## 9. 尚未解决的问题（提交业主决策，不阻塞修复主体）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| Q1 | `file:`/`mailto:`/`tel:` 协议是否纳入拦截（A3） | 低（a 需点击；img 被 CSP 拦） | 默认本次顺手拦截 `file:`（一行改动 + 1 用例）；`mailto:`/`tel:` 属合法，不拦 |
| Q2 | devCsp 的 `'unsafe-inline'`（script-src）是否在开发态也去掉 | 开发态自损面 | 需验证 Vite HMR 是否依赖；建议单独立项，不在 P0-2 |
| Q3 | `img-src http: https:` 是否收紧到 `data: blob:` | 远程图床追踪 | 收紧可能阻断用户贴图习惯，列入 P6 |
| Q4 | `<svg/onload>` 等原始 HTML 经文本转义已安全，是否需要显式用例 | 极低 | 新增用例成本一行，建议顺手加 |

**Q1 / Q4 处置（2026-11-02 业主授权，已实施）**

| # | 处置 | 证据 |
|---|---|---|
| Q1 | `file:` 拦截已由 R1 协议白名单落地（`SAFE_SCHEMES` 默认拒绝），`mailto:`/`tel:` 按建议保持放行；本次补齐 `file:` 的**图片形态**与**大写协议**两条用例——原用例只覆盖了链接形态，而 Q1 的影响评估把 img 侧依赖记在 CSP `img-src` 上，那属部署态，不能当已拦 | [md.ts:18](file:///F:/zhuomian/zxz/src/lib/md.ts#L18) + `src/lib/md.test.ts` 危险协议表 |
| Q4 | 新增 4 条用例：行内 4 种写法只剩转义文本（输出里没有裸 `<`）、块级 6 条路径（段落/标题/无序列表/有序列表/表格/引用）都不产生元素、合法链接 label 内嵌 `<svg/onload>` 时 href 照常放行、代码块内不逃出 `<code>` | `src/lib/md.test.ts` describe「原始 HTML 标签经文本转义（P0-2 Q4）」 |

**Q2 / Q3 处置（2026-11-02 业主授权）**

| # | 结论 | 实测证据 |
|---|---|---|
| Q2 | **devCsp 的 `script-src 'unsafe-inline'` 不能无条件删除**：它不是应用代码的需要，而是 `@vitejs/plugin-react` 在 dev server 上注入的内联 Fast Refresh preamble 的需要。原建议「需验证 Vite HMR 是否依赖」→ 已验证：**依赖**。本轮**未改** devCsp，改为记债 D18 并给出可选路径 | ① 真起 dev server 抓 HTML：`hmr: true` → 3 个 script 标签，其中 **1 个内联**（`import { injectIntoGlobalHook } from "/@react-refresh"`）；`hmr: false` → 2 个标签，**内联 0 个**；② 插件源码 `node_modules/@vitejs/plugin-react/dist/index.js:140` `skipFastRefresh = isProduction \|\| command === "build" \|\| config.server.hmr === false`，`:258` 据此决定是否注入；③ 生产产物 `dist/index.html` 只有 1 个外链 script → 生产 `script-src 'self'` 无内联依赖，与 Q2 无关 |
| Q3 | **已实施收紧**：`img-src` 从 `'self' data: blob: http: https:` 改为 `'self' data: blob:`，`csp` 与 `devCsp` 两条串同步。唯一行为损失＝模型回答里的远程图片（`![](https://…)`）不再被 WebView 自动拉取（这正是「图床可看到本机 IP」的追踪面）；原建议担心的「阻断用户贴图习惯」经核查**不成立**——本项目没有贴图/图片附件功能 | ① 应用自身图片全部同源：`ui.tsx:2` / `Welcome.tsx:2` 导入 `src/assets/avatar*.png`，产物里是 `/assets/avatar-sm-DlOOgIuV.png`、`/assets/avatar-DScMxy2X.png` → `'self'` 放行；② 站点图标是 `data:image/svg+xml`（`index.html:10`）→ `data:` 保留即放行；③ `src/**/*.css` 里 `url(` **零命中**，无 CSS 远程图；④ 全仓 `convertFileSrc` **零命中**，没有走 Tauri asset 协议的本地图；⑤ `App.tsx:1151-1171` 的 `FileReader` 只解析 JSON 导入，`src/**` 里 `paste/clipboardData` **零命中** → 不存在把剪贴板图片变成本地 `blob:`/`data:` 图的路径；⑥ blob: 保留，导出的 `<a download>` 不受影响 |

- 验收（两轮合并）：`vitest` 全量 15 文件 / **325** 通过（基线 319，+6 全为 Q1/Q4 新增），现有断言**零修改**；`tsc --noEmit` 0 错误；`src/lib/md.ts`、`text.ts` 未改动；`vite build` 绿；`tauri.conf.json` 经 `require()` 解析通过，CSP 串其余指令零改动。（D16 批次新增 1 条后为 **326**，见 `TECHNICAL_DEBT.md` D11。）
- ~~Q3 的桌面宿主实测缺口~~ → **已闭合（2026-11-02 O1 重编）**：宿主重编后交付产物内嵌串为
  `img-src 'self' data: blob:;`（csp + devCsp 各 1，旧串 0 命中），并在真实桌面宿主上实测：
  跨源图 `<img>` 元素正常生成但 `naturalWidth=0`、**图片服务器零网络命中**、控制台留下 CSP 违规原文，
  同源自带头像照常加载。取证与断言明细见 `docs/audit/O1_RELEASE_HOST_VALIDATION.md` §1.1、§4；
  该轮遗留的两个缺口（跑在"仅多一个 CDP 浏览器参数"的 release 变体上、`data:`/`blob:` 未单独断言）在同文档 §6 明示。

---

## 10. 最终状态

**`READY_FOR_PHASE_P0-2_IMPLEMENTATION_AUTHORIZATION`**

- 修复范围精确锁定：text.ts +3 行、md.ts 改 5 行，备选决策点仅 Q1 一处；
- 全部安全结论有源码行号 + 实测输出双证据；
- md.ts:41 已定性（缺陷性兼容逻辑 + 死代码，非恶意后门，无证据支持恶意）；
- 测试矩阵缺口明确（8 条新增），现有断言预计零修改；
- 兼容性影响可枚举、可回滚。

**本报告不构成实施授权。按纪律 STOP，等待业主决定是否正式启动 P0-2 实施。**
