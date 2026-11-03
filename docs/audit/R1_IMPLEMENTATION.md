# Phase R1 实施报告 —— Markdown URL 控制字符绕过修复

状态：`READY_FOR_R1_REVIEW`（未提交，未推送）
基线：`35b56c0`（Phase C1-F 本地提交）
执行时间：2026-11-02
授权依据：《Phase C1-F + R1｜受控整改与本地提交授权》第三条第 3、4 项（R1 实施 + R1 独立测试复审）

---

## 一、动手前重新核实的基线

授权书要求「不得假设仓库状态没有变化」，实施前重新测量：

| 项 | 核实方式 | 结果 |
| --- | --- | --- |
| HEAD | `git rev-parse --short HEAD` | `35b56c0`（= 复审报告 §12 白名单提交） |
| 工作区改动 | `git status --porcelain` | 仅 5 份未跟踪审计文档 + `.tmp-skills/`，无已跟踪文件改动 |
| R1 目标文件 | `git rev-parse HEAD:src/lib/md.ts` | blob `879db54`，234 行，仍是黑名单判定 |
| `package.json` | `git status` | 未修改，version 仍 `0.3.0` |
| 依赖 | `git status` | 无 lock 文件改动，零新增依赖 |

结论：与复审报告一致，R1 可开工。

## 二、漏洞复现（改代码之前先证明可达）

不改代码，先用 HEAD 版本的 `md.ts` 跑一遍真实渲染，再用 WHATWG 解析器（Node 内置 `URL`，与浏览器同一算法）读「浏览器最终看到的协议」：

```
输入（Markdown 链接）                 修复前最终协议      修复后最终协议
[a](java\tscript:alert(1))           javascript:         （无链接）
[a](java\nscript:alert(1))           javascript:         （无链接）
[a](java\rscript:alert(1))           javascript:         （无链接）
[a](\u0001javascript:alert(1))       javascript:         （无链接）
[a](\u0000javascript:alert(1))       javascript:         （无链接）
[a](JaVa\tScRiPt:alert(1))           javascript:         （无链接）
![x](da\tta:text/html;base64,AA)     data:               （无图片）
[a](vbscript:msgbox(1))              vbscript:           （无链接）
[a](file:///C:/Windows/win.ini)      file:               （无链接）
[a](https://x/?a=1&b=2)              https:              https:
[a](#heading)                        http:（相对 base）  http:
[a](path/to/file:name)               http:（相对 base）  http:
```

复现路径与危害：`renderInline` 的旧判定是 `/^\s*javascript:/i`。WHATWG 基础 URL 解析器在确定 scheme **之前**就会删掉输入里**所有** TAB/LF/CR，并剥掉首尾 C0+空格。于是 `java<TAB>script:` 顺利通过字符串黑名单，落地成 `href="java<TAB>script:alert(1)"`，浏览器解析时把 TAB 抹掉，协议确定为 `javascript:` —— 用户消息或模型回复里出现这一段文本就是一个可点击的 XSS。除控制符绕过外，旧黑名单还默认放行 `vbscript:`、`file:`、`blob:`、`about:` 等所有未列出的协议。

可达性说明：`java<TAB>script:` 这类**协议名内部**插控制符、以及 `\x00`/`\x01` 这类**不属于 JS `\s`** 的前导字符才是真实绕过；纯前导 TAB/`\x0c` 旧黑名单靠 `^\s*` 本就挡得住（实测 `\tjavascript:` 与 `\x0cjavascript:` 修复前后都是「无链接」）。另外本 WebView 配了 Tauri 默认 `script-src 'self'` CSP，`javascript:` 导航会被第二层拦下，但那是纵深防御，不是这一层的职责，也不能替代修复。

## 三、修复设计

### 3.1 操作顺序（授权书要求显式定义）

```
① 取出原始 URL 串 rawUrl            （正则匹配，未做任何改写）
② trim()                           （只做 JS 侧的空白收敛，不作为安全检查）
③ browserScheme(clean)             （识别协议：镜像解析器的预处理，仅用于判断，不回写）
④ 白名单查表 SAFE_SCHEMES.has()    （不在表内 → 降级为纯文本 label，不产出 href/src）
⑤ escapeAttr(clean)                （把**原始** clean 转义后写进属性，转义职责不变）
⑥ 浏览器：属性值单次解码 → URL 解析 → 协议确定
```

关键约束：③ 的规范化结果**只用于识别，绝不写回属性**。写进 HTML 的永远是 ② 之后的原始串。这样不存在「删字符后再检查，但落地的是另一个串」的解析歧义——授权书明令禁止的那种做法。

### 3.2 代码

[src/lib/md.ts:15-32](F:/zhuomian/zxz/src/lib/md.ts#L15-L32) 新增：

```ts
const SAFE_SCHEMES = new Set(["", "http", "https", "mailto", "tel"]);

function browserScheme(raw: string): string {
  const noBreaks = raw.replace(/[\t\n\r]/g, "");
  const aligned = noBreaks.replace(/^[\x00-\x20]+/, "").replace(/[\x00-\x20]+$/, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(aligned);
  return m ? m[1].toLowerCase() : "";
}
```

三步分别对应解析器的：删除全部 TAB/LF/CR → 剥离首尾 C0+空格（`0x00-0x20`，JS 的 `trim()` 覆盖不到 `0x01-0x08`）→ 按 scheme 文法（ASCII 字母开头，`[a-zA-Z0-9+\-.]` 延续，紧跟 `:`）取协议。取不到协议返回 `""`，语义是「相对路径 / 锚点 / 协议相对」，由 base URL 展开，安全。

[src/lib/md.ts:65](F:/zhuomian/zxz/src/lib/md.ts#L65) 替换判定：

```ts
// 改前
if (/^\s*javascript:/i.test(clean) || /^\s*data:/i.test(clean)) return keep(escapeHtml(label));
// 改后
if (!SAFE_SCHEMES.has(browserScheme(clean))) return keep(escapeHtml(label));
```

### 3.3 白名单取值理由

| 取值 | 放行理由 |
| --- | --- |
| `""` | 相对路径、`#锚点`、`//cdn.host` 协议相对——本项目消息链接的主要形态，工程模式下 `[文档](src/a.ts)` 必须继续可用 |
| `http` / `https` | 外链浏览，原有能力 |
| `mailto` / `tel` | 无脚本能力，交给系统处理器，不进入 WebView |
| 其他（含 `data` `vbscript` `blob` `about` `file` `view-source` `chrome` `wxwork` 未知协议） | 默认拒绝，降级为纯文本 |

黑名单是「想到才挡」，白名单是「想到才放」——这是策略层面的换向，后续新增协议必须显式评审。

### 3.4 未改动的部分（逐条核对）

| 约束 | 核对方式 | 结果 |
| --- | --- | --- |
| 不改 `escapeAttr()` 的安全职责 | `git status` | `src/lib/text.ts` 零改动；`escapeAttr(clean)` 调用形式一字未动 |
| 不回退 P0-2 属性转义修复 | `npm test` | P0-2 describe 全部 11 条转义回归用例仍绿，新增「控制字符 + 裸引号混排」用例仍绿 |
| 不改无关 Markdown 渲染 | `git diff` | 除判定行与新增两个顶层常量/函数外，`md.ts` 无其他改动；标题/列表/表格/引用/代码块/强调/换行逻辑未触碰 |
| 不改 App.tsx | `git status` | 零改动 |
| 不改 P0-1 会话机制 | `git status` | `src/lib/fsapi.ts`、`src-tauri/**` 零改动 |
| 不改 C1 命令实现 | `git status` | `src/lib/appcontrol.ts`、`appcontrol.test.ts` 零改动 |
| 不新增依赖 / 不改 package.json、lock、版本号 | `git status` + `grep version package.json` | 三者均无改动，version 仍 `0.3.0` |

## 四、新增安全回归测试

[src/lib/md.test.ts:155-265](F:/zhuomian/zxz/src/lib/md.test.ts#L155-L265) 新增 `describe("协议白名单与控制字符绕过（R1）")`（155-163 是两个测试辅助函数）。

断言口径按授权书要求落在**最终解析结果**上，不再只看字符串是否命中黑名单：

```ts
const decodeOnce = (v) => v.replace(/&(amp|lt|gt|quot);/g, ...);   // 属性值单次解码
function finalProtocols(html) {                                     // 取所有 href/src
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)]
    .map((m) => new URL(decodeOnce(m[1]), "http://localhost:1420/").protocol);
}
```

`new URL()` 用的是与浏览器同一份 WHATWG 实现，作为独立裁判；它看到的协议就是点击时真正会执行的协议。危险用例同时断言「不生成 `<a>` / `<img>`」与 `finalProtocols == []`。

覆盖清单（27 条新用例）：

- 协议名内部 TAB / LF / CR（3 条）
- 协议名前 TAB / CR（2 条）
- 前导 `\x01` / `\x00` / `\x0c`（3 条）
- 尾随 `\x02`（1 条）
- 大小写混合 + TAB、`da\tta:`（2 条）
- `vbscript:` `about:` `blob:` `file:` `view-source:` `chrome:` 未知协议 `wxwork:`（7 条）
- 协议名中间出现非法字符（NUL）→ 解析器判为无协议，最终协议是 base 的 `http:`，且不含 `javascript:`（1 条）
- 白名单落地一致性：`https:` / 大写 `HTTP://` / 带查询参数 / `mailto:` / `tel:`（1 条）
- 相对路径、`./`、`/abs`、`#anchor`、`//cdn`、`path/to/file:name` 全部放行并落在 base 协议（1 条）
- 前导控制符 + 大写协议经解析器还原后仍是合法 `http:`（1 条）
- `%6aavascript:` 与 `java&#115;cript:` 不复活成协议（1 条）
- 合法查询参数单个 `&` 仍只转义一次，解码后与原文等价（1 条）
- 控制字符 + 裸引号混排时属性仍闭合、协议判定未被削弱（1 条）
- 危险协议降级为纯文本后 label 内尖括号仍被转义（1 条）
- 块级 `renderMarkdown` 走同一条判定：整段文档路径同样拦下 TAB 绕过，同段合法外链与相对链接不受影响（1 条）

每条危险用例还断言 `html` 中不残留 `](` 结构，确认整段链接语法被完整消费、降级成纯文本而不是留下可被二次解析的残片。

## 五、门禁结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Markdown 单测 | `npx vitest run src/lib/md.test.ts` | 54 passed（原 27 + 新 27） |
| 全量单测 | `npm test` | 15 files / **319 passed**（改前 292） |
| 类型检查 | `npx tsc --noEmit` | exit 0，无输出 |
| 构建 | `npm run build` | exit 0，`✓ built in 2.27s`，产物 327.99 kB |

工作区当前状态：

```
 M src/lib/md.test.ts
 M src/lib/md.ts
?? .tmp-skills/
?? docs/audit/P0-1_INDEPENDENT_REVIEW.md
?? docs/audit/P0-2_COMMIT_RECORD.md
?? docs/audit/P0-2_IMPLEMENTATION_PLAN.md
?? docs/audit/P0-2_INDEPENDENT_REVIEW.md
?? docs/audit/R1_IMPLEMENTATION_PLAN.md
```

未跟踪文件与 R1 无关，一个都没动，也没删。

## 六、证据缺口与遗留项（须另行授权）

1. **无头测试 ≠ 真机验证。** 上述证据全部来自 Vitest node 环境 + WHATWG `URL` 裁判，没有用 WebView 真机点击过 `java<TAB>script:` 链接。要拿到真机证据需要临时开 CDP，属授权书明令禁止的动作，本阶段不做。复审方若要求真机证据，需要业主单独授权。
2. **README 同步未做。** 三处描述已与代码不一致：[README.md:413](F:/zhuomian/zxz/README.md#L413) 仍写「拒绝 `javascript:` / `data:` 链接」（现为白名单语义）、[README.md:40](F:/zhuomian/zxz/README.md#L40) 的「150 条单测」、[README.md:365](F:/zhuomian/zxz/README.md#L365) 的「纯逻辑单测 246 条」（现为 319）。授权书第六条把 R1 提交限定为「代码 + 测试」，故本阶段不改文档，留待业主裁决随 R1 提交还是单独文档批次。
3. **`mailto:` / `tel:` 由「未拦」变为「显式放行」。** 旧黑名单本就不挡这两个协议，所以这不是行为变化；但白名单把它们写成了明确承诺，而其在 Tauri WebView 里的真机表现（是否弹出外部邮件/拨号处理器）未实测。
4. **空 URL `[a]()` 仍会产出 `href=""`**（等价于当前页），白名单把它算作「无协议」放行，属既有行为，本次未改。
5. C1 遗留观察 O1/O2（reuse 路径的 stale `text`）、`.tmp-skills/` 处理、其余 5 份未跟踪审计文档，均不在本阶段范围。

## 七、停止点

R1 代码与测试已就绪，四项门禁全绿，未提交。按授权书流程，下一步是 R1 独立复审；复审通过后才执行 R1-C 本地提交（提交内容仅 `src/lib/md.ts` 与 `src/lib/md.test.ts` 两个文件）。

- 远端：`NOT_PUSHED`（授权书明令禁止 push，本阶段未执行任何远端操作）
- 状态：`READY_FOR_R1_REVIEW`
- 未开始：R1 提交、C2、A2、P0-4、P1-1、任何发布或部署
