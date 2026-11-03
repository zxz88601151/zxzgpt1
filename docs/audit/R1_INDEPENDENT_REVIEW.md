# Phase R1 独立复审报告

角色：独立复审人（只读 + 临时探针，探针文件测后即删，不留入仓）
被审对象：工作区未提交改动 `src/lib/md.ts`、`src/lib/md.test.ts`（R1 Markdown URL 控制字符绕过修复）
基线：`35b56c0`（Phase C1-F 提交）
复审时间：2026-11-02
结论：**`PASS`｜`READY_FOR_R1_LOCAL_COMMIT`**

---

## 一、复审前重新实测的基线（不采信实施报告）

| 项 | 命令 | 实测 |
| --- | --- | --- |
| HEAD | `git rev-parse --short HEAD` | `35b56c0` |
| 已跟踪改动 | `git status --porcelain` | 仅 `src/lib/md.ts`、`src/lib/md.test.ts` 两个 `M` |
| 未跟踪 | 同上 | `.tmp-skills/` + 6 份 `docs/audit/*.md`，与 C1-F 复审记录一致 |
| `md.ts` 改前 blob | `git rev-parse HEAD:src/lib/md.ts` | `879db54`（234 行） |
| `text.ts` 是否被动过 | HEAD 与工作区 md5 对比 | 两者同为 `03518d7e02d58431c673b990eea43722` → **零改动** |
| 依赖与版本 | `git status` + `grep version package.json` | `package.json`/lock 未修改，version `0.3.0` |

## 二、代码事实核对

逐行读 `md.ts` 与 `git diff`，确认实施报告所述与代码一致：

| 报告声称 | 代码实测 | 判定 |
| --- | --- | --- |
| 白名单在 `md.ts:18` | `const SAFE_SCHEMES = new Set(["", "http", "https", "mailto", "tel"]);` | 一致 |
| 协议识别在 `md.ts:27-32` | `browserScheme()`：`replace(/[\t\n\r]/g,"")` → `^[\x00-\x20]+`/`[\x00-\x20]+$` 剥离 → `^([a-zA-Z][a-zA-Z0-9+\-.]*):` | 一致 |
| 判定替换在 `md.ts:65` | `if (!SAFE_SCHEMES.has(browserScheme(clean))) return keep(escapeHtml(label));` | 一致 |
| 黑名单已彻底移除 | `grep -n "javascript:" src/lib/md.ts` | 仅命中第 22 行注释文字，无正则残留 |
| 属性写出仍用 `escapeAttr(clean)` | `md.ts:67-68` | 一致，转义职责未改动、未回退 |
| 规范化结果不回写属性 | `clean` 自 `String(rawUrl).trim()` 后未被重新赋值；`browserScheme` 内部用局部变量 | 一致，无「删字符后再检查再落地」的歧义 |
| 图片分支同样受守卫 | 单一判定在 `<img>`/`<a>` 分支之前 | 一致 |
| 未改其他 Markdown 渲染 | `git diff` 仅新增常量/函数 + 替换一行判定 | 一致 |

## 三、独立验证（复审人自测，非复述实施报告）

### 3.1 变异测试：证明新用例真的能抓回旧漏洞

做法：把 `md.ts` 的守卫复制件回退为旧黑名单 `^\s*javascript:/^\s*data:`，用同一份 `md.test.ts`（仅改 import 路径）跑。

结果：`15 failed | 39 passed (54)`。失败的 15 条全部是 R1 新增用例，包括：

```
协议名内 TAB / LF / CR、前导 C0 \x01 / \x00、大小写混合 + TAB、
data 协议名内 TAB、vbscript、about、blob、file、view-source、chrome、
未知协议默认拒绝、块级 renderMarkdown 路径
```

样例失败输出（旧代码实际产出可点击链接）：

```
FAIL 协议名内 TAB → expected '<a href="java\tscript:alert(1)" target="_blank" …' not to match /<a\s/
FAIL file       → expected '<a href="file:///C:/Windows/win.ini" …' not to match /<a\s/
FAIL data 协议名内 TAB → expected '<img src="da\tta:text/html;base64,AA" alt="x" …' not to match /<img\s/
```

仍通过的 12 条 R1 用例说明它们是「一致性断言」而非「漏洞断言」：`协议名前 TAB/CR`、`前导 \x0c`、`尾随 C0 \x02` 旧黑名单靠 `\s` 本就能挡（`\s` 含 `\t\n\r\f\v` 与空格），NUL 内部打断、白名单落地、相对路径、percent/实体、`&` 单次转义、混排引号、label 尖括号属回归护栏。

判定：**新用例可抓回被修漏洞，且非恒真断言。**

### 3.2 控制符全位置注入模糊测试（危险 3159 例 + 对照 468 例）

对 `javascript:` / `vbscript:` / `file:` / `data:` / 未知 `beacon:` 五个目标串，把 `0x00-0x20` 全部控制符加 6 个 Unicode 空白类字符（U+2028/2029/3000/2060/A0 等），逐个插入目标的**每一个位置**，走真实 `renderInline`，再用 WHATWG `URL`（与浏览器同一算法）读最终协议：

```
断言：所有产出的 href/src 的最终协议 ∈ {http:, https:}（即永远不会是脚本类协议）
结果：offenders = [] 通过
```

对照组：合法串 `https://x/a` 同样全位置注入 468 例，产出协议集合仅 `{https:, http:, THROW}`：

- `https:` —— 控制符落在协议名之后（如 `https:/\tx/a` 前缀完整）
- `http:` —— 控制符打断协议名，解析器判为无协议 → 按 base 展开成相对路径，惰性
- `THROW` —— 全部形如 `https:\x00//x/a`、`https: //x/a`（host 缺失/非法 host），浏览器同样拒绝导航，惰性

判定：**未发现白名单绕过；未出现过度封禁（合法 https 链接从未被误杀成非 http/https）。**

### 3.3 定向边界探针（13 例）

| 输入 | 最终协议 | 说明 |
| --- | --- | --- |
| `[a](<java\tscript:alert(1)>)` | `http:` | `<` 使解析器与 `browserScheme` 同时判为无协议，两侧一致；本渲染器不支持 CommonMark `<url>` 语法（既有行为） |
| `[a](java\tscript&#58;alert(1))` / `&colon;` | `http:` | 实体不被还原（P0-2 保证），字面冒号不存在 → 无协议 |
| `[a](javascript%3Aalert(1))` | `http:` | percent 冒号不参与协议判定 |
| `[a](java\tscript\t:alert(1))` | 无链接 | 冒号前后插 TAB：解析器删全部 TAB → 判 `javascript:`；白名单同判断为危险，拦下 |
| `[a](\t\u0000 javascript\t:alert(1))` | 无链接 | 多重前导控制符 + 内部 TAB，拦下 |
| `[a](&Tab;javascript:alert(1))` | `http:` | 具名实体 `&Tab;` 未被还原，解析器看到的是字面串 |
| `[a](  java\u0000script:alert(1))` | `http:` | 协议名内含 NUL → 无协议 |
| `[a](JaVa\tScRiPt\t:\tALERT(1))` | 无链接 | 大写 + 三处 TAB，拦下 |
| `[a](/**/javascript:alert(1))` | `http:` | URL 注释语法不被解析器支持，判为相对路径 |
| `![x](<da\tta:text/html,x>)` | `http:` | 图片分支同样受同一守卫，且降级不产出 `<img>` |
| `[x](https://ok/a?u=java\tscript:alert(1))` | `https:` | **不过度封禁的正例**：合法链接的查询串里含 `javascript:` 子串仍正常渲染 |

判定：`browserScheme` 与 WHATWG 解析器的判定在本轮全部探针中一致。

### 3.4 渲染面完整性：是否存在绕过 md.ts 的第二条 URL 通路

| 通路 | 实测 | 判定 |
| --- | --- | --- |
| `grep -rn "dangerouslySetInnerHTML" src` | 仅 `MessageList.tsx:57/87`（正文与思维链），二者均为 `renderMarkdown(...)` 输出 | 受白名单覆盖 |
| `renderMarkdown` 调用点 | 仅 `MessageList.tsx:40/57` | 唯一入口 |
| `grep innerHTML` 赋值 | 代码中无，仅命中内置技能文档 `security-check.md` 的文字 | 无第二 sink |
| 裸链接自动识别 `md.ts:74` | 正则强制 `https?://` 前缀，协议不可能是脚本类 | 安全 |
| `SkillPanel.tsx:333` `href={repoUrl(e)}` | `sources.ts:539-541` 为模板串 `https://github.com/${id}`，协议固定，且走 React JSX 属性而非字符串拼接 | 无 R1 关系，非漏洞 |

### 3.5 门禁复测（复审人重跑）

| 门禁 | 结果 |
| --- | --- |
| `npx vitest run src/lib/md.test.ts` | 54 passed |
| `npm test` | 15 files / **319 passed**，15 个文件全绿 |
| `npx tsc --noEmit` | exit 0（复审人显式检查退出码，非只看输出） |
| `npm run build` | exit 0，`✓ built in 2.31s`，产物 327.99 kB |
| 复审全部临时文件清理 | `__r1mut_md.ts`/`__r1mut.test.ts`/`__r1fuzz.test.ts`/`__r1probe.test.ts` 已删除；`md.ts` md5 `03f3c790…`、`md.test.ts` md5 `39f7ddd7…` 与被审状态逐字节一致 |

### 3.6 范围合规

`git diff --stat` 为 `md.test.ts +114 / md.ts +23-3`，合计 2 文件 134 插入 3 删除。`App.tsx`、`appcontrol.ts`、`fsapi.ts`、`src-tauri/**`、`package.json`、lock、版本号、其他未跟踪文档与 `.tmp-skills/` 全部未触碰。无新增依赖。未执行任何 `git add`/`commit`/`push`/远端操作/构建发布。

## 四、发现清单

### D1｜实施报告一处事实错误 —— 已更正（文档级，不影响代码准入）

`R1_IMPLEMENTATION.md` §六 原写「`mailto:` / `tel:` 是本次新引入的放行面」。实测反驳：旧黑名单只匹配 `javascript:` / `data:`，`mailto:`、`tel:`、`vbscript:`、`file:` 在改前均可落地（见 §3.1 变异测试里 `vbscript:`/`file:`/`blob:` 的失败输出）。因此 `mailto`/`tel` 不是新增放行面，只是从「未拦」变成「显式承诺」。

复审人已就地更正该条，并补记一条同类事实：空 URL `[a]()` 仍产出 `href=""`（白名单视作「无协议」），属既有行为，非本次引入。

分级：`NON-BLOCKING`（文档措辞），已修，代码零改动。

### O1｜`finalProtocols` 测试辅助未捕获 `URL` 构造异常

`md.test.ts:162` 无 try/catch，若某次渲染产出畸形 URL，测试会以「抛错」形式失败而不是静默通过。复审人在 §3.2 用带捕获的独立版本跑过模糊测试。分级：`NON-BLOCKING`（当前失败模式是显式的，不会掩盖问题）。

### O2｜模糊测试未纳入正式用例

§3.2/§3.3 的探针（3159 + 468 例，vitest 单文件运行 <1 s、用例自身 86 ms）价值高于现有 27 条定点用例，但它是复审人临时脚本，已按要求删除，未混入提交白名单。建议业主在 R1 提交后单独批准一个小批次，把「全位置控制符注入」固化为 `md.test.ts` 内的一条参数化用例。分级：`RECOMMENDATION`。

### O3｜内置技能文档与实现的口径差

`src/skills/builtin/security-check.md:20` 写「URL 参数进 `href` 前校验协议（只允许 http/https，拒绝 `javascript:`）」。实现现在是 `{"", http, https, mailto, tel}`。该文件是给模型看的规范文本，不参与代码逻辑，无耦合测试。分级：`PRE-EXISTING`/`NON-BLOCKING`，可与 README 文档同步批次一并处理。

### O4｜README 三处口径待同步（承接实施报告 §六 2）

`README.md:413` 仍是黑名单措辞、`:40` 写 150 条单测、`:365` 写纯逻辑单测 246 条（现 319）。授权书把 R1 提交限定为代码 + 测试，本阶段不动文档。分级：`NON-BLOCKING`，需业主单独裁决。

**撤回说明：本轮复审未提出任何仅凭阅读代码就断言的漏洞发现；上述 D1 与全部结论均附实测命令与输出。**

## 五、准入判定

| 判据 | 结果 |
| --- | --- |
| 漏洞真实可达（改前可执行脚本协议） | 已复现（变异测试输出 + WHATWG 裁判） |
| 修复策略与授权书一致（协议白名单优先） | 是 |
| 未引入新的解析歧义（不回写规范化串） | 是，`clean` 未被改写 |
| 未改变 `escapeAttr` 职责、未回退 P0-2 | 是（`text.ts` md5 与 HEAD 相同；P0-2 11 条仍绿） |
| 覆盖所有 URL 输出通路 | 是（正文/思维链同一渲染器；裸链接限 http(s)） |
| 新用例能抓回漏洞且非恒真 | 是（回退黑名单 → 15 条失败） |
| 范围合规（无越界改动、无依赖、无文档混入） | 是 |
| 四项门禁 | 全绿 |

**判定：`PASS`｜提交准入：`READY_FOR_R1_LOCAL_COMMIT`**

复审人未执行 `git add`、`git commit`、`git push`，未修改 `src/lib/md.ts` 与 `md.test.ts` 的任何一个字节（md5 前后一致），临时探针文件全部删除。提交动作留给业主指令。

远端状态：`NOT_PUSHED`。
